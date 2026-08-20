// ============================================================================
// N-tuple value network over board afterstates.
//
// An "afterstate" is the board immediately after a collapse and before the new
// tiles drop in — exactly what `preview(i, j, FILL_NONE)` produces. Cells hold
// 0..6 (0 = emptied by this collapse), so a 4-cell tuple has 7^4 = 2401 states.
//
// The value of a board is the sum of one table lookup per tuple. This is the
// standard 2048 architecture: a large, sparse, linear model over local patterns.
// It is fast to evaluate (36 adds) and, unlike a hand-written feature list, it
// can represent interactions between neighbouring cells.
//
// Tuple set: every 2x2 square (16) plus every horizontal and vertical run of 4
// (10 + 10) = 36 tuples, 86 436 weights.
// ============================================================================

(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.CollapseNTuple = factory();
})(typeof self !== 'undefined' ? self : this, function () {

    const W = 5, H = 5, V = 7, SIZE = V * V * V * V;   // 4-cell tuples
    const idx = (i, j) => i * H + j;

    function buildTuples() {
        const t = [];
        for (let i = 0; i < W - 1; i++)              // 2x2 squares
            for (let j = 0; j < H - 1; j++)
                t.push([idx(i, j), idx(i + 1, j), idx(i, j + 1), idx(i + 1, j + 1)]);
        for (let j = 0; j < H; j++)                  // horizontal runs of 4
            for (let i = 0; i + 3 < W; i++)
                t.push([idx(i, j), idx(i + 1, j), idx(i + 2, j), idx(i + 3, j)]);
        for (let i = 0; i < W; i++)                  // vertical runs of 4
            for (let j = 0; j + 3 < H; j++)
                t.push([idx(i, j), idx(i, j + 1), idx(i, j + 2), idx(i, j + 3)]);
        return t;
    }

    const TUPLES = buildTuples();
    const NT = TUPLES.length;

    // Flatten to a typed array so the inner loop does no property access.
    const T0 = new Int32Array(NT), T1 = new Int32Array(NT), T2 = new Int32Array(NT), T3 = new Int32Array(NT);
    TUPLES.forEach((t, k) => { T0[k] = t[0]; T1[k] = t[1]; T2[k] = t[2]; T3[k] = t[3]; });

    // Left-right mirroring is an exact symmetry of the rules (gravity is
    // vertical, and the tile generator is exchangeable across columns), so a
    // symmetric network reads every tuple twice — once on the board and once on
    // its mirror — and shares one table between them. That doubles the training
    // data each weight sees at no cost in parameters.
    const M0 = new Int32Array(NT), M1 = new Int32Array(NT), M2 = new Int32Array(NT), M3 = new Int32Array(NT);
    const mirror = k => (W - 1 - ((k / H) | 0)) * H + (k % H);
    TUPLES.forEach((t, k) => { M0[k] = mirror(t[0]); M1[k] = mirror(t[1]); M2[k] = mirror(t[2]); M3[k] = mirror(t[3]); });

    class Network {
        constructor(weights, sym) {
            this.w = weights || new Float32Array(NT * SIZE);
            this.sym = !!sym;
        }
        value(cells) {
            const w = this.w;
            let sum = 0;
            for (let k = 0; k < NT; k++) {
                sum += w[k * SIZE + (((cells[T0[k]] * V + cells[T1[k]]) * V + cells[T2[k]]) * V + cells[T3[k]])];
                if (this.sym) sum += w[k * SIZE + (((cells[M0[k]] * V + cells[M1[k]]) * V + cells[M2[k]]) * V + cells[M3[k]])];
            }
            return sum;
        }
        // Spread one TD error over the tuples that produced the estimate.
        update(cells, delta) {
            const w = this.w;
            const d = delta / (this.sym ? 2 * NT : NT);
            for (let k = 0; k < NT; k++) {
                w[k * SIZE + (((cells[T0[k]] * V + cells[T1[k]]) * V + cells[T2[k]]) * V + cells[T3[k]])] += d;
                if (this.sym) w[k * SIZE + (((cells[M0[k]] * V + cells[M1[k]]) * V + cells[M2[k]]) * V + cells[M3[k]])] += d;
            }
        }
    }

    return { Network, NT, SIZE, TUPLES };
});
