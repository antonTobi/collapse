#!/usr/bin/env node
// ============================================================================
// Compress a trained network by throwing away the weights nobody reads.
//
//   node bot/shrink.js --in bot/weights/dom39c.bin --out bot/weights/dom39s.bin \
//                      --keep 8000000 --games 24000 --jobs 4
//
// `dom39c` is 73.4M weights and 91% of them are never read: in 178M afterstates
// of real play only 12.1M of the 73.4M (bank, entry) slots come up at all, and
// 0.3% of the slots carry half the reads. The table is mostly air, and the file
// is paying for the air.
//
// What replaces it is two numbers instead of 39 per pattern:
//
//   base[e]      one bank-independent value per table entry: the read-weighted
//                mean of that entry across all 39 banks. The banks correlate at
//                0.91-1.00, so this is nearly the whole weight.
//   corr[s][e]   a per-bank correction, stored only for the slots that earn it.
//                Its rms is 26 against the base's 217, which is why it fits in
//                a byte.
//
// A slot earns its correction by `reads x correction^2` -- the read-weighted
// squared error paid for dropping it back to the base. Ranked that way, 4M of
// the 12.1M read slots hold the value function to a regret of 0.36 points of V
// and 8M to 0.14. (bot/agree.js measures that. The median gap between a
// position's best and second-best move is 11 points, so 0.14 is nothing.)
//
// COVERAGE IS THE WHOLE GAME. The same 4M-slot budget chosen from a 10M-board
// read count plays 440 +- 93 points worse than the full network; chosen from a
// 178M-board count, 107 +- 99 worse, and the 8M budget 42 +- 93. The difference
// is not which slots were kept, it is how many slots the counting pass had ever
// seen: at 10M boards 9.4% of afterstates in fresh play contain a slot the count
// table never saw, and fall back to `base`; at 178M boards 0.24% do. Count far
// more play than feels necessary -- it is cheap, and it is the whole result.
//
// AND THE COVERAGE IS OF *SELF-PLAY*, which bounds where the result holds. The
// counting pass walks the bot's own games, so the guarantee is about the bot's
// own distribution and nothing else. Measured on positions from human games, the
// error in the gap between two moves -- the quantity that decides anything -- is
// 26x larger:
//
//   positions          V error rms   move-gap rms   top move differs
//   bot self-play             3.02           3.74             7.1%
//   held-out human          177.37          98.26            19.6%
//
// Playing strength is untouched by this (the bot never visits those positions),
// so a strength benchmark cannot see it. Anything that *evaluates* off-policy
// positions can: see ANALYSIS.md.
//
// `--starts POOL` is the fix, and it is cheap. It begins a fraction of the
// counting games from stored positions (starts.js / hstarts.js format) and cuts
// them off after `--start-moves` plies, for the reason ptrain.js cuts its seeded
// episodes short: a game played out from a supplied position spends three plies
// near it and four hundred back in the bot's own distribution. Counting half the
// *boards* over human positions needs almost all the *games* to be seeded ones,
// because a full game contributes ~10 000 boards and a 10-ply one about 90.
//
//   node bot/shrink.js --in bot/weights/dom39c.bin --out bot/weights/dom39h.bins //        --keep 8000000 --games 512000 --jobs 4 //        --starts bot/data/human-train.bin --start-frac 0.977 --start-moves 10
//
// Measured, against the uncompressed dom39q:
//
//                              dom39s      dom39h
//   move-gap error, human pos  70.6        14.2
//   top move differs, human    11.4%       6.3%
//   move-gap error, bot pos    3.74        3.73
//   playing strength           +36 +- 98   +24 +- 112
//   size                       15 MB       17 MB
//
// 5x the accuracy off-distribution for 2 MB, and nothing given up on the
// distribution it already had. The counting pass sees 16.6M distinct slots
// instead of 12.1M, so the same 8M budget covers a smaller share of them -- and
// it still costs the bot side nothing, because the slots it now has to share
// with were the rarely-read ones anyway.
//
// The output is a 'CNTS' sparse file (see the sparse storage section of
// ntuple.js): base at int16, corrections at int8, and a two-level index over
// entries and banks. Every agent reads it exactly like an ordinary weight file
// -- `td:weights=bot/weights/dom39s.bins` just works. `--dense` additionally
// writes the same function as a full-size 'CNTP' file, for the tools that only
// know how to read `net.w`.
// ============================================================================

