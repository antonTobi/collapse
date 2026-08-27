#!/usr/bin/env node
// ============================================================================
// Ablation: what does each tuple category / global feature actually BUY?
//
//   node bot/ablate.js --net bot/weights/mini5-ep1500000-annealed.bin \
//                      --seeds 200 --mut bot/data/mut-starts.bin --mut-positions 200 --jobs 8
//
// contrib.js says which tuples carry weight and move the choice. That is a
// *correlational* read of the trained net. This is the causal one: knock a
// category or feature out of the network and play greedily from the same fixed
// starts, so the drop in mean score IS the points of strength that piece was
// worth. A piece with big contribution but ~0 ablation cost is redundant (some
// other tuple covers the same ground); one worth keeping shows a real drop.
//
// Two kinds of knockout, both applied to a copy of the trained weights:
//   zero <category>   set every table of that category to 0 -- exactly removing
//                     those tuples from the value sum.
//   marg <feature>    replace every table that reads the feature by its mean
//                     over that feature's buckets, holding the shape digits
//                     fixed. The tuple keeps its shape marginal but can no longer
//                     tell the feature's buckets apart -- it isolates the
//                     feature's information from the shape it rides on (zeroing a
//                     hybrid would throw away the shape too).
//
// Reported per distribution (regular openings and mutated/OOD starts) as the
// paired change in final greedy score vs the intact net over the same seeds.
// Globals are expected to earn their keep mainly on the mutated side.
// ============================================================================

const path = require('path');
const NTuple = require('./ntuple.js');
const Collapse = require('./engine.js');
const Starts = require('./starts.js');
const { FILL_NONE } = Collapse;

const V = 7, BOARD = 25;
const GNAMES = ['ZEROES', 'FIVES', 'SIXES', 'FIVE_COMP', 'EXPOSED'];
const GMAX = [6, 6, 6, 3, 6];

function parseArgs(argv) {
    const a = { net: null, seeds: 200, seedBase: 7000000, mut: null, mutPositions: 200, mutSeed: 12345, jobs: 8 };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--net') a.net = argv[++i];
        else if (k === '--seeds') a.seeds = parseInt(argv[++i], 10);
        else if (k === '--seed-base') a.seedBase = parseInt(argv[++i], 10);
        else if (k === '--mut') a.mut = argv[++i];
        else if (k === '--mut-positions') a.mutPositions = parseInt(argv[++i], 10);
        else if (k === '--mut-seed') a.mutSeed = parseInt(argv[++i], 10);
        else if (k === '--jobs') a.jobs = parseInt(argv[++i], 10);
        else { console.error('unknown option ' + k); process.exit(1); }
    }
    if (!a.net) { console.error('--net is required'); process.exit(1); }
    return a;
}

// Same classification as contrib.js: pure shape (by length / square) or global.
function classify(t, k) {
    const o = t.off[k], l = t.len[k];
    const cells = [];
    for (let c = 0; c < l; c++) cells.push(t.cells[o + c]);
    const globals = cells.filter(x => x >= BOARD);
    if (globals.length === l) return 'pure-global';
    if (globals.length > 0) return 'hybrid:' + GNAMES[globals[0] - BOARD];
    if (l === 2) return 'run2';
    if (l === 3) return 'run3';
    if (l === 5) return 'run5';
    const rows = new Set(cells.map(x => x % 5)), cols = new Set(cells.map(x => (x / 5) | 0));
    return (rows.size === 1 || cols.size === 1) ? 'run4' : 'square';
}

// --- weight knockouts (operate on net.w in place) --------------------------

// Zero every table belonging to `category` -- removes those tuples from the sum.
function zeroCategory(net, category) {
    const t = net.t;
    for (let k = 0; k < t.n; k++) {
        if (classify(t, k) !== category) continue;
        const b = t.wbase[k], size = Math.pow(V, t.len[k]);
        for (let i = 0; i < size; i++) net.w[b + i] = 0;
    }
}

// Marginalize feature f out of every tuple that reads it: for each table, hold
// all other digits fixed and set the feature-digit slice to its mean over the
// buckets the feature actually uses (0..GMAX[f]). The tuple keeps its shape
// marginal; the feature can no longer discriminate.
function marginalizeFeature(net, f) {
    const t = net.t, cell = BOARD + f, buckets = GMAX[f] + 1;
    for (let k = 0; k < t.n; k++) {
        const o = t.off[k], l = t.len[k];
        // position(s) of this feature inside the tuple (globals sit once each)
        let p = -1;
        for (let c = 0; c < l; c++) if (t.cells[o + c] === cell) { p = c; break; }
        if (p < 0) continue;
        const b = t.wbase[k], size = Math.pow(V, l);
        const place = Math.pow(V, l - 1 - p);   // value of the feature digit's position
        // iterate over every group (index with feature-digit 0), average, write back
        for (let i = 0; i < size; i++) {
            if (Math.floor(i / place) % V !== 0) continue;   // only group representatives
            let s = 0;
            for (let d = 0; d < buckets; d++) s += net.w[b + i + d * place];
            const mean = s / buckets;
            for (let d = 0; d < V; d++) net.w[b + i + d * place] = mean;
        }
    }
}

function applyVariant(net, variant) {
    if (variant.type === 'baseline') return;
    if (variant.type === 'zero') zeroCategory(net, variant.arg);
    else if (variant.type === 'marg') marginalizeFeature(net, variant.arg);
}

// Greedy value + chosen move: max over legal moves of gain + V(afterstate).
function greedyEval(net, game) {
    let best = null, bq = -Infinity;
    for (const [i, j] of game.legalMoves()) {
        const after = game.preview(i, j, FILL_NONE);
        const q = (after.score - game.score) + net.value(after.cells);
        if (q > bq) { bq = q; best = [i, j]; }
    }
    return best;
}

