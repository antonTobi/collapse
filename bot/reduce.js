#!/usr/bin/env node
// ============================================================================
// Remove the mirror-duplicated half of a network's tuples.
//
//   node bot/reduce.js --in bot/weights/bigx-s7.bin --out bot/weights/bigxr-s7.bin
//
// With `sym` on, every tuple is read twice: once on the board and once on the
// left-right mirrored board, both into the same table. The tuple sets here are
// closed under mirroring -- for all but the 17 self-mirrored shapes, the mirror
// of tuple k is itself another tuple k' in the list. That makes k and k' receive
// *identical* updates at identical indices, so their tables converge to the same
// thing and the sum counts each distinct contribution twice.
//
// Measured on the trained 95-tuple network: the two tables of a mirror pair
// differ by an RMS of 0.10 against an RMS magnitude of 32, i.e. 0.3%, and that
// residual is Hogwild write races rather than anything learned.
//
// Dropping one of each pair and folding its table into the survivor is exact,
// not approximate:
//
//     pair contribution = w_k[a_k] + w_k[m_k] + w_k'[a_k'] + w_k'[m_k']
//                       = w_k[a_k] + w_k[m_k] + w_k'[s(m_k)] + w_k'[s(a_k)]
//                       = W[a_k] + W[m_k]        with  W[x] = w_k[x] + w_k'[s(x)]
//
// where `a` is the reading on the board, `m` the reading on the mirror, and `s`
// permutes the digits of an index (the two tuples list the same cells in
// different orders). 95 tuples become 56: 40% fewer table reads per evaluation
// and 40% less memory, computing the same function.
// ============================================================================

const NTuple = require('./ntuple.js');
const Collapse = require('./engine.js');

const V = 7;

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

// Pair each tuple with the tuple holding its mirrored cells. Returns the
// representatives in order, plus for each one the partner it absorbs and the
// position permutation relating their cell lists.
function mirrorPairs(t) {
    const cellsOf = k => Array.from({ length: t.len[k] }, (_, i) => t.cells[t.off[k] + i]);
    const mcellsOf = k => Array.from({ length: t.len[k] }, (_, i) => t.mcells[t.off[k] + i]);
    const setKey = a => a.slice().sort((x, y) => x - y).join(',');

    const bySet = new Map();
    for (let k = 0; k < t.n; k++) bySet.set(setKey(cellsOf(k)), k);

    const out = [], taken = new Set();
    for (let k = 0; k < t.n; k++) {
        if (taken.has(k)) continue;
        taken.add(k);
        const partner = bySet.get(setKey(mcellsOf(k)));
        if (partner === undefined || partner === k) { out.push({ keep: k, drop: -1, perm: null }); continue; }
        taken.add(partner);
        // cells[partner][i] === mcells[k][perm[i]]
        const mk = mcellsOf(k), cp = cellsOf(partner);
        const perm = cp.map(c => mk.indexOf(c));
        if (perm.some(p => p < 0)) throw new Error('tuple ' + k + ' and ' + partner + ' do not cover the same cells');
        out.push({ keep: k, drop: partner, perm });
    }
    return out;
}

// index -> index, permuting the base-7 digits by `perm`
function permuteIndex(x, len, perm) {
    const d = new Array(len);
    for (let i = len - 1; i >= 0; i--) { d[i] = x % V; x = (x / V) | 0; }
    let y = 0;
    for (let i = 0; i < len; i++) y = y * V + d[perm[i]];
    return y;
}

function main() {
    const args = parseArgs(process.argv);
    const src = NTuple.load(args.in);
    if (!src.sym) { console.error('the reduction only applies to a symmetric network'); process.exit(1); }

    const t = src.t;
    const pairs = mirrorPairs(t);
    const setName = src.setName + 'r';
    if (!NTuple.SETS[setName]) {
        console.error(`no reduced set "${setName}" is defined in ntuple.js for "${src.setName}"`);
        process.exit(1);
    }
    const dst = new NTuple.Network(undefined, Object.assign({}, src.meta, { set: setName }));
    if (dst.t.n !== pairs.length) {
        console.error(`reduced set has ${dst.t.n} tuples but the reduction produced ${pairs.length}`);
        process.exit(1);
    }

    for (let bank = 0; bank < src.stages; bank++) {
        const so = bank * src.bank, dobase = bank * dst.bank;
        pairs.forEach((p, r) => {
            const len = t.len[p.keep], size = Math.pow(V, len);
            const from = so + t.wbase[p.keep], to = dobase + dst.t.wbase[r];
            for (let i = 0; i < size; i++) dst.w[to + i] = src.w[from + i];
            if (p.drop >= 0) {
                const other = so + t.wbase[p.drop];
                for (let i = 0; i < size; i++) dst.w[to + i] += src.w[other + permuteIndex(i, len, p.perm)];
            }
        });
    }

    // The only claim worth making is that the two networks agree, so check it on
    // boards a real game produces rather than on anything convenient.
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
    if (worst > 1e-2) {
        console.error('reduced network disagrees with the original (max ' + worst + ') — not writing');
        process.exit(1);
    }

    NTuple.save(args.out, dst);
    const lk = a => { let n = 0; for (let k = 0; k < a.n; k++) n += a.len[k]; return n * 2; };
    console.log(`${args.in}   ${t.n} tuples, ${lk(t)} reads/eval, ${src.w.length.toLocaleString()} weights`);
    console.log(`${args.out}   ${dst.t.n} tuples, ${lk(dst.t)} reads/eval, ${dst.w.length.toLocaleString()} weights`);
    console.log(`agree on ${checked.toLocaleString()} real afterstates (max difference ${worst.toExponential(2)} on values up to ${scale.toFixed(0)})`);
}

main();
