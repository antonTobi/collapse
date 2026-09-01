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
        const baseRng = o.rng || Math.random;
        // Common random numbers. Every root move's chance node currently draws
        // its own refill samples, so comparing two moves adds two independent
        // noise terms and the max picks partly on luck. Driving every root move
        // from the *same* stream makes the comparison paired: the sampling error
        // is largely common to all of them and cancels in the difference, which
        // is all that matters because only the argmax is used.
        //
        // Measured motivation: past depth 3 a search disagrees with itself on a
        // fresh sample as often as it disagrees with the rung below it (25% vs
        // 25% at d3c32), so extra depth was buying nothing but different dice.
        // This attacks that directly, and unlike more samples it is free.
        const crn = !!o.crn;
        let crnState = 1;
        const crnRng = () => {
            crnState ^= crnState << 13; crnState >>>= 0;
            crnState ^= crnState >>> 17;
            crnState ^= crnState << 5; crnState >>>= 0;
            return crnState / 4294967296;
        };
        const rng = crn ? crnRng : baseRng;
        // The stream is reset to the same value for every root move of a given
        // position, but that value is derived from the position itself. Sharing
        // one fixed pattern across every position of every game would be an
        // unforced risk: the stratification keeps each hole's marginal exact
        // whatever the shuffle, but nothing guarantees one particular shuffle is
        // unbiased for the *joint* draw, and reusing it everywhere would bake
        // that in. Per-position seeding keeps the pairing where it is wanted and
        // varies it where it is not.
        let crnSeed = 2463534242;
        const crnSeedFor = cells => {
            let h = 2166136261;
            for (let k = 0; k < N; k++) h = Math.imul(h ^ cells[k], 16777619);
            return (h >>> 0) || 1;
        };
        const crnReset = () => { crnState = crnSeed; };
        // At an internal max node, only the `topk` best moves by their shallow
        // (gain + net.value) score are searched deeper. The full width of a max
        // node is ~11 moves and almost all of them are obviously bad, so this
        // is where depth 3 becomes affordable. 0 = no pruning.
        // Same idea at the root, where the shallow ranking is usually already
        // right about which handful of moves are worth thinking about.
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
        // Skip the chance node entirely: hand the afterstate to the next max
        // node with its holes still empty and let the network evaluate the
        // zeros. The chance node is where nearly all the cost is -- it multiplies
        // the work below it by `cap` -- so this makes depth d cost about what
        // depth d-1 used to. What it gives up is that the second move is chosen
        // against a board the game will never actually present.
        const noRefill = !!o.norefill;
        // Hybrid depth: search at `depth`, and if the move that comes out makes
        // a tile of at least `esc`, search the whole position again one ply
        // deeper. The bet is that the positions where lookahead pays are not
        // spread evenly through a game -- committing a 5 or a 6 is close to
        // irreversible, since a 6 can never be collapsed again -- so the deep
        // search can be spent only on the turns that decide something.
        const esc = o.esc || 0;
        // How deep the escalated search goes. Worth setting well above
        // `depth + 1` when `esc` is rare: escalating only on 6s fires on about
        // 1.6% of moves, so even a search eight times the cost of the normal
        // one adds only a few percent to the average.
        const escDepth = o.escdepth || 0;
        // Gap-triggered deepening. `esc` escalates on a property of the move (it
        // makes a 6); `gap` escalates on a property of the *decision*: re-search
        // deeper only when the best and second-best moves are within `gap`
        // points of each other, because that is where getting it wrong costs
        // something and where a shallow search is least sure.
        //
        // The motivation is measured rather than assumed. With common random
        // numbers the search is deterministic, and a quarter of its decisions
        // still change between depth 3 and depth 4 -- yet removing all decision
        // noise (crn) changes the score by nothing. Both facts fit one
        // explanation: the moves that flip are near-ties, where either choice is
        // fine. If so, effort should go to the decisions that are close but not
        // tied, and be skipped everywhere else.
        const gapTrig = o.gap || 0;
        // Control variates at chance nodes. A chance node's job is to estimate
        // the mean of V over the tiles that could drop, and it currently does
        // that by evaluating every sample at full depth -- which is where
        // nearly all of the cost of deep search lives. Instead write
        //
        //     E[V_deep] = E[V_shallow] + E[V_deep - V_shallow]
        //
        // and estimate the first term from all B samples (cheap: one ply) and
        // the correction from only `cvk` of them. This is exact in expectation,
        // not an approximation, and it wins whenever V_deep - V_shallow varies
        // less across refills than V_deep itself does -- i.e. whenever the value
        // of looking ahead is steadier than the value of the position, which is
        // what one would expect.
        //
        // It is the unbiased form of the idea of spending most visits on one
        // outcome and few on the others: same "few deep, many shallow" shape,
        // no arbitrary weighting to reconcile the two scales.
        //
        // Only meaningful at d >= 2, since at d == 1 the full evaluation *is*
        // the shallow one.
        const cvk = o.cvk || 0;
        // Graded root allocation. `rootk` is a cliff: the top k moves each get
        // the full chance budget and everything below k gets none. But the
        // shallow ranking is not equally trustworthy all the way down -- it is
        // usually right about the best move and progressively less sure further
        // down -- so spending equally on ranks 1 and 6 is not obviously right.
        // With `grade`, rank i gets cap >> i, floored at 2. This is the
        // expectimax reading of progressive widening: allocate by how much a
        // branch is worth thinking about rather than cutting at a fixed depth
        // in the order.
        const grade = !!o.grade;
        // Anytime ladder. Instead of one fixed (depth, cap), climb a list of
        // settings in cost order until the time budget runs out, and answer with
        // the last rung that finished. That unifies the depth 2/3/4 family into
        // one knob -- milliseconds -- and can be stopped whenever the caller
        // likes, which fixed-depth search cannot.
        //
        // The rungs are the configurations measured to sit on the score/cost
        // Pareto frontier, so the ladder is not a guess about what is worth
        // trying next; it is the frontier walked from cheap to expensive. The
        // price of being anytime is the work on the rungs below the last one,
        // which here is a 25-50% overhead because consecutive rungs differ by
        // 2-5x in cost rather than the small factors classical iterative
        // deepening enjoys. Whether that overhead is worth paying is exactly
        // what the benchmark has to answer.
        const budgetMs = o.ms || 0;
        const LADDER = [
            { depth: 1, cap: 0, capDeep: 0, topk: 0, rootk: 0 },
            { depth: 2, cap: 4, capDeep: 2, topk: 2, rootk: 6 },
            { depth: 2, cap: 8, capDeep: 2, topk: 2, rootk: 6 },
            { depth: 2, cap: 16, capDeep: 2, topk: 2, rootk: 6 },
            { depth: 2, cap: 32, capDeep: 4, topk: 2, rootk: 8 },
            { depth: 2, cap: 96, capDeep: 4, topk: 2, rootk: 16 },
            { depth: 3, cap: 16, capDeep: 2, topk: 2, rootk: 6 },
            { depth: 3, cap: 32, capDeep: 4, topk: 2, rootk: 6 },
            { depth: 3, cap: 64, capDeep: 4, topk: 3, rootk: 8 },
            { depth: 4, cap: 32, capDeep: 2, topk: 2, rootk: 6 },
            { depth: 4, cap: 64, capDeep: 2, topk: 3, rootk: 8 },
            { depth: 5, cap: 64, capDeep: 2, topk: 2, rootk: 8 }
        ];

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
            // Dead: no future score. Except under `norefill`, where a board
            // below the root still has its holes and can run out of moves for
            // want of a refill that the real game would have given it. Scoring
            // that as death would make the search terrified of the big clears
            // it should like, so fall back to evaluating the position instead.
            if (nm === 0) return (noRefill && lv > 0) ? net.value(cells) : 0;
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

        function chanceValue(after, maxGen, d, lv, budgetOverride) {
            if (noRefill) return maxValue(after, maxGen, d, lv + 1);
            const hs = holes[lv];
            let nh = 0;
            for (let k = 0; k < N; k++) if (after[k] === 0) hs[nh++] = k;
            if (nh === 0) return maxValue(after, maxGen, d, lv + 1);

            const total = Math.pow(maxGen, nh);
            const budget = budgetOverride || (lv <= 1 ? cap : capDeep);
            const fill = fillBuf[lv];
            let sum = 0;

            // Control-variate estimate. `sum` accumulates the shallow value over
            // every sample; `corr` accumulates (deep - shallow) over the first
            // `k` of them, which the stratified shuffle makes an unbiased subset.
            const cv = cvk > 0 && d >= 2;
            let corr = 0, nCorr = 0;

            let sumsq = 0;
            if (total <= budget) {
                const k = cv ? Math.min(cvk, total) : 0;
                for (let x = 0; x < total; x++) {
                    let q = x;
                    fill.set(after);
                    for (let t = 0; t < nh; t++) { fill[hs[t]] = (q % maxGen) + 1; q = (q / maxGen) | 0; }
                    if (cv) {
                        const sh = maxValue(fill, maxGen, 1, lv + 1);
                        sum += sh;
                        if (x < k) { corr += maxValue(fill, maxGen, d, lv + 1) - sh; nCorr++; }
                        continue;
                    }
                    const v = maxValue(fill, maxGen, d, lv + 1);
                    sum += v; sumsq += v * v;
                }
                if (cv) return sum / total + (nCorr ? corr / nCorr : 0);
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
            const k = cv ? Math.min(cvk, B) : 0;
            for (let x = 0; x < B; x++) {
                fill.set(after);
                for (let t = 0; t < nh; t++) fill[hs[t]] = st[t * B + x];
                if (cv) {
                    const sh = maxValue(fill, maxGen, 1, lv + 1);
                    sum += sh;
                    if (x < k) { corr += maxValue(fill, maxGen, d, lv + 1) - sh; nCorr++; }
                    continue;
                }
                const v = maxValue(fill, maxGen, d, lv + 1);
                sum += v; sumsq += v * v;
            }
            if (cv) return sum / B + (nCorr ? corr / nCorr : 0);
            return adjust(sum, sumsq, B);
        }

        // The ladder varies cap/capDeep/topk/rootk per rung, so the values the
        // search reads have to be settable rather than captured constants.
        let cap = o.cap || 64, capDeep = o.capDeep || o.cap || 16;
        let topk = o.topk || 0, rootk = o.rootk || 0;

        // Root: score every legal move of a live Game at a given depth.
        function searchAt(game, d) {
            const e = exp[0];
            if (crn) crnSeed = crnSeedFor(game.cells);
            const nm = e.expand(game.cells, game.maxGen);
            const out = [];
            for (let s = 0; s < nm; s++) {
                const view = e.board(s);
                const k = e.cell(s);
                out.push({
                    move: [(k / H) | 0, k % H],
                    value: e.gain(s) + net.value(view) + (leaf ? leaf(view) : 0),
                    slot: s,
                    // Collapsing a chain of v leaves v+1 behind, so this is the
                    // tile the move commits the board to.
                    made: game.cells[k] + 1
                });
            }
            if (d <= 1 || nm === 0) return out;
            let deep = out;
            if (rootk && nm > rootk) {
                deep = out.slice().sort((p, q) => q.value - p.value).slice(0, rootk);
            }
            for (let i = 0; i < deep.length; i++) {
                const r = deep[i];
                const b = grade ? Math.max(2, cap >> i) : 0;
                // Same stream for every root move, so their errors are common.
                if (crn) crnReset();
                r.value = e.gain(r.slot) + chanceValue(e.board(r.slot), e.nextGen(r.slot), d - 1, 1, b);
            }
            return out;
        }

        // Walk the ladder until the clock says stop, answering with the last
        // rung that completed. A rung is never returned half-finished: a partial
        // pass leaves some moves scored deep and others shallow, and comparing
        // those is exactly the unequal-noise mistake that has cost this project
        // three separate ideas.
        function ladderSearch(game) {
            const t0 = Date.now();
            let best = null;
            for (const rung of LADDER) {
                cap = rung.cap || 64; capDeep = rung.capDeep || rung.cap || 16;
                topk = rung.topk; rootk = rung.rootk;
                const out = searchAt(game, rung.depth);
                best = out;
                const spent = Date.now() - t0;
                // Stop when the next rung would plausibly overrun. Rungs cost
                // 2-5x their predecessor, so assume 3x rather than discovering
                // the overrun after paying for it.
                if (spent * 3 >= budgetMs) break;
            }
            return best;
        }

        function scoreMoves(game) {
            if (budgetMs) return ladderSearch(game);
            const out = searchAt(game, depth);
            if (out.length === 0) return out;
            let best = out[0], second = null;
            for (const r of out) if (r.value > best.value) { second = best; best = r; }
                else if (!second || r.value > second.value) second = r;

            let deeper = false;
            if (esc && best.made >= esc) deeper = true;
            // A single legal move needs no thought; a tiny gap is where thought
            // is worth buying.
            if (gapTrig && second && (best.value - second.value) < gapTrig) deeper = true;

            // Re-search the whole position, not just the leader: a deeper value
            // for one move is not comparable with shallow values for its
            // rivals, and the point is to let the extra ply change the ranking.
            return deeper ? searchAt(game, escDepth || depth + 1) : out;
        }

        return { scoreMoves };
    }

    // Deterministic no-refill tactical lookahead with a separately trained
    // evaluator for every synthetic depth. This is deliberately *not* the old
    // `norefill` expectimax option above. At an afterstate A at level d it uses
    //
    //   H_d(A) = V_d(A) + beta_d max(0, max_m(gain(m) + H_{d+1}(A_m)) - V_d(A))
    //
    // so stopping the visible line and allowing a normal refill is always an
    // available option. A no-refill child may raise the estimate, never lower
    // it. The depth-specific heads are trained by norefill-train.js to predict
    // exactly that "refill now" value on their synthetic state distributions.
    function makeNoRefillSearcher(nets, opts) {
        const o = opts || {};
        const depth = Math.max(1, o.depth || nets.length);
        if (!Array.isArray(nets) || nets.length < depth)
            throw new Error('no-refill search depth ' + depth + ' needs ' + depth + ' networks');

        const exp = [];
        for (let d = 0; d < depth; d++) exp.push(makeExpander());

        function betaAt(level) {
            const named = o['beta' + level];
            return named != null ? Number(named) : (o.beta != null ? Number(o.beta) : 1);
        }

        // `level` is one-based: level 1 is the ordinary root afterstate, level
        // 2 is after one further visible collapse without a refill, and so on.
        function afterValue(cells, maxGen, level) {
            const base = nets[level - 1].value(cells);
            if (level >= depth) return base;
            const beta = betaAt(level);
            if (!Number.isFinite(beta) || beta < 0)
                throw new Error('no-refill beta' + level + ' must be a non-negative number');
            if (beta === 0) return base;

            const e = exp[level];
            const nm = e.expand(cells, maxGen);
            if (nm === 0) return base;                 // choose the stop action
            let continuation = -Infinity;
            for (let s = 0; s < nm; s++) {
                const v = e.gain(s) + afterValue(e.board(s), e.nextGen(s), level + 1);
                if (v > continuation) continuation = v;
            }
            return base + beta * Math.max(0, continuation - base);
        }

        function scoreMoves(game) {
            const e = exp[0];
            const nm = e.expand(game.cells, game.maxGen);
            const out = [];
            for (let s = 0; s < nm; s++) {
                const k = e.cell(s);
                out.push({
                    move: [(k / H) | 0, k % H],
                    value: e.gain(s) + afterValue(e.board(s), e.nextGen(s), 1),
                    slot: s,
                    made: game.cells[k] + 1
                });
            }
            return out;
        }

        return { scoreMoves };
    }

    return { makeSearcher, makeNoRefillSearcher, makeExpander, components, collapseInto };
});
