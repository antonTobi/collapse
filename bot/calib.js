#!/usr/bin/env node
// ============================================================================
// Is the value network's *number* right, not just its ranking?
//
//   node bot/calib.js --weights bot/weights/dom21q.bin --positions bot/data/human-test.bin
//   node bot/calib.js --weights W --positions P --moves 3      (delta calibration)
//
// residual.js measures self-consistency: whether one Bellman backup would move
// V. A network can be perfectly self-consistent and still wrong, because the
// residual is zero at *any* fixed point of its own bootstrap. The only ground
// truth is to play the position out, so this rolls out.
//
// Two questions, and the second is the one an analysis UI actually asks.
//
//   level   V's estimate of the points left from here, against the mean of R
//           greedy rollouts. Answers "expected final score" claims.
//   delta   (--moves K) the top K moves are each rolled out, so the true cost
//           of playing move k instead of move 1 is known. That is exactly the
//           "this move loses X points" quantity, and it is not the same
//           question as the level: a bias shared by every move cancels out of
//           a delta, and a bias that grows with move rank does not.
//
// Rollouts share their refill seed across the moves of one position (common
// random numbers), which correlates the arms and shrinks the error on the
// *difference* far below the error on either arm.
//
// Monte Carlo noise is subtracted rather than ignored. With R rollouts the
// measured mean square error is (true error)^2 + (MC standard error)^2, and
// the second term is estimable from the rollout spread, so the report gives
// both the raw and the corrected number. Without that correction a small
// sample makes every network look equally bad.
//
// The rollout policy is the network's own greedy policy by default, which is
// what V was trained to predict -- the right check for "is V internally
// truthful". It is the WRONG thing for comparing two networks, because it moves
// the ground truth with the candidate: a network that plays differently squanders
// an advantage differently, so the true cost of a move changes underneath the
// measurement. Measured, that is not a small effect -- the same 250 positions
// gave a true rank-2 loss of 18.2 under one candidate's rollouts and 75.0 under
// another's.
//
// `--rollout-weights` pins the continuation to a fixed reference network, which
// is what any cross-network comparison must use. It also asks a slightly better
// question: a user wants to know what a move costs under *good* play, not under
// the analysis network's own play.
// ============================================================================

const Collapse = require('./engine.js');
const Search = require('./search.js');
const NTuple = require('./ntuple.js');
const Starts = require('./starts.js');

function parseArgs(argv) {
    const a = {
        weights: 'bot/weights/dom21q.bin', positions: null, sample: 80, rolloutWeights: null,
        rollouts: 16, moves: 0, seedBase: 800000, maxMoves: 20000, games: 8, every: 40,
        depth: 1, cap: 64, crn: false
    };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--weights') a.weights = argv[++i];
        else if (k === '--rollout-weights') a.rolloutWeights = argv[++i];
        else if (k === '--depth') a.depth = parseInt(argv[++i], 10);
        else if (k === '--cap') a.cap = parseInt(argv[++i], 10);
        // Seeds the chance sampling from the position itself: every move at a
        // position meets the same refills, which is the same common-random-
        // numbers trick the rollouts use, applied to the search. It shrinks the
        // variance of the *difference* between two moves, which is the number
        // being displayed, and makes a review reproducible.
        else if (k === '--crn') a.crn = true;
        else if (k === '--positions') a.positions = argv[++i];
        else if (k === '--sample') a.sample = parseInt(argv[++i], 10);
        else if (k === '--rollouts') a.rollouts = parseInt(argv[++i], 10);
        else if (k === '--moves') a.moves = parseInt(argv[++i], 10);
        else if (k === '--seed-base') a.seedBase = parseInt(argv[++i], 10);
        else if (k === '--games') a.games = parseInt(argv[++i], 10);
        else if (k === '--every') a.every = parseInt(argv[++i], 10);
        else { console.error('unknown option ' + k); process.exit(1); }
    }
    return a;
}

