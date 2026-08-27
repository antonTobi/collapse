#!/usr/bin/env node
// ============================================================================
// Parallel TD(0) / TD(lambda) training of the n-tuple network (Hogwild).
//
//   node bot/ptrain.js --jobs 10 --set big --sym --episodes 2000000 --out w.bin
//   node bot/ptrain.js --jobs 10 --resume w.bin --episodes 2000000
//
// Same update as train.js, but the weight table lives in a SharedArrayBuffer
// and every worker reads and writes it without locking. N-tuple updates are
// extremely sparse (36-70 weights out of millions per step), so collisions are
// rare and the lost updates behave like a little extra gradient noise. This is
// the standard Hogwild argument and it buys a near-linear speedup, which
// matters because the one thing that has reliably improved this network is
// more episodes.
//
// Workers report finished-episode scores back to the main thread, which owns
// the progress log and the checkpointing.
//
// Three ways to spend episodes on something other than plain on-policy TD, all
// aimed at the same measured problem -- V sits at its fixed point on the states
// self-play walks through and nowhere else, and everything a search buys is that
// gap (see bot/residual.js and SCALING.md):
//
//   --explore EPS   deviate to a nearby rank sometimes. Grounded (the episode
//                   still runs to a terminal) and free. Safe because the target
//                   is a max, so the behaviour policy may wander.
//   --siblings K    also back up the K rejected afterstates the expander has
//                   already built. 2.7x, and it bootstraps off the live table.
//   --distil K      regress the top K+1 candidates onto a FROZEN copy's backup.
//                   ~5x, supervised, and the one with an exact statement of what
//                   it is aiming at: greedy over TV plays depth-2's moves.
//   --freeze-prefix SET
//                   update only tuples appended after SET, preserving an
//                   exact-grown evaluator while a correction module learns.
// ============================================================================

const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const Collapse = require('./engine.js');
const NTuple = require('./ntuple.js');
const Search = require('./search.js');

function isPrefix(small, big) {
    if (small.n > big.n) return false;
    for (let t = 0; t < small.n; t++) {
        if (small.len[t] !== big.len[t]) return false;
        for (let c = 0; c < small.len[t]; c++)
            if (small.cells[small.off[t] + c] !== big.cells[big.off[t] + c]) return false;
    }
    return true;
}

