#!/usr/bin/env node
// ============================================================================
// Feature-vs-capacity check for a screening arm.
//
//   node bot/analyze-arm.js --net bot/weights/screen/mini5_heights-600k-anneal100k.bin \
//        --marg HEIGHT0,HEIGHT1,HEIGHT2,HEIGHT3,HEIGHT4 --seeds 300 --mut-positions 300
//
// An arm ADDS tuples, so a benchmark gain mixes "the feature helped" with "the
// extra tables added capacity". This isolates the feature: it marginalizes the
// named feature(s) OUT of the arm's own trained weights -- every table that
// reads the feature is replaced by its mean over that feature's buckets, so the
// tuples stay (capacity unchanged) but the feature can no longer discriminate --
// and measures the paired drop in greedy score vs the intact arm. A big drop =
// the feature is doing real work; ~0 = the gain was capacity, not the feature.
// ============================================================================

const NTuple = require('./ntuple.js');
const Collapse = require('./engine.js');
const Starts = require('./starts.js');
const { FILL_NONE } = Collapse;
const V = 7, BOARD = 25;

// name -> [cell index, max bucket the feature uses]
const FEAT = {
    ZEROES: [25, 6], FIVES: [26, 6], SIXES: [27, 6], FIVE_COMP: [28, 3], EXPOSED: [29, 6],
    LEGAL: [30, 6], LEGAL_NO6: [31, 6],
    HEIGHT0: [32, 5], HEIGHT1: [33, 5], HEIGHT2: [34, 5], HEIGHT3: [35, 5], HEIGHT4: [36, 5],
};

function parseArgs(argv) {
    const a = { net: null, marg: [], seeds: 300, seedBase: 7000000, mut: 'bot/data/mut-starts.bin',
        mutPositions: 300, mutSeed: 12345, jobs: 8 };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--net') a.net = argv[++i];
        else if (k === '--marg') a.marg = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
        else if (k === '--seeds') a.seeds = parseInt(argv[++i], 10);
        else if (k === '--mut') a.mut = argv[++i];
        else if (k === '--mut-positions') a.mutPositions = parseInt(argv[++i], 10);
        else if (k === '--jobs') a.jobs = parseInt(argv[++i], 10);
        else { console.error('unknown option ' + k); process.exit(1); }
    }
    if (!a.net) { console.error('--net is required'); process.exit(1); }
    return a;
}

// Marginalize one feature (cell index) out of every tuple that reads it.
function marginalizeCell(net, cell, buckets) {
    const t = net.t;
    for (let k = 0; k < t.n; k++) {
        const o = t.off[k], l = t.len[k];
        let p = -1;
        for (let c = 0; c < l; c++) if (t.cells[o + c] === cell) { p = c; break; }
        if (p < 0) continue;
        const b = t.wbase[k], size = Math.pow(V, l), place = Math.pow(V, l - 1 - p);
        for (let i = 0; i < size; i++) {
            if (Math.floor(i / place) % V !== 0) continue;
            let s = 0;
            for (let d = 0; d < buckets; d++) s += net.w[b + i + d * place];
            const m = s / buckets;
            for (let d = 0; d < V; d++) net.w[b + i + d * place] = m;
        }
    }
}

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
    while (!g.gameOver && g.moves.length < 20000) { const m = greedyEval(net, g); if (!m) break; g.apply(m[0], m[1]); }
    return g.score;
}

if (process.env.COLLAPSE_ANALYZE_WORKER) {
    process.on('message', ({ netFile, margCells, boards, seeds }) => {
        const net = NTuple.load(netFile);
        for (const [cell, buckets] of margCells) marginalizeCell(net, cell, buckets);
        process.send({ scores: boards.map((arr, n) => playout(net, arr, seeds[n])) });
        process.exit(0);
    });
    return;
}

const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const seOf = a => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / (a.length - 1) / a.length); };
function xorshift(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; }; }

function evalVariant(netFile, margCells, starts, jobs) {
    const { fork } = require('child_process');
    const chunks = Array.from({ length: jobs }, () => []);
    starts.forEach((s, k) => chunks[k % jobs].push({ ...s, idx: k }));
    const scores = new Array(starts.length);
    return Promise.all(chunks.map(chunk => new Promise((resolve, reject) => {
        if (!chunk.length) return resolve();
        const child = fork(__filename, [], { env: Object.assign({}, process.env, { COLLAPSE_ANALYZE_WORKER: '1' }) });
        child.on('message', ({ scores: sc }) => { chunk.forEach((c, n) => { scores[c.idx] = sc[n]; }); resolve(); });
        child.on('error', reject);
        child.send({ netFile, margCells, boards: chunk.map(c => c.cells), seeds: chunk.map(c => c.seed) });
    }))).then(() => scores);
}

async function main() {
    const args = parseArgs(process.argv);
    const margCells = args.marg.map(n => { if (!FEAT[n]) { console.error('unknown feature ' + n); process.exit(1); } return FEAT[n]; });

    const reg = [], mut = [];
    for (let i = 0; i < args.seeds; i++) reg.push({ cells: Array.from(new Collapse.Game(args.seedBase + i).cells), seed: args.seedBase + i });
    const pool = Starts.load(args.mut), poolN = pool.length / 25, rng = xorshift(args.mutSeed);
    for (let i = 0; i < args.mutPositions; i++) { const at = ((rng() * poolN) | 0) * 25; mut.push({ cells: Array.from(pool.subarray(at, at + 25)), seed: args.seedBase + 500000 + i }); }
    const all = reg.concat(mut);
    const regIdx = all.map((_, i) => i).filter(i => i < reg.length), mutIdx = all.map((_, i) => i).filter(i => i >= reg.length);

    const intact = await evalVariant(args.net, [], all, args.jobs);
    const marged = await evalVariant(args.net, margCells, all, args.jobs);

    console.log('\n' + args.net);
    console.log('marginalized: ' + args.marg.join(', ') + '  (' + reg.length + ' regular + ' + mut.length + ' mutated starts)\n');
    const dReg = regIdx.map(i => marged[i] - intact[i]), dMut = mutIdx.map(i => marged[i] - intact[i]);
    console.log('  intact:        regular ' + mean(regIdx.map(i => intact[i])).toFixed(0) + '   mutated ' + mean(mutIdx.map(i => intact[i])).toFixed(0));
    console.log('  marginalized:  regular ' + mean(regIdx.map(i => marged[i])).toFixed(0) + '   mutated ' + mean(mutIdx.map(i => marged[i])).toFixed(0));
    console.log('  Δ feature:     regular ' + (mean(dReg) >= 0 ? '+' : '') + mean(dReg).toFixed(0) + ' ±' + seOf(dReg).toFixed(0) +
        '   mutated ' + (mean(dMut) >= 0 ? '+' : '') + mean(dMut).toFixed(0) + ' ±' + seOf(dMut).toFixed(0));
    console.log('\n  large negative Δ = the feature does real work; ~0 = the arm\'s gain was capacity, not the feature.');
}

if (require.main === module) main();
