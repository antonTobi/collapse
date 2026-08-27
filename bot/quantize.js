#!/usr/bin/env node
// ============================================================================
// Store a trained network's weights as int16 instead of float32.
//
//   node bot/quantize.js --in bot/weights/dom21c.bin --out bot/weights/dom21q.bin
//
// Evaluation is memory-bound: the table is far larger than any cache, so most
// of a lookup is waiting for a load. Halving the load width is worth about 1.3x
// measured, on top of whatever bot/compact.js already bought.
//
// The scale is per (bank, tuple), not global, and that detail is the whole
// difference between free and costly. With one scale for the network, a single
// outlier weight -- max |w| is 1449 against a typical magnitude of 18 -- sets
// the step size for every table and the result loses 106 +- 81. Scoped to a
// table it loses 16 +- 67, with 38 of 200 games played identically.
//
// Deployment only: Network.update() refuses a quantised table, because every
// TD increment is far smaller than the step size and would round to nothing.
// ============================================================================

const NTuple = require('./ntuple.js');
const Collapse = require('./engine.js');

function parseArgs(argv) {
    const a = { in: null, out: null };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--in') a.in = argv[++i];
        else if (k === '--out') a.out = argv[++i];
        else { console.error('unknown option ' + k); process.exit(1); }
    }
    if (!a.in || !a.out) { console.error('--in and --out are required'); process.exit(1); }
    return a;
}

function main() {
    const args = parseArgs(process.argv);
    const src = NTuple.load(args.in);
    if (src.q16) { console.error(args.in + ' is already quantised'); process.exit(1); }

    const dst = new NTuple.Network(undefined, Object.assign({}, src.meta, { q16: true }));
    const t = src.t;
    for (let k = 0; k < t.n; k++) {
        const size = Math.pow(NTuple.V, t.len[k]);
        const o = t.wbase[k];
        let mx = 0;
        for (let i = 0; i < size; i++) { const v = Math.abs(src.w[o + i]); if (v > mx) mx = v; }
        const s = mx > 0 ? mx / 32767 : 1;
        dst.scale[k] = s;
        for (let i = 0; i < size; i++) dst.w[o + i] = Math.round(src.w[o + i] / s);
    }

    // Check on the boards a real game produces, not on anything convenient.
    const agent = require('./agents.js').createAgent('td:weights=' + args.in, { seed: 1 });
    let worst = 0, scale = 0, checked = 0;
    for (let seed = 1; seed <= 8; seed++) {
        const g = new Collapse.Game(seed);
        while (!g.gameOver && g.moves.length < 600) {
            for (const m of g.legalMoves()) {
                const a = g.preview(m[0], m[1], Collapse.FILL_NONE).cells;
                const x = src.value(a), y = dst.value(a);
                worst = Math.max(worst, Math.abs(x - y));
                scale = Math.max(scale, Math.abs(x));
                checked++;
            }
            const mv = agent.chooseMove(g);
            if (!mv) break;
            g.apply(mv[0], mv[1]);
        }
    }

    NTuple.save(args.out, dst);
    const mb = n => (n / (1 << 20)).toFixed(0) + ' MB';
    console.log(`${args.in}   float32, ${mb(src.w.length * 4)}`);
    console.log(`${args.out}   int16,   ${mb(dst.w.length * 2 + dst.scale.length * 4)}`);
    console.log(`agree on ${checked.toLocaleString()} real afterstates (max difference ${worst.toFixed(3)} on values up to ${scale.toFixed(0)})`);
}

main();
