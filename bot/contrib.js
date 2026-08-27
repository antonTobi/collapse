#!/usr/bin/env node
// ============================================================================
// Which tuples / features is the value net actually using?
//
//   node bot/contrib.js --net bot/weights/mini5-ep1500000-annealed.bin \
//                       --games 80 --starts bot/data/mut-starts.bin
//
// Two questions, measured over afterstates from the net's own greedy play:
//
//   magnitude   mean |contribution| of each tuple to V(afterstate). How much
//               weight the tuple carries on an absolute scale.
//   discrimination  at each decision the agent argmaxes over candidate moves;
//               a tuple only changes the choice if its contribution VARIES
//               across those candidates. So the decision-relevant number is the
//               std of a tuple's contribution across the sibling afterstates of
//               one decision, averaged over decisions. A tuple with high
//               magnitude but near-zero discrimination is a constant offset that
//               never moves a move.
//
// Also sweeps each global feature's bucket 0..max on the sampled boards and
// reports the resulting swing in V -- how much the net leans on each feature.
//
// Contributions are grouped by tuple category (run2/3/4, run5, square,
// pure-global, and hybrid:<feature>) so the categories can be compared directly.
// ============================================================================

const NTuple = require('./ntuple.js');
const Collapse = require('./engine.js');
const Starts = require('./starts.js');
const { FILL_NONE } = Collapse;

const V = 7, BOARD = 25;
const GNAMES = ['ZEROES', 'FIVES', 'SIXES', 'FIVE_COMP', 'EXPOSED', 'LEGAL', 'LEGAL_NO6',
    'HEIGHT0', 'HEIGHT1', 'HEIGHT2', 'HEIGHT3', 'HEIGHT4'];
const GMAX = [6, 6, 6, 3, 6, 6, 6, 5, 5, 5, 5, 5];

function parseArgs(argv) {
    const a = { net: null, games: 80, starts: null, startFrac: 0.5, seedBase: 6000000, maxDecisions: 6000, seed: 424242 };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--net') a.net = argv[++i];
        else if (k === '--games') a.games = parseInt(argv[++i], 10);
        else if (k === '--starts') a.starts = argv[++i];
        else if (k === '--start-frac') a.startFrac = parseFloat(argv[++i]);
        else if (k === '--max-decisions') a.maxDecisions = parseInt(argv[++i], 10);
        else if (k === '--seed') a.seed = parseInt(argv[++i], 10);
        else { console.error('unknown option ' + k); process.exit(1); }
    }
    if (!a.net) { console.error('--net is required'); process.exit(1); }
    return a;
}

// Classify tuple k by its cells: pure shape (by length / square) or global.
function classify(t, k) {
    const o = t.off[k], l = t.len[k];
    const cells = [];
    for (let c = 0; c < l; c++) cells.push(t.cells[o + c]);
    const globals = cells.filter(x => x >= BOARD);
    if (globals.length === l) return 'pure-global';
    if (globals.length > 0) { const g = GNAMES[globals[0] - BOARD]; return 'hybrid:' + (g.startsWith('HEIGHT') ? 'HEIGHT' : g); }
    if (l === 2) return 'run2';
    if (l === 3) return 'run3';
    if (l === 5) return 'run5';
    // length 4: run4 (colinear) vs square (2 rows x 2 cols)
    const rows = new Set(cells.map(x => x % 5)), cols = new Set(cells.map(x => (x / 5) | 0));
    return (rows.size === 1 || cols.size === 1) ? 'run4' : 'square';
}

// Per-tuple contributions on a prepared feature array (sym, no selfOnce, 1 bank).
function contribs(net, prepared, out) {
    const t = net.t, w = net.w;
    for (let k = 0; k < t.n; k++) {
        const o = t.off[k], l = t.len[k], b = t.wbase[k];
        let a = 0, m = 0;
        for (let c = 0; c < l; c++) { a = a * V + prepared[t.cells[o + c]]; m = m * V + prepared[t.mcells[o + c]]; }
        out[k] = w[b + a] + w[b + m];
    }
}

function greedyBest(net, game) {
    let best = null, bq = -Infinity;
    for (const [i, j] of game.legalMoves()) {
        const after = game.preview(i, j, FILL_NONE);
        const q = (after.score - game.score) + net.value(after.cells);
        if (q > bq) { bq = q; best = [i, j]; }
    }
    return best;
}

function xorshift(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; }; }

