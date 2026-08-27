#!/usr/bin/env node
// ============================================================================
// Starting positions for the from-scratch mini5 training run.
//
//   node bot/mutstarts.js --positions 200000 --out bot/data/mut-starts.bin
//
// Every position begins as a *regular* opening -- a fresh Collapse.Game, i.e.
// all 25 cells filled with 1s/2s/3s by the LCG seed. Each is then mutated:
// pick a random n in [1, n-max], choose n *distinct* cells, and replace each
// with a 5 or a 6 (50/50). This is the deliberately out-of-distribution half
// of training: boards with fragmented fives and sealed sixes the network would
// otherwise not see for hundreds of moves.
//
// The pool holds only the *mutated* boards. The unmutated regular half of
// training is supplied for free by ptrain's fresh Game(seed) episodes, so the
// intended 50/50 split is realised with `--start-frac 0.5`.
//
// Output is the shared CSTA pool format (bot/starts.js): one board = 25 raw
// bytes; maxGen is recovered from the board by Collapse.fromCells.
// ============================================================================

const path = require('path');
const Collapse = require('./engine.js');
const Starts = require('./starts.js');

// Same splitmix-style 32-bit generator as oodstarts.js, for reproducibility.
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

function parseArgs(argv) {
    const a = {
        positions: 200000,
        out: path.join(__dirname, 'data/mut-starts.bin'),
        seed: 7302026,
        seedBase: 5000000,
        nMax: 10
    };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--positions') a.positions = parseInt(argv[++i], 10);
        else if (k === '--out') a.out = argv[++i];
        else if (k === '--seed') a.seed = parseInt(argv[++i], 10);
        else if (k === '--seed-base') a.seedBase = parseInt(argv[++i], 10);
        else if (k === '--n-max') a.nMax = parseInt(argv[++i], 10);
        else { console.error('unknown option ' + k); process.exit(1); }
    }
    if (a.positions < 0) { console.error('--positions must be >= 0'); process.exit(1); }
    if (a.nMax < 1 || a.nMax > 25) { console.error('--n-max must be in [1, 25]'); process.exit(1); }
    return a;
}

// A regular opening with n distinct cells replaced by 5/6. Returns the cells,
// or null if the mutated board has no legal move (caller resamples).
function mutatedStart(gameSeed, rng, nMax) {
    const cells = new Collapse.Game(gameSeed).cells.slice();   // regular 1/2/3 board
    const n = 1 + ri(rng, nMax);                               // n in [1, nMax]
    // Partial Fisher-Yates over [0,25) to pick n *distinct* cells.
    const order = Array.from({ length: 25 }, (_, k) => k);
    for (let p = 0; p < n; p++) {
        const q = p + ri(rng, 25 - p);
        const tmp = order[p]; order[p] = order[q]; order[q] = tmp;
        cells[order[p]] = rng() < 0.5 ? 5 : 6;
    }
    if (Collapse.fromCells(cells, gameSeed).gameOver) return null;
    return cells;
}

function main() {
    const args = parseArgs(process.argv);
    const rng = rngFrom(args.seed);
    const positions = [];
    let attempts = 0;
    while (positions.length < args.positions) {
        const cells = mutatedStart(args.seedBase + attempts, rng, args.nMax);
        attempts++;
        if (cells) positions.push(cells);
    }

    Starts.save(args.out, positions);

    // 6-count histogram, matching starts.js/oodstarts.js reporting.
    const hist = new Array(20).fill(0);
    let mutSum = 0;
    for (const c of positions) {
        let sixes = 0, muts = 0;
        for (let k = 0; k < 25; k++) { if (c[k] === 6) sixes++; if (c[k] === 5 || c[k] === 6) muts++; }
        hist[sixes]++; mutSum += muts;
    }
    console.log('saved ' + positions.length.toLocaleString() + ' mutated starts to ' + args.out +
        ' (' + ((8 + positions.length * 25) / 1048576).toFixed(1) + ' MB), ' +
        (attempts - positions.length).toLocaleString() + ' terminal boards rejected');
    console.log('mean 5/6 cells per board: ' + (mutSum / positions.length).toFixed(2) +
        ' (= mean n, uniform on [1,' + args.nMax + '])');
    console.log('6-count distribution:');
    console.log('  ' + hist.map((v, k) => v ? k + ':' + (100 * v / positions.length).toFixed(1) + '%' : null)
        .filter(Boolean).join('  '));
}

module.exports = { mutatedStart, rngFrom, ri };
if (require.main === module) main();
