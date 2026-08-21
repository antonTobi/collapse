// ============================================================================
// N-tuple value network over board afterstates.
//
// An "afterstate" is the board immediately after a collapse and before the new
// tiles drop in — exactly what `preview(i, j, FILL_NONE)` produces. Cells hold
// 0..6 (0 = emptied by this collapse), so a 4-cell tuple has 7^4 = 2401 states.
//
// The value of a board is the sum of one table lookup per tuple. This is the
// standard 2048 architecture: a large, sparse, linear model over local patterns.
// It is fast to evaluate and, unlike a hand-written feature list, it can
// represent interactions between neighbouring cells.
//
// Three knobs:
//
//   set     which tuples to read. 'base' is the original 36 x 4-cell set;
//           bigger sets see longer-range structure at the cost of far more
//           weights (and far more data to fill them).
//   sym     also read every tuple on the left-right mirrored board, sharing one
//           table between the two. Mirroring is an exact symmetry of the rules
//           (gravity is vertical and the tile generator is exchangeable across
//           columns), so this doubles the training data each weight sees at no
//           cost in parameters.
//   stages  split the weights into independent banks by how many 6s are on the
//           board. The opening and the endgame are different games -- the
//           `s_*` interaction features in eval.js are the hand-written version
//           of the same idea -- and one bank has to average over both.
//
// Weight files are self-describing: a 'CNTP' header records set, symmetry and
// stage count, so an agent never has to be told how a file was trained.
// Headerless files (the original format) are read as base / 1 stage.
// ============================================================================

