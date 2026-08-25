#!/usr/bin/env node
// Build a reproducible mixture of in-distribution, human, perturbed-human and
// synthetic full-board positions for --starts in ptrain.js.
//
//   node bot/oodstarts.js --source bot/data/human-train.bin \
//       --positions 100000 --out bot/data/ood-train.bin
//
// The default quarters are intentionally easy to interpret in an A/B test:
// source positions, mutations of source positions, independent random boards,
// and spatially correlated random boards. Rejected terminal boards are simply
// resampled. This is corpus construction, not a claim that random boards are a
// realistic game distribution; their job is to expose unconstrained table
// entries and catastrophic extrapolation.

const path = require('path');
const Collapse = require('./engine.js');
const Starts = require('./starts.js');

function parseArgs(argv) {
    const a = {
        source: path.join(__dirname, 'data/human-train.bin'),
        out: path.join(__dirname, 'data/ood-train.bin'), positions: 100000,
        sourceFrac: 0.25, mutateFrac: 0.25, iidFrac: 0.25,
        mutateMax: 8, seed: 7302026
    };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--source') a.source = argv[++i];
        else if (k === '--out') a.out = argv[++i];
        else if (k === '--positions') a.positions = parseInt(argv[++i], 10);
        else if (k === '--source-frac') a.sourceFrac = parseFloat(argv[++i]);
        else if (k === '--mutate-frac') a.mutateFrac = parseFloat(argv[++i]);
        else if (k === '--iid-frac') a.iidFrac = parseFloat(argv[++i]);
        else if (k === '--mutate-max') a.mutateMax = parseInt(argv[++i], 10);
        else if (k === '--seed') a.seed = parseInt(argv[++i], 10);
        else { console.error('unknown option ' + k); process.exit(1); }
    }
    const sum = a.sourceFrac + a.mutateFrac + a.iidFrac;
    if (sum > 1 + 1e-9 || [a.sourceFrac, a.mutateFrac, a.iidFrac].some(x => x < 0)) {
        console.error('source-frac + mutate-frac + iid-frac must be between 0 and 1');
        process.exit(1);
    }
    if ((a.sourceFrac > 0 || a.mutateFrac > 0) && !a.source) {
        console.error('--source is required when source or mutation positions are requested');
        process.exit(1);
    }
    if (a.positions < 0 || a.mutateMax < 1) {
        console.error('--positions must be non-negative and --mutate-max at least 1');
        process.exit(1);
    }
    return a;
}

function rngFrom(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6D2B79F5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const ri = (rng, n) => (rng() * n) | 0;

function sourceBoard(pool, rng) {
    if (Array.isArray(pool)) pool = pool[ri(rng, pool.length)];
    const at = ri(rng, pool.length / 25) * 25;
    return pool.slice(at, at + 25);
}

function mutate(pool, rng, maxChanges) {
    const cells = sourceBoard(pool, rng);
    let maxGen = 3;
    for (let k = 0; k < 25; k++) if (cells[k] > 3) { maxGen = 4; break; }
    const changes = 1 + ri(rng, maxChanges);
    for (let n = 0; n < changes; n++) {
        const k = ri(rng, 25);
        // Sixes are deliberately much more common than in the generator: this
        // makes new sealed boundaries and endgames absent from ordinary play.
        cells[k] = rng() < 0.22 ? 6 : 1 + ri(rng, maxGen);
    }
    return cells;
}

function iid(rng) {
    const cells = new Uint8Array(25);
    const maxGen = rng() < 0.65 ? 4 : 3;
    for (let k = 0; k < 25; k++) cells[k] = 1 + ri(rng, maxGen);
    const sixes = ri(rng, 16);
    for (let n = 0; n < sixes; n++) {
        let k = ri(rng, 25);
        while (cells[k] === 6) k = ri(rng, 25);
        cells[k] = 6;
    }
    return cells;
}

function spatial(rng) {
    const cells = new Uint8Array(25);
    const maxGen = rng() < 0.65 ? 4 : 3;
    // Grow correlated material in scan order, producing bands, blobs and
    // corner structures while remaining independent of any bot policy.
    for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++) {
        const k = i * 5 + j;
        const candidates = [];
        if (i > 0) candidates.push(k - 5);
        if (j > 0) candidates.push(k - 1);
        cells[k] = candidates.length && rng() < 0.7
            ? cells[candidates[ri(rng, candidates.length)]] : 1 + ri(rng, maxGen);
    }
    // Random rectangles of sixes create long barriers that are especially
    // rare under strong play, including deliberately awkward interior walls.
    if (rng() < 0.8) {
        const x0 = ri(rng, 5), y0 = ri(rng, 5);
        const w = 1 + ri(rng, 5 - x0), h = 1 + ri(rng, 5 - y0);
        for (let i = x0; i < x0 + w; i++) for (let j = y0; j < y0 + h; j++)
            if (rng() < 0.75) cells[i * 5 + j] = 6;
    }
    return cells;
}

function main() {
    const args = parseArgs(process.argv), rng = rngFrom(args.seed);
    // Multiple comma-separated pools are sampled uniformly by pool first, so a
    // small high-value blindspot corpus is not drowned by a large human pool.
    const pool = args.source
        ? args.source.split(',').filter(Boolean).map(file => Starts.load(file)) : null;
    if (pool && pool.some(p => p.length === 0)) {
        console.error('every --source pool must contain at least one position');
        process.exit(1);
    }
    const positions = [], counts = { source: 0, mutated: 0, iid: 0, spatial: 0 };
    let rejected = 0;
    while (positions.length < args.positions) {
        const q = rng();
        let cells, mode;
        if (q < args.sourceFrac) { cells = sourceBoard(pool, rng); mode = 'source'; }
        else if (q < args.sourceFrac + args.mutateFrac) {
            cells = mutate(pool, rng, args.mutateMax); mode = 'mutated';
        } else if (q < args.sourceFrac + args.mutateFrac + args.iidFrac) {
            cells = iid(rng); mode = 'iid';
        } else { cells = spatial(rng); mode = 'spatial'; }
        if (Collapse.fromCells(cells, args.seed + positions.length).gameOver) { rejected++; continue; }
        positions.push(cells); counts[mode]++;
    }
    Starts.save(args.out, positions);

    const sixHist = new Array(26).fill(0);
    for (const cells of positions) {
        let n = 0;
        for (let k = 0; k < 25; k++) if (cells[k] === 6) n++;
        sixHist[n]++;
    }
    console.log('saved ' + positions.length.toLocaleString() + ' positions to ' + args.out);
    console.log(Object.entries(counts).map(([k, n]) => k + '=' + n.toLocaleString()).join('  ') +
        '  rejected-terminal=' + rejected.toLocaleString());
    console.log('6-count: ' + sixHist.map((n, k) => n ? k + ':' + (100 * n / positions.length).toFixed(1) + '%' : '')
        .filter(Boolean).join('  '));
}

if (require.main === module) main();
module.exports = { rngFrom, mutate, iid, spatial };
