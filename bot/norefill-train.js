#!/usr/bin/env node
// ============================================================================
// Train one depth-specific head for deterministic no-refill tactical search.
//
// V_d is defined on an afterstate reached after d consecutive collapses without
// refilling. Its target is the ordinary real-game value if we refill *now*:
//
//   Y_d(A) = max_m (gain(m) + V_1(A'_m)),
//
// where A is refilled once before the max and V_1 is a frozen base network.
// A single genuine random refill is used per update, just like ptrain.js's
// one-sample Bellman backup. Synthetic states are sampled by choosing a root
// move and every later no-refill continuation uniformly. The real trajectory
// still follows the frozen base policy, but all of its root siblings receive
// coverage rather than only the move that policy selected.
//
// Example:
//   node bot/norefill-train.js --base bot/weights/base.bin --depth 2 \
//       --jobs 10 --episodes 1000000 --out bot/weights/base-nf2.bin
// ============================================================================

const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const Collapse = require('./engine.js');
const NTuple = require('./ntuple.js');
const Search = require('./search.js');
const Freeze = require('./freeze.js');

function parseArgs(argv) {
    const a = {
        base: null, init: null, depth: 2, episodes: 100000, jobs: 8,
        alpha: 0.004, alphaEnd: 0.001, samples: 1, maxMoves: 20000,
        seedBase: 6000000, report: 5000,
        out: path.join(__dirname, 'weights/norefill-depth2.bin'),
        checkpointEvery: 0, checkpointDir: null, freezeRoot: false
    };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--base') a.base = argv[++i];
        else if (k === '--init' || k === '--resume') a.init = argv[++i];
        else if (k === '--depth') a.depth = parseInt(argv[++i], 10);
        else if (k === '--episodes') a.episodes = parseInt(argv[++i], 10);
        else if (k === '--jobs') a.jobs = parseInt(argv[++i], 10);
        else if (k === '--alpha') a.alpha = parseFloat(argv[++i]);
        else if (k === '--alpha-end') a.alphaEnd = parseFloat(argv[++i]);
        else if (k === '--samples') a.samples = parseInt(argv[++i], 10);
        else if (k === '--max-moves') a.maxMoves = parseInt(argv[++i], 10);
        else if (k === '--seed-base') a.seedBase = parseInt(argv[++i], 10);
        else if (k === '--report') a.report = parseInt(argv[++i], 10);
        else if (k === '--out') a.out = argv[++i];
        else if (k === '--checkpoint-every') a.checkpointEvery = parseInt(argv[++i], 10);
        else if (k === '--checkpoint-dir') a.checkpointDir = argv[++i];
        else if (k === '--freeze-root') a.freezeRoot = true;
        else { console.error('unknown option ' + k); process.exit(1); }
    }
    if (!a.base) { console.error('--base FILE is required'); process.exit(1); }
    if (a.depth !== 2 && a.depth !== 3) {
        console.error('--depth must be 2 or 3'); process.exit(1);
    }
    if (a.samples < 1) { console.error('--samples must be at least 1'); process.exit(1); }
    if (a.alpha <= 0 || a.alphaEnd <= 0) {
        console.error('--alpha and --alpha-end must be positive'); process.exit(1);
    }
    return a;
}

// Training is float32 even when the seed is a deployment q16 file. Expand the
// per-table quantisation scales once so the new head initially computes the
// same function (up to float rounding) as its seed.
function floatCopy(net) {
    if (!net.q16) return new Float32Array(net.w);
    const out = new Float32Array(net.w.length);
    for (let t = 0; t < net.t.n; t++) {
        const from = net.t.wbase[t];
        const to = t + 1 < net.t.n ? net.t.wbase[t + 1] : net.w.length;
        const scale = net.scale[t];
        for (let k = from; k < to; k++) out[k] = net.w[k] * scale;
    }
    return out;
}