const fs = require('fs');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const NT = require('./ntuple.js');

// --- counting pass ----------------------------------------------------------
// Workers share one count array and increment it without atomics. A lost
// increment costs nothing: the counts only rank slots against each other, and
// no ranking here turns on a handful of reads.

function tally(net, cells, cnt) {
    const t = net.t, V = 7, BK = net.bank;
    cells = net.prepare(cells);
    const bank = net.preparedStage(cells) * BK;
    for (let k = 0; k < t.n; k++) {
        const o = t.off[k], l = t.len[k], b = bank + t.wbase[k];
        let a = 0, m = 0;
        for (let c = 0; c < l; c++) { a = a * V + cells[t.cells[o + c]]; m = m * V + cells[t.mcells[o + c]]; }
        if (net.self[k]) cnt[b + (a < m ? a : m)]++;
        else { cnt[b + a]++; cnt[b + m]++; }
    }
}

function countWorker() {
    const Collapse = require('./engine.js');
    const { wsab, csab, meta, from, to, eps, psab, startFrac, startMoves } = workerData;
    const net = new NT.Network(new Float32Array(wsab), meta);
    const cnt = new Uint32Array(csab);
    const pool = psab ? new Uint8Array(psab) : null;
    const poolSize = pool ? pool.length / 25 : 0;
    let rng = (from * 2654435761) >>> 0;
    const rand = () => { rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0; return rng / 4294967296; };
    let boards = 0;
    for (let seed = from; seed < to; seed++) {
        // A counting game either starts fresh or from a supplied position. The
        // ones that start from the pool are cut short, for the same reason
        // ptrain.js cuts its seeded episodes short: a game played out from a
        // human position spends 3 plies near it and 400 back in the bot's own
        // distribution, so without the cap the pool barely shifts the counts.
        const seeded = poolSize > 0 && rand() < startFrac;
        let g, cap = 20000;
        if (seeded) {
            const at = ((rand() * poolSize) | 0) * 25;
            g = Collapse.fromCells(pool.subarray(at, at + 25), seed);
            cap = startMoves;
        } else {
            g = new Collapse.Game(seed);
        }
        let ply = 0;
        while (!g.gameOver && ply < cap) {
            const moves = g.legalMoves();
            if (!moves.length) break;
            let best = null, bv = -Infinity;
            for (const m of moves) {
                const a = g.preview(m[0], m[1], Collapse.FILL_NONE);
                tally(net, a.cells, cnt); boards++;
                const v = (a.score - g.score) + net.value(a.cells);
                if (v > bv) { bv = v; best = m; }
            }
            // A little exploration widens what the count table has seen, and
            // what it has seen is what decides how well the compressed net plays.
            const mv = (eps > 0 && rand() < eps) ? moves[(rand() * moves.length) | 0] : best;
            g.apply(mv[0], mv[1]); ply++;
        }
        if ((seed - from + 1) % 500 === 0) parentPort.postMessage({ boards });
    }
    parentPort.postMessage({ boards, done: true });
}

// --- main -------------------------------------------------------------------

