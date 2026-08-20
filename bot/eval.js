// ============================================================================
// Position features and the linear evaluation used by heuristic agents.
//
// Every feature is computed on the board *after* a move has been applied with
// FILL_NONE, i.e. the collapse has happened and the emptied cells at the top of
// each column are still empty. That keeps positional features honest — no
// invented tiles — and costs nothing for move counting: a 6 and an empty cell
// are equally inert, so countLegalMoves() is identical under FILL_NONE and
// FILL_SIX at depth 1.
//
// FEATURES lists the extractors; a weight vector is just an object keyed by
// feature name, so agents/tuning/ablation all speak the same language.
// ============================================================================

(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.CollapseEval = factory();
})(typeof self !== 'undefined' ? self : this, function () {

    const W = 5, H = 5, N = W * H;

    const _stamp = new Int32Array(N);
    const _stack = new Int32Array(N);
    let _stampId = 0;

    // Feature names, in a fixed order. Values are raw (not normalized); the
    // weights carry the scale.
    const FEATURES = [
        'moves',      // number of canonical legal moves
        'pairs',      // adjacent same-value tile pairs (1..5) — "potential"
        'made',       // value of the tile this move created (2..6); small is good
        'made3',      // indicators for the created value — lets the tuner price
        'made4',      // "don't make a 5 yet" independently of "don't make a 4",
        'made5',      // since the cost is very non-linear in the value
        'made6',
        'gain',       // points scored by this move
        'comp4',      // connected components of 4s (fewer = more concentrated)
        'comp5',      // connected components of 5s (STRATEGY: keep 5s together)
        'singles',    // tiles of value 4-5 with no same-value neighbour
        'sixopen',    // open (non-6, in-bounds) neighbours summed over 6-tiles
        'trapped',    // non-6 tiles walled in on >= 3 sides by 6s/edges
        'heightsum',  // sum of n*row over tiles 1..5; low = big tiles sit low
        'lowtiles',   // count of 1s and 2s in the bottom two rows
        'sixes',      // number of 6-tiles on the board
        'chain',      // number of tiles this move collapsed
        // Tile counts by value. A linear weight on these is a potential
        // function over board material: score equals the total value of all
        // tiles ever consumed, so what a move is really worth is its immediate
        // gain plus the change in the board's future-value potential.
        'cnt1', 'cnt2', 'cnt3', 'cnt4', 'cnt5',
        // Anti-deadlock features. Many games end in a checkerboard with only
        // 4-5 sixes on the board rather than from 6-clog, so what matters is
        // how much of the material is still matchable, and at which values.
        'iso',        // tiles (1..5) with no orthogonally adjacent equal tile
        'pairlo',     // adjacent equal pairs of value <= 2 (cheap safety net)
        'pairhi',     // adjacent equal pairs of value >= 4 (costly to cash in)
        'distinct',   // how many of the values 1..5 are present at all
        'gen4',       // 1 once a 4 has been made: new tiles become 1-4 instead
                      // of 1-3, which makes matches permanently harder
        // Collapsing k tiles of value n always scores n*k, but yields a single
        // tile of n+1. For n < 5 a small chain is therefore better (same points,
        // more product); for n = 5 the product is an inert 6, so a big chain is
        // strictly better - same points, fewer permanent 6s on the board.
        'chain5',     // chain length when the move creates a 6
        'chainlow',   // chain length when the move creates a 2-5
        // Interactions with the number of 6s already on the board, i.e. with
        // how far into the game we are. A weight here bends the corresponding
        // base weight as the board fills up, so one linear agent can play the
        // opening and the endgame differently.
        's_moves', 's_pairs', 's_made', 's_sixopen', 's_gain', 's_heightsum',
        // --- 5-placement ---------------------------------------------------
        // A 5 is nearly inert: it can only ever be consumed by merging with
        // another 5. So unlike a 6, where sealing it into a corner is purely
        // good, a 5 wants to be BOTH tucked away AND next to its own kind.
        // Vertical gaps between 5s close for free as the tiles between them are
        // consumed; horizontal gaps never close, because nothing moves sideways.
        // Hence connectivity is measured in columns, not in cells.
        'new5bond',    // 5s orthogonally adjacent to the 5 this move created
        'new5colgap',  // column distance from the new 5 to the nearest other 5
        'new5blocked', // walls/6s orthogonally adjacent to the new 5
        'fivebond',    // adjacent 5-5 pairs on the board
        'fiveblocked', // 5-tile sides facing a wall or a 6
        'fivecols',    // distinct columns containing a 5
        'fivespan',    // rightmost column with a 5 minus leftmost
        'fivemax',     // size of the largest connected group of 5s
        'fournear5'    // 4s adjacent to, or sharing a column with, a 5
    ];
    // Features describing the MOVE itself (as opposed to the resulting board).
    // Search sums these along a line and adds the positional score of the leaf.
    const MOVE_FEATURES = ['made', 'made3', 'made4', 'made5', 'made6', 'gain', 'chain',
        'new5bond', 'new5colgap', 'new5blocked'];

    const FI = {};
    FEATURES.forEach((f, k) => { FI[f] = k; });
    const NF = FEATURES.length;

    // Fills `out` (Float64Array of length NF) with the features of `next`.
    // `made` and `gain` describe the move that produced it and are passed in.
    function extract(next, made, gain, out, chain) {
        const cells = next.cells;
        out.fill(0);
        out[FI.moves] = next.countLegalMoves();
        out[FI.made] = made;
        if (made >= 3 && made <= 6) out[FI.made3 + (made - 3)] = 1;
        out[FI.gain] = gain;
        out[FI.chain] = chain || 0;
        out[made === 6 ? FI.chain5 : FI.chainlow] = chain || 0;

        let pairs = 0, sixopen = 0, trapped = 0, heightsum = 0, lowtiles = 0, sixes = 0, fiveColMask = 0;
        for (let i = 0; i < W; i++) {
            for (let j = 0; j < H; j++) {
                const k = i * H + j;
                const n = cells[k];
                if (n === 0) continue;

                if (n === 6) {
                    sixes++;
                    // count open neighbours: walls and other 6s are "closed"
                    if (i > 0 && cells[k - H] !== 6) sixopen++;
                    if (i < W - 1 && cells[k + H] !== 6) sixopen++;
                    if (j > 0 && cells[k - 1] !== 6) sixopen++;
                    if (j < H - 1 && cells[k + 1] !== 6) sixopen++;
                } else {
                    out[FI.cnt1 + n - 1]++;
                    if (n === 5) {
                        fiveColMask |= 1 << i;
                        if (i < W - 1 && cells[k + H] === 5) out[FI.fivebond]++;
                        if (j < H - 1 && cells[k + 1] === 5) out[FI.fivebond]++;
                        if (i === 0 || cells[k - H] === 6) out[FI.fiveblocked]++;
                        if (i === W - 1 || cells[k + H] === 6) out[FI.fiveblocked]++;
                        if (j === 0 || cells[k - 1] === 6) out[FI.fiveblocked]++;
                        if (j === H - 1 || cells[k + 1] === 6) out[FI.fiveblocked]++;
                    }
                    heightsum += n * j;
                    if (n <= 2 && j <= 1) lowtiles++;
                    let blocked = 0;
                    if (i === 0 || cells[k - H] === 6) blocked++;
                    if (i === W - 1 || cells[k + H] === 6) blocked++;
                    if (j === 0 || cells[k - 1] === 6) blocked++;
                    if (j === H - 1 || cells[k + 1] === 6) blocked++;
                    if (blocked >= 3) trapped++;
                    if (i < W - 1 && cells[k + H] === n) { pairs++; if (n <= 2) out[FI.pairlo]++; else if (n >= 4) out[FI.pairhi]++; }
                    if (j < H - 1 && cells[k + 1] === n) { pairs++; if (n <= 2) out[FI.pairlo]++; else if (n >= 4) out[FI.pairhi]++; }
                    if (!((i > 0 && cells[k - H] === n) || (i < W - 1 && cells[k + H] === n) ||
                          (j > 0 && cells[k - 1] === n) || (j < H - 1 && cells[k + 1] === n))) out[FI.iso]++;
                }
            }
        }
        out[FI.pairs] = pairs;
        out[FI.sixopen] = sixopen;
        out[FI.trapped] = trapped;
        out[FI.heightsum] = heightsum;
        out[FI.lowtiles] = lowtiles;
        out[FI.sixes] = sixes;

        // Connected components of 4s and 5s, and isolated 4s/5s.
        // The stamp is stored in an Int32Array but counted in a JS number, so
        // past 2^31 the stored value wraps negative and never compares equal
        // again -- the visited check silently stops working and the fill spins
        // forever. Recycle the counter before that can happen.
        if (_stampId >= 0x7ffffffe) { _stamp.fill(0); _stampId = 0; }
        _stampId++;
        let comp4 = 0, comp5 = 0, singles = 0;
        for (let start = 0; start < N; start++) {
            const v = cells[start];
            if (v !== 4 && v !== 5) continue;
            if (_stamp[start] === _stampId) continue;
            let sp = 0, size = 0;
            _stack[sp++] = start;
            _stamp[start] = _stampId;
            while (sp) {
                const k = _stack[--sp];
                size++;
                const i = (k / H) | 0, j = k - i * H;
                if (j < H - 1 && cells[k + 1] === v && _stamp[k + 1] !== _stampId) { _stamp[k + 1] = _stampId; _stack[sp++] = k + 1; }
                if (j > 0 && cells[k - 1] === v && _stamp[k - 1] !== _stampId) { _stamp[k - 1] = _stampId; _stack[sp++] = k - 1; }
                if (i > 0 && cells[k - H] === v && _stamp[k - H] !== _stampId) { _stamp[k - H] = _stampId; _stack[sp++] = k - H; }
                if (i < W - 1 && cells[k + H] === v && _stamp[k + H] !== _stampId) { _stamp[k + H] = _stampId; _stack[sp++] = k + H; }
            }
            if (v === 4) comp4++; else { comp5++; if (size > out[FI.fivemax]) out[FI.fivemax] = size; }
            if (size === 1) singles++;
        }
        out[FI.gen4] = next.maxGen >= 4 ? 1 : 0;
        out[FI.s_moves] = out[FI.moves] * sixes;
        out[FI.s_pairs] = pairs * sixes;
        out[FI.s_made] = made * sixes;
        out[FI.s_sixopen] = sixopen * sixes;
        out[FI.s_gain] = gain * sixes;
        out[FI.s_heightsum] = heightsum * sixes;
        for (let v = 1; v <= 5; v++) if (out[FI.cnt1 + v - 1] > 0) out[FI.distinct]++;
        if (fiveColMask) {
            let lo = -1, hi = -1;
            for (let i = 0; i < W; i++) {
                if (!(fiveColMask & (1 << i))) continue;
                out[FI.fivecols]++;
                if (lo < 0) lo = i;
                hi = i;
            }
            out[FI.fivespan] = hi - lo;
            for (let k = 0; k < N; k++) {
                if (cells[k] !== 4) continue;
                const i = (k / H) | 0, j = k - i * H;
                if ((fiveColMask & (1 << i)) ||
                    (i > 0 && cells[k - H] === 5) || (i < W - 1 && cells[k + H] === 5) ||
                    (j > 0 && cells[k - 1] === 5) || (j < H - 1 && cells[k + 1] === 5)) out[FI.fournear5]++;
            }
        }

        // Placement of the tile this move created, but only when it is a 5 --
        // a rare decision, so these can carry a strong weight without touching
        // the other 95% of moves. `next.lastCreated` is the post-gravity index.
        const kc = next.lastCreated;
        if (made === 5 && kc >= 0) {
            const ci = (kc / H) | 0, cj = kc - ci * H;
            if (ci > 0 && cells[kc - H] === 5) out[FI.new5bond]++;
            if (ci < W - 1 && cells[kc + H] === 5) out[FI.new5bond]++;
            if (cj > 0 && cells[kc - 1] === 5) out[FI.new5bond]++;
            if (cj < H - 1 && cells[kc + 1] === 5) out[FI.new5bond]++;
            if (ci === 0 || cells[kc - H] === 6) out[FI.new5blocked]++;
            if (ci === W - 1 || cells[kc + H] === 6) out[FI.new5blocked]++;
            if (cj === 0 || cells[kc - 1] === 6) out[FI.new5blocked]++;
            if (cj === H - 1 || cells[kc + 1] === 6) out[FI.new5blocked]++;
            let nearest = W;
            for (let k2 = 0; k2 < N; k2++) {
                if (k2 === kc || cells[k2] !== 5) continue;
                const d = Math.abs(((k2 / H) | 0) - ci);
                if (d < nearest) nearest = d;
            }
            out[FI.new5colgap] = nearest === W ? 0 : nearest;
        }
        out[FI.comp4] = comp4;
        out[FI.comp5] = comp5;
        out[FI.singles] = singles;
        return out;
    }

    // Turn a {name: weight} object into a dense array; unknown names throw so
    // typos in CLI weight specs don't silently do nothing.
    function toVector(weights) {
        const v = new Float64Array(NF);
        for (const key of Object.keys(weights || {})) {
            if (!(key in FI)) throw new Error(`Unknown feature "${key}". Known: ${FEATURES.join(', ')}`);
            v[FI[key]] = weights[key];
        }
        return v;
    }

    function describe(weights) {
        return FEATURES.filter(f => weights[f]).map(f => `${f}=${weights[f]}`).join(' ');
    }

    const IS_MOVE_FEATURE = FEATURES.map(f => MOVE_FEATURES.indexOf(f) >= 0);

    return { FEATURES, MOVE_FEATURES, IS_MOVE_FEATURE, FI, NF, extract, toVector, describe };
});
