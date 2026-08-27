#!/usr/bin/env node
// ============================================================================
// Fold every subset-redundant tuple into a tuple that contains it.
//
//   node bot/compact.js --in bot/weights/dom21.bin --out bot/weights/dom21c.bin
//
// If tuple A's cells are a strict subset of tuple B's, then B's reading of the
// board determines A's reading of it. So A's whole table can be added into B's:
//
//     W_B[x] += w_A[project(x)]
//
// and A's lookup disappears. The value function is unchanged; only the work
// needed to compute it changes. On `domsr` this takes 78 tuples down to 28 --
// every domino, every 4-run, every 2x2 square and every T and L cross folds
// into the rows, blocks and plus shapes that contain them -- which is 64% fewer
// table lookups and 50% fewer cell reads for an identical function.
//
// This does NOT mean the folded tuples were wasted. They are worth a great deal
// while learning: a domino has 49 entries, so every one of them is visited
// constantly and generalises over the 23 cells it ignores, which is why adding
// them was worth +984. Coarse features earn their keep during training and cost
// nothing to give up afterwards, once the fine tables have absorbed what they
// taught. Compaction is a deployment step, not an architecture change -- train
// with the subsets, ship without them.
//
// The one subtlety is mirroring. With `sym`, a tuple is read twice (board and
// mirror) unless it is self-mirrored, in which case `selfOnce` reads it once at
// the canonical index. So a fold has to match how often each side is read, and
// there are four cases -- see foldInto() below. Getting this wrong is not a
// crash, it is a network that is quietly 5% wrong, which is why the check at
// the end compares the two networks on real afterstates before writing.
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

// digits of `x` in base 7, most significant first, as read into `len` cells
function digits(x, len) {
    const d = new Array(len);
    for (let i = len - 1; i >= 0; i--) { d[i] = x % V; x = (x / V) | 0; }
    return d;
}

// Permute an index: output position i takes the digit from input position
// perm[i]. Used both for projecting into a subset and for mirroring in place.
function permuteIndex(x, lenIn, perm) {
    const d = digits(x, lenIn);
    let y = 0;
    for (let i = 0; i < perm.length; i++) y = y * V + d[perm[i]];
    return y;
}

