#!/usr/bin/env node
// ============================================================================
// Does the review feature's "biggest mistakes" list contain real mistakes?
//
//   node bot/reveval.js --weights bot/weights/all7g-Rcq.bin --depth 2 --cap 16 --crn
//   node bot/reveval.js --weights bot/weights/all7g-Rcq.bin --depth 2 --cap 16 --crn
//
// This measures the thing spectate.html actually does, which is not what
// calib.js measures. calib.js prices the network's own 2nd and 3rd choices. The
// review prices the move a *human* played, which is usually much further down
// the order, and then shows the five positions with the largest predicted loss.
//
// So the question is a ranking question over positions, not a calibration
// question over moves:
//
//   the list   mean TRUE loss of the positions the UI would list, against the
//              mean over all positions. Selection is by the prediction, which is
//              deterministic, so this mean is unbiased.
//   the curve  mean true loss bucketed by predicted loss. "If the UI says 300,
//              what is it really?" -- also unbiased, same reason.
//   corr       predicted against true loss over all positions.
//
// What is NOT reported, deliberately: recall against the top-N by *true* loss,
// and the mean true loss of the ones the list missed. Selecting on a noisy
// measurement and then reporting that measurement is selection-on-noise --  the
// top-N by measured truth are mostly the positions whose noise came out high,
// and their mean is inflated by construction. An early version printed
// "mean true loss of a missed one: 492" for a set whose real mean is nothing
// like that.
//
// Per-position truth is expensive here. One move's real effect on a final score
// is small next to the spread of a game (sd ~1500), and common random numbers
// stop helping as soon as the two lines diverge, so resolving a single position
// to +-25 points would need on the order of 1600 rollout pairs. The population
// statistics above need far less, which is why they are the ones reported.
//
// True loss is Monte Carlo: roll out the reviewer's preferred move and the move
// actually played, and difference them. Both arms share their refill seeds
// (common random numbers), so the *difference* is far less noisy than either
// arm -- which matters, because the difference is the whole quantity.
//
// The rollout policy is a fixed reference network, never the candidate, so that
// two candidates are judged against the same ground truth. See the note in
// calib.js: letting the candidate roll out its own continuation moves the truth
// underneath the measurement by more than the effect being measured.
//
// Positions come from held-out human games -- the same 1-in-10 split hstarts.js
// uses, so a network trained on the training pool has never seen these.
// ============================================================================

const Collapse = require('./engine.js');
const Search = require('./search.js');
const NTuple = require('./ntuple.js');
const Replays = require('./replays.js');

function parseArgs(argv) {
    const a = {
        weights: 'bot/weights/all7g-Rcq.bin', rolloutWeights: 'bot/weights/all7g-Rcq.bin',
        depth: 2, cap: 16, crn: false, games: 20, every: 8, rollouts: 16,
        top: 5, threshold: 25, seedBase: 810000, maxMoves: 20000, holdout: 10, minScore: 0
    };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--weights') a.weights = argv[++i];
        else if (k === '--rollout-weights') a.rolloutWeights = argv[++i];
        else if (k === '--depth') a.depth = parseInt(argv[++i], 10);
        else if (k === '--cap') a.cap = parseInt(argv[++i], 10);
        else if (k === '--crn') a.crn = true;
        else if (k === '--games') a.games = parseInt(argv[++i], 10);
        else if (k === '--every') a.every = parseInt(argv[++i], 10);
        else if (k === '--rollouts') a.rollouts = parseInt(argv[++i], 10);
        else if (k === '--top') a.top = parseInt(argv[++i], 10);
        else if (k === '--threshold') a.threshold = parseFloat(argv[++i]);
        else if (k === '--seed-base') a.seedBase = parseInt(argv[++i], 10);
        else { console.error('unknown option ' + k); process.exit(1); }
    }
    return a;
}

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

function mean(xs) { let m = 0; for (const x of xs) m += x; return m / xs.length; }
function variance(xs) {
    if (xs.length < 2) return 0;
    const m = mean(xs);
    let v = 0; for (const x of xs) v += (x - m) * (x - m);
    return v / (xs.length - 1);
}

