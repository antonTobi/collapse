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
// ============================================================================

const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const Collapse = require('./engine.js');
const NTuple = require('./ntuple.js');
const Search = require('./search.js');

function parseArgs(argv) {
    const a = {
        episodes: 100000, alpha: 0.1, out: path.join(__dirname, 'weights/ptd.bin'), resume: null,
        seedBase: 2000000, report: 5000, decay: 1, maxMoves: 20000, jobs: 8,
        set: 'base', stages: 1, sym: false, alphaEnd: 0, lambda: 0,
        searchDepth: 1, searchCap: 16, searchCapDeep: 4, searchTopk: 2, searchRootk: 6,
        lambdaEnd: -1
    };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--episodes') a.episodes = parseInt(argv[++i], 10);
        else if (k === '--alpha') a.alpha = parseFloat(argv[++i]);
        else if (k === '--alpha-end') a.alphaEnd = parseFloat(argv[++i]);
        else if (k === '--lambda') a.lambda = parseFloat(argv[++i]);
        else if (k === '--lambda-end') a.lambdaEnd = parseFloat(argv[++i]);
        else if (k === '--out') a.out = argv[++i];
        else if (k === '--resume') a.resume = argv[++i];
        else if (k === '--seed-base') a.seedBase = parseInt(argv[++i], 10);
        else if (k === '--report') a.report = parseInt(argv[++i], 10);
        else if (k === '--jobs') a.jobs = parseInt(argv[++i], 10);
        else if (k === '--sym') a.sym = true;
        else if (k === '--set') a.set = argv[++i];
        else if (k === '--stages') a.stages = parseInt(argv[++i], 10);
        else if (k === '--max-moves') a.maxMoves = parseInt(argv[++i], 10);
        else if (k === '--search-depth') a.searchDepth = parseInt(argv[++i], 10);
        else if (k === '--search-cap') a.searchCap = parseInt(argv[++i], 10);
        else if (k === '--search-cap-deep') a.searchCapDeep = parseInt(argv[++i], 10);
        else if (k === '--search-topk') a.searchTopk = parseInt(argv[++i], 10);
        else if (k === '--search-rootk') a.searchRootk = parseInt(argv[++i], 10);
        else { console.error('unknown option ' + k); process.exit(1); }
    }
    return a;
}

// ---- worker ---------------------------------------------------------------

if (!isMainThread) {
    const { sab, meta, args, index } = workerData;
    const weights = new Float32Array(sab);
    const net = new NTuple.Network(weights, meta);

    // Best (reward + V(afterstate)) from a position. null when terminal.
    function best(game) {
        const moves = game.legalMoves();
        if (!moves.length) return null;
        let bv = -Infinity, bm = null, bafter = null, br = 0;
        for (const m of moves) {
            const after = game.preview(m[0], m[1], Collapse.FILL_NONE);
            const r = after.score - game.score;
            const v = r + net.value(after.cells);
            if (v > bv) { bv = v; bm = m; bafter = after.cells; br = r; }
        }
        return { move: bm, cells: bafter, reward: br, value: bv };
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
        return { move: bm, cells: after.cells, reward: after.score - game.score, value: bv };
    }

    // TD(lambda) over afterstates. An eligibility trace the size of the weight
    // table is out of the question, but the trajectory is only a few hundred
    // boards, so accumulate the episode and walk it backwards applying the
    // lambda-return instead.
    const trail = [];

    parentPort.on('message', msg => {
        if (msg.stop) process.exit(0);
        const scores = [];
        for (let e = 0; e < msg.count; e++) {
            const game = new Collapse.Game(msg.seedBase + e);
            let cur = bestMove(game);
            trail.length = 0;
            while (cur && game.moves.length < args.maxMoves) {
                const cells = cur.cells.slice();
                game.apply(cur.move[0], cur.move[1]);
                const next = bestMove(game);
                const target = next ? next.reward + net.value(next.cells) : 0;
                if (msg.lambda > 0) trail.push({ cells, target });
                else net.update(cells, msg.alpha * (target - net.value(cells)));
                cur = next;
            }
            if (msg.lambda > 0) {
                let carry = 0;
                for (let t = trail.length - 1; t >= 0; t--) {
                    const err = trail[t].target - net.value(trail[t].cells);
                    carry = err + msg.lambda * carry;
                    net.update(trail[t].cells, msg.alpha * carry);
                }
            }
            scores.push(game.score);
        }
        parentPort.postMessage({ index, scores });
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
        meta = { set: args.set, sym: args.sym, stages: args.stages };
    }
    const size = new NTuple.Network(initial, meta).w.length;

    const sab = new SharedArrayBuffer(size * 4);
    const weights = new Float32Array(sab);
    if (initial) weights.set(initial);
    const net = new NTuple.Network(weights, meta);   // main-thread view, for saving

    console.log('network: set=' + meta.set + ' sym=' + meta.sym + ' stages=' + (meta.stages || 1) +
        ' weights=' + size + '  jobs=' + args.jobs + '  lambda=' + args.lambda +
        (args.searchDepth > 1 ? '  behaviour=expectimax depth ' + args.searchDepth : ''));

    const chunk = Math.max(1, Math.round(args.report / args.jobs / 4));
    const workers = [];
    for (let k = 0; k < args.jobs; k++) {
        workers.push(new Worker(__filename, { workerData: { sab, meta, args, index: k } }));
    }

    let issued = 0, done = 0, lastReport = 0;
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
                done += m.scores.length;
                for (const s of m.scores) window.push(s);
                while (window.length > 4000) window.shift();
                if (done - lastReport >= args.report) {
                    lastReport = done;
                    const mean = window.reduce((a, b) => a + b, 0) / window.length;
                    const secs = (Date.now() - t0) / 1000;
                    console.log('ep ' + done + '  mean(last ' + window.length + ') ' + mean.toFixed(0) +
                        '  alpha ' + alphaAt(done / args.episodes).toFixed(4) +
                        (args.lambda > 0 ? '  lambda ' + lambdaAt(done / args.episodes).toFixed(3) : '') +
                        '  ' + secs.toFixed(0) + 's  ' + (done / secs).toFixed(0) + ' ep/s');
                    NTuple.save(args.out, net);
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