function parseArgs(argv) {
    const a = {
        in: 'bot/weights/dom39c.bin', out: null, dense: null, keep: 8000000, games: 24000, jobs: 4,
        seedBase: 20000000, eps: 0.02, counts: null, saveCounts: null, qbase: 16, qcorr: 8,
        starts: null, startFrac: 0.5, startMoves: 12
    };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--in') a.in = argv[++i];
        else if (k === '--out') a.out = argv[++i];
        else if (k === '--dense') a.dense = argv[++i];
        else if (k === '--keep') a.keep = Number(argv[++i]);
        else if (k === '--games') a.games = Number(argv[++i]);
        else if (k === '--jobs') a.jobs = Number(argv[++i]);
        else if (k === '--seed-base') a.seedBase = Number(argv[++i]);
        else if (k === '--eps') a.eps = Number(argv[++i]);
        else if (k === '--starts') a.starts = argv[++i];
        else if (k === '--start-frac') a.startFrac = Number(argv[++i]);
        else if (k === '--start-moves') a.startMoves = Number(argv[++i]);
        else if (k === '--counts') a.counts = argv[++i];
        else if (k === '--save-counts') a.saveCounts = argv[++i];
        else if (k === '--qbase') a.qbase = Number(argv[++i]);
        else if (k === '--qcorr') a.qcorr = Number(argv[++i]);
        else { console.error('unknown option ' + k); process.exit(1); }
    }
    if (!a.out) { console.error('--out is required'); process.exit(1); }
    return a;
}

async function countReads(ref, args) {
    const need = ref.w.length;
    const csab = new SharedArrayBuffer(need * 4);
    const cnt = new Uint32Array(csab);
    if (args.counts) {
        const b = fs.readFileSync(args.counts);
        cnt.set(new Uint32Array(b.buffer, b.byteOffset, need));
        console.log('read counts from ' + args.counts);
        return cnt;
    }
    // The reference's weights go in shared memory too, so N workers cost one
    // copy of a 290 MB table rather than N.
    const wsab = new SharedArrayBuffer(need * 4);
    new Float32Array(wsab).set(ref.w);
    // Optional: count over somewhere other than the bot's own play. Which slots
    // the pass has seen is the whole result, and it is only ever a guarantee
    // about the distribution it walked -- so a network that will be used to
    // evaluate human positions has to count over human positions.
    let psab = null;
    if (args.starts) {
        const cells = require('./starts.js').load(args.starts);
        psab = new SharedArrayBuffer(cells.length);
        new Uint8Array(psab).set(cells);
        console.log('count pool: ' + (cells.length / 25).toLocaleString() + ' positions from ' +
            args.starts + ', starting ' + (100 * args.startFrac).toFixed(0) + '% of games, ' +
            args.startMoves + ' plies each');
    }
    const per = Math.ceil(args.games / args.jobs);
    let boards = 0, done = 0;
    const t0 = Date.now();
    await new Promise(resolve => {
        for (let k = 0; k < args.jobs; k++) {
            const from = args.seedBase + k * per;
            const w = new Worker(__filename, {
                workerData: { wsab, csab, meta: ref.meta, from, to: from + per, eps: args.eps,
                    psab, startFrac: args.starts ? args.startFrac : 0, startMoves: args.startMoves }
            });
            let last = 0;
            w.on('message', m => {
                boards += m.boards - last; last = m.boards;
                process.stderr.write('  counting: ' + (boards / 1e6).toFixed(1) + 'M afterstates, ' +
                    ((Date.now() - t0) / 1000).toFixed(0) + 's   \r');
                if (m.done && ++done === args.jobs) resolve();
            });
        }
    });
    process.stderr.write('\n');
    console.log('counted ' + (boards / 1e6).toFixed(1) + 'M afterstates from ' + args.games + ' games');
    if (args.saveCounts) fs.writeFileSync(args.saveCounts, Buffer.from(cnt.buffer));
    return cnt;
}

