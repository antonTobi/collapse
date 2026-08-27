#!/usr/bin/env node
// ============================================================================
// Value calibration and playing strength on mutated (OOD) start positions.
//
//   node bot/predcal.js --nets bot/weights/mini5-ep1500000-annealed.bin,bot/weights/dom39h.bins \
//                       --positions 500 --seed 999 --jobs 8
//
// For each net and each mutated position P (a regular opening with 1..10 tiles
// replaced by 5/6, same scheme as bot/mutstarts.js, but a held-out seed):
//   predicted = the greedy agent's own value of P
//             = max over legal moves of  gain + V(afterstate)   (FILL_NONE),
//               i.e. its estimate of the total remaining score  -- identical to
//               the `td` agent in agents.js.
//   actual    = play greedily from P to the end and take the final score.
//
// Reports, per net: mean predicted, mean actual, bias (pred-actual), RMSE and
// Pearson correlation of predicted vs actual (calibration); mean actual is the
// playing strength on these positions. The paired actual difference shows which
// net plays the SAME mutated positions better.
// ============================================================================

const path = require('path');
const NTuple = require('./ntuple.js');
const Collapse = require('./engine.js');
const { FILL_NONE } = Collapse;
const { mutatedStart, rngFrom } = require('./mutstarts.js');

function parseArgs(argv) {
    const a = { nets: null, positions: 500, seed: 999, seedBase: 8000000, nMax: 10, jobs: 8 };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--nets') a.nets = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
        else if (k === '--positions') a.positions = parseInt(argv[++i], 10);
        else if (k === '--seed') a.seed = parseInt(argv[++i], 10);
        else if (k === '--seed-base') a.seedBase = parseInt(argv[++i], 10);
        else if (k === '--n-max') a.nMax = parseInt(argv[++i], 10);
        else if (k === '--jobs') a.jobs = parseInt(argv[++i], 10);
        else { console.error('unknown option ' + k); process.exit(1); }
    }
    if (!a.nets) { console.error('--nets a.bin,b.bin is required'); process.exit(1); }
    return a;
}

// Greedy value of `game`: max over legal moves of gain + V(afterstate), plus the
// chosen move. Matches the `td` agent (agents.js).
function greedyEval(net, game) {
    let best = null, bq = -Infinity;
    for (const [i, j] of game.legalMoves()) {
        const after = game.preview(i, j, FILL_NONE);
        const q = (after.score - game.score) + net.value(after.cells);
        if (q > bq) { bq = q; best = [i, j]; }
    }
    return { move: best, q: bq };
}

// --- worker: one net over a slice of (board, seed) pairs -------------------
if (process.env.COLLAPSE_PREDCAL_WORKER) {
    process.on('message', ({ netFile, boards, seeds }) => {
        const net = NTuple.load(netFile);
        const pred = [], actual = [];
        boards.forEach((arr, n) => {
            const cells = Uint8Array.from(arr), seed = seeds[n];
            pred.push(greedyEval(net, Collapse.fromCells(cells, seed)).q);
            const g = Collapse.fromCells(cells, seed);   // fresh copy; refills seeded per position
            while (!g.gameOver && g.moves.length < 20000) {
                const m = greedyEval(net, g).move;
                if (!m) break;
                g.apply(m[0], m[1]);
            }
            actual.push(g.score);
        });
        process.send({ pred, actual });
        process.exit(0);
    });
    return;
}

const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const se = a => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / (a.length - 1) / a.length); };
function corr(x, y) {
    const n = x.length, mx = mean(x), my = mean(y);
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
    return sxy / Math.sqrt(sxx * syy);
}

function makePositions(count, seed, seedBase, nMax) {
    const rng = rngFrom(seed);
    const out = [];
    let attempts = 0;
    while (out.length < count) {
        const cells = mutatedStart(seedBase + attempts, rng, nMax);
        attempts++;
        if (cells) out.push(cells);
    }
    return out;
}

// Each position keeps a fixed seed = seedBase + its global index, so predicted
// and actual are stable and shared across nets regardless of job sharding.
async function evalNet(netFile, boards, seedBase, jobs) {
    const { fork } = require('child_process');
    const chunks = Array.from({ length: jobs }, () => []);
    boards.forEach((b, k) => chunks[k % jobs].push({ arr: Array.from(b), seed: seedBase + k, idx: k }));
    const pred = new Array(boards.length), actual = new Array(boards.length);
    await Promise.all(chunks.map(chunk => new Promise((resolve, reject) => {
        if (!chunk.length) return resolve();
        const child = fork(__filename, [], { env: Object.assign({}, process.env, { COLLAPSE_PREDCAL_WORKER: '1' }) });
        child.on('message', ({ pred: p, actual: aa }) => {
            chunk.forEach((c, n) => { pred[c.idx] = p[n]; actual[c.idx] = aa[n]; });
            resolve();
        });
        child.on('error', reject);
        child.send({ netFile, boards: chunk.map(c => c.arr), seeds: chunk.map(c => c.seed) });
    })));
    return { pred, actual };
}

async function main() {
    const args = parseArgs(process.argv);
    const boards = makePositions(args.positions, args.seed, args.seedBase, args.nMax);
    console.log(args.positions + ' held-out mutated positions (seed ' + args.seed + ')\n');
    console.log('  ' + 'net'.padEnd(40) + 'meanPred'.padStart(9) + 'meanActual'.padStart(11) +
        'bias'.padStart(8) + 'RMSE'.padStart(8) + 'corr'.padStart(7));
    console.log('  ' + '-'.repeat(83));

    const results = {};
    for (const netFile of args.nets) {
        const { pred, actual } = await evalNet(netFile, boards, args.seedBase, args.jobs);
        results[netFile] = { pred, actual };
        const diff = pred.map((p, i) => p - actual[i]);
        const rmse = Math.sqrt(mean(diff.map(d => d * d)));
        console.log('  ' + path.basename(netFile).padEnd(40) +
            mean(pred).toFixed(0).padStart(9) + mean(actual).toFixed(0).padStart(11) +
            mean(diff).toFixed(0).padStart(8) + rmse.toFixed(0).padStart(8) +
            corr(pred, actual).toFixed(3).padStart(7));
    }

    if (args.nets.length === 2) {
        const [A, B] = args.nets;
        const dActual = results[A].actual.map((v, i) => v - results[B].actual[i]);
        console.log('\n  greedy playing strength on these positions: ' + path.basename(A) + ' - ' +
            path.basename(B) + ' = ' + (mean(dActual) >= 0 ? '+' : '') + mean(dActual).toFixed(0) +
            ' ± ' + se(dActual).toFixed(0) + ' (paired)');
    }
}

if (require.main === module) main();
