// ============================================================================
// Frozen-tile detection: replace provably-dead tiles with 6s before evaluation.
//
// A tile is "frozen" when it can never move (fall) and never be collapsed, so
// it will sit where it is for the rest of the game contributing no further
// score -- exactly what a 6 already is. Passing frozen tiles to the value
// network as 6s lets the whole 6-machinery (heights, exposed, sealing) see the
// dead space for what it is, instead of the net having to infer permanence from
// a live-looking tile.
//
// Rules (the outside of the grid is frozen by convention):
//   - a 6 is frozen iff the tile below it is frozen (so a stack of 6s resting on
//     the floor, or on an already-frozen tile, is frozen);
//   - a 1x1 pocket -- a single non-6 tile whose four neighbours are all 6-or-
//     wall -- is frozen iff every 6 bordering it from below and from the
//     left/right is frozen. The tile above need not be frozen: the pocket tile
//     can never rise, and once it is itself frozen the 6 above rests on frozen
//     support and can never fall to expose it.
// Converting a pocket to a 6 can freeze the 6s above it, which can freeze more
// pockets, so this iterates to a fixpoint.
//
// Deliberately limited to 1x1 pockets and meant to run ONCE at the search root
// (not on every afterstate): real games from honest starts make pockets rare
// and small, a flood-fill for larger pockets rarely pays, and re-running it
// inside the search would let the 6-count wobble mid-lookahead -- a horizon
// artefact that could scare the net off a freeze it will have to take anyway.
//
// Soundness: a tile is only converted when it is surrounded by permanent
// (frozen) structure, so it has no legal move now and can never gain one; the
// set of legal moves on the board is therefore unchanged. Only 1x1 pockets are
// detected, so the transform is conservative -- it never freezes a tile that
// could still play.
// ============================================================================

(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.CollapseFreeze = factory();
})(typeof self !== 'undefined' ? self : this, function () {

    const W = 5, H = 5, N = W * H;

    // Return a new Uint8Array with every frozen 1x1 pocket set to 6. `cells` is
    // the length-25 board (values 0..6). The input is not modified.
    function freezeBoard(cells) {
        const work = cells.slice();
        const frozen = new Uint8Array(N);   // per-cell: is this a frozen 6?
        let changed = true;
        while (changed) {
            changed = false;

            // Frozen 6s, computed bottom-up per column. belowFrozen tracks
            // whether the cell under the current one is frozen (the floor is).
            frozen.fill(0);
            for (let i = 0; i < W; i++) {
                let belowFrozen = true;        // floor
                for (let j = 0; j < H; j++) {
                    const k = i * H + j;
                    if (work[k] === 6) { frozen[k] = belowFrozen ? 1 : 0; belowFrozen = frozen[k] === 1; }
                    else belowFrozen = false;  // a live tile supports nothing permanently
                }
            }

            // 1x1 pockets: a lone non-6 tile walled by 6s/edges whose below and
            // side 6s are all frozen.
            for (let i = 0; i < W; i++) {
                for (let j = 0; j < H; j++) {
                    const k = i * H + j, v = work[k];
                    if (v < 1 || v > 5) continue;
                    const up = j + 1 < H ? work[k + 1] : 6;
                    const down = j > 0 ? work[k - 1] : 6;
                    const left = i > 0 ? work[k - H] : 6;
                    const right = i + 1 < W ? work[k + H] : 6;
                    // Surrounded in all four directions by 6s or walls.
                    if (up !== 6 || down !== 6 || left !== 6 || right !== 6) continue;
                    // Every bordering 6 below / left / right must be frozen
                    // (walls count as frozen; the tile above is exempt).
                    if (j > 0 && !frozen[k - 1]) continue;
                    if (i > 0 && !frozen[k - H]) continue;
                    if (i + 1 < W && !frozen[k + H]) continue;
                    work[k] = 6;
                    changed = true;
                }
            }
        }
        return work;
    }

    return { freezeBoard };
});
