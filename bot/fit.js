#!/usr/bin/env node
// ============================================================================
// Fit linear evaluation weights to human move choices.
//
//   node bot/fit.js --min-score 7000 --decisions 150000
//   node bot/fit.js --min-score 7000 --out bot/weights/fit7000.json
//   node bot/fit.js --sweep 0,4000,6000,7000,8000,9000
//
// Each position a human played is one training example: the features of every
// legal move go through a softmax, and the loss is the negative log likelihood
// of the move the human actually chose (Bradley-Terry / conditional logit).
// The gradient touches all features at once, so this recovers a whole weight
// vector from data in minutes -- where tune.js gets one noisy scalar (the mean
// over a few hundred games, +-60) per candidate vector and needs hours to see
// a 100-point difference.
//
// What it CANNOT do is exceed the human policy: the objective is agreement,
// not score. Use the result as a starting point for tune.js, not as the
// finished article.
//
// Softmax is shift-invariant, so only the differences between the candidates
// in a position matter; features are centred per decision before fitting and
// standardized across the sample. Weights are converted back to raw feature
// units at the end, which is what agents.js PRESETS expects.
// ============================================================================

const fs = require('fs');
const path = require('path');
const Collapse = require('./engine.js');
const Ev = require('./eval.js');
const Replays = require('./replays.js');

const NF = Ev.NF;

function parseArgs(argv) {
    const a = {
        minScore: 7000, games: 0, decisions: 150000, epochs: 30, lr: 0.05, l2: 1e-4,
        val: 0.15, out: null, sweep: null, user: null, seed: 12345, quiet: false, features: null,
        bench: 0, benchBase: 20001, jobs: 4
    };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--min-score') a.minScore = Number(argv[++i]);
        else if (k === '--games') a.games = Number(argv[++i]);
        else if (k === '--decisions') a.decisions = Number(argv[++i]);
        else if (k === '--epochs') a.epochs = Number(argv[++i]);
        else if (k === '--lr') a.lr = Number(argv[++i]);
        else if (k === '--l2') a.l2 = Number(argv[++i]);
        else if (k === '--val') a.val = Number(argv[++i]);
        else if (k === '--out') a.out = argv[++i];
        else if (k === '--user') a.user = argv[++i];
        else if (k === '--seed') a.seed = Number(argv[++i]);
        else if (k === '--features') a.features = argv[++i].split(',');
        else if (k === '--quiet') a.quiet = true;
        else if (k === '--bench') a.bench = Number(argv[++i]);
        else if (k === '--bench-base') a.benchBase = Number(argv[++i]);
        else if (k === '--jobs') a.jobs = Number(argv[++i]);
        else if (k === '--sweep') a.sweep = argv[++i].split(',').map(Number);
        else { console.error('unknown option ' + k); process.exit(1); }
    }
    return a;
}

