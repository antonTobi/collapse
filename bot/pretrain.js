#!/usr/bin/env node
// ============================================================================
// Supervised pretraining of the n-tuple value network on HUMAN play.
//
//   node bot/pretrain.js --min-score 6000 --epochs 8 --sym --bench 200
//   node bot/pretrain.js --rank-weight 1 --mc-weight 0.2 --epochs 10 --sym
//
// Two losses over the same data, both aimed at the network train.js trains:
//
//   MC regression  (--mc-weight) on the afterstate the human moved into, with
//     target finalScore - score(afterstate): the points they went on to make.
//     This is exactly the quantity TD bootstraps towards.
//
//   Ranking        (--rank-weight) over ALL the legal moves in the position:
//     softmax on r(m) + V(afterstate(m)) with the human's move as the label.
//
// The ranking loss exists because MC regression alone does not work. Measured:
// regression on 1.39M human afterstates reaches a val RMSE of 911 against a
// 2346 baseline -- an excellent fit -- and the resulting greedy agent scores
// 1056. The reason is that a replay only ever shows the branch the human took,
// so every alternative a greedy agent has to rank against it is off
// distribution, and the network's opinion about those is untrained noise. A
// value function can be accurate everywhere it was fitted and still be useless
// for choosing, because choosing happens exactly where it was not fitted.
//
// The ranking loss fixes the mismatch by construction: it scores the losing
// candidates too, so their values become constrained. The reward term r(m)
// keeps V in points, so the two losses stay on one scale.
//
// The bias to keep in mind either way: an MC return is what ONE continuation
// happened to score, luck included, and human mistakes are baked in. This is a
// starting point for train.js, not something to converge to.
// ============================================================================

const path = require('path');
const Collapse = require('./engine.js');
const NTuple = require('./ntuple.js');
const Replays = require('./replays.js');

