// ============================================================================
// Expectimax over the n-tuple value network.
//
// The tree alternates two node types:
//
//   max node     a full board. Pick the legal move maximizing
//                (points it scores) + (value of what follows).
//   chance node  an afterstate: the chain has collapsed, the columns have
//                fallen, and the holes at the top have not been filled yet.
//                Average over the tiles that can drop into them.
//
// The network is trained on exactly those afterstates, so a leaf is one
// `net.value(cells)` and depth 1 reduces to the plain greedy `td` agent.
//
// Why this file exists rather than recursing with `game.preview`: `Game.apply`
// recomputes `gameOver` with a full legal-move scan on every call, which is 25
// flood fills that a search node throws away, and every node allocates a Game
// and a fresh move array. Here a position is just a Uint8Array(25) plus a
// maxGen flag, one connected-components pass finds every chain at once, and
// all the boards live in preallocated per-level scratch buffers.
//
// Refill order: `apply` compacts each column downwards and then tops it up from
// the generator, columns left to right and bottom to top within a column. After
// a collapse the holes are exactly the zeros, and scanning them in index order
// visits them in the order the generator fills them -- so writing a tile vector
// into that scan produces a genuine successor board (verified against the real
// engine move for move).
// ============================================================================

(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.CollapseSearch = factory();
})(typeof self !== 'undefined' ? self : this, function () {

    const W = 5, H = 5, N = W * H;
    // 25 cells, so at most 25 canonical moves. The comment that used to be here
    // said "canonical moves never approach 16", which was wrong: real positions
    // reach 19, and 1.6% of them have more than 16, where `expand` was silently
    // dropping the last few moves it found.
    const MAX_MOVES = 25;
    const LEVELS = 24;

    // --- connected components ----------------------------------------------
    // One sweep labels every chain and records its size, which replaces the 25
    // separate flood fills a per-cell legality test would do.
    const lbl = new Int8Array(N);
    const csize = new Int8Array(N);
    const cstack = new Int32Array(N);

    function components(cells) {
        lbl.fill(-1);
        let nc = 0;
        for (let s = 0; s < N; s++) {
            if (cells[s] === 0 || lbl[s] >= 0) continue;
            const v = cells[s];
            let sp = 0, cnt = 0;
            cstack[sp++] = s; lbl[s] = nc;
            while (sp) {
                const k = cstack[--sp];
                cnt++;
                const i = (k / H) | 0, j = k - i * H;
                if (j < H - 1 && cells[k + 1] === v && lbl[k + 1] < 0) { lbl[k + 1] = nc; cstack[sp++] = k + 1; }
                if (j > 0 && cells[k - 1] === v && lbl[k - 1] < 0) { lbl[k - 1] = nc; cstack[sp++] = k - 1; }
                if (i > 0 && cells[k - H] === v && lbl[k - H] < 0) { lbl[k - H] = nc; cstack[sp++] = k - H; }
                if (i < W - 1 && cells[k + H] === v && lbl[k + H] < 0) { lbl[k + H] = nc; cstack[sp++] = k + H; }
            }
            csize[nc++] = cnt;
        }
        return nc;
    }

    // Collapse the chain containing `k` and let the columns fall. Writes the
    // afterstate (holes as zeros) into `out`; returns the points scored.
    // Assumes `lbl` currently describes `cells`.
    function collapseInto(cells, k, out) {
        const n = cells[k], c = lbl[k], len = csize[c];
        for (let t = 0; t < N; t++) out[t] = (lbl[t] === c) ? 0 : cells[t];
        out[k] = n + 1;
        // gravity, column by column
        for (let i = 0; i < W; i++) {
            const base = i * H;
            let write = base;
            for (let j = 0; j < H; j++) {
                const v = out[base + j];
                if (v !== 0) out[write++] = v;
            }
            for (let t = write; t < base + H; t++) out[t] = 0;
        }
        return n * len;
    }

    // One position's worth of move expansion, with its own scratch space.
    // The searcher keeps one of these per tree level; the trainer keeps one.
    // Having a single implementation is the point: the trainer used to go
    // through Game.preview, which re-runs a full legal-move scan inside apply()
    // just to set gameOver, and that scan is 25 flood fills a training step
    // throws away.
    function makeExpander() {
        const after = new Uint8Array(N * MAX_MOVES);
        const gain = new Int32Array(MAX_MOVES);
        const nextGen = new Int32Array(MAX_MOVES);
        const cell = new Int32Array(MAX_MOVES);
        const scratch = new Uint8Array(N);
        let n = 0;

        return {
            get count() { return n; },
            gain(s) { return gain[s]; },
            nextGen(s) { return nextGen[s]; },
            cell(s) { return cell[s]; },
            board(s) { return after.subarray(s * N, s * N + N); },
            copy(s) { return after.slice(s * N, s * N + N); },

            // Every canonical legal move of `cells`. Returns how many.
            expand(cells, maxGen) {
                components(cells);
                n = 0;
                for (let k = 0; k < N; k++) {
                    const v = cells[k];
                    if (v < 1 || v > 5) continue;
                    if (csize[lbl[k]] < 2) continue;
                    if (k % H > 0 && cells[k - 1] === v) continue;   // lowest of a vertical run
                    gain[n] = collapseInto(cells, k, scratch);
                    after.set(scratch, n * N);
                    cell[n] = k;
                    nextGen[n] = (v + 1 === 4) ? 4 : maxGen;
                    if (++n === MAX_MOVES) break;
                }
                return n;
            }
        };
    }

    function makeSearcher(net, opts) {
        const o = opts || {};
        const depth = o.depth || 2;
        const cap = o.cap || 64;         // chance branches at the first chance node
        const capDeep = o.capDeep || o.cap || 16;   // and at every deeper one
        const rng = o.rng || Math.random;
        // At an internal max node, only the `topk` best moves by their shallow
        // (gain + net.value) score are searched deeper. The full width of a max
        // node is ~11 moves and almost all of them are obviously bad, so this
        // is where depth 3 becomes affordable. 0 = no pruning.
        const topk = o.topk || 0;
        // Same idea at the root, where the shallow ranking is usually already
        // right about which handful of moves are worth thinking about.
        const rootk = o.rootk || 0;
        // Risk adjustment at chance nodes. A chance node normally returns the
        // mean over the tiles that could drop; with `risk` it returns
        // mean - risk * sd, where sd is the spread over those outcomes.
        //   risk > 0  averse: prefers moves whose value barely depends on which
        //             tiles fall, which is what a consistent game wants.
        //   risk < 0  seeking: prefers moves with a good best case, which is
        //             what one attempt out of many wants.
        // risk = 0 is the plain expectation and the right thing for mean score.
        const risk = o.risk || 0;
        // Leaf blend: an extra evaluation added to net.value at the leaves.
        const leaf = o.leaf || null;

        // Latin-hypercube sampling of a chance node: rather than drawing every
        // hole independently, each hole's tile takes each of its maxGen values
        // exactly budget/maxGen times across the sample. The marginal
        // distribution per hole is then exact, which matters because a max node
        // over noisy estimates is biased upwards in proportion to the noise --
        // and the noise here is worst exactly for the widest chains, so plain
        // sampling systematically over-rates collapsing a big group.
        const MAX_BUDGET = 2048;
        const exp = [], fillBuf = [], holes = [], shallow = [], order = [], strat = [];
        for (let l = 0; l < LEVELS; l++) {
            exp.push(makeExpander());
            fillBuf.push(new Uint8Array(N));
            holes.push(new Int32Array(N));
            shallow.push(new Float64Array(MAX_MOVES));
            order.push(new Int32Array(MAX_MOVES));
            strat.push(new Uint8Array(N * MAX_BUDGET));
        }

        function maxValue(cells, maxGen, d, lv) {
            const e = exp[lv];
            const nm = e.expand(cells, maxGen);
            if (nm === 0) return 0;                       // dead: no future score
            let best = -Infinity;

            if (d <= 1) {
                for (let s = 0; s < nm; s++) {
                    const view = e.board(s);
                    const v = e.gain(s) + net.value(view) + (leaf ? leaf(view) : 0);
                    if (v > best) best = v;
                }
                return best;
            }

            // Shallow pass first, so the deep search can be spent on the moves
            // that could plausibly be the max.
            const sh = shallow[lv], ord = order[lv];
            for (let s = 0; s < nm; s++) {
                const view = e.board(s);
                sh[s] = e.gain(s) + net.value(view) + (leaf ? leaf(view) : 0);
                ord[s] = s;
            }
            let keep = nm;
            if (topk && nm > topk) {
                // Partial selection sort: only the top `topk` need to be ordered.
                for (let a = 0; a < topk; a++) {
                    let bi = a;
                    for (let b = a + 1; b < nm; b++) if (sh[ord[b]] > sh[ord[bi]]) bi = b;
                    const t = ord[a]; ord[a] = ord[bi]; ord[bi] = t;
                }
                keep = topk;
            }
            for (let a = 0; a < keep; a++) {
                const s = ord[a];
                const v = e.gain(s) + chanceValue(e.board(s), e.nextGen(s), d - 1, lv + 1);
                if (v > best) best = v;
            }
            return best;
        }

        function adjust(sum, sumsq, n) {
            const mean = sum / n;
            if (!risk || n < 2) return mean;
            const varr = sumsq / n - mean * mean;
            return mean - risk * Math.sqrt(varr > 0 ? varr : 0);
        }

        function chanceValue(after, maxGen, d, lv) {
            const hs = holes[lv];
            let nh = 0;
            for (let k = 0; k < N; k++) if (after[k] === 0) hs[nh++] = k;
            if (nh === 0) return maxValue(after, maxGen, d, lv + 1);

            const total = Math.pow(maxGen, nh);
            const budget = lv <= 1 ? cap : capDeep;
            const fill = fillBuf[lv];
            let sum = 0;

            let sumsq = 0;
            if (total <= budget) {
                for (let x = 0; x < total; x++) {
                    let q = x;
                    fill.set(after);
                    for (let t = 0; t < nh; t++) { fill[hs[t]] = (q % maxGen) + 1; q = (q / maxGen) | 0; }
                    const v = maxValue(fill, maxGen, d, lv + 1);
                    sum += v; sumsq += v * v;
                }
                return adjust(sum, sumsq, total);
            }
            // Round the budget down to a multiple of maxGen so the strata come
            // out even, and build one shuffled column of tiles per hole.
            const B = Math.max(maxGen, Math.min(MAX_BUDGET, budget - (budget % maxGen)));
            const st = strat[lv], reps = B / maxGen;
            for (let t = 0; t < nh; t++) {
                const base = t * B;
                for (let a = 0; a < maxGen; a++)
                    for (let r = 0; r < reps; r++) st[base + a * reps + r] = a + 1;
                for (let a = B - 1; a > 0; a--) {
                    const b = (rng() * (a + 1)) | 0;
                    const tmp = st[base + a]; st[base + a] = st[base + b]; st[base + b] = tmp;
                }
            }
            for (let x = 0; x < B; x++) {
                fill.set(after);
                for (let t = 0; t < nh; t++) fill[hs[t]] = st[t * B + x];
                const v = maxValue(fill, maxGen, d, lv + 1);
                sum += v; sumsq += v * v;
            }
            return adjust(sum, sumsq, B);
        }

        // Root: score every legal move of a live Game.
        function scoreMoves(game) {
            const e = exp[0];
            const nm = e.expand(game.cells, game.maxGen);
            const out = [];
            for (let s = 0; s < nm; s++) {
                const view = e.board(s);
                const k = e.cell(s);
                out.push({
                    move: [(k / H) | 0, k % H],
                    value: e.gain(s) + net.value(view) + (leaf ? leaf(view) : 0),
                    slot: s
                });
            }
            if (depth <= 1 || nm === 0) return out;
            let deep = out;
            if (rootk && nm > rootk) {
                deep = out.slice().sort((p, q) => q.value - p.value).slice(0, rootk);
            }
            for (const r of deep) {
                r.value = e.gain(r.slot) + chanceValue(e.board(r.slot), e.nextGen(r.slot), depth - 1, 1);
            }
            return out;
        }

        return { scoreMoves };
    }

    return { makeSearcher, makeExpander, components, collapseInto };
});