function mulberry(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6D2B79F5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// --- dataset ---------------------------------------------------------------
// Decisions are stored flat: `feat` holds every candidate move's feature row
// back to back, `start[d]`/`count[d]` index into it, `pick[d]` is the human's
// choice. A budget keeps memory bounded and, more importantly, lets a
// threshold sweep hold the sample SIZE fixed so only move QUALITY varies.
function build(rows, budget, rng) {
    const total = rows.reduce((a, r) => a + r.numMoves, 0);
    const keep = Math.min(1, budget / Math.max(1, total));   // uniform thinning
    const feat = [], start = [], count = [], pick = [], game = [];
    const buf = new Float64Array(NF);
    let n = 0;
    Replays.walkAll(rows, (d, rec) => {
        if (keep < 1 && rng() > keep) return;
        const rowsHere = [];
        for (const m of d.legalMoves) {
            const next = d.game.preview(m[0], m[1], Collapse.FILL_NONE);
            const made = d.game.at(m[0], m[1]) + 1;
            const gain = next.score - d.game.score;
            Ev.extract(next, made, gain, buf, gain / (made - 1));
            rowsHere.push(Float64Array.from(buf));
        }
        // Centre within the decision: only differences between candidates
        // affect the softmax, and removing the common part kills most of the
        // between-position variance before standardization.
        const mean = new Float64Array(NF);
        for (const v of rowsHere) for (let t = 0; t < NF; t++) mean[t] += v[t] / rowsHere.length;
        start.push(feat.length); count.push(rowsHere.length); pick.push(d.pick); game.push(rec.id);
        for (const v of rowsHere) {
            for (let t = 0; t < NF; t++) v[t] -= mean[t];
            feat.push(Float32Array.from(v));
        }
        n++;
    });
    return { feat, start, count, pick, game, n };
}

// Per-feature scale, so the learning rate means the same thing for heightsum
// (spread ~15) and trapped (spread ~0.16). Features that never vary within a
// decision get scale 1 and a permanently zero gradient.
function standardize(ds) {
    const sd = new Float64Array(NF);
    let m = 0;
    for (const v of ds.feat) { m++; for (let t = 0; t < NF; t++) sd[t] += v[t] * v[t]; }
    for (let t = 0; t < NF; t++) {
        sd[t] = Math.sqrt(sd[t] / Math.max(1, m));
        if (!(sd[t] > 1e-9)) sd[t] = 1;
    }
    for (const v of ds.feat) for (let t = 0; t < NF; t++) v[t] /= sd[t];
    return sd;
}

// Loss and top-1 agreement over a set of decision indices.
function evaluate(ds, w, idx) {
    let nll = 0, hit = 0;
    const s = new Float64Array(32);
    for (const d of idx) {
        const c = ds.count[d], base = ds.start[d];
        let mx = -Infinity, bi = 0;
        for (let k = 0; k < c; k++) {
            const v = ds.feat[base + k];
            let x = 0;
            for (let t = 0; t < NF; t++) x += w[t] * v[t];
            s[k] = x;
            if (x > mx) { mx = x; bi = k; }
        }
        let Z = 0;
        for (let k = 0; k < c; k++) Z += Math.exp(s[k] - mx);
        nll += -(s[ds.pick[d]] - mx - Math.log(Z));
        if (bi === ds.pick[d]) hit++;
    }
    return { nll: nll / idx.length, top1: hit / idx.length };
}

// Adam. The objective is convex in w, but the scaling across features is bad
// enough that plain SGD crawls on the rare ones (new5*, made6).
function train(ds, trainIdx, valIdx, args) {
    const w = new Float64Array(NF);
    const m = new Float64Array(NF), v = new Float64Array(NF), g = new Float64Array(NF);
    const active = new Uint8Array(NF).fill(1);
    if (args.features) {
        active.fill(0);
        for (const f of args.features) {
            if (!(f in Ev.FI)) throw new Error('unknown feature ' + f);
            active[Ev.FI[f]] = 1;
        }
    }
    const b1 = 0.9, b2 = 0.999, eps = 1e-8, BS = 512;
    const order = trainIdx.slice();
    const rng = mulberry(args.seed);
    const s = new Float64Array(32), e = new Float64Array(32);
    let step = 0, best = null, bestNll = Infinity;
    for (let ep = 0; ep < args.epochs; ep++) {
        for (let i = order.length - 1; i > 0; i--) {
            const j = (rng() * (i + 1)) | 0;
            const t = order[i]; order[i] = order[j]; order[j] = t;
        }
        const lr = args.lr * (0.5 * (1 + Math.cos(Math.PI * ep / args.epochs)));   // cosine decay
        for (let b = 0; b < order.length; b += BS) {
            g.fill(0);
            const hi = Math.min(b + BS, order.length);
            for (let q = b; q < hi; q++) {
                const d = order[q], c = ds.count[d], base = ds.start[d];
                let mx = -Infinity;
                for (let k = 0; k < c; k++) {
                    const vv = ds.feat[base + k];
                    let x = 0;
                    for (let t = 0; t < NF; t++) x += w[t] * vv[t];
                    s[k] = x; if (x > mx) mx = x;
                }
                let Z = 0;
                for (let k = 0; k < c; k++) { e[k] = Math.exp(s[k] - mx); Z += e[k]; }
                for (let k = 0; k < c; k++) {
                    const coef = (k === ds.pick[d] ? 1 : 0) - e[k] / Z;
                    if (coef === 0) continue;
                    const vv = ds.feat[base + k];
                    for (let t = 0; t < NF; t++) g[t] += coef * vv[t];
                }
            }
            const nb = hi - b;
            step++;
            const c1 = 1 - Math.pow(b1, step), c2 = 1 - Math.pow(b2, step);
            for (let t = 0; t < NF; t++) {
                if (!active[t]) { w[t] = 0; continue; }
                const gt = -g[t] / nb + args.l2 * w[t];         // negative: we minimize NLL
                m[t] = b1 * m[t] + (1 - b1) * gt;
                v[t] = b2 * v[t] + (1 - b2) * gt * gt;
                w[t] -= lr * (m[t] / c1) / (Math.sqrt(v[t] / c2) + eps);
            }
        }
        const va = evaluate(ds, w, valIdx);
        if (va.nll < bestNll) { bestNll = va.nll; best = Float64Array.from(w); }
        if (!args.quiet && (ep % 5 === 4 || ep === args.epochs - 1)) {
            const tr = evaluate(ds, w, trainIdx.slice(0, Math.min(20000, trainIdx.length)));
            console.log('  ep' + String(ep + 1).padStart(3) +
                '  train nll ' + tr.nll.toFixed(4) + ' top1 ' + (100 * tr.top1).toFixed(1) + '%' +
                '   val nll ' + va.nll.toFixed(4) + ' top1 ' + (100 * va.top1).toFixed(1) + '%');
        }
    }
    return best;
}

// Back to raw feature units, normalized so `moves` matches the presets (the
// overall scale is irrelevant to a greedy agent, but it keeps the numbers
// comparable with v1-v4 by eye).
function toRawPreset(w, sd) {
    const raw = {};
    for (let t = 0; t < NF; t++) raw[Ev.FEATURES[t]] = w[t] / sd[t];
    const k = raw.moves ? 0.70661 / raw.moves : 1;
    const out = {};
    for (const f of Ev.FEATURES) {
        const val = raw[f] * k;
        if (Math.abs(val) > 1e-4) out[f] = +val.toFixed(5);
    }
    return out;
}

function specOf(preset) {
    return 'linear:' + Object.entries(preset).map(kv => kv[0] + '=' + kv[1]).join(',');
}

function fitOnce(args, minScore) {
    const rows = Replays.load({ minScore, games: args.games, user: args.user });
    const rng = mulberry(args.seed);
    const ds = build(rows, args.decisions, rng);
    const sd = standardize(ds);
    // Split by GAME, not by decision: consecutive positions in one game are
    // near-duplicates, so a random split would leak and flatter the val score.
    const games = Array.from(new Set(ds.game));
    const every = Math.max(2, Math.round(1 / args.val));
    const held = new Set(games.filter((_, k) => (k % every) === 0));
    const trainIdx = [], valIdx = [];
    for (let d = 0; d < ds.n; d++) (held.has(ds.game[d]) ? valIdx : trainIdx).push(d);
    if (!args.quiet) {
        console.log('  ' + Replays.describe(rows) + '  ->  ' + ds.n + ' decisions (' +
            trainIdx.length + ' train / ' + valIdx.length + ' val, ' + games.length + ' games)');
    }
    const w = train(ds, trainIdx, valIdx, args);
    const va = evaluate(ds, w, valIdx);
    return { preset: toRawPreset(w, sd), val: va, decisions: ds.n, rows: rows.length };
}

function writePreset(file, preset) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(preset, null, 1));
}