async function main() {
    const args = parseArgs(process.argv);
    const ref = NT.load(args.in);
    const BK = ref.bank, S = ref.stages, t = ref.t, w = ref.w;
    console.log(args.in + ': ' + (w.length / 1e6).toFixed(1) + 'M weights, ' + S + ' banks x ' + t.n + ' tuples');
    const cnt = await countReads(ref, args);

    // base: read-weighted mean across banks. An entry no bank ever reads falls
    // back to the plain mean of the banks that have a trained value, which is
    // the best guess available for a pattern nobody has seen.
    const base = new Float32Array(BK);
    {
        const num = new Float64Array(BK), den = new Float64Array(BK);
        const nU = new Float64Array(BK), dU = new Float64Array(BK);
        for (let s = 0; s < S; s++) {
            const bs = s * BK;
            for (let i = 0; i < BK; i++) {
                const c = cnt[bs + i], v = w[bs + i];
                if (c) { num[i] += c * v; den[i] += c; }
                if (v !== 0) { nU[i] += v; dU[i]++; }
            }
        }
        for (let i = 0; i < BK; i++) {
            const v = den[i] ? num[i] / den[i] : (dU[i] ? nU[i] / dU[i] : 0);
            base[i] = isFinite(v) ? v : 0;
        }
    }
    // Rank slots by reads x correction^2 through a log histogram, so the cutoff
    // comes out of one pass rather than a sort of 73M elements.
    const NB = 8192, SCALE = 40, OFF = 60;
    const binOf = (s, i) => {
        const j = s * BK + i, c = cnt[j];
        if (!c) return -1;
        const d = w[j] - base[i], v = c * d * d;
        return v <= 0 ? 0 : Math.min(NB - 1, Math.max(0, Math.round((Math.log(v) + OFF) * SCALE)));
    };
    const hist = new Float64Array(NB);
    let read = 0;
    for (let s = 0; s < S; s++) for (let i = 0; i < BK; i++) { const b = binOf(s, i); if (b >= 0) { hist[b]++; read++; } }
    let acc = 0, cut = 0;
    for (let b = NB - 1; b >= 0; b--) { acc += hist[b]; if (acc >= args.keep) { cut = b; break; } }

    let kept = 0;
    for (let s = 0; s < S; s++) for (let i = 0; i < BK; i++) if (binOf(s, i) >= cut) kept++;

    const sp = NT.toSparse(ref, base, (s, e) => binOf(s, e) >= cut, { qbase: args.qbase, qcorr: args.qcorr });
    NT.save(args.out, sp);

    const bytes = sp.bytes, full = w.length * 4;
    // vals[] interleaves each entry's base with its corrections, so the split
    // is by what a byte is for rather than by array.
    const baseBytes = sp.rest.byteLength + sp.entries * 2;
    const corrBytes = sp.vals.byteLength - sp.entries * 2;
    const idxBytes = sp.idx.byteLength + sp.rec.byteLength;
    console.log('slots read at least once: ' + (read / 1e6).toFixed(2) + 'M of ' +
        (w.length / 1e6).toFixed(1) + 'M (' + (100 * read / w.length).toFixed(2) + '%)');
    console.log('kept ' + (kept / 1e6).toFixed(2) + 'M corrections, ' +
        (sp.corrections / 1e6).toFixed(2) + 'M of them nonzero after rounding, over ' +
        (sp.entries / 1e6).toFixed(2) + 'M entries');
    console.log('sparse size ' + (bytes / 1e6).toFixed(1) + ' MB: base ' +
        (baseBytes / 1e6).toFixed(1) + ' + corr ' + (corrBytes / 1e6).toFixed(1) +
        ' + index ' + (idxBytes / 1e6).toFixed(1));
    console.log('  ' + (full / bytes).toFixed(1) + 'x vs the float32 file, ' +
        (full / 2 / bytes).toFixed(1) + 'x vs int16');
    console.log('wrote ' + args.out);
    if (args.dense) {
        NT.save(args.dense, new NT.Network(sp.toDense(), ref.meta));
        console.log('wrote ' + args.dense + ' (the same function, full size)');
    }
}

if (isMainThread) main();
else countWorker();