function main() {
    const args = parseArgs(process.argv);
    const net = NTuple.load(args.net);
    const t = net.t, n = t.n;
    const cat = Array.from({ length: n }, (_, k) => classify(t, k));

    const pool = args.starts ? Starts.load(args.starts) : null;
    const poolN = pool ? pool.length / 25 : 0;
    const rng = xorshift(args.seed);

    // Accumulators.
    const magSum = new Float64Array(n);        // sum |contribution| (chosen afterstate)
    let magCount = 0;
    const discSum = new Float64Array(n);        // sum of per-decision std of contribution
    let discCount = 0;
    const featSwing = new Float64Array(GNAMES.length); // sum of V range over each feature sweep
    let featCount = 0;

    const cChosen = new Float64Array(n);
    const cand = new Float64Array(n);
    const prepared = new Uint8Array(net.featureInput ? net.featureInput.length : 25);

    let decisions = 0, g = 0;
    while (decisions < args.maxDecisions) {
        let game;
        if (poolN && rng() < args.startFrac) {
            const at = ((rng() * poolN) | 0) * 25;
            game = Collapse.fromCells(pool.subarray(at, at + 25), args.seedBase + g);
        } else game = new Collapse.Game(args.seedBase + g);
        g++;

        while (!game.gameOver && decisions < args.maxDecisions) {
            const moves = game.legalMoves();
            if (moves.length === 0) break;
            // Candidate afterstates.
            const afters = moves.map(([i, j]) => game.preview(i, j, FILL_NONE));
            // Per-tuple contribution across candidates -> discrimination + pick best.
            let bestIdx = 0, bestQ = -Infinity;
            const perTuple = afters.map(() => null);
            const mean = new Float64Array(n), meanSq = new Float64Array(n);
            afters.forEach((after, ci) => {
                const prep = net.prepare(after.cells);           // returns net.featureInput
                for (let x = 0; x < prep.length; x++) prepared[x] = prep[x];
                contribs(net, prepared, cand);
                const c = cand.slice();
                perTuple[ci] = c;
                let q = after.score - game.score;
                for (let k = 0; k < n; k++) { q += c[k]; mean[k] += c[k]; meanSq[k] += c[k] * c[k]; }
                if (q > bestQ) { bestQ = q; bestIdx = ci; }
            });
            const nc = afters.length;
            if (nc >= 2) {
                for (let k = 0; k < n; k++) {
                    const mu = mean[k] / nc, varr = Math.max(0, meanSq[k] / nc - mu * mu);
                    discSum[k] += Math.sqrt(varr);
                }
                discCount++;
            }
            // Magnitude from the chosen afterstate.
            const chosen = perTuple[bestIdx];
            for (let k = 0; k < n; k++) magSum[k] += Math.abs(chosen[k]);
            magCount++;

            // Global-feature sensitivity on the chosen afterstate.
            if (net.featureInput) {
                const prep = net.prepare(afters[bestIdx].cells);
                for (let x = 0; x < prep.length; x++) prepared[x] = prep[x];
                for (let f = 0; f < GNAMES.length; f++) {
                    const orig = prepared[BOARD + f];
                    let lo = Infinity, hi = -Infinity;
                    for (let val = 0; val <= GMAX[f]; val++) {
                        prepared[BOARD + f] = val;
                        contribs(net, prepared, cand);
                        let v = 0; for (let k = 0; k < n; k++) v += cand[k];
                        if (v < lo) lo = v; if (v > hi) hi = v;
                    }
                    prepared[BOARD + f] = orig;
                    featSwing[f] += hi - lo;
                }
                featCount++;
            }

            decisions++;
            game.apply(moves[bestIdx][0], moves[bestIdx][1]);
        }
    }

    // Aggregate by category.
    const cats = {};
    for (let k = 0; k < n; k++) {
        const c = cat[k];
        if (!cats[c]) cats[c] = { count: 0, mag: 0, disc: 0 };
        cats[c].count++;
        cats[c].mag += magSum[k] / magCount;
        cats[c].disc += discSum[k] / discCount;
    }

    console.log('\n' + args.net);
    console.log(decisions + ' decisions over ' + g + ' greedy games ' +
        (pool ? '(' + (100 * args.startFrac).toFixed(0) + '% from ' + args.starts + ')' : '') + '\n');

    const order = ['run2', 'run3', 'run4', 'run5', 'square', 'pure-global',
        'hybrid:ZEROES', 'hybrid:FIVES', 'hybrid:SIXES', 'hybrid:FIVE_COMP', 'hybrid:EXPOSED',
        'hybrid:LEGAL', 'hybrid:LEGAL_NO6', 'hybrid:HEIGHT'];
    console.log('  ' + 'category'.padEnd(16) + 'tuples'.padStart(7) + 'sum|contrib|'.padStart(13) +
        'per-tuple'.padStart(11) + 'sum-disc'.padStart(10) + 'per-tuple'.padStart(11));
    console.log('  ' + '-'.repeat(68));
    for (const c of order) {
        const s = cats[c]; if (!s) continue;
        console.log('  ' + c.padEnd(16) + String(s.count).padStart(7) +
            s.mag.toFixed(0).padStart(13) + (s.mag / s.count).toFixed(1).padStart(11) +
            s.disc.toFixed(1).padStart(10) + (s.disc / s.count).toFixed(2).padStart(11));
    }

    if (featCount) {
        console.log('\n  global-feature sensitivity (mean swing in V when bucket varies 0..max):');
        for (let f = 0; f < GNAMES.length; f++)
            console.log('    ' + GNAMES[f].padEnd(12) + (featSwing[f] / featCount).toFixed(1).padStart(8) + ' pts');
    }
    console.log('\n  (magnitude = absolute weight carried; discrimination = how much the tuple');
    console.log('   moves the choice between sibling moves -- the decision-relevant number.)');
}

if (require.main === module) main();