if (!isMainThread) {
    const { sab, meta, args, index } = workerData;
    const head = new NTuple.Network(new Float32Array(sab), meta);
    const base = NTuple.load(args.base);
    const realExp = Search.makeExpander();
    const pathExp = Search.makeExpander();
    const backupExp = Search.makeExpander();
    const fill = new Uint8Array(25);

    let rngState = (args.seedBase + Math.imul(index + 1, 2246822519)) >>> 0;
    function random() {
        rngState ^= rngState << 13; rngState >>>= 0;
        rngState ^= rngState >>> 17;
        rngState ^= rngState << 5; rngState >>>= 0;
        return rngState / 4294967296;
    }

    const rootCells = cells => args.freezeRoot ? Freeze.freezeBoard(cells) : cells;

    // Base V1 greedy behaviour on real positions. The expander remains intact
    // afterwards so training samples can start from any root sibling, not just
    // the move the behaviour policy selected.
    function chooseBase(game) {
        const nm = realExp.expand(rootCells(game.cells), game.maxGen);
        if (nm === 0) return null;
        let best = -Infinity, slots = [];
        for (let s = 0; s < nm; s++) {
            const v = realExp.gain(s) + base.value(realExp.board(s));
            if (v > best) { best = v; slots = [s]; }
            else if (v === best) slots.push(s);
        }
        const s = slots[(random() * slots.length) | 0];
        const k = realExp.cell(s);
        return {
            move: [(k / 5) | 0, k % 5],
            count: nm
        };
    }

    // Sample A_d from A1 by uniformly choosing among legal visible moves. A
    // copy is required after every expansion because the expander reuses its
    // board storage at the next level.
    function synthetic(a1, maxGen) {
        let cells = a1.slice(), gen = maxGen;
        for (let level = 2; level <= args.depth; level++) {
            const nm = pathExp.expand(cells, gen);
            if (nm === 0) return null;
            const s = (random() * nm) | 0;
            cells = pathExp.copy(s);
            gen = pathExp.nextGen(s);
        }
        return { cells, maxGen: gen };
    }

    // One genuine refill followed by a max backup through the frozen base V1.
    function target(after, maxGen) {
        fill.set(after);
        for (let k = 0; k < 25; k++)
            if (fill[k] === 0) fill[k] = ((random() * maxGen) | 0) + 1;
        const cells = rootCells(fill);
        const nm = backupExp.expand(cells, maxGen);
        if (nm === 0) return 0;
        let best = -Infinity;
        for (let s = 0; s < nm; s++) {
            const v = backupExp.gain(s) + base.value(backupExp.board(s));
            if (v > best) best = v;
        }
        return best;
    }

    parentPort.on('message', msg => {
        if (msg.stop) process.exit(0);
        let updates = 0, sqerr = 0, abserr = 0, moves = 0, score = 0;
        for (let e = 0; e < msg.count; e++) {
            const game = new Collapse.Game(msg.seedBase + e);
            while (!game.gameOver && game.moves.length < args.maxMoves) {
                const chosen = chooseBase(game);
                if (!chosen) break;
                for (let n = 0; n < args.samples; n++) {
                    const rootSlot = (random() * chosen.count) | 0;
                    const state = synthetic(realExp.copy(rootSlot), realExp.nextGen(rootSlot));
                    if (!state) continue;
                    const y = target(state.cells, state.maxGen);
                    const err = y - head.value(state.cells);
                    head.update(state.cells, msg.alpha * err);
                    updates++; sqerr += err * err; abserr += Math.abs(err);
                }
                game.apply(chosen.move[0], chosen.move[1]);
            }
            moves += game.moves.length;
            score += game.score;
        }
        parentPort.postMessage({ index, episodes: msg.count, updates, sqerr, abserr, moves, score });
    });
}

async function main() {
    const args = parseArgs(process.argv);
    args.base = path.resolve(args.base);
    if (args.init) args.init = path.resolve(args.init);

    const seed = NTuple.load(args.init || args.base);
    const weights = floatCopy(seed);
    const meta = Object.assign({}, seed.meta, { q16: false });
    delete meta.scale;
    const sab = new SharedArrayBuffer(weights.byteLength);
    new Float32Array(sab).set(weights);
    const head = new NTuple.Network(new Float32Array(sab), meta);

    console.log('depth=' + args.depth + '  base=' + args.base + '  init=' + (args.init || args.base));
    console.log('network: set=' + meta.set + ' sym=' + meta.sym + ' weights=' + weights.length +
        '  jobs=' + args.jobs + '  samples/move=' + args.samples +
        (args.freezeRoot ? '  freeze-root' : ''));

    const workers = [];
    for (let k = 0; k < args.jobs; k++)
        workers.push(new Worker(__filename, { workerData: { sab, meta, args, index: k } }));

    const chunk = Math.max(1, Math.round(args.report / args.jobs / 4));
    const alphaAt = frac => args.alpha * Math.pow(args.alphaEnd / args.alpha, frac);
    let issued = 0, done = 0, sinceReport = 0, updates = 0;
    let sqerr = 0, abserr = 0, moves = 0, score = 0, lastCheckpoint = 0;
    const ckptBase = path.basename(args.out).replace(/\.[^.]*$/, '');
    const ckptDir = args.checkpointDir || path.dirname(args.out);
    const t0 = Date.now();

    function dispatch(w) {
        if (issued >= args.episodes) return false;
        const count = Math.min(chunk, args.episodes - issued);
        w.postMessage({ count, seedBase: args.seedBase + issued, alpha: alphaAt(issued / args.episodes) });
        issued += count;
        return true;
    }

    await new Promise(resolve => {
        let live = workers.length;
        for (const w of workers) {
            w.on('message', m => {
                done += m.episodes; sinceReport += m.episodes; updates += m.updates;
                sqerr += m.sqerr; abserr += m.abserr; moves += m.moves; score += m.score;
                if (sinceReport >= args.report || done === args.episodes) {
                    const secs = (Date.now() - t0) / 1000;
                    console.log('ep ' + done + '  updates ' + updates +
                        '  score ' + (score / sinceReport).toFixed(0) +
                        '  rms ' + Math.sqrt(sqerr / Math.max(1, updates)).toFixed(1) +
                        '  mae ' + (abserr / Math.max(1, updates)).toFixed(1) +
                        '  alpha ' + alphaAt(done / args.episodes).toFixed(5) +
                        '  ' + (done / secs).toFixed(1) + ' ep/s');
                    NTuple.save(args.out, head);
                    sinceReport = 0; updates = 0; sqerr = 0; abserr = 0; moves = 0; score = 0;
                }
                if (args.checkpointEvery > 0 && done - lastCheckpoint >= args.checkpointEvery) {
                    lastCheckpoint = done;
                    const file = path.join(ckptDir, ckptBase + '-ep' + done + '.bin');
                    NTuple.save(file, head);
                    console.log('  checkpoint ' + file);
                }
                if (!dispatch(w)) { w.postMessage({ stop: true }); if (--live === 0) resolve(); }
            });
            w.on('error', err => { throw err; });
            dispatch(w);
        }
    });

    NTuple.save(args.out, head);
    console.log('saved ' + args.out + ' (' + head.t.n + ' tuples, ' + weights.length + ' weights)');
    process.exit(0);
}

if (isMainThread) main();