(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.CollapseNTuple = factory();
})(typeof self !== 'undefined' ? self : this, function () {

    const W = 5, H = 5, V = 7;
    const idx = (i, j) => i * H + j;

    // --- tuple sets ---------------------------------------------------------

    function squares() {
        const t = [];
        for (let i = 0; i < W - 1; i++)
            for (let j = 0; j < H - 1; j++)
                t.push([idx(i, j), idx(i + 1, j), idx(i, j + 1), idx(i + 1, j + 1)]);
        return t;
    }

    function runs(len) {
        const t = [];
        for (let j = 0; j < H; j++)
            for (let i = 0; i + len - 1 < W; i++)
                t.push(Array.from({ length: len }, (_, k) => idx(i + k, j)));
        for (let i = 0; i < W; i++)
            for (let j = 0; j + len - 1 < H; j++)
                t.push(Array.from({ length: len }, (_, k) => idx(i, j + k)));
        return t;
    }

    // Rectangular blocks capture 2-D shape that a straight run cannot: a
    // checkerboard and a solid block look the same to any single row.
    function blocks(bw, bh) {
        const t = [];
        for (let i = 0; i + bw - 1 < W; i++)
            for (let j = 0; j + bh - 1 < H; j++) {
                const cells = [];
                for (let a = 0; a < bw; a++) for (let b = 0; b < bh; b++) cells.push(idx(i + a, j + b));
                t.push(cells);
            }
        return t;
    }

    // A cell together with every orthogonal neighbour it has: a plus in the
    // middle of the board, a T on an edge, an L in a corner. No rectangular
    // shape contains one -- a plus does not fit inside a 2x3 -- so without
    // these the network can never read "this cell, and what is on all four
    // sides of it" from a single tuple, which is exactly the question
    // "how exposed is this 6" and its dual "is this hole walled in".
    function crosses() {
        const t = [];
        for (let i = 0; i < W; i++)
            for (let j = 0; j < H; j++) {
                const cells = [idx(i, j)];
                if (j > 0) cells.push(idx(i, j - 1));
                if (j < H - 1) cells.push(idx(i, j + 1));
                if (i > 0) cells.push(idx(i - 1, j));
                if (i < W - 1) cells.push(idx(i + 1, j));
                t.push(cells);
            }
        return t;
    }

    const SETS = {
        base: () => squares().concat(runs(4)),                                   // 36 tuples,   86 436 w
        rows: () => squares().concat(runs(4), runs(5)),                          // 46 tuples,  254 506 w
        blocks: () => squares().concat(runs(4), blocks(3, 2)),                   // 48 tuples, 1 498 224 w
        big: () => squares().concat(runs(4), runs(5), blocks(2, 3), blocks(3, 2)),// 70 tuples, 3 078 218 w
        // `big` with the cross shapes appended. The appended tuples come last,
        // so a `big` network's weights are exactly this one's leading prefix
        // and can be copied straight in -- see bot/grow.js.
        bigx: () => SETS.big().concat(crosses())                                 // 95 tuples, 3 259 476 w
    };

    const mirrorCell = k => (W - 1 - ((k / H) | 0)) * H + (k % H);

    // Pack a tuple list into flat arrays: `cells` holds every tuple's indices
    // back to back, off[t]/len[t] index into it, wbase[t] is where tuple t's
    // table starts. `mcells` is the same list read on the mirrored board.
    function pack(tuples) {
        const n = tuples.length;
        const off = new Int32Array(n), len = new Int32Array(n), wbase = new Int32Array(n);
        let cellCount = 0;
        for (let t = 0; t < n; t++) cellCount += tuples[t].length;
        const cells = new Int32Array(cellCount), mcells = new Int32Array(cellCount);
        let c = 0, total = 0;
        for (let t = 0; t < n; t++) {
            off[t] = c; len[t] = tuples[t].length; wbase[t] = total;
            for (const k of tuples[t]) { cells[c] = k; mcells[c] = mirrorCell(k); c++; }
            total += Math.pow(V, tuples[t].length);
        }
        return { n, off, len, wbase, cells, mcells, size: total };
    }

    const packed = {};
    function tupleSet(name) {
        const key = name || 'base';
        if (!packed[key]) {
            if (!SETS[key]) throw new Error('unknown tuple set "' + key + '". Known: ' + Object.keys(SETS).join(', '));
            packed[key] = pack(SETS[key]());
        }
        return packed[key];
    }

    // --- network ------------------------------------------------------------

    class Network {
        // opts: { set, sym, stages }
        constructor(weights, opts) {
            const o = opts || {};
            this.setName = o.set || 'base';
            this.t = tupleSet(this.setName);
            this.sym = !!o.sym;
            // `edges` gives the 6-counts where one bank ends and the next
            // begins: [3, 6] means bank 0 is 0-2 sixes, bank 1 is 3-5, bank 2 is
            // 6 and up. Without it the banks split the 0..16 range evenly, which
            // sounds fair and is not: positions are not spread evenly over
            // 6-count. With three even banks the agent spends 67% of its moves
            // in bank 0 and 6% in bank 2, so the endgame bank -- the one that
            // decides how games finish -- is the one starved of data.
            this.edges = o.edges && o.edges.length ? o.edges.slice() : null;
            // A second, independent banking dimension: how many separate groups
            // of 5s are on the board, capped at 2+. Measured over real play it
            // is 12% / 50% / 38% and correlates -0.06 with the 6-count, so it
            // partitions the same data along an axis the 6-count says nothing
            // about. (The obvious alternative -- how much connected playable
            // area is left -- turned out to correlate -0.999 with the 6-count,
            // because a strong agent always seals its 6s against a wall or
            // another 6, so the two carry the same information.)
            this.five = !!o.five;
            const sixBanks = this.edges ? this.edges.length + 1 : (o.stages && !this.five ? o.stages : 1);
            this.sixBanks = sixBanks;
            this.stages = sixBanks * (this.five ? 3 : 1);
            this.bank = this.t.size;
            const need = this.bank * this.stages;
            if (weights && weights.length !== need) {
                throw new Error('weight file has ' + weights.length + ' weights; set "' + this.setName +
                    '" x ' + this.stages + ' stage(s) needs ' + need);
            }
            this.w = weights || new Float32Array(need);
        }

        get meta() {
            const m = { set: this.setName, sym: this.sym, stages: this.stages };
            if (this.edges) m.edges = this.edges.slice();
            if (this.five) m.five = true;
            return m;
        }

        // Which bank a board with this many 6s and this many groups of 5s uses.
        // Splitting on the 6-count alone is the original scheme; `five` adds a
        // factor of three on top of it.
        bankFor(sixes, fives) {
            if (this.stages <= 1) return 0;
            let s;
            if (this.edges) {
                s = 0;
                while (s < this.edges.length && sixes >= this.edges[s]) s++;
            } else {
                s = (sixes * this.sixBanks / 17) | 0;
                if (s >= this.sixBanks) s = this.sixBanks - 1;
            }
            return this.five ? s * 3 + Math.min(2, fives || 0) : s;
        }

        // Which weight bank a board belongs to. Counted here rather than by
        // calling out, because this runs on every evaluation -- about a
        // thousand times per move under search. The 5-group flood fill uses a
        // 25-bit visited mask in one integer, so it allocates nothing and needs
        // no clearing between calls.
        stageOf(cells) {
            if (this.stages <= 1) return 0;
            let sixes = 0;
            for (let k = 0; k < 25; k++) if (cells[k] === 6) sixes++;
            if (!this.five) return this.bankFor(sixes, 0);

            // Groups of 5s by Euler characteristic rather than by flood fill:
            // for a polyomino, components = cells - adjacencies + independent
            // cycles, and the independent cycles are counted here as the filled
            // 2x2 squares. One straight pass instead of a stack-based fill,
            // which matters because this runs on every evaluation -- about a
            // thousand times per move under search.
            //
            // It is not an exact group count: a ring of 5s around a non-5 has a
            // cycle that no filled 2x2 accounts for, and it comes out one too
            // low. That happens on 12 boards in 200 000 of real play, and it
            // does not matter, because a bank only has to be a *deterministic*
            // partition of positions -- not a correct answer to any particular
            // question. The same board always lands in the same bank, which is
            // the only property the weights depend on.
            let n = 0, adj = 0, sq = 0;
            for (let i = 0; i < W; i++) {
                for (let j = 0; j < H; j++) {
                    const k = i * H + j;
                    if (cells[k] !== 5) continue;
                    n++;
                    const up = j < H - 1 && cells[k + 1] === 5;
                    const right = i < W - 1 && cells[k + H] === 5;
                    if (up) adj++;
                    if (right) adj++;
                    if (up && right && cells[k + H + 1] === 5) sq++;
                }
            }
            return this.bankFor(sixes, n - adj + sq);
        }

        value(cells) {
            const t = this.t, w = this.w, sym = this.sym;
            const bank = this.stages > 1 ? this.stageOf(cells) * this.bank : 0;
            let sum = 0;
            for (let k = 0; k < t.n; k++) {
                const o = t.off[k], l = t.len[k], b = bank + t.wbase[k];
                let a = 0, m = 0;
                for (let c = 0; c < l; c++) {
                    a = a * V + cells[t.cells[o + c]];
                    if (sym) m = m * V + cells[t.mcells[o + c]];
                }
                sum += w[b + a];
                if (sym) sum += w[b + m];
            }
            return sum;
        }

        // Spread one error over the tuples that produced the estimate.
        update(cells, delta) {
            const t = this.t, w = this.w, sym = this.sym;
            const bank = this.stages > 1 ? this.stageOf(cells) * this.bank : 0;
            const d = delta / (sym ? 2 * t.n : t.n);
            for (let k = 0; k < t.n; k++) {
                const o = t.off[k], l = t.len[k], b = bank + t.wbase[k];
                let a = 0, m = 0;
                for (let c = 0; c < l; c++) {
                    a = a * V + cells[t.cells[o + c]];
                    if (sym) m = m * V + cells[t.mcells[o + c]];
                }
                w[b + a] += d;
                if (sym) w[b + m] += d;
            }
        }
    }

    // --- temporal coherence -------------------------------------------------
    // Per-weight step size |sum of errors| / sum of |errors|. A weight whose
    // updates keep pulling the same way keeps a full step; one that is being
    // yanked back and forth by conflicting positions damps itself down. This is
    // the standard fix for n-tuple learning, where a single global alpha is
    // either too slow for rarely-seen tuples or too noisy for common ones.
    class TC {
        constructor(net) {
            this.net = net;
            this.E = new Float32Array(net.w.length);
            this.A = new Float32Array(net.w.length);
        }
        update(cells, delta) {
            const net = this.net, t = net.t, w = net.w, sym = net.sym, E = this.E, A = this.A;
            const bank = net.stages > 1 ? net.stageOf(cells) * net.bank : 0;
            const d = delta / (sym ? 2 * t.n : t.n);
            const ad = Math.abs(d);
            for (let k = 0; k < t.n; k++) {
                const o = t.off[k], l = t.len[k], b = bank + t.wbase[k];
                let a = 0, m = 0;
                for (let c = 0; c < l; c++) {
                    a = a * V + cells[t.cells[o + c]];
                    if (sym) m = m * V + cells[t.mcells[o + c]];
                }
                const ia = b + a;
                w[ia] += d * (A[ia] > 0 ? Math.abs(E[ia]) / A[ia] : 1);
                E[ia] += d; A[ia] += ad;
                if (sym) {
                    const im = b + m;
                    w[im] += d * (A[im] > 0 ? Math.abs(E[im]) / A[im] : 1);
                    E[im] += d; A[im] += ad;
                }
            }
        }
    }

    // --- file format --------------------------------------------------------
    // 'CNTP' | u32 padded json length | json meta | Float32 weights.
    // The json block is padded so the weights stay 4-byte aligned.

    const MAGIC = 0x50544e43;   // 'CNTP' little-endian

    // Typed arrays rather than Buffer, so the spectator can fetch() a weight
    // file straight into a network in the browser.
    function encode(net) {
        const json = new TextEncoder().encode(JSON.stringify(net.meta));
        const pad = (4 - (json.length % 4)) % 4;
        const head = 8 + json.length + pad;
        const out = new Uint8Array(head + net.w.byteLength);
        const view = new DataView(out.buffer);
        view.setUint32(0, MAGIC, true);
        view.setUint32(4, json.length + pad, true);
        out.set(json, 8);
        out.set(new Uint8Array(net.w.buffer, net.w.byteOffset, net.w.byteLength), head);
        return out;
    }

    // Accepts an ArrayBuffer, a Uint8Array or a Node Buffer.
    function decode(input, override) {
        const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
        const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
        let meta = { set: 'base', sym: false, stages: 1 };
        let offset = 0;
        if (u8.byteLength >= 8 && view.getUint32(0, true) === MAGIC) {
            const len = view.getUint32(4, true);
            const text = new TextDecoder().decode(u8.subarray(8, 8 + len));
            meta = JSON.parse(text.replace(/\0+$/, ''));
            offset = 8 + len;
        }
        // slice() copies, which also guarantees the 4-byte alignment Float32Array needs.
        const weights = new Float32Array(
            u8.buffer.slice(u8.byteOffset + offset, u8.byteOffset + u8.byteLength));
        return new Network(weights, Object.assign(meta, override || {}));
    }

    function save(file, net) {
        const fs = require('fs'), path = require('path');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, Buffer.from(encode(net)));
    }

    function load(file, override) {
        return decode(require('fs').readFileSync(file), override);
    }

    // Kept for the old log line in train.js.
    const NT = tupleSet('base').n;
    const SIZE = 2401;

    return { Network, TC, tupleSet, SETS, save, load, encode, decode, NT, SIZE, W, H, V };
});
