// ============================================================================
// Headless Collapse engine
//
// Rules-identical to game.js (including the LCG that generates new tiles), but
// with no rendering, achievements, storage or animation. Designed to be cheap
// to clone so search-based bots can explore.
//
// Board representation: a flat Uint8Array of W*H values, index k = i * H + j
// where i is the column (0 = left) and j is the row (0 = BOTTOM). 0 means
// empty, 1..5 are collapsible tiles, 6 is a finished tile (never clickable).
// In normal play the board is always full.
//
// Loads both in Node (module.exports) and in the browser (window.Collapse).
// ============================================================================

(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.Collapse = factory();
})(typeof self !== 'undefined' ? self : this, function () {

    const W = 5;
    const H = 5;

    // LCG constants — must match config.js
    const M = 4294967296;
    const A = 1664525;
    const C = 1013904223;

    const ALPHABET = "abcdefghijklmnopqrstuvwxyz";

    // --- scratch buffers (shared, single-threaded) -------------------------
    const _stamp = new Int32Array(W * H);
    const _stack = new Int32Array(W * H);
    const _chain = new Int32Array(W * H);
    let _stampId = 0;

    // Flood fill from `start` over equal values. Fills _chain, returns length.
    // The caller must consume _chain before the next call.
    function chainAt(cells, start) {
        const n = cells[start];
        // The stamp is stored in an Int32Array but counted in a JS number, so
        // past 2^31 the stored value wraps negative and never compares equal
        // again -- the visited check silently stops working and the fill spins
        // forever. Recycle the counter before that can happen.
        if (_stampId >= 0x7ffffffe) { _stamp.fill(0); _stampId = 0; }
        _stampId++;
        let sp = 0, len = 0;
        _stack[sp++] = start;
        _stamp[start] = _stampId;
        while (sp) {
            const k = _stack[--sp];
            _chain[len++] = k;
            const i = (k / H) | 0;
            const j = k - i * H;
            if (j < H - 1 && cells[k + 1] === n && _stamp[k + 1] !== _stampId) { _stamp[k + 1] = _stampId; _stack[sp++] = k + 1; }
            if (j > 0 && cells[k - 1] === n && _stamp[k - 1] !== _stampId) { _stamp[k - 1] = _stampId; _stack[sp++] = k - 1; }
            if (i > 0 && cells[k - H] === n && _stamp[k - H] !== _stampId) { _stamp[k - H] = _stampId; _stack[sp++] = k - H; }
            if (i < W - 1 && cells[k + H] === n && _stamp[k + H] !== _stampId) { _stamp[k + H] = _stampId; _stack[sp++] = k + H; }
        }
        return len;
    }

    // A move (i,j) is redundant if the tile directly below has the same value:
    // clicking either cell of a vertically adjacent pair yields the same board,
    // so we only keep the lowermost cell of a vertical run as canonical.
    function isCanonical(cells, i, j) {
        const k = i * H + j;
        return j === 0 || cells[k - 1] !== cells[k];
    }

    // Fill modes for refilling emptied cells:
    //   'random' — the real game: draw from the LCG (advances the PRNG)
    //   'six'    — pessimistic lookahead: incoming tiles are unusable blockers
    //   'none'   — optimistic lookahead: incoming tiles are ignored (empty)
    //   'sample' — Monte Carlo: draw from the same distribution using the
    //              agent's own RNG (game.sampleRng), which is fair — the bot
    //              knows the distribution, not the actual upcoming tiles
    const FILL_RANDOM = 'random';
    const FILL_SIX = 'six';
    const FILL_NONE = 'none';
    const FILL_SAMPLE = 'sample';

    class Game {
        constructor(seed) {
            this.seed = seed;
            this.rngState = seed % M;
            this.maxGen = 3;
            this.score = 0;
            this.cells = new Uint8Array(W * H);
            this.moves = [];
            this.scoreSplits = [];   // score at the moment each 6 was created
            this.lastCreated = -1;   // index of the tile the last move created
            this.fill = FILL_RANDOM;
            this.sampleRng = Math.random;
            this.refill();
            this.gameOver = !this.hasLegalMove();
        }

        get w() { return W; }
        get h() { return H; }
        get sixCount() { return this.scoreSplits.length; }

        at(i, j) { return this.cells[i * H + j]; }

        // Cheap copy for search. History is dropped unless keepHistory is set.
        clone(fill, keepHistory) {
            const g = Object.create(Game.prototype);
            g.seed = this.seed;
            g.rngState = this.rngState;
            g.maxGen = this.maxGen;
            g.score = this.score;
            g.cells = this.cells.slice();
            g.moves = keepHistory ? this.moves.slice() : [];
            g.scoreSplits = this.scoreSplits.slice();
            g.lastCreated = this.lastCreated;
            g.fill = fill || this.fill;
            g.sampleRng = this.sampleRng;
            g.gameOver = this.gameOver;
            return g;
        }

        nextTile() {
            if (this.fill === FILL_SIX) return 6;
            if (this.fill === FILL_NONE) return 0;
            if (this.fill === FILL_SAMPLE) return Math.floor(this.maxGen * this.sampleRng()) + 1;
            this.rngState = (this.rngState * A + C) % M;
            return Math.floor((this.maxGen * this.rngState) / M) + 1;
        }

        // Compact each column downwards, then top it up with new tiles.
        // Column order matters: it fixes the order tiles are drawn from the LCG.
        refill() {
            const cells = this.cells;
            for (let i = 0; i < W; i++) {
                const base = i * H;
                let write = base;
                for (let j = 0; j < H; j++) {
                    const v = cells[base + j];
                    if (v !== 0) cells[write++] = v;
                }
                const removed = base + H - write;
                for (let t = 0; t < removed; t++) cells[write + t] = this.nextTile();
            }
        }

        // Play (i,j). Returns the score gained, or 0 if the move was illegal.
        apply(i, j) {
            const cells = this.cells;
            const k = i * H + j;
            const n = cells[k];
            if (n < 1 || n > 5) return 0;
            const len = chainAt(cells, k);
            if (len < 2) return 0;

            const gain = n * len;
            this.score += gain;
            for (let t = 0; t < len; t++) cells[_chain[t]] = 0;
            cells[k] = n + 1;

            if (n + 1 === 4) this.maxGen = 4;
            if (n + 1 === 6) this.scoreSplits.push(this.score);

            this.moves.push(ALPHABET[5 * j + i]);
            // Where the new tile lands: everything in this column below the
            // click that survived the collapse stays below it, so its row after
            // compaction is exactly the count of those cells. Features about
            // *where* a move puts a tile need this, not the click position.
            let below = 0;
            for (let t = 0; t < j; t++) if (cells[i * H + t]) below++;
            this.lastCreated = i * H + below;
            this.refill();
            this.gameOver = !this.hasLegalMove();
            return gain;
        }

        // Apply a move on a copy, without touching the real PRNG.
        // `fill` decides what the bot is allowed to assume about incoming tiles;
        // FILL_RANDOM would peek at the real future, so lookahead should use
        // FILL_SIX or FILL_NONE.
        preview(i, j, fill) {
            const g = this.clone(fill || FILL_SIX);
            g.apply(i, j);
            return g;
        }

        legalMoves() {
            const cells = this.cells;
            const out = [];
            for (let i = 0; i < W; i++) {
                for (let j = 0; j < H; j++) {
                    const n = cells[i * H + j];
                    if (n < 1 || n > 5) continue;
                    if (!isCanonical(cells, i, j)) continue;
                    if (chainAt(cells, i * H + j) < 2) continue;
                    out.push([i, j]);
                }
            }
            return out;
        }

        countLegalMoves() {
            const cells = this.cells;
            let count = 0;
            for (let i = 0; i < W; i++) {
                for (let j = 0; j < H; j++) {
                    const n = cells[i * H + j];
                    if (n < 1 || n > 5) continue;
                    if (!isCanonical(cells, i, j)) continue;
                    if (chainAt(cells, i * H + j) >= 2) count++;
                }
            }
            return count;
        }

        hasLegalMove() {
            const cells = this.cells;
            for (let i = 0; i < W; i++) {
                for (let j = 0; j < H; j++) {
                    const n = cells[i * H + j];
                    if (n < 1 || n > 5) continue;
                    if (!isCanonical(cells, i, j)) continue;
                    if (chainAt(cells, i * H + j) >= 2) return true;
                }
            }
            return false;
        }

        // Cells of the chain that clicking (i,j) would collapse, as [i,j] pairs.
        getChain(i, j) {
            const n = this.cells[i * H + j];
            if (n < 1 || n > 5) return [];
            const len = chainAt(this.cells, i * H + j);
            const out = [];
            for (let t = 0; t < len; t++) {
                const k = _chain[t];
                const ci = (k / H) | 0;
                out.push([ci, k - ci * H]);
            }
            return out;
        }

        toString() {
            let s = '';
            for (let j = H - 1; j >= 0; j--) {
                for (let i = 0; i < W; i++) s += (this.cells[i * H + j] || '.') + ' ';
                s += '\n';
            }
            return s;
        }
    }

    // Play a full game with an agent. Returns a result summary.
    // agent.chooseMove(game) -> [i, j]
    function playGame(agent, seed, options) {
        const opts = options || {};
        const game = new Game(seed);
        const maxMoves = opts.maxMoves || 100000;
        while (!game.gameOver && game.moves.length < maxMoves) {
            const move = agent.chooseMove(game);
            if (!move) break;
            const gain = game.apply(move[0], move[1]);
            if (!gain) throw new Error(`Agent ${agent.name} played illegal move ${move} on seed ${seed}`);
            if (opts.onMove) opts.onMove(game, move, gain);
        }
        return {
            seed,
            score: game.score,
            moves: game.moves.length,
            sixes: game.sixCount,
            splits: game.scoreSplits.slice(),
            movesString: game.moves.join(''),
            game
        };
    }

    return { Game, playGame, W, H, FILL_RANDOM, FILL_SIX, FILL_NONE, FILL_SAMPLE, ALPHABET };
});