// Greedy playout, written against the expander rather than an agent object:
// this is the inner loop and it runs tens of millions of times.
function rollout(net, expander, cells, seed, maxMoves) {
    const game = Collapse.fromCells(cells, seed);
    // `cells` is an AFTERSTATE: the move has been applied and the collapsed
    // cells are holes, but the random refill has not happened yet. It has to
    // happen before the first move is chosen, or the rollout picks its move on a
    // board with holes in it -- which penalises exactly the moves that collapsed
    // the most tiles, i.e. the strong ones. Left out, this made the measured
    // "true loss" of the bot's own preferred move NEGATIVE on average.
    game.refill();
    game.gameOver = !game.hasLegalMove();
    while (!game.gameOver && game.moves.length < maxMoves) {
        const nm = expander.expand(game.cells, game.maxGen);
        if (nm === 0) break;
        let bv = -Infinity, bs = 0;
        for (let s = 0; s < nm; s++) {
            const v = expander.gain(s) + net.value(expander.board(s));
            if (v > bv) { bv = v; bs = s; }
        }
        const c = expander.cell(bs);
        game.apply((c / Collapse.H) | 0, c % Collapse.H);
    }
    return game.score;
}

function meanVar(xs) {
    const n = xs.length;
    let m = 0; for (const x of xs) m += x; m /= n;
    let v = 0; for (const x of xs) v += (x - m) * (x - m);
    return { mean: m, var: n > 1 ? v / (n - 1) : 0 };
}

// Positions: either a stored pool or the network's own greedy trajectory, so
// the same tool reports on-distribution and off-distribution calibration.
function collect(net, expander, args) {
    const out = [];
    if (args.positions) {
        const pool = Starts.load(args.positions);
        const total = pool.length / 25;
        const step = Math.max(1, Math.floor(total / args.sample));
        for (let at = 0; at < total && out.length < args.sample; at += step) {
            const cells = pool.slice(at * 25, at * 25 + 25);
            const g = Collapse.fromCells(cells, 1);
            if (!g.gameOver && g.countLegalMoves() >= 2) out.push(cells);
        }
        return out;
    }
    for (let s = 0; s < args.games && out.length < args.sample; s++) {
        const game = new Collapse.Game(args.seedBase + s);
        let step = 0;
        while (!game.gameOver && out.length < args.sample) {
            if (step % args.every === 0 && game.countLegalMoves() >= 2) out.push(game.cells.slice());
            const nm = expander.expand(game.cells, game.maxGen);
            if (nm === 0) break;
            let bv = -Infinity, bs = 0;
            for (let k = 0; k < nm; k++) {
                const v = expander.gain(k) + net.value(expander.board(k));
                if (v > bv) { bv = v; bs = k; }
            }
            const c = expander.cell(bs);
            game.apply((c / Collapse.H) | 0, c % Collapse.H);
            step++;
        }
    }
    return out;
}

const SIX_EDGES = [3, 6, 9, 12];
const sixBucket = n => { let b = 0; for (const e of SIX_EDGES) if (n >= e) b++; return b; };
const BUCKETS = SIX_EDGES.map((e, k) => (k ? SIX_EDGES[k - 1] : 0) + '-' + (e - 1))
    .concat([SIX_EDGES[SIX_EDGES.length - 1] + '+']);