function parseArgs(argv) {
    const a = {
        episodes: 100000, alpha: 0.1, out: path.join(__dirname, 'weights/ptd.bin'), resume: null,
        seedBase: 2000000, report: 5000, decay: 1, maxMoves: 20000, jobs: 8,
        set: 'base', sym: false, alphaEnd: 0, lambda: 0,
        searchDepth: 1, searchCap: 16, searchCapDeep: 4, searchTopk: 2, searchRootk: 6, searchTarget: false, sub: '',
        lambdaEnd: -1, starts: null, startFrac: 0.5, startMoves: 0,
        checkpointEvery: 0, checkpointDir: null,
        siblings: 0, sibAlpha: 1, sibEvery: 1, sibCenter: false, explore: 0, exploreRank: 2,
        distil: 0, frozen: null, rank: 0, rankK: 3, freezePrefix: null, trainFrom: 0
    };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--episodes') a.episodes = parseInt(argv[++i], 10);
        else if (k === '--alpha') a.alpha = parseFloat(argv[++i]);
        else if (k === '--alpha-end') a.alphaEnd = parseFloat(argv[++i]);
        else if (k === '--lambda') a.lambda = parseFloat(argv[++i]);
        else if (k === '--lambda-end') a.lambdaEnd = parseFloat(argv[++i]);
        else if (k === '--starts') a.starts = argv[++i];
        else if (k === '--start-frac') a.startFrac = parseFloat(argv[++i]);
        else if (k === '--start-moves') a.startMoves = parseInt(argv[++i], 10);
        else if (k === '--out') a.out = argv[++i];
        else if (k === '--resume') a.resume = argv[++i];
        else if (k === '--seed-base') a.seedBase = parseInt(argv[++i], 10);
        else if (k === '--report') a.report = parseInt(argv[++i], 10);
        else if (k === '--checkpoint-every') a.checkpointEvery = parseInt(argv[++i], 10);
        else if (k === '--checkpoint-dir') a.checkpointDir = argv[++i];
        else if (k === '--jobs') a.jobs = parseInt(argv[++i], 10);
        else if (k === '--sym') a.sym = true;
        else if (k === '--set') a.set = argv[++i];
        else if (k === '--max-moves') a.maxMoves = parseInt(argv[++i], 10);
        else if (k === '--search-depth') a.searchDepth = parseInt(argv[++i], 10);
        else if (k === '--search-cap') a.searchCap = parseInt(argv[++i], 10);
        else if (k === '--search-cap-deep') a.searchCapDeep = parseInt(argv[++i], 10);
        else if (k === '--search-topk') a.searchTopk = parseInt(argv[++i], 10);
        else if (k === '--search-rootk') a.searchRootk = parseInt(argv[++i], 10);
        else if (k === '--search-target') a.searchTarget = true;
        // Off-policy coverage of the value function. See best() in the worker
        // and the "residual repair" section of SCALING.md.
        else if (k === '--siblings') a.siblings = parseInt(argv[++i], 10);
        else if (k === '--sib-alpha') a.sibAlpha = parseFloat(argv[++i]);
        else if (k === '--sib-every') a.sibEvery = parseInt(argv[++i], 10);
        else if (k === '--sib-center') a.sibCenter = true;
        else if (k === '--explore') a.explore = parseFloat(argv[++i]);
        else if (k === '--explore-rank') a.exploreRank = parseInt(argv[++i], 10);
        else if (k === '--distil') a.distil = parseInt(argv[++i], 10);
        else if (k === '--frozen') a.frozen = argv[++i];
        else if (k === '--rank') a.rank = parseFloat(argv[++i]);
        else if (k === '--rank-k') a.rankK = parseInt(argv[++i], 10);
        // When a larger architecture was made with grow.js, train only the
        // appended correction tables first. This protects the known-strong
        // evaluator while the new features learn from deliberately OOD starts.
        else if (k === '--freeze-prefix') a.freezePrefix = argv[++i];
        // Train on a walled-off board. A 6 can never be collapsed, so a row and
        // a column of them is exactly a smaller game -- and the network reads
        // 6-heavy boards already, so no architecture change is needed. Games are
        // 8x shorter, which turns a 5-hour A/B into a 20-minute one. The point
        // is to decide the expensive questions (search targets, behaviour depth)
        // cheaply before committing them to a full 5x5 run.
        else if (k === '--sub') a.sub = argv[++i];
        else { console.error('unknown option ' + k); process.exit(1); }
    }
    // Both of these used to fail silently, which is worse than failing.
    // --search-target reads the searcher's value for the next position, and
    // there is no searcher unless --search-depth > 1: with depth 1 the "search
    // target" is character-for-character the static one.
    if (a.searchTarget && a.searchDepth <= 1) {
        console.error('--search-target needs --search-depth > 1; at depth 1 it is the static target');
        process.exit(1);
    }
    // A start pool holds full boards; the walled subgames build their own start
    // position and would ignore the pool entirely.
    if (a.starts && a.sub) {
        console.error('--starts and --sub cannot be combined (the pool is ignored under --sub)');
        process.exit(1);
    }
    if (a.startMoves && !a.starts) {
        console.error('--start-moves only caps seeded episodes and there is no pool without --starts');
        process.exit(1);
    }
    if (a.explore > 0 && a.exploreRank < 2) {
        console.error('--explore-rank must be at least 2 (rank 1 is what greedy already plays)');
        process.exit(1);
    }
    if (a.explore > 0 && a.searchDepth > 1) {
        console.error('--explore is a greedy-behaviour option; it does nothing under --search-depth > 1');
        process.exit(1);
    }
    if ((a.distil > 0 || (a.rank > 0 && a.frozen)) && !a.resume && !a.frozen) {
        console.error('--distil needs a target: --resume the network to distil, or name one with --frozen');
        process.exit(1);
    }
    if (a.rank > 0 && a.distil > 0) {
        console.error('--rank and --distil are alternatives: --distil replaces the TD update with a ' +
            'regression onto TV, --rank keeps it and only reorders. Use --frozen with --rank to take ' +
            'the ranking from a frozen network.');
        process.exit(1);
    }
    if (a.rank > 0 && a.searchDepth > 1) {
        console.error('--rank is a greedy-behaviour option');
        process.exit(1);
    }
    if (a.distil > 0 && (a.siblings > 0 || a.lambda > 0 || a.searchDepth > 1)) {
        console.error('--distil replaces the TD update; it cannot be combined with --siblings, --lambda or --search-depth');
        process.exit(1);
    }
    if (a.siblings > 0 && a.searchDepth > 1) {
        console.error('--siblings is a greedy-behaviour option; for search behaviour the equivalent is ' +
            'updating every root move towards the value the search already computed (not implemented)');
        process.exit(1);
    }
    return a;
}