function parseArgs(argv) {
    const a = {
        minScore: 6000, games: 0, user: null, decisions: 400000,
        epochs: 8, alpha: 0.1, decay: 0.7, mcWeight: 1, rankWeight: 0, temp: 150,
        out: path.join(__dirname, 'weights', 'hv.bin'), resume: null,
        set: 'base', stages: 1, sym: false, tc: false, val: 0.1, seed: 999, bench: 0, jobs: 4
    };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--min-score') a.minScore = Number(argv[++i]);
        else if (k === '--games') a.games = Number(argv[++i]);
        else if (k === '--user') a.user = argv[++i];
        else if (k === '--decisions') a.decisions = Number(argv[++i]);
        else if (k === '--epochs') a.epochs = Number(argv[++i]);
        else if (k === '--alpha') a.alpha = Number(argv[++i]);
        else if (k === '--decay') a.decay = Number(argv[++i]);
        else if (k === '--mc-weight') a.mcWeight = Number(argv[++i]);
        else if (k === '--rank-weight') a.rankWeight = Number(argv[++i]);
        else if (k === '--temp') a.temp = Number(argv[++i]);
        else if (k === '--out') a.out = argv[++i];
        else if (k === '--resume') a.resume = argv[++i];
        else if (k === '--set') a.set = argv[++i];
        else if (k === '--stages') a.stages = Number(argv[++i]);
        else if (k === '--sym') a.sym = true;
        else if (k === '--tc') a.tc = true;
        else if (k === '--val') a.val = Number(argv[++i]);
        else if (k === '--seed') a.seed = Number(argv[++i]);
        else if (k === '--bench') a.bench = Number(argv[++i]);
        else if (k === '--jobs') a.jobs = Number(argv[++i]);
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
// One record per decision: the afterstate cells of EVERY legal move (25 bytes
// each), the points each move scores, which one the human played, and the MC
// return from the played one. ~8.3 candidates per decision, so 400k decisions
// is about 85 MB.
function buildDataset(rows, budget, rng) {
    const totalMoves = rows.reduce((a, r) => a + r.numMoves, 0);
    const keep = Math.min(1, budget / Math.max(1, totalMoves));
    const cells = [], reward = [], start = [], count = [], pick = [], mc = [], gameOf = [];
    let gi = -1, lastId = null, flat = 0;
    Replays.walkAll(rows, (d, rec) => {
        if (rec.id !== lastId) { lastId = rec.id; gi++; }
        if (keep < 1 && rng() > keep) return;
        start.push(flat); count.push(d.legalMoves.length); pick.push(d.pick); gameOf.push(gi);
        let played = null;
        for (const m of d.legalMoves) {
            const after = d.game.preview(m[0], m[1], Collapse.FILL_NONE);
            cells.push(Uint8Array.from(after.cells));
            reward.push(after.score - d.game.score);
            if (m[0] === d.move[0] && m[1] === d.move[1]) played = after;
            flat++;
        }
        mc.push(d.finalScore - played.score);
    }, 1);   // minLegal 1: forced moves still carry MC value information
    return {
        cells, reward: Float32Array.from(reward), start: Int32Array.from(start),
        count: Int32Array.from(count), pick: Int32Array.from(pick), mc: Float32Array.from(mc),
        gameOf: Int32Array.from(gameOf), n: start.length, games: gi + 1
    };
}

// Held-out diagnostics: how well the value predicts the return (rmse), and how
// often argmax(r + V) is the move the human played (top1).
function check(net, ds, idx) {
    let se = 0, hit = 0;
    for (const d of idx) {
        const base = ds.start[d], c = ds.count[d];
        const e = net.value(ds.cells[base + ds.pick[d]]) - ds.mc[d];
        se += e * e;
        let bv = -Infinity, bi = 0;
        for (let k = 0; k < c; k++) {
            const v = ds.reward[base + k] + net.value(ds.cells[base + k]);
            if (v > bv) { bv = v; bi = k; }
        }
        if (bi === ds.pick[d]) hit++;
    }
    return { rmse: Math.sqrt(se / idx.length), top1: hit / idx.length };
}

async function main() {
    const args = parseArgs(process.argv);
    const rows = Replays.load({ minScore: args.minScore, games: args.games, user: args.user });
    console.log(Replays.describe(rows));

    const rng = mulberry(args.seed);
    const ds = buildDataset(rows, args.decisions, rng);
    console.log(ds.n + ' decisions from ' + ds.games + ' games (' + ds.cells.length + ' candidate afterstates)');

    const net = args.resume
        ? NTuple.load(args.resume, args.sym ? { sym: true } : null)
        : new NTuple.Network(undefined, { set: args.set, sym: args.sym, stages: args.stages });
    console.log('network: set=' + net.setName + ' sym=' + net.sym + ' stages=' + net.stages +
        ' weights=' + net.w.length + (args.tc ? ' (temporal coherence)' : ''));
    console.log('loss: mc x' + args.mcWeight + ' + rank x' + args.rankWeight + ' (temp ' + args.temp + ')');

    const tc = args.tc ? new NTuple.TC(net) : null;
    const apply = tc ? (c, d) => tc.update(c, d) : (c, d) => net.update(c, d);

    // Hold out whole games: successive decisions in one game share most of
    // their tuples and all of their final score.
    const trainIdx = [], valIdx = [];
    const every = Math.max(2, Math.round(1 / args.val));
    for (let i = 0; i < ds.n; i++) (ds.gameOf[i] % every === 0 ? valIdx : trainIdx).push(i);

    const mean = trainIdx.reduce((a, i) => a + ds.mc[i], 0) / trainIdx.length;
    let base = 0;
    for (const i of valIdx) base += (ds.mc[i] - mean) ** 2;
    console.log('target mean ' + mean.toFixed(0) + '; predicting it alone gives val rmse ' +
        Math.sqrt(base / valIdx.length).toFixed(0));

    const order = Int32Array.from(trainIdx);
    const s = new Float64Array(32), e = new Float64Array(32);
    let alpha = args.alpha;
    const t0 = Date.now();

    for (let ep = 0; ep < args.epochs; ep++) {
        for (let i = order.length - 1; i > 0; i--) {
            const j = (rng() * (i + 1)) | 0;
            const t = order[i]; order[i] = order[j]; order[j] = t;
        }
        for (let q = 0; q < order.length; q++) {
            const d = order[q], base2 = ds.start[d], c = ds.count[d], p = ds.pick[d];
            if (args.rankWeight && c > 1) {
                let mx = -Infinity;
                for (let k = 0; k < c; k++) {
                    s[k] = (ds.reward[base2 + k] + net.value(ds.cells[base2 + k])) / args.temp;
                    if (s[k] > mx) mx = s[k];
                }
                let Z = 0;
                for (let k = 0; k < c; k++) { e[k] = Math.exp(s[k] - mx); Z += e[k]; }
                for (let k = 0; k < c; k++) {
                    const coef = (k === p ? 1 : 0) - e[k] / Z;
                    // d(loss)/dV is coef/temp; the temp cancels against the
                    // scale we divided by, leaving a step in points.
                    if (coef) apply(ds.cells[base2 + k], alpha * args.rankWeight * coef * args.temp);
                }
            }
            if (args.mcWeight) {
                const cell = ds.cells[base2 + p];
                apply(cell, alpha * args.mcWeight * (ds.mc[d] - net.value(cell)));
            }
        }
        const va = check(net, ds, valIdx);
        console.log('epoch ' + (ep + 1) + '  alpha ' + alpha.toFixed(4) +
            '  val rmse ' + va.rmse.toFixed(0) + '  val top1 ' + (100 * va.top1).toFixed(1) + '%' +
            '  ' + ((Date.now() - t0) / 1000).toFixed(0) + 's');
        alpha *= args.decay;
        NTuple.save(args.out, net);
    }

    NTuple.save(args.out, net);
    console.log('saved ' + args.out);

    // The number that matters: how well does acting greedily on this value
    // function actually play? A good regression fit is not the same thing.
    if (args.bench) {
        const { Pool, summarize } = require('./harness.js');
        const pool = new Pool(args.jobs);
        const seeds = Array.from({ length: args.bench }, (_, k) => 20001 + k);
        const rel = path.relative(path.join(__dirname, '..'), args.out).split(path.sep).join('/');
        const st = summarize(await pool.evaluate('td:weights=' + rel, seeds));
        console.log('greedy play: mean ' + st.mean.toFixed(0) + ' +- ' + st.se.toFixed(0) +
            ' over ' + args.bench + ' games');
        pool.close();
    }
}

main();