function playout(net, cells, seed) {
    const g = Collapse.fromCells(Uint8Array.from(cells), seed);
    while (!g.gameOver && g.moves.length < 20000) {
        const m = greedyEval(net, g);
        if (!m) break;
        g.apply(m[0], m[1]);
    }
    return g.score;
}

// --- worker: play a slice of starts under one variant ----------------------
if (process.env.COLLAPSE_ABLATE_WORKER) {
    process.on('message', ({ netFile, variant, boards, seeds }) => {
        const net = NTuple.load(netFile);
        applyVariant(net, variant);
        const scores = boards.map((arr, n) => playout(net, arr, seeds[n]));
        process.send({ scores });
        process.exit(0);
    });
    return;
}

const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const seOf = a => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / (a.length - 1) / a.length); };

// Play `starts` (array of {cells, seed}) under one variant, sharded over jobs.
function evalVariant(netFile, variant, starts, jobs) {
    const { fork } = require('child_process');
    const chunks = Array.from({ length: jobs }, () => []);
    starts.forEach((s, k) => chunks[k % jobs].push({ ...s, idx: k }));
    const scores = new Array(starts.length);
    return Promise.all(chunks.map(chunk => new Promise((resolve, reject) => {
        if (!chunk.length) return resolve();
        const child = fork(__filename, [], { env: Object.assign({}, process.env, { COLLAPSE_ABLATE_WORKER: '1' }) });
        child.on('message', ({ scores: sc }) => { chunk.forEach((c, n) => { scores[c.idx] = sc[n]; }); resolve(); });
        child.on('error', reject);
        child.send({ netFile, variant, boards: chunk.map(c => c.cells), seeds: chunk.map(c => c.seed) });
    }))).then(() => scores);
}

function xorshift(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; }; }

function buildStarts(args) {
    const reg = [];
    for (let i = 0; i < args.seeds; i++) {
        const seed = args.seedBase + i;
        reg.push({ cells: Array.from(new Collapse.Game(seed).cells), seed, group: 'regular' });
    }
    const mut = [];
    if (args.mut) {
        const pool = Starts.load(args.mut);
        const poolN = pool.length / 25;
        const rng = xorshift(args.mutSeed);
        for (let i = 0; i < args.mutPositions; i++) {
            const at = ((rng() * poolN) | 0) * 25;
            mut.push({ cells: Array.from(pool.subarray(at, at + 25)), seed: args.seedBase + 500000 + i, group: 'mutated' });
        }
    }
    return { reg, mut };
}

async function main() {
    const args = parseArgs(process.argv);
    const net0 = NTuple.load(args.net);
    const present = new Set();
    for (let k = 0; k < net0.t.n; k++) present.add(classify(net0.t, k));

    const catOrder = ['run2', 'run3', 'run4', 'run5', 'square', 'pure-global',
        'hybrid:ZEROES', 'hybrid:FIVES', 'hybrid:SIXES', 'hybrid:FIVE_COMP', 'hybrid:EXPOSED'];
    const variants = [{ type: 'baseline', label: 'baseline (intact)' }];
    for (const c of catOrder) if (present.has(c)) variants.push({ type: 'zero', arg: c, label: 'zero ' + c });
    for (let f = 0; f < GNAMES.length; f++) variants.push({ type: 'marg', arg: f, label: 'marg ' + GNAMES[f] });

    const { reg, mut } = buildStarts(args);
    const all = reg.concat(mut);
    console.log('\n' + args.net);
    console.log(reg.length + ' regular + ' + mut.length + ' mutated starts, greedy playout, ' + variants.length + ' variants\n');

    // Baseline first, then each knockout; paired per-start deltas by group.
    const results = {};
    for (const v of variants) {
        results[v.label] = await evalVariant(args.net, v, all, args.jobs);
    }
    const base = results['baseline (intact)'];

    function groupIdx(group) { return all.map((s, i) => s.group === group ? i : -1).filter(i => i >= 0); }
    const regIdx = groupIdx('regular'), mutIdx = groupIdx('mutated');
    const baseReg = mean(regIdx.map(i => base[i])), baseMut = mut.length ? mean(mutIdx.map(i => base[i])) : NaN;

    console.log('  baseline mean:  regular ' + baseReg.toFixed(1) +
        (mut.length ? '   mutated ' + baseMut.toFixed(1) : '') + '\n');
    const head = '  ' + 'knockout'.padEnd(22) + 'Δ regular'.padStart(16) + (mut.length ? 'Δ mutated'.padStart(16) : '');
    console.log(head);
    console.log('  ' + '-'.repeat(head.length - 2));

    for (const v of variants) {
        if (v.type === 'baseline') continue;
        const sc = results[v.label];
        const dReg = regIdx.map(i => sc[i] - base[i]);
        const cellReg = fmtDelta(mean(dReg), seOf(dReg));
        let cellMut = '';
        if (mut.length) { const dMut = mutIdx.map(i => sc[i] - base[i]); cellMut = fmtDelta(mean(dMut), seOf(dMut)); }
        console.log('  ' + v.label.padEnd(22) + cellReg.padStart(16) + (mut.length ? cellMut.padStart(16) : ''));
    }
    console.log('\n  Δ = mean(final score with knockout) - mean(intact), paired over the same starts.');
    console.log('  more negative = the piece was worth more; ~0 = redundant given the rest.');
}

function fmtDelta(m, se) {
    const s = (m >= 0 ? '+' : '') + m.toFixed(1);
    return s + ' ±' + se.toFixed(1);
}

if (require.main === module) main();
