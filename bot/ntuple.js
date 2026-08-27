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
//
// The opening and the endgame are different games; the network tells them apart
// through virtual-cell global features (6-count, 5s, exposed-6s, mobility,
// column heights -- see GLOBAL / prepare), read by the tuples like any other
// cell, rather than by splitting the weights into separate banks.
//
// Weight files are self-describing: a 'CNTP' header records set and symmetry, so
// an agent never has to be told how a file was trained. Headerless files (the
// original format) are read as the `base` set. `decode` returns a Network, which
// every agent uses through the same `value(cells)`.
// ============================================================================

(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.CollapseNTuple = factory();
})(typeof self !== 'undefined' ? self : this, function () {

    const W = 5, H = 5, V = 7;
    const BOARD_CELLS = W * H;
    const idx = (i, j) => i * H + j;

    // Global categorical features live after the 25 physical cells. They are
    // deliberately also 0..6, so a tuple can mix board cells and global facts
    // without changing the base-7 tables or the weight-file format. Adding a
    // new global feature is now one extractor entry and one tuple, rather than
    // another complete bank of every local table.
    //
    // These five replaced an earlier eight-feature layout when the weight-bank
    // system was retired: the new architecture carries all global conditioning
    // through virtual cells instead of banks, so the board input is exactly 25
    // physical + 5 virtual = 30 cells. Each feature is bucketed to 0..6 (five
    // components to 0..3) to mirror the physical tile range.
    const GLOBAL = Object.freeze({
        ZEROES: BOARD_CELLS,          // holes, grouped in pairs: 1-2->0, 3-4->1, ... 13+->6
        FIVES: BOARD_CELLS + 1,       // raw 5-count in pairs: 0-1->0, 2-3->1, ... 12+->6
        SIXES: BOARD_CELLS + 2,       // raw 6-count in pairs: 0-1->0, 2-3->1, ... 12+->6
        FIVE_COMP: BOARD_CELLS + 3,   // Euler-estimated 5-components: 0,1,2,3+
        EXPOSED: BOARD_CELLS + 4,     // 6s with >=3 in-bounds non-6 neighbours, 0..6+
        // Mobility on the afterstate: a tile is a canonical legal move iff nothing
        // equal sits directly below it (else clicking either yields the same board)
        // and some orthogonal neighbour equals it (a chain of >=2 to collapse).
        // On a FILL_NONE afterstate this is a lower bound on post-refill mobility.
        LEGAL: BOARD_CELLS + 5,       // canonical legal moves, raw 0..6+
        LEGAL_NO6: BOARD_CELLS + 6,   // those not collapsing a 5 into a 6 (tile 1..4), 0..6+
        // Per-column height of the highest 6 (0 = none), 0..5. Not mirror-
        // invariant: HEIGHTi <-> HEIGHT(W-1-i) under the left-right mirror, which
        // mirrorCell handles so --sym/reduce stay exact.
        HEIGHT0: BOARD_CELLS + 7,
        HEIGHT1: BOARD_CELLS + 8,
        HEIGHT2: BOARD_CELLS + 9,
        HEIGHT3: BOARD_CELLS + 10,
        HEIGHT4: BOARD_CELLS + 11
    });
    const GLOBAL_NAMES = Object.freeze({
        [GLOBAL.ZEROES]: 'zeroes / pairs (13+ capped)',
        [GLOBAL.FIVES]: '5-count / pairs (12+ capped)',
        [GLOBAL.SIXES]: '6-count / pairs (12+ capped)',
        [GLOBAL.FIVE_COMP]: '5-components (3+ capped)',
        [GLOBAL.EXPOSED]: 'exposed 6s, >=3 non-6 nbrs (6+ capped)',
        [GLOBAL.LEGAL]: 'canonical legal moves (6+ capped)',
        [GLOBAL.LEGAL_NO6]: 'legal moves not making a 6 (6+ capped)',
        [GLOBAL.HEIGHT0]: 'height of highest 6 in column 0 (0..5)',
        [GLOBAL.HEIGHT1]: 'height of highest 6 in column 1 (0..5)',
        [GLOBAL.HEIGHT2]: 'height of highest 6 in column 2 (0..5)',
        [GLOBAL.HEIGHT3]: 'height of highest 6 in column 3 (0..5)',
        [GLOBAL.HEIGHT4]: 'height of highest 6 in column 4 (0..5)'
    });
    const INPUT_CELLS = BOARD_CELLS + Object.keys(GLOBAL).length;

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


    // The five global features as one pure-global tuple.
    const GVEC = [GLOBAL.ZEROES, GLOBAL.FIVES, GLOBAL.SIXES, GLOBAL.FIVE_COMP, GLOBAL.EXPOSED];

    // Small from-scratch architecture: pure local shapes, one pure-global tuple,
    // and a hybrid per (size-4 shape, global feature). The hybrids let the same
    // local shape mean something different in an open board, a sealed endgame or
    // a fragmented board, without any weight banks. Global conditioning comes
    // only through these virtual cells; see GLOBAL above.
    function miniHybrids() {
        const t = [];
        for (const sq of squares().concat(runs(4)))
            for (const g of GVEC) t.push(sq.concat(g));
        return t;
    }

    // Hybridise each shape in `shapes` with each global in `gv`: one tuple per
    // (shape, feature) pair, so the same local shape can mean different things in
    // different global contexts. Used to build the deployed `mini5_all7` set.
    function hybridsOf(shapes, gv) {
        const t = [];
        for (const s of shapes) for (const g of gv) t.push(s.concat(g));
        return t;
    }

    // Height arm: one pure-global tuple of all five column heights, plus a hybrid
    // per domino carrying the height feature(s) of the column(s) it occupies --
    // vertical dominoes take their own column, horizontal ones both columns.
    const GVEC7 = [GLOBAL.ZEROES, GLOBAL.FIVES, GLOBAL.SIXES, GLOBAL.FIVE_COMP, GLOBAL.EXPOSED, GLOBAL.LEGAL, GLOBAL.LEGAL_NO6];
    const HEIGHTVEC = [GLOBAL.HEIGHT0, GLOBAL.HEIGHT1, GLOBAL.HEIGHT2, GLOBAL.HEIGHT3, GLOBAL.HEIGHT4];
    function heightDomHybrids() {
        const t = [];
        for (let i = 0; i < W; i++) for (let j = 0; j + 1 < H; j++)
            t.push([i * H + j, i * H + j + 1, GLOBAL.HEIGHT0 + i]);
        for (let j = 0; j < H; j++) for (let i = 0; i + 1 < W; i++)
            t.push([i * H + j, (i + 1) * H + j, GLOBAL.HEIGHT0 + i, GLOBAL.HEIGHT0 + i + 1]);
        return t;
    }

    const SETS = {
        // Small single-bank set with virtual-cell globals, trained from scratch.
        // runs() already emits both orientations, so runs(2..5) covers every
        // 1xL / Lx1 shape; squares() covers all 2x2 blocks.
        mini5: () => runs(2).concat(runs(3), runs(4), runs(5), squares(),
            [GVEC.slice()], miniHybrids()),
        // Full new architecture for the long (3M) run: every winning family at
        // once -- all 7 scalar globals on both the size-4 shapes and the dominoes,
        // heights on dominoes, and three pure-global tuples (board-shape, mobility,
        // and column-height). GVEC7 = the 7 mirror-invariant scalar globals.
        mini5_all7: () => runs(2).concat(runs(3), runs(4), runs(5), squares(),
            [GVEC.slice()], miniHybrids(),
            hybridsOf(squares().concat(runs(4)), [GLOBAL.LEGAL, GLOBAL.LEGAL_NO6]),
            hybridsOf(runs(2), GVEC7),
            [[GLOBAL.ZEROES, GLOBAL.SIXES, GLOBAL.EXPOSED, GLOBAL.LEGAL, GLOBAL.LEGAL_NO6]],
            [HEIGHTVEC.slice()], heightDomHybrids()),
        // `all7` plus two more global-only tuples: contrib.js shows pure-global
        // tuples are the highest-impact type per table, so mix the high-signal
        // globals -- one bringing the (mirror-invariant) centre-column height in
        // beside sealing+mobility, one an all-scalar endgame-danger cluster.
        mini5_all7g: () => SETS.mini5_all7().concat(
            [[GLOBAL.HEIGHT2, GLOBAL.SIXES, GLOBAL.EXPOSED, GLOBAL.LEGAL, GLOBAL.ZEROES]],
            [[GLOBAL.SIXES, GLOBAL.EXPOSED, GLOBAL.LEGAL, GLOBAL.LEGAL_NO6, GLOBAL.FIVE_COMP]]),

        base: () => squares().concat(runs(4)),                                   // 36 tuples,   86 436 w
    };

    // With `sym` on, the mirror of a tuple is another tuple in these sets, and
    // the two get identical updates -- so half the tables are duplicates and
    // half the reads are wasted. Keeping one of each mirror pair computes the
    // same function with 40% fewer reads. bot/reduce.js converts a trained
    // network; training a reduced set from zeros needs no conversion at all.
    function mirrorReduce(tuples) {
        const mirror = t => t.map(mirrorCell);
        const setKey = a => a.slice().sort((x, y) => x - y).join(',');
        const index = new Map();
        tuples.forEach((t, i) => index.set(setKey(t), i));
        const out = [], taken = new Set();
        tuples.forEach((t, i) => {
            if (taken.has(i)) return;
            taken.add(i);
            const partner = index.get(setKey(mirror(t)));
            if (partner !== undefined) taken.add(partner);
            out.push(t);
        });
        return out;
    }
    for (const name of Object.keys(SETS)) {
        const build = SETS[name];
        SETS[name + 'r'] = () => mirrorReduce(build());
    }

    // A tuple whose cells are a strict subset of another tuple's is redundant
    // *after training*: the larger tuple's reading determines the smaller one's,
    // so the smaller table can be added into the larger one and its lookup
    // dropped. This is not the same claim as "subset tuples are useless" -- they
    // are worth a lot while learning, because a 49-entry domino table is visited
    // constantly and generalises over everything it does not look at. The
    // coarseness earns its keep during training and costs nothing to give up
    // afterwards, because the fine table has by then absorbed what it taught.
    // bot/compact.js does the folding; this only defines the resulting shape.
    function subsetCompact(tuples) {
        const sets = tuples.map(t => new Set(t));
        const strictSub = (a, b) => {
            if (sets[a].size >= sets[b].size) return false;
            for (const c of sets[a]) if (!sets[b].has(c)) return false;
            return true;
        };
        return tuples.filter((_, a) => !tuples.some((__, b) => strictSub(a, b)));
    }
    for (const name of Object.keys(SETS)) {
        const build = SETS[name];
        SETS[name + 'c'] = () => subsetCompact(build());
    }


    // Most global features are whole-board scalars, hence mirror-invariant, so a
    // tuple can mix physical and virtual cells and reuse the mirror machinery
    // unchanged. The exception is the per-column HEIGHT features: the left-right
    // mirror swaps column i with W-1-i, so HEIGHTi must map to HEIGHT(W-1-i) for
    // the mirror reading (and reduction) to stay exact.
    const mirrorCell = k => {
        if (k >= BOARD_CELLS)
            return (k >= GLOBAL.HEIGHT0 && k <= GLOBAL.HEIGHT0 + (W - 1))
                ? GLOBAL.HEIGHT0 + (W - 1) - (k - GLOBAL.HEIGHT0) : k;
        return (W - 1 - ((k / H) | 0)) * H + (k % H);
    };

    // Pack a tuple list into flat arrays: `cells` holds every tuple's indices
    // back to back, off[t]/len[t] index into it, wbase[t] is where tuple t's
    // table starts. `mcells` is the same list read on the mirrored board.
    function pack(tuples) {
        const n = tuples.length;
        const off = new Int32Array(n), len = new Int32Array(n), wbase = new Int32Array(n);
        // A tuple whose mirror is itself -- a full-width row, anything centred on
        // the middle column. Its two readings are the same cells in a different
        // order, so its table ends up internally symmetric (w[x] == w[mirror x],
        // measured at 0.1% RMS on the trained network) and the two reads return
        // the same number. Reading the smaller of the two indices once is
        // therefore exact, and it is the symmetry that makes it safe: the value
        // stays mirror-invariant because both orderings map to the same entry.
        const selfMir = new Int8Array(n);
        let cellCount = 0;
        for (let t = 0; t < n; t++) cellCount += tuples[t].length;
        const cells = new Int32Array(cellCount), mcells = new Int32Array(cellCount);
        let c = 0, total = 0;
        for (let t = 0; t < n; t++) {
            off[t] = c; len[t] = tuples[t].length; wbase[t] = total;
            for (const k of tuples[t]) { cells[c] = k; mcells[c] = mirrorCell(k); c++; }
            const own = tuples[t].slice().sort((a, b) => a - b).join(',');
            const mir = tuples[t].map(mirrorCell).sort((a, b) => a - b).join(',');
            selfMir[t] = own === mir ? 1 : 0;
            total += Math.pow(V, tuples[t].length);
        }
        let hasGlobal = false;
        for (let k = 0; k < cells.length; k++) if (cells[k] >= BOARD_CELLS) { hasGlobal = true; break; }
        return { n, off, len, wbase, cells, mcells, selfMir, hasGlobal, size: total };
    }

    // Stands in for selfMir when the optimisation is off, so the hot loop keeps
    // the same shape either way.
    const NO_SELF = new Int8Array(256);

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
        // opts: { set, sym, selfOnce, q16 }. Global board state enters through
        // virtual-cell features (see GLOBAL / prepare), not weight banks, so a
        // network is a single flat table per tuple.
        constructor(weights, opts) {
            const o = opts || {};
            this.setName = o.set || 'base';
            this.t = tupleSet(this.setName);
            this.sym = !!o.sym;
            const need = this.t.size;
            if (weights && weights.length !== need) {
                throw new Error('weight file has ' + weights.length + ' weights; set "' +
                    this.setName + '" needs ' + need);
            }
            // Deployment-only int16 storage. Evaluation is memory-bound -- the
            // table is far larger than cache -- so halving the load width is
            // worth about 1.3x. The scale is per (bank, tuple): with one global
            // scale a single outlier weight of 1449 against a typical 18 sets
            // the step size for every table and costs ~100 points, while
            // per-table scaling costs -16 +- 67, i.e. nothing.
            this.q16 = !!o.q16;
            this.w = weights || (this.q16 ? new Int16Array(need) : new Float32Array(need));
            this.scale = this.q16 ? (o.scale || new Float32Array(this.t.n)) : null;
            // Opt-in, because it changes what a given table of weights means: a
            // self-mirrored tuple contributes one term instead of two. Files
            // trained without it keep their old semantics, and bot/reduce.js
            // produces files that have it (folding each pair of entries into
            // one as it goes).
            this.selfOnce = !!o.selfOnce && this.sym;
            this.self = this.selfOnce ? this.t.selfMir : NO_SELF;
            let sc = 0;
            if (this.selfOnce) for (let k = 0; k < this.t.n; k++) sc += this.t.selfMir[k];
            this.selfCount = sc;
            this.selfPrefix = new Int16Array(this.t.n + 1);
            for (let k = 0; k < this.t.n; k++) this.selfPrefix[k + 1] = this.selfPrefix[k] + this.self[k];

            // Reused scratch for global feature extraction. No allocation is
            // performed in value(), including under a many-node phone search.
            this.featureInput = this.t.hasGlobal ? new Uint8Array(INPUT_CELLS) : null;
        }

        get meta() {
            const m = { set: this.setName, sym: this.sym };
            if (this.selfOnce) m.selfOnce = true;
            if (this.q16) m.q16 = true;
            return m;
        }


        // Materialise the global virtual cells for tuple sets that use them. This
        // is a single allocation-free board pass. The 5-component count uses an
        // Euler approximation: components = cells - adjacencies
        // + filled 2x2 squares. A 6 is "exposed" when at least three of its
        // in-bounds orthogonal neighbours are not 6 (walls do not count, so a
        // corner 6 -- two neighbours -- can never be exposed).
        prepare(cells) {
            if (!this.featureInput) return cells;
            const out = this.featureInput;
            let holes = 0, sixes = 0, exposed = 0, fiveN = 0, fiveAdj = 0, fiveSq = 0;
            let legal = 0, legalNo6 = 0;
            for (let i = 0; i < W; i++) for (let j = 0; j < H; j++) {
                const k = i * H + j, v = cells[k]; out[k] = v;
                if (v === 0) { holes++; continue; }
                if (v === 6) {
                    sixes++;
                    let non6 = 0;
                    if (i > 0 && cells[k - H] !== 6) non6++;
                    if (i + 1 < W && cells[k + H] !== 6) non6++;
                    if (j > 0 && cells[k - 1] !== 6) non6++;
                    if (j + 1 < H && cells[k + 1] !== 6) non6++;
                    if (non6 >= 3) exposed++;
                    continue;
                }
                if (v === 5) {
                    fiveN++;
                    const up = j + 1 < H && cells[k + 1] === 5;
                    const right = i + 1 < W && cells[k + H] === 5;
                    if (up) fiveAdj++;
                    if (right) fiveAdj++;
                    if (up && right && cells[k + H + 1] === 5) fiveSq++;
                }
                // v in 1..5: a canonical legal move iff nothing equal directly
                // below (else non-canonical) and some other neighbour equals it.
                if (j === 0 || cells[k - 1] !== v) {
                    if ((j + 1 < H && cells[k + 1] === v) ||
                        (i > 0 && cells[k - H] === v) ||
                        (i + 1 < W && cells[k + H] === v)) {
                        legal++;
                        if (v <= 4) legalNo6++;   // a 5-collapse mints a 6
                    }
                }
            }

            // Per-column height of the highest 6 (0 = none), 0..5.
            for (let i = 0; i < W; i++) {
                let hi = 0;
                for (let j = 0; j < H; j++) if (cells[i * H + j] === 6) hi = j + 1;
                out[GLOBAL.HEIGHT0 + i] = hi;
            }

            const fiveGroups = fiveN - fiveAdj + fiveSq;

            out[GLOBAL.ZEROES] = Math.min(6, ((holes > 0 ? holes - 1 : 0) / 2) | 0);
            out[GLOBAL.FIVES] = Math.min(6, (fiveN / 2) | 0);
            out[GLOBAL.SIXES] = Math.min(6, (sixes / 2) | 0);
            out[GLOBAL.FIVE_COMP] = Math.min(3, Math.max(0, fiveGroups));
            out[GLOBAL.EXPOSED] = Math.min(6, exposed);
            out[GLOBAL.LEGAL] = Math.min(6, legal);
            out[GLOBAL.LEGAL_NO6] = Math.min(6, legalNo6);
            return out;
        }

        value(cells) {
            const t = this.t, w = this.w, sym = this.sym, self = this.self;
            if (this.q16) return this.valueQ(cells);
            cells = this.prepare(cells);
            let sum = 0;
            for (let k = 0; k < t.n; k++) {
                const o = t.off[k], l = t.len[k], b = t.wbase[k];
                let a = 0, m = 0;
                for (let c = 0; c < l; c++) {
                    a = a * V + cells[t.cells[o + c]];
                    if (sym) m = m * V + cells[t.mcells[o + c]];
                }
                if (!sym) { sum += w[b + a]; continue; }
                if (self[k]) sum += w[b + (a < m ? a : m)];   // one entry, both orderings
                else sum += w[b + a] + w[b + m];
            }
            return sum;
        }

        // Same sum, reading int16 and scaling per table. Kept separate from
        // value() rather than branching inside the loop, because the branch
        // would sit in the hottest loop in the program.
        valueQ(cells) {
            const t = this.t, w = this.w, self = this.self, sc = this.scale;
            cells = this.prepare(cells);
            let sum = 0;
            for (let k = 0; k < t.n; k++) {
                const o = t.off[k], l = t.len[k], b = t.wbase[k];
                let a = 0, m = 0;
                for (let c = 0; c < l; c++) {
                    a = a * V + cells[t.cells[o + c]];
                    m = m * V + cells[t.mcells[o + c]];
                }
                const g = sc[k];
                if (self[k]) sum += g * w[b + (a < m ? a : m)];
                else sum += g * (w[b + a] + w[b + m]);
            }
            return sum;
        }

        // Spread one error over the tuples that produced the estimate. A
        // self-mirrored tuple contributes one term rather than two, so it takes
        // one share rather than two -- otherwise its weights would move at twice
        // the rate of everything else.
        update(cells, delta, fromTuple) {
            const t = this.t, w = this.w, sym = this.sym, self = this.self;
            // Training an int16 table would quantise every increment to the
            // step size and stall; quantisation is the last step before play.
            if (this.q16) throw new Error('cannot train a quantised network');
            cells = this.prepare(cells);
            const first = fromTuple || 0;
            if (first < 0 || first >= t.n) throw new Error('fromTuple must leave at least one trainable tuple');
            const selfAfter = this.selfPrefix[t.n] - this.selfPrefix[first];
            const d = delta / (sym ? 2 * (t.n - first) - selfAfter : t.n - first);
            for (let k = first; k < t.n; k++) {
                const o = t.off[k], l = t.len[k], b = t.wbase[k];
                let a = 0, m = 0;
                for (let c = 0; c < l; c++) {
                    a = a * V + cells[t.cells[o + c]];
                    if (sym) m = m * V + cells[t.mcells[o + c]];
                }
                if (!sym) { w[b + a] += d; continue; }
                if (self[k]) w[b + (a < m ? a : m)] += d;
                else { w[b + a] += d; w[b + m] += d; }
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
            cells = net.prepare(cells);
            const d = delta / (sym ? 2 * t.n : t.n);
            const ad = Math.abs(d);
            for (let k = 0; k < t.n; k++) {
                const o = t.off[k], l = t.len[k], b = t.wbase[k];
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
        // A quantised file carries its scale table between the header and the
        // weights; meta.q16 is what says it is there.
        const scaleBytes = net.q16 ? net.scale.byteLength : 0;
        const out = new Uint8Array(head + scaleBytes + net.w.byteLength);
        const view = new DataView(out.buffer);
        view.setUint32(0, MAGIC, true);
        view.setUint32(4, json.length + pad, true);
        out.set(json, 8);
        if (net.q16) out.set(new Uint8Array(net.scale.buffer, net.scale.byteOffset, scaleBytes), head);
        out.set(new Uint8Array(net.w.buffer, net.w.byteOffset, net.w.byteLength), head + scaleBytes);
        return out;
    }

    // Accepts an ArrayBuffer, a Uint8Array or a Node Buffer.
    function decode(input, override) {
        const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
        const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
        let meta = { set: 'base', sym: false };
        let offset = 0;
        if (u8.byteLength >= 8 && view.getUint32(0, true) === MAGIC) {
            const len = view.getUint32(4, true);
            const text = new TextDecoder().decode(u8.subarray(8, 8 + len));
            meta = JSON.parse(text.replace(/\0+$/, ''));
            offset = 8 + len;
        }
        const m = Object.assign(meta, override || {});
        if (m.q16) {
            // The scale table's length follows from the architecture, so read
            // the meta first, size it, and the rest of the file is the weights.
            const probe = new Network(undefined, Object.assign({}, m, { q16: false }));
            const sBytes = probe.t.n * 4;
            const scale = new Float32Array(
                u8.buffer.slice(u8.byteOffset + offset, u8.byteOffset + offset + sBytes));
            const weights = new Int16Array(
                u8.buffer.slice(u8.byteOffset + offset + sBytes, u8.byteOffset + u8.byteLength));
            return new Network(weights, Object.assign({}, m, { scale }));
        }
        // slice() copies, which also guarantees the 4-byte alignment Float32Array needs.
        const weights = new Float32Array(
            u8.buffer.slice(u8.byteOffset + offset, u8.byteOffset + u8.byteLength));
        return new Network(weights, m);
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

    return {
        Network, TC, tupleSet, SETS, save, load, encode, decode,
        NT, SIZE, W, H, V, BOARD_CELLS, GLOBAL, GLOBAL_NAMES
    };
});