// ---- worker ---------------------------------------------------------------

if (!isMainThread) {
    const { sab, meta, args, index, starts, frozen } = workerData;
    const weights = new Float32Array(sab);
    const net = new NTuple.Network(weights, meta);
    const applyUpdate = (cells, delta) => net.update(cells, delta, args.trainFrom);

    // Best (reward + V(afterstate)) from a position. null when terminal.
    //
    // This goes through search.js's expander rather than Game.preview, and the
    // difference is not small: preview -> apply recomputes gameOver with a full
    // legal-move scan, which is 25 flood fills per candidate move that a
    // training step immediately throws away. One components() pass finds every
    // chain at once and the afterstates land in a preallocated buffer. Same
    // moves, same values, ~1.6x the episodes per hour.
    const expander = Search.makeExpander();
    // A second expander, for the one-step backup of a sibling afterstate. It has
    // to be separate: the outer one is still holding the afterstates being
    // updated when the backup runs.
    const sibExpander = Search.makeExpander();
    const sibFill = new Uint8Array(25);
    const shVal = new Float64Array(25);
    const shOrd = new Int32Array(25);
    const sibV = new Float64Array(26);
    const sibB = new Float64Array(26);
    let curAlpha = 0;      // set per dispatch, read by the sibling updates
    let sibClock = 0;

    // E_refill[ max_a (gain + V) ] for one afterstate, from a single sampled
    // refill. That is the same one-sample estimator the trajectory update
    // already uses -- unbiased for the expectation, noisy per call, and TD
    // averages the noise out over visits.
    //
    // The zeros in an afterstate are exactly the holes, and scanning them in
    // index order visits them in the order the real generator fills them (see
    // the header of search.js), so writing independent tiles into that scan
    // produces a genuine successor board.
    function backup(after, maxGen, on) {
        const V = on || net;
        sibFill.set(after);
        for (let k = 0; k < 25; k++) if (sibFill[k] === 0) sibFill[k] = ((nextRandom() * maxGen) | 0) + 1;
        const nm = sibExpander.expand(sibFill, maxGen);
        if (nm === 0) return 0;                       // that refill is terminal
        let bv = -Infinity;
        for (let s = 0; s < nm; s++) {
            const v = sibExpander.gain(s) + V.value(sibExpander.board(s));
            if (v > bv) bv = v;
        }
        return bv;
    }

    // The frozen target network for --distil. See the block in best().
    const fnet = frozen ? new NTuple.Network(new Float32Array(frozen), meta) : null;

    // Order the top `keep` slots by shallow value. Partial selection sort:
    // nothing below `keep` needs to be in order.
    function rank(nm, keep) {
        for (let s = 0; s < nm; s++) shOrd[s] = s;
        const n = Math.min(keep, nm);
        for (let a = 0; a < n; a++) {
            let bi = a;
            for (let b = a + 1; b < nm; b++) if (shVal[shOrd[b]] > shVal[shOrd[bi]]) bi = b;
            const t = shOrd[a]; shOrd[a] = shOrd[bi]; shOrd[bi] = t;
        }
        return n;
    }

    function best(game) {
        const nm = expander.expand(game.cells, game.maxGen);
        if (nm === 0) return null;
        let bs = 0;
        for (let s = 0; s < nm; s++) {
            shVal[s] = expander.gain(s) + net.value(expander.board(s));
            if (shVal[s] > shVal[bs]) bs = s;
        }
        const qmax = shVal[bs];

        // How far down the order anything needs to be sorted.
        const wantSib = args.siblings > 0 && nm > 1 && curAlpha > 0 &&
            (args.sibEvery <= 1 || (sibClock++ % args.sibEvery) === 0);
        const wantDistil = fnet !== null && curAlpha > 0;
        const wantRank = args.rank > 0 && nm > 1 && curAlpha > 0;
        const wantExplore = args.explore > 0 && nm > 1 && nextRandom() < args.explore;
        const keep = Math.max(wantSib ? args.siblings + 1 : 0,
            wantDistil ? args.distil + 1 : 0, wantRank ? args.rankK + 1 : 0,
            wantExplore ? args.exploreRank : 0);
        if (keep > 1) rank(nm, keep);

        // Fitted value iteration against a frozen target network.
        //
        // The goal is stated exactly by one line of algebra: a depth-2 search is
        // `argmax(gain + TV)` where greedy is `argmax(gain + V)`, so a network
        // that has learned `TV` plays depth-2's moves at depth-1's price. TV is
        // computable -- one sampled refill and one expansion against the frozen
        // copy -- so this is a *supervised regression*, not a bootstrap.
        //
        // That distinction is the reason this exists alongside --siblings.
        // Bootstrapping off the live network (--siblings) puts a positive-mean
        // update into a table that generalises it everywhere, and 200k grid44
        // episodes moved the whole residual column down by 3.5 while leaving
        // every difference intact -- work spent on a constant that changes no
        // move. A frozen target cannot drift: TV is a fixed function and the
        // regression has a fixed answer.
        //
        // Unlike --siblings this also updates rank 1, because the point is not
        // to patch the rejected moves but to learn TV everywhere the deployed
        // agent looks. The trajectory TD update is switched off when it is on --
        // rank 1's frozen backup is the same quantity, computed more stably.
        if (wantDistil) {
            const n = Math.min(args.distil + 1, nm);
            for (let a = 0; a < n; a++) {
                const s = n === 1 ? bs : shOrd[a];
                const after = expander.board(s);
                const t = backup(after, expander.nextGen(s), fnet);
                applyUpdate(after, curAlpha * (t - net.value(after)));
            }
        }

        // Pairwise ranking update -- policy distillation rather than value
        // distillation.
        //
        // Regressing V onto TV (--distil) works as a regression and fails as a
        // policy, and the decomposition says exactly why. Within a position,
        // writing R = TV - V for the correction search applies and delta for the
        // correction the fit actually applied, 100k grid44 episodes gave
        // corr(delta, R) = 0.76 and delta = 0.31 R -- the right direction -- but
        // 20.2 rms of movement ORTHOGONAL to R as well. An exact 0.31 step up
        // that axis is worth +151 measured; the off-axis part costs more than
        // that, because a max node over siblings picks whichever candidate the
        // stray movement favoured. This project has paid for that lesson three
        // times already (norefill, control variates, graded allocation).
        //
        // So ask for less. The policy only needs the *order* of the candidates,
        // not their values, and an order is a far weaker thing to represent than
        // a function. When the search's preferred move is not the one greedy
        // would play, push the two apart by a fixed step and leave everything
        // else alone:
        //
        //   - equal and opposite, so there is no level to drift (the failure
        //     mode of --siblings and of --search-target),
        //   - zero once they agree, so it cannot overshoot into churn,
        //   - only two afterstates touched per position, so there is very little
        //     surface for off-axis movement,
        //   - and the ordinary TD trajectory update stays on underneath it,
        //     which is what keeps V anchored to real returns.
        if (args.rank > 0 && nm > 1 && curAlpha > 0) {
            const n = Math.min(args.rankK + 1, nm);
            const V = fnet || net;
            let star = shOrd[0], sv = -Infinity;
            for (let a = 0; a < n; a++) {
                const s = shOrd[a];
                const v = expander.gain(s) + backup(expander.board(s), expander.nextGen(s), V);
                if (v > sv) { sv = v; star = s; }
            }
            if (star !== shOrd[0]) {
                const step = curAlpha * args.rank;
                applyUpdate(expander.board(star), step);
                applyUpdate(expander.board(shOrd[0]), -step);
            }
        }

        // Sibling Bellman updates. TD only ever updates the afterstate it walks
        // into, so V ends up at its fixed point on the trajectory and nowhere
        // else -- measured, the residual is ~0 on the move greedy plays and +7
        // to +160 on the moves it rejects (bot/residual.js). Since a depth-d
        // search scores a root move as (greedy score + residual), that gap is
        // the whole of what search buys. Applying the backup to the rejected
        // siblings during training attacks it where it is cheap: the
        // afterstates already exist in the expander and V has already been
        // evaluated on all of them, so the only new work is one refill and one
        // expansion per sibling.
        //
        // --sib-center subtracts rank 1's own residual from every sibling
        // target. The first version of this did not, and measurably paid for
        // it: the sibling updates carry a positive mean (the residual is +7 to
        // +25 down the ranks), the n-tuple table generalises that mean onto the
        // trajectory afterstates as well, and 200k episodes moved the whole
        // residual column down by 3.5 while leaving every *difference* where it
        // started. A common offset changes no move, so that is work spent on
        // nothing. Centring puts the whole update into the relative structure,
        // which is the only part that picks a move.
        if (wantSib) {
            const n = Math.min(args.siblings + 1, nm);
            // Read every value and every backup before writing anything: an
            // update changes V, and these all have to come off the same V.
            for (let a = 0; a < n; a++) {
                const s = shOrd[a];
                sibV[a] = net.value(expander.board(s));
                sibB[a] = backup(expander.board(s), expander.nextGen(s));
            }
            const base = args.sibCenter ? sibB[0] - sibV[0] : 0;
            for (let a = 1; a < n; a++) {
                applyUpdate(expander.board(shOrd[a]),
                    curAlpha * args.sibAlpha * (sibB[a] - base - sibV[a]));
            }
        }

        // Exploration. Uniform-random deviation is ruinous in this game -- a
        // random move wastes structure that cannot be rebuilt, and eps=0.02
        // costs 2450 points of episode quality -- but stepping down one rank is
        // nearly free: eps=0.02 on the second-best move costs 120, eps=0.005
        // costs nothing measurable. That is enough to put the rank-2 and rank-3
        // afterstates on the trajectory, where they get a grounded update.
        //
        // Safe because the target below is the MAX, not the value of what was
        // played: the backup is Q-learning-shaped, so the behaviour policy can
        // wander without changing what is learned.
        // --explore-rank R deviates to a rank drawn uniformly from 2..R, so R=2
        // is "always the second best" and a larger R spreads the coverage down
        // the order. Only rank 1 is excluded -- that is what greedy already does.
        let played = bs;
        if (wantExplore) {
            const top = Math.min(args.exploreRank, nm);
            const r = top > 2 ? 2 + ((nextRandom() * (top - 1)) | 0) : top;
            played = shOrd[r - 1];
        }
        const k = expander.cell(played);
        return {
            move: [(k / 5) | 0, k % 5], cells: expander.board(played),
            reward: expander.gain(played), value: shVal[played], qmax
        };
    }

    // With --search-depth > 1 the behaviour policy is the expectimax agent
    // rather than 1-ply greedy. The TD target is unchanged -- V(afterstate) is
    // still moved towards (reward + V(next afterstate)) -- but the trajectory
    // is the one the search agent actually plays, which runs several hundred
    // moves longer and several sixes deeper than greedy self-play ever gets.
    // Those late positions are exactly where a net trained on greedy games has
    // seen nothing, and exactly where the search agent spends its endgame.
    let searcher = null;
    if (args.searchDepth > 1) {
        let sd = (index * 2654435761 + 12345) >>> 0;
        const srng = () => {
            sd = (sd + 0x6D2B79F5) | 0;
            let t = Math.imul(sd ^ (sd >>> 15), 1 | sd);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        searcher = Search.makeSearcher(net, {
            depth: args.searchDepth, cap: args.searchCap, capDeep: args.searchCapDeep,
            topk: args.searchTopk, rootk: args.searchRootk, rng: srng
        });
    }

    function bestMove(game) {
        if (!searcher) return best(game);
        const scored = searcher.scoreMoves(game);
        if (!scored.length) return null;
        let bm = null, bv = -Infinity;
        for (const s of scored) if (s.value > bv) { bv = s.value; bm = s.move; }
        const after = game.preview(bm[0], bm[1], Collapse.FILL_NONE);
        return { move: bm, cells: after.cells, reward: after.score - game.score, value: bv, qmax: bv };
    }

    // TD(lambda) over afterstates. An eligibility trace the size of the weight
    // table is out of the question, but the trajectory is only a few hundred
    // boards, so accumulate the episode and walk it backwards applying the
    // lambda-return instead.
    const trail = [];

    // Positions sampled from search play, to start some episodes from. See
    // bot/starts.js for why. A seeded episode is a real episode in every way
    // except that its score is the score from that point on, so it is reported
    // separately and kept out of the self-play mean.
    const pool = starts ? new Uint8Array(starts) : null;
    const poolSize = pool ? pool.length / 25 : 0;
    let rngState = (index * 2246822519 + 374761393) >>> 0;
    function nextRandom() {
        rngState ^= rngState << 13; rngState >>>= 0;
        rngState ^= rngState >>> 17;
        rngState ^= rngState << 5; rngState >>>= 0;
        return rngState / 4294967296;
    }

    parentPort.on('message', msg => {
        if (msg.stop) process.exit(0);
        curAlpha = msg.alpha;
        const scores = [], seededScores = [];
        for (let e = 0; e < msg.count; e++) {
            const seeded = poolSize > 0 && nextRandom() < args.startFrac;
            let game;
            if (args.sub) {
                const g0 = new Collapse.Game(msg.seedBase + e);
                const cells = Array.from(g0.cells);
                if (args.sub === 'grid54' || args.sub === 'grid44')
                    for (let i = 0; i < 5; i++) cells[i * 5] = 6;
                if (args.sub === 'grid45' || args.sub === 'grid44')
                    for (let j = 0; j < 5; j++) cells[4 * 5 + j] = 6;
                game = Collapse.fromCells(cells, msg.seedBase + e);
            } else if (seeded) {
                const at = ((nextRandom() * poolSize) | 0) * 25;
                game = Collapse.fromCells(pool.subarray(at, at + 25), msg.seedBase + e);
            } else {
                game = new Collapse.Game(msg.seedBase + e);
            }
            let cur = bestMove(game);
            trail.length = 0;
            // How far to play this episode. A seeded episode exists to put
            // updates *near its start position*, and TD(0) bootstraps, so
            // there is no reason to play it out: after --start-moves moves the
            // last target is V's own estimate, which is exactly what the rest
            // of the episode would have converged to anyway. Cutting a 400-move
            // episode to 24 buys ~17x the density of updates around the pool
            // for the same compute.
            //
            // Only seeded episodes are capped. Ordinary ones still run to the
            // end, because something has to stay anchored to the true terminal
            // 0 -- a diet of nothing but truncated episodes is a bootstrap with
            // no ground under it, free to drift.
            const cap = seeded && args.startMoves ? args.startMoves : args.maxMoves;
            while (cur && game.moves.length < cap) {
                const cells = cur.cells.slice();
                game.apply(cur.move[0], cur.move[1]);
                const next = bestMove(game);
                // Two choices of target, and the difference is the whole point
                // of training with search.
                //
                //   static  reward + V(next afterstate) -- a one-ply estimate,
                //           so V learns to predict its own greedy continuation.
                //           Search then only changes which positions are seen,
                //           not what is learned about them.
                //   search  the searcher's own value for the next position,
                //           which already includes the reward and a much better
                //           estimate of what follows. V learns to predict what
                //           SEARCH achieves, which is what the agent actually
                //           does at play time.
                //
                // Measured motivation: V currently under-predicts the final
                // score by 1268 at move 200 and 311 at move 800, because it was
                // trained under a greedy policy scoring ~8700 while the game is
                // played out with search scoring ~10400. Bootstrapping off the
                // search closes that gap by construction -- but only the level;
                // measured, it leaves the residual's *shape* alone, and shape is
                // what picks moves. See SCALING.md.
                //
                // `qmax` rather than (reward + V) of what was played: identical
                // without --explore, and the difference is the whole reason
                // exploration is safe. The target is the max over moves, so it
                // does not care which move the behaviour actually took.
                const target = next ? (args.searchTarget ? next.value : next.qmax) : 0;
                if (args.distil > 0) { /* best() already wrote the frozen-target updates */ }
                else if (msg.lambda > 0) trail.push({ cells, target });
                else applyUpdate(cells, msg.alpha * (target - net.value(cells)));
                cur = next;
            }
            if (msg.lambda > 0) {
                let carry = 0;
                for (let t = trail.length - 1; t >= 0; t--) {
                    const err = trail[t].target - net.value(trail[t].cells);
                    carry = err + msg.lambda * carry;
                    applyUpdate(trail[t].cells, msg.alpha * carry);
                }
            }
            (seeded ? seededScores : scores).push(game.score);
        }
        parentPort.postMessage({ index, scores, seeded: seededScores.length });
    });
}

// ---- main -----------------------------------------------------------------

async function main() {
    const args = parseArgs(process.argv);

    let meta, initial = null;
    if (args.resume) {
        const loaded = NTuple.load(args.resume, args.sym ? { sym: true } : null);
        meta = loaded.meta;
        initial = loaded.w;
    } else {
        meta = { set: args.set, sym: args.sym };
    }
    if (args.freezePrefix) {
        if (!args.resume) {
            console.error('--freeze-prefix is only useful with a grown --resume network');
            process.exit(1);
        }
        const small = NTuple.tupleSet(args.freezePrefix), big = NTuple.tupleSet(meta.set);
        if (small.n >= big.n || !isPrefix(small, big)) {
            console.error(`set "${args.freezePrefix}" is not a strict prefix of "${meta.set}"`);
            process.exit(1);
        }
        args.trainFrom = small.n;
    }
    const size = new NTuple.Network(initial, meta).w.length;

    const sab = new SharedArrayBuffer(size * 4);
    const weights = new Float32Array(sab);
    if (initial) weights.set(initial);
    const net = new NTuple.Network(weights, meta);   // main-thread view, for saving

    // The frozen target for --distil: a read-only second copy of the network,
    // shared by every worker, that the backups are computed against. Freezing is
    // what makes this a supervised regression rather than a bootstrap -- see the
    // block in best(). Defaults to the weights being resumed, so one run learns
    // TV; feed the result back with --frozen to get T^2 V.
    let frozenSab = null;
    if (args.distil > 0 || (args.rank > 0 && args.frozen)) {
        const src = args.frozen ? NTuple.load(args.frozen).w : initial;
        if (src.length !== size) { console.error('--frozen network has a different architecture'); process.exit(1); }
        frozenSab = new SharedArrayBuffer(size * 4);
        new Float32Array(frozenSab).set(src);
        console.log('frozen target: ' + (args.frozen || args.resume));
    }

    // Shared so ten workers do not each hold a copy.
    let startPool = null;
    if (args.starts) {
        const cells = require('./starts.js').load(args.starts);
        const sb = new SharedArrayBuffer(cells.length);
        new Uint8Array(sb).set(cells);
        startPool = sb;
        console.log('start pool: ' + (cells.length / 25).toLocaleString() + ' positions from ' +
            args.starts + ', used for ' + (100 * args.startFrac).toFixed(0) + '% of episodes');
    }

    console.log('network: set=' + meta.set + ' sym=' + meta.sym +
        ' weights=' + size + '  jobs=' + args.jobs + '  lambda=' + args.lambda +
        (args.searchDepth > 1 ? '  behaviour=expectimax depth ' + args.searchDepth : '') +
        (args.searchTarget ? '  target=search' : '') +
        (args.siblings ? '  siblings=' + args.siblings +
            (args.sibAlpha !== 1 ? '@' + args.sibAlpha : '') +
            (args.sibEvery > 1 ? '/' + args.sibEvery : '') +
            (args.sibCenter ? ' centred' : '') : '') +
        (args.startMoves ? '  start-moves=' + args.startMoves : '') +
        (args.explore ? '  explore=' + args.explore + ' rank ' + args.exploreRank : '') +
        (args.distil ? '  distil=' + args.distil + ' (frozen target)' : '') +
        (args.rank ? '  rank=' + args.rank + ' over top ' + (args.rankK + 1) +
            (args.frozen ? ' (frozen)' : ' (live)') : '') +
        (args.freezePrefix ? '  frozen-prefix=' + args.freezePrefix +
            ' (' + args.trainFrom + ' tuples)' : ''));

    const chunk = Math.max(1, Math.round(args.report / args.jobs / 4));
    const workers = [];
    for (let k = 0; k < args.jobs; k++) {
        workers.push(new Worker(__filename, { workerData: { sab, meta, args, index: k, starts: startPool, frozen: frozenSab } }));
    }

    let issued = 0, done = 0, lastReport = 0, seededDone = 0, lastCheckpoint = 0;
    // Numbered checkpoints for a learning curve: <out-basename>-ep<N>.bin in
    // checkpointDir, in addition to the rolling --out. One extra dense write
    // per interval; benchmarked afterwards by bot/bench-curve.js.
    const ckptBase = path.basename(args.out).replace(/\.[^.]*$/, '');
    const ckptDir = args.checkpointDir || path.dirname(args.out);
    const window = [];
    const t0 = Date.now();

    // Geometric alpha schedule when --alpha-end is given; otherwise --decay.
    const alphaAt = frac => args.alphaEnd > 0
        ? args.alpha * Math.pow(args.alphaEnd / args.alpha, frac)
        : args.alpha * Math.pow(args.decay, frac * args.episodes);

    // The lambda-return is worth about 3x in episodes while the value function
    // is still far from right, and costs a few hundred points once it is close
    // -- its extra variance stops buying anything and starts disturbing a
    // converged table. So lambda wants to be annealed to zero, not held.
    const lambdaAt = frac => args.lambdaEnd >= 0
        ? args.lambda + (args.lambdaEnd - args.lambda) * frac
        : args.lambda;

    function dispatch(w) {
        if (issued >= args.episodes) return false;
        const count = Math.min(chunk, args.episodes - issued);
        const frac = issued / args.episodes;
        w.postMessage({ seedBase: args.seedBase + issued, count, alpha: alphaAt(frac), lambda: lambdaAt(frac) });
        issued += count;
        return true;
    }

    await new Promise(resolve => {
        let live = workers.length;
        for (const w of workers) {
            w.on('message', m => {
                done += m.scores.length + m.seeded;
                seededDone += m.seeded;
                for (const s of m.scores) window.push(s);
                while (window.length > 4000) window.shift();
                if (done - lastReport >= args.report) {
                    lastReport = done;
                    const mean = window.reduce((a, b) => a + b, 0) / window.length;
                    const secs = (Date.now() - t0) / 1000;
                    console.log('ep ' + done + (seededDone ? ' (' + seededDone + ' seeded)' : '') +
                        '  mean(last ' + window.length + ') ' + mean.toFixed(0) +
                        '  alpha ' + alphaAt(done / args.episodes).toFixed(4) +
                        (args.lambda > 0 ? '  lambda ' + lambdaAt(done / args.episodes).toFixed(3) : '') +
                        '  ' + secs.toFixed(0) + 's  ' + (done / secs).toFixed(0) + ' ep/s');
                    NTuple.save(args.out, net);
                }
                if (args.checkpointEvery > 0 && done - lastCheckpoint >= args.checkpointEvery) {
                    lastCheckpoint = done;
                    const file = path.join(ckptDir, ckptBase + '-ep' + done + '.bin');
                    NTuple.save(file, net);
                    console.log('  checkpoint ' + file);
                }
                if (!dispatch(w)) { w.postMessage({ stop: true }); if (--live === 0) resolve(); }
            });
            dispatch(w);
        }
    });

    NTuple.save(args.out, net);
    console.log('saved ' + args.out + ' (' + net.t.n + ' tuples, ' + size + ' weights)');
    process.exit(0);
}

if (isMainThread) main();
