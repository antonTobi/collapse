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
// Headerless files (the original format) are read as base / 1 stage. A 'CNTS'
// file is the same function stored sparsely -- see the sparse storage section
// below -- and `decode` returns a SparseNetwork for it, which every agent uses
// through the same `value(cells)`.
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
    const GLOBAL = Object.freeze({
        SIXES: BOARD_CELLS,
        FIVE_GROUPS: BOARD_CELLS + 1,
        EQUAL_EDGES: BOARD_CELLS + 2,
        PLAYABLE_CELLS: BOARD_CELLS + 3,
        EXPOSED_SIXES: BOARD_CELLS + 4,
        SINGLETONS: BOARD_CELLS + 5,
        HOLES: BOARD_CELLS + 6,
        HIGH_TILES: BOARD_CELLS + 7
    });
    const GLOBAL_NAMES = Object.freeze({
        [GLOBAL.SIXES]: '6-count / 2 (12+ capped)',
        [GLOBAL.FIVE_GROUPS]: '5-components (6+ capped)',
        [GLOBAL.EQUAL_EDGES]: 'equal playable adjacencies / 3 (18+ capped)',
        [GLOBAL.PLAYABLE_CELLS]: 'cells in legal groups / 3 (18+ capped)',
        [GLOBAL.EXPOSED_SIXES]: 'exposed 6s (6+ capped)',
        [GLOBAL.SINGLETONS]: 'singleton groups / 2 (12+ capped)',
        [GLOBAL.HOLES]: 'holes (6+ capped)',
        [GLOBAL.HIGH_TILES]: '4/5 tiles / 2 (12+ capped)'
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

    // Sparse long-range interactions. The rectangle corners cover distances
    // of three or four cells; the two diagonals are the only tuples in the
    // first experiment whose receptive field crosses the whole board. The
    // list is closed under left-right reflection so reduce.js can fold it.
    function farTuples() {
        const t = [];
        const spans = [[0, 4], [0, 3], [1, 4]];
        // Full-width rectangles at three vertical placements, plus a mirrored
        // pair of full-height rectangles. This keeps the phone probe small
        // while covering both gravity-sensitive vertical contexts.
        for (const [y0, y1] of spans)
            t.push([idx(0, y0), idx(4, y0), idx(0, y1), idx(4, y1)]);
        t.push(
            [idx(0, 0), idx(3, 0), idx(0, 4), idx(3, 4)],
            [idx(1, 0), idx(4, 0), idx(1, 4), idx(4, 4)]
        );
        t.push(
            [idx(0, 0), idx(1, 1), idx(2, 2), idx(3, 3), idx(4, 4)],
            [idx(4, 0), idx(3, 1), idx(2, 2), idx(1, 3), idx(0, 4)],
            [idx(0, 0), idx(1, 1), idx(2, 2), idx(3, 3)],
            [idx(4, 0), idx(3, 1), idx(2, 2), idx(1, 3)]
        );
        return t;
    }

    // Two pure-global tables plus four mirror-paired local/global tables. The
    // latter let the same corner or edge pattern mean something different in
    // an open board, a sealed endgame, or a fragmented human position without
    // replicating every local tuple into another global bank.
    function globalTuples() {
        const G = GLOBAL;
        return [
            [G.SIXES, G.FIVE_GROUPS, G.EQUAL_EDGES, G.EXPOSED_SIXES],
            [G.PLAYABLE_CELLS, G.SINGLETONS, G.HOLES, G.HIGH_TILES],
            [idx(0, 0), idx(0, 1), G.SIXES, G.EQUAL_EDGES],
            [idx(4, 0), idx(4, 1), G.SIXES, G.EQUAL_EDGES],
            [idx(2, 0), idx(2, 1), G.SIXES, G.EQUAL_EDGES],
            [idx(0, 4), idx(0, 3), G.SIXES, G.EXPOSED_SIXES],
            [idx(4, 4), idx(4, 3), G.SIXES, G.EXPOSED_SIXES],
            [idx(2, 4), idx(2, 3), G.SIXES, G.EXPOSED_SIXES],
            [idx(0, 0), idx(1, 0), G.FIVE_GROUPS, G.PLAYABLE_CELLS],
            [idx(4, 0), idx(3, 0), G.FIVE_GROUPS, G.PLAYABLE_CELLS]
        ];
    }

    const SETS = {
        base: () => squares().concat(runs(4)),                                   // 36 tuples,   86 436 w
        rows: () => squares().concat(runs(4), runs(5)),                          // 46 tuples,  254 506 w
        blocks: () => squares().concat(runs(4), blocks(3, 2)),                   // 48 tuples, 1 498 224 w
        big: () => squares().concat(runs(4), runs(5), blocks(2, 3), blocks(3, 2)),// 70 tuples, 3 078 218 w
        // `big` with the cross shapes appended. The appended tuples come last,
        // so a `big` network's weights are exactly this one's leading prefix
        // and can be copied straight in -- see bot/grow.js.
        bigx: () => SETS.big().concat(crosses()),                                // 95 tuples, 3 259 476 w

        // Three cuts of `bigx`, for the question "does a tuple that is a strict
        // subset of another tuple earn its place". A 4-run sits inside a 5-run,
        // a 2x2 sits inside a 2x3, a corner L sits inside a 2x2 -- so in pure
        // representational terms the smaller one adds nothing the larger cannot
        // express. What it adds is *coarseness*: its table is 7x smaller, so
        // every entry is visited 7x more often and generalises over the cell it
        // does not look at. Which effect wins is an empirical question about
        // how much data there is, not an argument.
        bigx5: () => squares().concat(runs(4), runs(5), crosses()),              // 71 tuples,   435 953 w
        lean: () => squares().concat(runs(5), crosses()),                        // 51 tuples,   387 933 w
        coarse: () => squares().concat(runs(4), crosses()),                      // 61 tuples,   267 883 w
        // Every adjacent pair. The coarsest feature there is: 49 entries, so
        // each is visited constantly and generalises over everything else on
        // the board. Every domino already sits inside a 2x2 or a run, so it
        // adds no representational power at all -- only speed of learning.
        doms: () => squares().concat(runs(4), runs(5), blocks(2, 3), blocks(3, 2), crosses(), runs(2)),
        // `doms` without the 2x3/3x2 blocks: they are 86% of the weight table and
        // 33% of the reads, so whether they still earn that once the dominoes
        // are present is worth its own measurement.
        domsx: () => squares().concat(runs(4), runs(5), crosses(), runs(2)),

        // First next-network experiment. Every arm has `doms` as an exact
        // leading prefix, so grow.js starts them as precisely the same function
        // and training can initially freeze that prefix (ptrain.js).
        domsfar: () => SETS.doms().concat(farTuples()),
        domsglobal: () => SETS.doms().concat(globalTuples()),
        domshybrid: () => SETS.doms().concat(farTuples(), globalTuples())
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

    // Runnable directly from the checked-in dom39h.bins, whose deployed tuple
    // set is `domsrc`. These keep that already reduced/compacted set as their
    // leading prefix, append trainable experiment tables, and define the two
    // normal post-training transforms explicitly.
    const deployedArms = {
        domsrcfar: () => SETS.domsrc().concat(farTuples()),
        domsrcglobal: () => SETS.domsrc().concat(globalTuples()),
        domsrchybrid: () => SETS.domsrc().concat(farTuples(), globalTuples())
    };
    for (const [name, build] of Object.entries(deployedArms)) {
        SETS[name] = build;
        SETS[name + 'r'] = () => mirrorReduce(build());
        SETS[name + 'rc'] = () => subsetCompact(mirrorReduce(build()));
    }

    // Global features are mirror-invariant. A tuple may therefore contain a
    // mixture of physical and virtual cells and still use the existing mirror
    // reader and reduction machinery unchanged.
    const mirrorCell = k => k >= BOARD_CELLS ? k : (W - 1 - ((k / H) | 0)) * H + (k % H);

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
            // Deployment-only int16 storage. Evaluation is memory-bound -- the
            // table is far larger than cache -- so halving the load width is
            // worth about 1.3x. The scale is per (bank, tuple): with one global
            // scale a single outlier weight of 1449 against a typical 18 sets
            // the step size for every table and costs ~100 points, while
            // per-table scaling costs -16 +- 67, i.e. nothing.
            this.q16 = !!o.q16;
            // `noWeights` is for SparseNetwork, which stores the same function
            // in a different shape and must not allocate the 290 MB it replaces.
            this.w = weights || (o.noWeights ? null : (this.q16 ? new Int16Array(need) : new Float32Array(need)));
            this.scale = this.q16 ? (o.scale || new Float32Array(this.stages * this.t.n)) : null;
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
            this.featureStage = 0;
        }

        get meta() {
            const m = { set: this.setName, sym: this.sym, stages: this.stages };
            if (this.edges) m.edges = this.edges.slice();
            if (this.five) m.five = true;
            if (this.selfOnce) m.selfOnce = true;
            if (this.q16) m.q16 = true;
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
            // Clamped at both ends. The Euler count below can come out at -1
            // on a board whose 5s enclose two holes, and an unclamped -1 makes
            // bank -1, whose weights are `undefined` -- so `value()` returns NaN
            // and every comparison against that move silently goes false. Two
            // afterstates in 10 million of real play hit it.
            const f = fives > 2 ? 2 : (fives > 0 ? fives : 0);
            return this.five ? s * 3 + f : s;
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

        // Materialise virtual cells for tuple sets that use them. This is a
        // single allocation-free board pass. The 5-component count uses the
        // same Euler approximation as stageOf(); broader connectivity is given
        // by equal adjacencies, playable-cell count and singleton count. These
        // are cheaper than five separate component fills at every search leaf.
        prepare(cells) {
            if (!this.featureInput) return cells;
            const out = this.featureInput;
            let holes = 0, sixes = 0, high = 0, exposed = 0;
            let singletons = 0, playable = 0, equalEdges = 0, fiveN = 0, fiveAdj = 0, fiveSq = 0;
            for (let i = 0; i < W; i++) for (let j = 0; j < H; j++) {
                const k = i * H + j, v = cells[k]; out[k] = v;
                if (v === 0) { holes++; continue; }
                const left = i > 0 && cells[k - H] === v;
                const right = i + 1 < W && cells[k + H] === v;
                const down = j > 0 && cells[k - 1] === v;
                const up = j + 1 < H && cells[k + 1] === v;
                if (v === 6) {
                    sixes++;
                    if (!(left && right && down && up) &&
                        ((i > 0 && cells[k - H] !== 6) || (i + 1 < W && cells[k + H] !== 6) ||
                         (j > 0 && cells[k - 1] !== 6) || (j + 1 < H && cells[k + 1] !== 6))) exposed++;
                    continue;
                }
                if (v >= 4) high++;
                if (up) equalEdges++;
                if (right) equalEdges++;
                if (v === 5) {
                    fiveN++;
                    if (up) fiveAdj++;
                    if (right) fiveAdj++;
                    if (up && right && cells[k + H + 1] === 5) fiveSq++;
                }
                if (left || right || down || up) playable++; else singletons++;
            }

            const fiveGroups = fiveN - fiveAdj + fiveSq;
            this.featureStage = this.bankFor(sixes, fiveGroups);

            out[GLOBAL.SIXES] = Math.min(6, (sixes / 2) | 0);
            out[GLOBAL.FIVE_GROUPS] = Math.max(0, Math.min(6, fiveGroups));
            out[GLOBAL.EQUAL_EDGES] = Math.min(6, (equalEdges / 3) | 0);
            out[GLOBAL.PLAYABLE_CELLS] = Math.min(6, (playable / 3) | 0);
            out[GLOBAL.EXPOSED_SIXES] = Math.min(6, exposed);
            out[GLOBAL.SINGLETONS] = Math.min(6, (singletons / 2) | 0);
            out[GLOBAL.HOLES] = Math.min(6, holes);
            out[GLOBAL.HIGH_TILES] = Math.min(6, (high / 2) | 0);
            return out;
        }

        // prepare() already computed the two banking features. Reuse them for
        // global architectures instead of immediately scanning the board again.
        preparedStage(cells) {
            return this.featureInput ? this.featureStage : this.stageOf(cells);
        }

        value(cells) {
            const t = this.t, w = this.w, sym = this.sym, self = this.self;
            if (this.q16) return this.valueQ(cells);
            cells = this.prepare(cells);
            const bank = this.stages > 1 ? this.preparedStage(cells) * this.bank : 0;
            let sum = 0;
            for (let k = 0; k < t.n; k++) {
                const o = t.off[k], l = t.len[k], b = bank + t.wbase[k];
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
            const st = this.stages > 1 ? this.preparedStage(cells) : 0;
            const bank = st * this.bank, sb = st * t.n;
            let sum = 0;
            for (let k = 0; k < t.n; k++) {
                const o = t.off[k], l = t.len[k], b = bank + t.wbase[k];
                let a = 0, m = 0;
                for (let c = 0; c < l; c++) {
                    a = a * V + cells[t.cells[o + c]];
                    m = m * V + cells[t.mcells[o + c]];
                }
                const g = sc[sb + k];
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
            const bank = this.stages > 1 ? this.preparedStage(cells) * this.bank : 0;
            const first = fromTuple || 0;
            if (first < 0 || first >= t.n) throw new Error('fromTuple must leave at least one trainable tuple');
            const selfAfter = this.selfPrefix[t.n] - this.selfPrefix[first];
            const d = delta / (sym ? 2 * (t.n - first) - selfAfter : t.n - first);
            for (let k = first; k < t.n; k++) {
                const o = t.off[k], l = t.len[k], b = bank + t.wbase[k];
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
            const bank = net.stages > 1 ? net.preparedStage(cells) * net.bank : 0;
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

    // --- sparse storage -----------------------------------------------------
    // The dense table is 91% air: of 73.4M (bank, entry) slots only 12.1M are
    // ever read in 178M afterstates of real play, and the 39 banks correlate at
    // 0.91-1.00, so a weight is mostly "what this pattern is worth" and only
    // slightly "which bank am I in". So store
    //
    //   base[e]      int16, one per table entry, scaled per tuple
    //   corr[s][e]   int8, only for the slots that earn one, scaled per
    //                (bank, tuple)
    //
    // and read base[e] alone wherever no correction was stored. bot/shrink.js
    // decides which slots earn one; this is only the shape they are kept in.
    //
    // Addressing 8M of 73.4M slots is a third of the budget, so the index is
    // most of the design. Entries are the outer axis, because only 540k of the
    // 1.9M entries carry any correction at all, and the layout is arranged so a
    // lookup touches two lines rather than four:
    //
    //   idx[]   two words per 32 entries: a bitmap of which entries carry
    //           anything, and the running count of set bits before that word.
    //           A rank is then one popcount and one 8-byte read, and at 470 kB
    //           this array stays in L2.
    //   rec[]   two words per carrying entry, in rank order: which of the 39
    //           banks it carries (32 bits, plus 7 packed against the offset),
    //           and where its values start in vals[].
    //   vals[]  each carrying entry's base value followed immediately by its
    //           correction bytes. 93% of lookups land on an entry that carries
    //           something, so base and correction want to be in the same cache
    //           line -- keeping them apart cost 1.25 us per board.
    //   rest[]  the base values of entries that carry nothing. Their position is
    //           `e - rank(e)`, which the same popcount already produced, so they
    //           need no index of their own.
    //
    // Evaluation is 1.3x the dense int16 table's, and the file is 8.6x smaller.
    // It cannot reach parity: a dense read is one load, and no arrangement of an
    // index is fewer than two. The dense table's hot set is small enough to
    // cache too -- 0.3% of its slots carry half the reads -- so the win here is
    // the file, not the memory traffic.

    function pc32(x) {
        x = x - ((x >>> 1) & 0x55555555);
        x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
        x = (x + (x >>> 4)) & 0x0f0f0f0f;
        return (Math.imul(x, 0x01010101) >>> 24);
    }

    const OFF_BITS = 25;                       // vals[] index inside rec[2r+1]
    const OFF_MASK = (1 << OFF_BITS) - 1;

    class SparseNetwork extends Network {
        // parts: { scaleBase, scaleCorr, idx, rec, vals, rest }
        constructor(parts, opts) {
            super(undefined, Object.assign({}, opts, { noWeights: true, q16: false }));
            this.sparse = true;
            for (const k of Object.keys(parts)) this[k] = parts[k];
            // A byte view of the same buffer, so one cache line serves the base
            // (int16) and the corrections (int8) that follow it.
            this.vals8 = new Int8Array(this.vals.buffer, this.vals.byteOffset, this.vals.byteLength);
        }

        get meta() {
            const m = { set: this.setName, sym: this.sym, stages: this.stages };
            if (this.edges) m.edges = this.edges.slice();
            if (this.five) m.five = true;
            if (this.selfOnce) m.selfOnce = true;
            m.sparse = true;
            return m;
        }

        get entries() { return this.rec.length >> 1; }
        get corrections() { return this.nCorr; }
        get bytes() {
            return this.scaleBase.byteLength + this.scaleCorr.byteLength + this.idx.byteLength +
                this.rec.byteLength + this.vals.byteLength + this.rest.byteLength;
        }

        value(cells) {
            const t = this.t, self = this.self;
            const sBase = this.scaleBase, sCorr = this.scaleCorr;
            const idx = this.idx, rec = this.rec, vals = this.vals, v8 = this.vals8, rest = this.rest;
            cells = this.prepare(cells);
            const st = this.stages > 1 ? this.preparedStage(cells) : 0;
            const sb = st * t.n;
            const hi = st >= 32, sbit = 1 << (hi ? st - 32 : st), below = sbit - 1;
            let sum = 0;
            for (let k = 0; k < t.n; k++) {
                const o = t.off[k], l = t.len[k], wb = t.wbase[k];
                let a = 0, m = 0;
                for (let c = 0; c < l; c++) { a = a * V + cells[t.cells[o + c]]; m = m * V + cells[t.mcells[o + c]]; }
                const gB = sBase[k], gC = sCorr[sb + k];
                // One reading for a self-mirrored tuple, two for the rest.
                const one = self[k] ? 1 : 0;
                for (let q = one; q < 2; q++) {
                    const e = wb + (one ? (a < m ? a : m) : (q ? m : a));
                    const wI = (e >>> 5) << 1, word = idx[wI + 1], eb = 1 << (e & 31);
                    const r = idx[wI] + pc32(word & (eb - 1));
                    if (word & eb) {
                        const R = r << 1, lo = rec[R], packed = rec[R + 1], off = packed & OFF_MASK;
                        sum += vals[off] * gB;
                        const mask = hi ? (packed >>> OFF_BITS) : lo;
                        if (mask & sbit) {
                            const p = hi ? pc32(lo) + pc32(mask & below) : pc32(mask & below);
                            sum += v8[(off << 1) + 2 + p] * gC;
                        }
                    } else sum += rest[e - r] * gB;
                }
            }
            return sum;
        }

        // Expand back to a full Float32 table. Nothing in play needs this -- it
        // is how the sparse form is checked against the dense one, and how the
        // tools that only read `net.w` can still be pointed at a shrunk network.
        toDense() {
            const t = this.t, BK = this.bank, S = this.stages;
            const w = new Float32Array(S * BK);
            for (let k = 0; k < t.n; k++) {
                const sz = Math.pow(V, t.len[k]), off0 = t.wbase[k], gB = this.scaleBase[k];
                for (let i = 0; i < sz; i++) {
                    const e = off0 + i;
                    const wI = (e >>> 5) << 1, word = this.idx[wI + 1], eb = 1 << (e & 31);
                    const r = this.idx[wI] + pc32(word & (eb - 1));
                    if (!(word & eb)) {
                        const v = this.rest[e - r] * gB;
                        for (let s = 0; s < S; s++) w[s * BK + e] = v;
                        continue;
                    }
                    const R = r << 1, lo = this.rec[R], packed = this.rec[R + 1];
                    const off = packed & OFF_MASK, hiMask = packed >>> OFF_BITS;
                    const v = this.vals[off] * gB;
                    let p = 0;
                    for (let s = 0; s < S; s++) {
                        let c = 0;
                        if (s < 32 ? (lo & (1 << s)) : (hiMask & (1 << (s - 32))))
                            c = this.vals8[(off << 1) + 2 + p++] * this.scaleCorr[s * t.n + k];
                        w[s * BK + e] = v + c;
                    }
                }
            }
            return w;
        }

        update() { throw new Error('cannot train a sparse network'); }
    }

    // Build the sparse form from a dense one plus the decision of which slots
    // keep a per-bank correction. `base` is the bank-independent value per entry
    // (bot/shrink.js computes it as the read-weighted mean across banks);
    // `keep(bank, entry)` says whether that slot gets a correction.
    //
    // Quantisation is per table on both levels: int16 for the base, int8 for the
    // correction. One scale for everything does not work -- a handful of +-1400
    // weights against a typical +-90 sets the step for every table -- and the
    // correction needs its own scale again because its rms is 26 against the
    // base's 217, which is exactly why a byte is enough for it.
    function toSparse(net, base, keep, opts) {
        const o = Object.assign({ qbase: 16, qcorr: 8 }, opts || {});
        const t = net.t, BK = net.bank, S = net.stages;
        const blim = (1 << (o.qbase - 1)) - 1, clim = (1 << (o.qcorr - 1)) - 1;
        const qbase = new Int16Array(BK), scaleBase = new Float32Array(t.n);
        const scaleCorr = new Float32Array(S * t.n);
        const qb = new Float64Array(BK);        // the base after rounding, which is what a correction corrects
        for (let k = 0; k < t.n; k++) {
            const sz = Math.pow(V, t.len[k]), off0 = t.wbase[k];
            let mx = 0;
            for (let i = 0; i < sz; i++) { const v = Math.abs(base[off0 + i]); if (v > mx) mx = v; }
            const sc = mx / blim || 1;
            scaleBase[k] = sc;
            for (let i = 0; i < sz; i++) {
                let q = Math.round(base[off0 + i] / sc);
                if (q > blim) q = blim; if (q < -blim - 1) q = -blim - 1;
                qbase[off0 + i] = q; qb[off0 + i] = q * sc;
            }
            for (let s = 0; s < S; s++) {
                const bs = s * BK + off0;
                let cm = 0;
                for (let i = 0; i < sz; i++) {
                    if (!keep(s, off0 + i)) continue;
                    const d = Math.abs(net.w[bs + i] - qb[off0 + i]);
                    if (d > cm) cm = d;
                }
                scaleCorr[s * t.n + k] = cm / clim || 1;
            }
        }
        // Pass 1: the int8 code for every kept slot, and how many survive
        // rounding. A code of zero is not worth an index bit -- it says "read
        // the base", which is what happens anyway.
        const code = new Int8Array(S * BK);
        const perEntry = new Int32Array(BK);
        let nCorr = 0, nEntry = 0, nVals = 0;
        for (let k = 0; k < t.n; k++) {
            const sz = Math.pow(V, t.len[k]), off0 = t.wbase[k];
            for (let s = 0; s < S; s++) {
                const sc = scaleCorr[s * t.n + k], bs = s * BK + off0;
                for (let i = 0; i < sz; i++) {
                    const e = off0 + i;
                    if (!keep(s, e)) continue;
                    let q = Math.round((net.w[bs + i] - qb[e]) / sc);
                    if (q > clim) q = clim; if (q < -clim - 1) q = -clim - 1;
                    if (!q) continue;
                    code[s * BK + e] = q; perEntry[e]++; nCorr++;
                }
            }
        }
        // vals[] is int16-addressed, so each entry's run of correction bytes is
        // padded to an even length to keep the next entry's base aligned.
        for (let e = 0; e < BK; e++) if (perEntry[e]) { nEntry++; nVals += 1 + ((perEntry[e] + 1) >> 1); }
        if (nVals > OFF_MASK) throw new Error(nVals + ' value slots exceed the ' + OFF_BITS +
            '-bit offset the record packs them into; keep fewer corrections');
        // Pass 2: pack. Entries in index order, banks ascending within an entry.
        const nWords = (BK + 31) >> 5;
        const idx = new Uint32Array(2 * nWords);
        const rec = new Uint32Array(2 * nEntry);
        const vals = new Int16Array(nVals);
        const vals8 = new Int8Array(vals.buffer);
        const rest = new Int16Array(BK - nEntry);
        let r = 0, at = 0;
        for (let e = 0; e < BK; e++) {
            const wI = (e >>> 5) << 1;
            if ((e & 31) === 0) idx[wI] = r;
            if (!perEntry[e]) { rest[e - r] = qbase[e]; continue; }
            idx[wI + 1] |= 1 << (e & 31);
            vals[at] = qbase[e];
            let lo = 0, hi = 0, p = 0;
            for (let s = 0; s < S; s++) {
                const q = code[s * BK + e];
                if (!q) continue;
                if (s < 32) lo |= 1 << s; else hi |= 1 << (s - 32);
                vals8[(at << 1) + 2 + p++] = q;
            }
            const R = r << 1;
            rec[R] = lo; rec[R + 1] = at | (hi << OFF_BITS);
            at += 1 + ((p + 1) >> 1);
            r++;
        }
        const sp = new SparseNetwork({ scaleBase, scaleCorr, idx, rec, vals, rest }, net.meta);
        sp.nCorr = nCorr;
        return sp;
    }

    // --- file format --------------------------------------------------------
    // 'CNTP' | u32 padded json length | json meta | Float32 weights.
    // The json block is padded so the weights stay 4-byte aligned.
    //
    // A sparse file is 'CNTS' | u32 padded json length | u32 entries |
    // u32 value slots | json meta | the six arrays above, widest element first
    // so each one lands on its own alignment. Its meta carries `sparse: true`,
    // which is what tells `decode` to build a SparseNetwork.

    const MAGIC = 0x50544e43;   // 'CNTP' little-endian
    const MAGIC_S = 0x53544e43; // 'CNTS'

    const SPARSE_PARTS = [
        ['scaleBase', Float32Array], ['scaleCorr', Float32Array],
        ['idx', Uint32Array], ['rec', Uint32Array],
        ['vals', Int16Array], ['rest', Int16Array]
    ];

    function encodeSparse(net) {
        const json = new TextEncoder().encode(JSON.stringify(net.meta));
        const pad = (4 - (json.length % 4)) % 4;
        const head = 16 + json.length + pad;
        let total = head;
        for (const [name] of SPARSE_PARTS) total += net[name].byteLength;
        const out = new Uint8Array(total);
        const view = new DataView(out.buffer);
        view.setUint32(0, MAGIC_S, true);
        view.setUint32(4, json.length + pad, true);
        // The two lengths the architecture cannot imply.
        view.setUint32(8, net.rec.length >> 1, true);
        view.setUint32(12, net.vals.length, true);
        out.set(json, 16);
        let at = head;
        for (const [name] of SPARSE_PARTS) {
            const a = net[name];
            out.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), at);
            at += a.byteLength;
        }
        return out;
    }

    function decodeSparse(u8, view, meta, offset) {
        const nEntry = view.getUint32(8, true), nVals = view.getUint32(12, true);
        const probe = new Network(undefined, Object.assign({}, meta, { noWeights: true }));
        const BK = probe.bank, nWords = (BK + 31) >> 5;
        const lens = {
            scaleBase: probe.t.n, scaleCorr: probe.stages * probe.t.n,
            idx: 2 * nWords, rec: 2 * nEntry, vals: nVals, rest: BK - nEntry
        };
        const parts = {};
        let at = u8.byteOffset + offset;
        for (const [name, Type] of SPARSE_PARTS) {
            const bytes = lens[name] * Type.BYTES_PER_ELEMENT;
            // slice() copies, which is also what guarantees the alignment each
            // typed array needs regardless of where the file landed in memory.
            parts[name] = new Type(u8.buffer.slice(at, at + bytes));
            at += bytes;
        }
        return new SparseNetwork(parts, meta);
    }

    // Typed arrays rather than Buffer, so the spectator can fetch() a weight
    // file straight into a network in the browser.
    function encode(net) {
        if (net.sparse) return encodeSparse(net);
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
        let meta = { set: 'base', sym: false, stages: 1 };
        let offset = 0;
        if (u8.byteLength >= 16 && view.getUint32(0, true) === MAGIC_S) {
            const len = view.getUint32(4, true);
            const text = new TextDecoder().decode(u8.subarray(16, 16 + len));
            meta = Object.assign(JSON.parse(text.replace(/\0+$/, '')), override || {});
            return decodeSparse(u8, view, meta, 16 + len);
        }
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
            const nScale = probe.stages * probe.t.n;
            const sBytes = nScale * 4;
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
        Network, SparseNetwork, TC, tupleSet, SETS, save, load, encode, decode, toSparse,
        NT, SIZE, W, H, V, BOARD_CELLS, GLOBAL, GLOBAL_NAMES
    };
});