// Repo-relative path, which is what agents.js `linear:json=` resolves against.
function repoRel(file) {
    return path.relative(path.join(__dirname, '..'), file).split(path.sep).join('/');
}

async function main() {
    const args = parseArgs(process.argv);
    const thresholds = args.sweep || [args.minScore];
    const results = [];

    for (const ms of thresholds) {
        if (thresholds.length > 1) console.log('\n=== min-score ' + ms + ' ===');
        const r = fitOnce(args, ms);
        r.minScore = ms;
        r.file = args.out
            ? (thresholds.length > 1 ? args.out.replace(/\.json$/, '') + '-' + ms + '.json' : args.out)
            : path.join(__dirname, 'weights', 'fit-' + ms + '.json');
        writePreset(r.file, r.preset);
        results.push(r);
    }

    // Mean score is the only number here that is comparable across thresholds.
    // val nll / top1 are measured against DIFFERENT reference play at each
    // threshold (agreement with 9000+ games is a harder target than agreement
    // with all games), so they rank the fits only within a single threshold.
    if (args.bench) {
        const { Pool, summarize } = require('./harness.js');
        const pool = new Pool(args.jobs);
        const seeds = Array.from({ length: args.bench }, (_, k) => args.benchBase + k);
        for (const r of results) {
            r.bench = summarize(await pool.evaluate('linear:json=' + repoRel(r.file), seeds));
        }
        pool.close();
    }

    console.log('\nmin-score   games  decisions   val nll   val top1' + (args.bench ? '      mean     ±se' : ''));
    for (const r of results) {
        console.log(String(r.minScore).padStart(9) + String(r.rows).padStart(7) + String(r.decisions).padStart(11) +
            r.val.nll.toFixed(4).padStart(10) + (100 * r.val.top1).toFixed(1).padStart(9) + '%' +
            (r.bench ? r.bench.mean.toFixed(0).padStart(10) + r.bench.se.toFixed(0).padStart(8) : ''));
    }
    if (args.bench) console.log('(mean over ' + args.bench + ' games, seeds ' + args.benchBase + '+)');
    console.log('\nweights written:');
    for (const r of results) console.log('  linear:json=' + repoRel(r.file));
    if (results.length === 1) console.log('\nraw preset: ' + JSON.stringify(results[0].preset));
}

if (require.main === module) main();
module.exports = { build, standardize, train, evaluate, toRawPreset, specOf, fitOnce };
