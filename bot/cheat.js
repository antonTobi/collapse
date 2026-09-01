// ============================================================================
// Clairvoyant ("cheating") search.
//
// A benchmark yardstick, not a real agent: it searches N moves deep like the
// expectimax in search.js, but instead of averaging over the tiles that COULD
// drop into the holes it peeks at the ones that ACTUALLY will. In other words
// it is allowed to see the future -- the exact tiles the real game's PRNG is
// about to produce, for whichever line of play it explores.
//
// Because the future is fixed, there is no chance node and no averaging: the
// tree is a plain max-tree. Playing move m from a full board yields exactly one
// successor board (the real refill of m's afterstate), so
//
//   value(board, d) = max over legal m of  gain(m) + value(successor(m), d-1)
//
// and value(board, 0) is the leaf estimate. This makes clairvoyant depth d far
// cheaper than expectimax depth d, whose every ply multiplies the work by the
// chance cap.
//
// The real refill is produced by the engine itself: Game.preview(i,j,'random')
// clones the game -- carrying its rngState -- and advances that clone's PRNG
// exactly as a real move would. Going through the engine (rather than a private
// LCG here) means the clairvoyance is genuine under whatever generator the game
// is using, including the COLLAPSE_RNG=hash alternative.
//
// Leaf estimate. A leaf is a FULL board (the real refill filled it), but the
// value network is trained on afterstates (holes), so we never call net.value
// on a full board directly. Instead we take the ordinary greedy one-ply reading
// -- max over legal m of gain(m) + net.value(afterstate(m)), no refill -- which
// is exactly what the deployed net does as the `td` agent. With freeze on, the
// leaf board is passed through freezeBoard first, matching how the deployed
// (freeze-trained) net is used everywhere else.
// ============================================================================

(function (root, factory) {
    if (typeof module === 'object' && module.exports)
        module.exports = factory(require('./engine.js'), require('./search.js'), require('./freeze.js'));
    else root.CollapseCheat = factory(root.Collapse, root.CollapseSearch, root.CollapseFreeze);
})(typeof self !== 'undefined' ? self : this, function (Collapse, Search, Freeze) {

    const { FILL_RANDOM } = Collapse;

    function makeCheat(net, opts) {
        const o = opts || {};
        const depth = Math.max(1, o.depth || 1);
        const freeze = !!o.freeze;
        // Leaves only: one expander is enough because leafValue consumes it fully
        // before returning and never recurses through it.
        const exp = Search.makeExpander();
        const froze = freeze ? cells => Freeze.freezeBoard(cells) : cells => cells;

        // Greedy net reading of a full board, no refill (the `td` evaluation).
        // 0 if the board is dead: no move, hence no further score.
        function leafValue(game) {
            const cells = froze(game.cells);
            const nm = exp.expand(cells, game.maxGen);
            if (nm === 0) return 0;
            let best = -Infinity;
            for (let s = 0; s < nm; s++) {
                const v = exp.gain(s) + net.value(exp.board(s));
                if (v > best) best = v;
            }
            return best;
        }

        // Best total future score over the next `d` clairvoyant plies, from a
        // full board `game`, plus the leaf estimate at the horizon.
        function searchValue(game, d) {
            if (d === 0) return leafValue(game);
            const moves = game.legalMoves();
            if (!moves.length) return 0;              // dead: no future score
            let best = -Infinity;
            for (const m of moves) {
                const next = game.preview(m[0], m[1], FILL_RANDOM);
                const v = (next.score - game.score) + searchValue(next, d - 1);
                if (v > best) best = v;
            }
            return best;
        }

        return {
            scoreMoves(game) {
                return game.legalMoves().map(move => {
                    const next = game.preview(move[0], move[1], FILL_RANDOM);
                    return { move, value: (next.score - game.score) + searchValue(next, depth - 1) };
                });
            }
        };
    }

    return { makeCheat };
});