function main() {
    const args = parseArgs(process.argv);
    const src = NTuple.load(args.in);
    if (!src.sym) { console.error('compaction assumes a symmetric network'); process.exit(1); }
    if (!src.selfOnce) { console.error('expected selfOnce; run bot/reduce.js first'); process.exit(1); }

    const setName = src.setName + 'c';
    if (!NTuple.SETS[setName]) {
        console.error(`no compacted set "${setName}" is defined in ntuple.js`);
        process.exit(1);
    }
    const dst = new NTuple.Network(undefined, Object.assign({}, src.meta, { set: setName }));

    const st = src.t, dt = dst.t;
    const cellsOf = (t, k) => Array.from({ length: t.len[k] }, (_, i) => t.cells[t.off[k] + i]);
    const mcellsOf = (t, k) => Array.from({ length: t.len[k] }, (_, i) => t.mcells[t.off[k] + i]);
    const key = a => a.slice().sort((x, y) => x - y).join(',');

    // Which source tuple each destination tuple is, by cell set.
    const srcOf = new Map();
    for (let k = 0; k < st.n; k++) srcOf.set(key(cellsOf(st, k)), k);
    const dstHost = [];                       // dst index -> src index
    for (let k = 0; k < dt.n; k++) {
        const s = srcOf.get(key(cellsOf(dt, k)));
        if (s === undefined) { console.error('compacted tuple ' + k + ' is not in the source set'); process.exit(1); }
        dstHost.push(s);
    }

    // For a self-mirrored tuple, the permutation taking its board reading to its
    // mirror reading: output position i draws from the position holding the cell
    // that mirrors into slot i.
    function mirrorPerm(t, k) {
        const c = cellsOf(t, k), m = mcellsOf(t, k);
        return m.map(cell => c.indexOf(cell));
    }

    // Every source tuple is either kept (it is one of the dst tuples) or folded
    // into a dst tuple that strictly contains it. Prefer a host with the same
    // self-mirror status, because that fold is the simple one.
    const kept = new Set(dstHost);
    const plan = [];
    for (let a = 0; a < st.n; a++) {
        if (kept.has(a)) continue;
        const sa = new Set(cellsOf(st, a));
        const contains = d => {
            const sb = new Set(cellsOf(dt, d));
            if (sb.size <= sa.size) return false;
            for (const c of sa) if (!sb.has(c)) return false;
            return true;
        };
        let host = -1;
        for (let d = 0; d < dt.n; d++)
            if (contains(d) && st.selfMir[a] === dt.selfMir[d]) { host = d; break; }
        if (host < 0) for (let d = 0; d < dt.n; d++) if (contains(d)) { host = d; break; }
        if (host < 0) { console.error('no host contains source tuple ' + a); process.exit(1); }
        plan.push({ a, host });
    }

    // Copy the kept tables across (their offsets differ between the two sets).
    for (let d = 0; d < dt.n; d++) {
        const a = dstHost[d], size = Math.pow(V, dt.len[d]);
        const from = st.wbase[a], to = dt.wbase[d];
        for (let i = 0; i < size; i++) dst.w[to + i] = src.w[from + i];
    }

    // Fold the rest in.
    //
    //   A read twice, B read twice   W_B[x] += w_A[p(x)]
    //   A read once,  B read once    W_B[x] += w_A[canon_A(p(x))]
    //   A read once,  B read twice   W_B[x] += w_A[canon_A(p(x))] / 2
    //   A read twice, B read once    W_B[x] += w_A[p(x)] + w_A[p(mirror_B(x))]
    //
    // In each case the totals over B's actual reads come to exactly what A
    // contributed before. The last case is the interesting one: B is read a
    // single time at its canonical index, so that one read has to carry both of
    // A's readings, which it can because mirror_B(x) is B's other orientation.
    function foldInto(p, a, d) {
        const lenA = st.len[a], lenB = dt.len[d];
        const sizeB = Math.pow(V, lenB);
        const selfA = st.selfMir[a], selfB = dt.selfMir[d];
        const permA = selfA ? mirrorPerm(st, a) : null;
        const permB = selfB ? mirrorPerm(dt, d) : null;
        const canonA = x => {
            const m = permuteIndex(x, lenA, permA);
            return x < m ? x : m;
        };
        const from = st.wbase[a], to = dt.wbase[d];
        for (let x = 0; x < sizeB; x++) {
            const pa = permuteIndex(x, lenB, p);
            let add;
            if (!selfA && !selfB) add = src.w[from + pa];
            else if (selfA && selfB) add = src.w[from + canonA(pa)];
            else if (selfA && !selfB) add = 0.5 * src.w[from + canonA(pa)];
            else add = src.w[from + pa] + src.w[from + permuteIndex(permuteIndex(x, lenB, permB), lenB, p)];
            dst.w[to + x] += add;
        }
    }

    for (const { a, host } of plan) {
        const cA = cellsOf(st, a), cB = cellsOf(dt, host);
        const p = cA.map(c => cB.indexOf(c));
        if (p.some(i => i < 0)) { console.error('projection failed for tuple ' + a); process.exit(1); }
        foldInto(p, a, host);
    }

    // The claim is that the two networks compute the same function, so check it
    // on the boards a real game produces rather than on anything convenient.
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
        console.error('compacted network disagrees with the original (max ' + worst + ') — not writing');
        process.exit(1);
    }

    NTuple.save(args.out, dst);
    const reads = t => { let n = 0; for (let k = 0; k < t.n; k++) n += t.len[k]; return n; };
    console.log(`${args.in}   ${st.n} tuples, ${st.n} lookups, ${reads(st)} cell reads, ${src.w.length.toLocaleString()} weights`);
    console.log(`${args.out}   ${dt.n} tuples, ${dt.n} lookups, ${reads(dt)} cell reads, ${dst.w.length.toLocaleString()} weights`);
    console.log(`folded ${plan.length} tuples away`);
    console.log(`agree on ${checked.toLocaleString()} real afterstates (max difference ${worst.toExponential(2)} on values up to ${scale.toFixed(0)})`);
}

main();