function main() {
    const args = parseArgs(process.argv);
    const net = NTuple.load(args.weights);
    // The network being judged and the network that plays the continuation are
    // two different roles. They are the same object unless --rollout-weights
    // says otherwise.
    const roller = args.rolloutWeights && args.rolloutWeights !== args.weights
        ? NTuple.load(args.rolloutWeights) : net;
    const expander = Search.makeExpander();
    const positions = collect(net, expander, args);

    // Per-position level calibration, and optionally per-move delta.
    const lvl = BUCKETS.map(() => ({ n: 0, bias: 0, se2: 0, err2: 0 }));
    const dlt = [];              // one entry per (position, rank) pair, rank >= 2
    let nRoll = 0;

    // At depth 1 a move is scored gain + V(afterstate). At depth > 1 it is
    // scored by the searcher, which is gain + V + the residual -- the whole
    // point being that the residual is exactly the error measured above, so a
    // deeper score should be better calibrated with no retraining at all.
    // rootk/topk are off so every move gets the deep treatment.
    let sd = 20260824;
    const srng = () => { sd ^= sd << 13; sd >>>= 0; sd ^= sd >>> 17; sd ^= sd << 5; sd >>>= 0; return sd / 4294967296; };
    const searcher = args.depth > 1
        ? Search.makeSearcher(net, { depth: args.depth, cap: args.cap, capDeep: args.cap, topk: 0, rootk: 0, rng: srng, crn: args.crn })
        : null;

    positions.forEach((cells, p) => {
        const game = Collapse.fromCells(cells, 1);
        const legal = game.legalMoves();
        const deep = searcher ? new Map(searcher.scoreMoves(game).map(d => [d.move[0] + ',' + d.move[1], d.value])) : null;
        const cand = [];
        for (const m of legal) {
            const after = game.preview(m[0], m[1], Collapse.FILL_NONE);
            const gain = after.score - game.score;
            cand.push({
                q: deep ? deep.get(m[0] + ',' + m[1]) : gain + net.value(after.cells),
                cells: after.cells.slice(), gain
            });
        }
        cand.sort((x, y) => y.q - x.q);

        // How many moves to roll out: 1 (level only) or the top K.
        const k = args.moves ? Math.min(args.moves, cand.length) : 1;
        const arms = [];
        for (let m = 0; m < k; m++) {
            const xs = [];
            for (let r = 0; r < args.rollouts; r++) {
                // Common random numbers: the seed depends on the position and
                // the rollout index, NOT on which move -- so every arm meets
                // the same stream and the difference between arms is far less
                // noisy than either arm alone.
                const seed = args.seedBase + p * 8191 + r * 17;
                xs.push(cand[m].gain + rollout(roller, expander, cand[m].cells, seed, args.maxMoves));
                nRoll++;
            }
            arms.push(Object.assign(meanVar(xs), { pred: cand[m].q, xs }));
        }

        let sixes = 0; for (let c = 0; c < 25; c++) if (cells[c] === 6) sixes++;
        const b = lvl[sixBucket(sixes)];
        const e = arms[0].pred - arms[0].mean;
        b.n++; b.bias += e; b.err2 += e * e; b.se2 += arms[0].var / args.rollouts;

        for (let m = 1; m < arms.length; m++) {
            // Paired difference, per rollout, so the CRN correlation is used.
            const d = arms[0].xs.map((x, r) => x - arms[m].xs[r]);
            const mv = meanVar(d);
            dlt.push({
                rank: m + 1, pred: arms[0].pred - arms[m].pred,
                actual: mv.mean, se2: mv.var / args.rollouts
            });
        }
    });

    const rms = (err2, se2, n) => ({
        raw: Math.sqrt(err2 / n),
        corrected: Math.sqrt(Math.max(0, err2 / n - se2 / n))
    });

    console.log(args.weights + '   ' + (args.positions || 'greedy trajectory') +
        (args.depth > 1 ? '   scored at depth ' + args.depth + ' cap ' + args.cap + (args.crn ? ' crn' : '') : '   scored at depth 1') +
        (roller === net ? '   rollouts: own policy' : '   rollouts: ' + args.rolloutWeights) +
        '   ' + positions.length + ' positions x ' + args.rollouts + ' rollouts' +
        (args.moves ? ' x ' + args.moves + ' moves' : '') + '  (' + nRoll.toLocaleString() + ' games)');

    console.log('  LEVEL  V(best move) against the mean rollout from here');
    console.log('    ' + '6s'.padEnd(8) + 'n'.padStart(6) + 'bias'.padStart(10) + 'rms'.padStart(10) + 'rms-MC'.padStart(10));
    let tn = 0, tb = 0, te = 0, ts = 0;
    lvl.forEach((b, k) => {
        if (!b.n) return;
        const r = rms(b.err2, b.se2, b.n);
        console.log('    ' + BUCKETS[k].padEnd(8) + String(b.n).padStart(6) + (b.bias / b.n).toFixed(0).padStart(10) +
            r.raw.toFixed(0).padStart(10) + r.corrected.toFixed(0).padStart(10));
        tn += b.n; tb += b.bias; te += b.err2; ts += b.se2;
    });
    if (tn) {
        const r = rms(te, ts, tn);
        console.log('    ' + 'all'.padEnd(8) + String(tn).padStart(6) + (tb / tn).toFixed(0).padStart(10) +
            r.raw.toFixed(0).padStart(10) + r.corrected.toFixed(0).padStart(10));
    }

    if (dlt.length) {
        console.log('  DELTA  "this move loses X" -- predicted gap to move 1 against the rolled-out gap');
        console.log('    ' + 'rank'.padEnd(8) + 'n'.padStart(6) + 'pred'.padStart(10) + 'actual'.padStart(10) +
            'over'.padStart(10) + 'rms-MC'.padStart(10) + 'corr'.padStart(8) + 'corr*'.padStart(8) +
            'slope'.padStart(8) + 'rms@fit'.padStart(9));
        const ranks = [...new Set(dlt.map(d => d.rank))].sort((a, b) => a - b);
        for (const rk of ranks) {
            const rows = dlt.filter(d => d.rank === rk);
            const n = rows.length;
            const pred = rows.reduce((a, d) => a + d.pred, 0) / n;
            const act = rows.reduce((a, d) => a + d.actual, 0) / n;
            const err2 = rows.reduce((a, d) => a + (d.pred - d.actual) * (d.pred - d.actual), 0);
            const se2 = rows.reduce((a, d) => a + d.se2, 0);
            // Does the reported loss *track* the real loss, position by
            // position? A tool can be unbiased on average and still rank the
            // severity of mistakes at random, which is the failure a user
            // would notice first.
            //
            // The raw correlation understates badly, because the y it is
            // measured against is itself a noisy R-rollout estimate. The
            // attenuation factor is sqrt(reliability), reliability being the
            // share of the observed spread in y that is real, so `corr*`
            // divides it back out. Report both: corr is what was seen, corr*
            // is the estimate of what would be seen with infinite rollouts.
            let sxy = 0, sxx = 0, syy = 0;
            for (const d of rows) {
                const x = d.pred - pred, y = d.actual - act;
                sxy += x * y; sxx += x * x; syy += y * y;
            }
            const corr = sxy / Math.sqrt(sxx * syy);
            const rel = Math.max(0, (syy / n - se2 / n) / (syy / n));
            // Least-squares slope of truth on prediction. If the network
            // exaggerates differences this is well below 1, and multiplying the
            // displayed number by it is the best possible display-time fix: a
            // positive scalar is monotone, so it cannot change which move is
            // recommended, and it cannot make the magnitude worse in the mean
            // square sense. `rms@fit` is what the error becomes after applying
            // it, against `rms-MC` before.
            const slope = sxy / sxx;
            let fit2 = 0;
            for (const d of rows) {
                const e = (act + slope * (d.pred - pred)) - d.actual;
                fit2 += e * e;
            }
            console.log('    ' + String(rk).padEnd(8) + String(n).padStart(6) + pred.toFixed(1).padStart(10) +
                act.toFixed(1).padStart(10) + (pred - act).toFixed(1).padStart(10) +
                Math.sqrt(Math.max(0, err2 / n - se2 / n)).toFixed(1).padStart(10) +
                corr.toFixed(3).padStart(8) +
                (rel > 0 ? (corr / Math.sqrt(rel)).toFixed(3) : 'n/a').padStart(8) +
                slope.toFixed(3).padStart(8) +
                Math.sqrt(Math.max(0, fit2 / n - se2 / n)).toFixed(1).padStart(9));
        }
        console.log('    (`over` > 0 means the tool would tell the user the move costs more than it does;');
        console.log('     `slope` < 1 means it exaggerates, and `rms@fit` is the error after rescaling by it.');
        console.log('     The slope is fitted on these same rows, so fit it on a training pool before believing it.)');
    }
}

if (require.main === module) main();