function main() {
    const args = parseArgs(process.argv);
    const net = NTuple.load(args.weights);
    const roller = args.rolloutWeights === args.weights ? net : NTuple.load(args.rolloutWeights);
    const expander = Search.makeExpander();

    let sd = 20260824;
    const srng = () => { sd ^= sd << 13; sd >>>= 0; sd ^= sd >>> 17; sd ^= sd << 5; sd >>>= 0; return sd / 4294967296; };
    // topk/rootk off: a pruned root leaves most moves holding their depth-1
    // value, and the move a human played is usually outside the top few, so a
    // cliff would invent a mistake out of the depth difference alone.
    const searcher = args.depth > 1
        ? Search.makeSearcher(net, {
            depth: args.depth, cap: args.cap, capDeep: args.cap,
            topk: 0, rootk: 0, rng: srng, crn: args.crn
        })
        : null;

    const rows = Replays.load({ minScore: args.minScore });
    const test = rows.filter((_, k) => k % args.holdout === 0).slice(0, args.games);

    const perGame = [];
    let nPos = 0, nRoll = 0;

    for (const rec of test) {
        const here = [];
        let step = 0;
        Replays.walk(rec, ({ game, move }) => {
            if (step++ % args.every !== 0) return;
            const legal = game.legalMoves();
            if (legal.length < 2) return;

            // Score every legal move exactly as the review does.
            let scored;
            if (searcher) {
                scored = searcher.scoreMoves(game).map(d => ({ move: d.move, value: d.value }));
            } else {
                scored = legal.map(m => {
                    const after = game.preview(m[0], m[1], Collapse.FILL_NONE);
                    return { move: m, value: (after.score - game.score) + net.value(after.cells) };
                });
            }
            let best = scored[0];
            for (const s of scored) if (s.value > best.value) best = s;
            const played = scored.find(s => s.move[0] === move[0] && s.move[1] === move[1]);
            if (!played) return;
            here.push({
                pred: best.value - played.value,
                bestMove: best.move, playedMove: move,
                cells: game.cells.slice(), score: game.score
            });
        }, 2);
        if (here.length > args.top) { perGame.push(here); nPos += here.length; }
    }

    // Roll out both arms of every sampled position. Rolling out only the top
    // few by prediction would make prec@5 unmeasurable in the direction that
    // matters -- catching a real mistake the list *missed* needs the truth for
    // positions the list did not pick.
    let done = 0;
    for (const here of perGame) {
        for (const p of here) {
            const g = Collapse.fromCells(p.cells, 1);
            const arm = mv => {
                const after = g.preview(mv[0], mv[1], Collapse.FILL_NONE);
                return { cells: after.cells.slice(), gain: after.score - g.score };
            };
            const a = arm(p.bestMove), b = arm(p.playedMove);
            const diffs = [];
            for (let r = 0; r < args.rollouts; r++) {
                const seed = args.seedBase + (done * 8191 + r * 17);
                diffs.push((a.gain + rollout(roller, expander, a.cells, seed, args.maxMoves)) -
                           (b.gain + rollout(roller, expander, b.cells, seed, args.maxMoves)));
                nRoll += 2;
            }
            p.actual = mean(diffs);
            p.se2 = variance(diffs) / args.rollouts;
            done++;
        }
        process.stderr.write('  ' + done + ' / ' + nPos + ' positions rolled out\r');
    }
    process.stderr.write('\n');

    // --- ranking quality -----------------------------------------------------
    // Selection is by `pred`, which is a deterministic function of the position
    // and the config. That is what makes the mean of `actual` over a selected
    // set an unbiased estimate of that set's true mean.
    const picked = [], all = [];
    for (const here of perGame) {
        const byPred = here.slice().sort((x, y) => y.pred - x.pred).slice(0, args.top);
        picked.push(...byPred);
        all.push(...here);
    }

    const mp = mean(all.map(p => p.pred)), ma = mean(all.map(p => p.actual));
    let sxy = 0, sxx = 0, syy = 0, se2 = 0;
    for (const p of all) {
        const x = p.pred - mp, y = p.actual - ma;
        sxy += x * y; sxx += x * x; syy += y * y; se2 += p.se2;
    }
    const corr = sxy / Math.sqrt(sxx * syy);
    const rel = (syy / all.length - se2 / all.length) / (syy / all.length);
    const sePos = Math.sqrt(se2 / all.length);
    const seOf = set => Math.sqrt(set.reduce((a, p) => a + p.se2, 0)) / set.length;

    console.log(args.weights + '   depth ' + args.depth + ' cap ' + args.cap + (args.crn ? ' crn' : '') +
        '   rollouts: ' + args.rolloutWeights);
    console.log('  ' + perGame.length + ' held-out games, ' + all.length + ' positions, ' +
        nRoll.toLocaleString() + ' rollout games, ' + args.rollouts + ' pairs each');
    console.log('  per-position MC noise: +-' + sePos.toFixed(0) + ' points' +
        (rel <= 0 ? '  (larger than the whole spread of the truth -- single positions are unresolvable)' : ''));
    console.log('  corr(pred, true)  ' + corr.toFixed(3) +
        (rel > 0 ? '   disattenuated ' + (corr / Math.sqrt(rel)).toFixed(3) : '   (disattenuation undefined)'));
    console.log('');
    console.log('  THE LIST -- what the UI would show, top ' + args.top + ' per game');
    console.log('    mean true loss, listed     ' + mean(picked.map(p => p.actual)).toFixed(1) +
        ' +- ' + seOf(picked).toFixed(0) + '   (' + picked.length + ' entries)');
    console.log('    mean true loss, all        ' + ma.toFixed(1) +
        ' +- ' + seOf(all).toFixed(0));
    console.log('    mean predicted loss, listed ' + mean(picked.map(p => p.pred)).toFixed(1));
    console.log('');
    // Least-squares slope of truth on prediction, through the origin: a
    // displayed loss of X corresponds to a real loss of about slope*X. Forced
    // through the origin because "no predicted loss" must mean "no loss" --
    // an intercept would have the UI report a cost for the move it recommends.
    let sxy0 = 0, sxx0 = 0;
    for (const p of all) { sxy0 += p.pred * p.actual; sxx0 += p.pred * p.pred; }
    console.log('  DISPLAY SCALE  true ~ ' + (sxy0 / sxx0).toFixed(3) + ' x predicted' +
        '   (so a shown loss of 400 is really about ' + (400 * sxy0 / sxx0).toFixed(0) + ')');
    console.log('');
    console.log('  THE CURVE -- true loss by predicted loss');
    const EDGES = [0, 25, 50, 100, 200, 400, Infinity];
    console.log('    ' + 'predicted'.padEnd(14) + 'n'.padStart(6) + 'mean true'.padStart(12) + 'se'.padStart(8));
    for (let b = 0; b < EDGES.length - 1; b++) {
        const set = all.filter(p => p.pred >= EDGES[b] && p.pred < EDGES[b + 1]);
        if (!set.length) continue;
        const label = EDGES[b + 1] === Infinity ? EDGES[b] + '+' : EDGES[b] + '-' + EDGES[b + 1];
        console.log('    ' + label.padEnd(14) + String(set.length).padStart(6) +
            mean(set.map(p => p.actual)).toFixed(1).padStart(12) + seOf(set).toFixed(0).padStart(8));
    }
}

if (require.main === module) main();
