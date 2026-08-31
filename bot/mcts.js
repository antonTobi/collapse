// ============================================================================
// MCTS over the n-tuple value network, with the network AT THE LEAVES instead
// of a rollout.
//
// The tree alternates two node kinds, exactly as the expectimax in search.js
// does:
//
//   max node     a full board. Pick a legal move.
//   chance node  a move's afterstate (holes where the chain collapsed, columns
//                fallen). Which tiles drop in is the randomness.
//
// The difference from search.js is the shape of the tree. Fixed-depth
// expectimax spends the same budget on every branch to a fixed horizon; this
// grows an asymmetric tree, guided by two rules that make it worth doing:
//
//   * MAX NODES use UCB, but with the exploration term sqrt(sqrt(N)/n) rather
//     than the textbook sqrt(log N / n). A node's value here is NOT stationary
//     -- it drifts upward as the node is searched deeper, because deeper search
//     finds better moves -- and that is exactly the case the log-term bandit
//     bound is not built for. It is worse in a single-player game, where there
//     is no adversary to cap the drift, so we explore much harder.
//
//   * CHANCE NODES are treated asymmetrically by design. For a move visited n
//     times we look at only ~n^0.2 distinct refills, spend ~n^0.9 visits spread
//     across the less-visited ones and the remaining n - n^0.9 on a SINGLE
//     refill -- so the tree can go deep down one line and learn what a better
//     move a few plies down is worth. The move's value is then a weighted
//     average in which that deep refill gets only 1/log n of the weight and the
//     others share 1 - 1/log n: the deep line scores higher because it is
//     searched hardest, and down-weighting it corrects that optimism.
//
// A leaf is a full board that has not been expanded yet; its value is the
// greedy one-ply estimate max_m (gain + net.value(afterstate)). We never call
// net.value on a full board directly -- the network is trained on afterstates
// (holes), so a full board is off its training distribution; the greedy max
// over afterstate values is the in-distribution reading and is what td/depth-1
// use everywhere else.
//
// Refill order matches the engine: an afterstate's holes are its zeros, and
// filling them in ascending index order reproduces the generator's fill order
// (columns left to right, bottom to top), so a filled board is a genuine
// successor. See search.js for the verification note.
// ============================================================================

(function (root, factory) {
    if (typeof module === 'object' && module.exports)
        module.exports = factory(require('./search.js'));
    else root.CollapseMCTS = factory(root.CollapseSearch);
})(typeof self !== 'undefined' ? self : this, function (Search) {

    const H = 5, N = 25;

    function makeMcts(net, opts) {
        const o = opts || {};
        const sims = o.sims || 2000;
        // Unitless: children's Q are min-max normalized to [0,1] before this is
        // added, so c does not have to carry the (large, drifting) point scale.
        // 0.1 from a grid44 sweep: 0.4+ over-explores and loses to greedy; the
        // score is flat over c in [0.05, 0.2] and falls off above it.
        const c = o.c != null ? o.c : 0.1;
        const capExp = o.capExp != null ? o.capExp : 0.2;   // distinct refills ~ n^capExp
        const splitExp = o.splitExp != null ? o.splitExp : 0.9; // exploration visits ~ n^splitExp
        const maxDepth = o.maxdepth || 40;
        // Which exploration term the max-node UCB uses:
        //   'ss'  sqrt(sqrt(N)/n)  -- the enlarged term (tip 2), the default.
        //   'log' sqrt(log(N)/n)   -- the textbook UCB1 term, for comparison.
        const ucbForm = o.ucb || 'ss';
        // How chance nodes (refills) are handled:
        //   'tip' the asymmetric deep/exploration split with 1/log n down-
        //         weighting of the deep line (tip 1), the default.
        //   'pw'  textbook progressive widening: cap distinct refills at n^capExp,
        //         route to the least-visited, value = plain mean over them (an
        //         unbiased Monte-Carlo expectation, no deep line, no re-weight).
        const chanceForm = o.chance || 'tip';
        // Ceiling on how many max nodes one decision may grow. A position with a
        // long survivable deep line can otherwise build a tree big enough to
        // exhaust the heap at large `sims`; past the ceiling the search stops
        // creating new refills and only refines the tree it has, which bounds
        // memory (~maxnodes nodes) and time while barely touching normal play,
        // where a decision expands far fewer nodes than this.
        const maxNodes = o.maxnodes || 120000;
        const rng = o.rng || Math.random;

        // Max nodes created in the current decision (reset each scoreMoves).
        let nodeCount = 0;

        // One expander shared across the whole tree. Its scratch is overwritten
        // on the next expand(), so a node must copy its afterstates out the
        // moment it is expanded -- which is what expand() below does.
        const exp = Search.makeExpander();

        // --- max node -------------------------------------------------------
        // Lazily expanded. Before expansion `edges` is null and `value` holds
        // the greedy leaf estimate; after expansion `edges` is the move list.
        function MaxNode(cells, maxGen) {
            this.cells = cells;        // owned Uint8Array(25)
            this.maxGen = maxGen;
            this.edges = null;
            this.terminal = false;
            this.Nvisits = 0;          // total visits into this node
            this.value = 0;            // current estimate
        }

        function expand(node) {
            const nm = exp.expand(node.cells, node.maxGen);
            if (nm === 0) { node.terminal = true; node.edges = []; node.value = 0; return; }
            const edges = new Array(nm);
            let best = -Infinity;
            for (let s = 0; s < nm; s++) {
                const after = exp.copy(s);             // copy out before the next expand
                const gain = exp.gain(s);
                const k = exp.cell(s);
                const q = gain + net.value(after);     // prior = greedy one-ply value
                edges[s] = {
                    move: [(k / H) | 0, k % H],
                    gain,
                    nextGen: exp.nextGen(s),
                    after,
                    n: 0,
                    Q: q,
                    chance: null
                };
                if (q > best) best = q;
            }
            node.edges = edges;
            node.value = best;
        }

        // --- chance node ----------------------------------------------------
        // Children are distinct refills of the move's afterstate. child[0] is
        // the "deep" refill (the one that soaks up the n - n^0.9 visits).
        function ChanceNode(after, maxGen) {
            this.after = after;        // afterstate with zero-holes
            this.maxGen = maxGen;
            this.holes = [];
            for (let k = 0; k < N; k++) if (after[k] === 0) this.holes.push(k);
            // How many distinct refills exist at all. When this is <= the cap we
            // will enumerate them exactly instead of sampling.
            this.total = Math.pow(maxGen, this.holes.length);
            this.children = [];        // { cells, node, visits }
            this.d = 0;                // visits routed to the deep refill
            this.e = 0;                // visits routed to exploration refills
            this.value = 0;
        }

        // Build the full board for the x-th enumerated refill (x in base maxGen
        // over the holes, low hole = low digit), or a random one when x < 0.
        function fillBoard(chance, x) {
            const cells = chance.after.slice();
            const holes = chance.holes, maxGen = chance.maxGen;
            if (x < 0) {
                for (let t = 0; t < holes.length; t++)
                    cells[holes[t]] = ((rng() * maxGen) | 0) + 1;
            } else {
                let q = x;
                for (let t = 0; t < holes.length; t++) { cells[holes[t]] = (q % maxGen) + 1; q = (q / maxGen) | 0; }
            }
            return cells;
        }

        function newRefill(chance) {
            const enumerate = chance.total <= capOf(chance);
            let cells;
            if (enumerate) {
                // Take the next unused enumeration index, so the distinct
                // refills really are distinct when the space is small.
                cells = fillBoard(chance, chance.children.length);
            } else {
                cells = fillBoard(chance, -1);
            }
            const child = { cells, node: new MaxNode(cells, chance.maxGen), visits: 0 };
            nodeCount++;
            chance.children.push(child);
            return child;
        }

        // The distinct-refill cap for a chance node at its current visit count,
        // never more than the number of refills that actually exist.
        function capOf(chance) {
            const n = chance.d + chance.e + 1;         // counting the visit about to happen
            const cap = Math.max(1, Math.round(Math.pow(n, capExp)));
            return Math.min(cap, chance.total);
        }

        // Route this visit to a refill child, creating one if the rules call for
        // it. Returns the child (or null when the node budget is spent and there
        // is nothing to descend into -- the caller then scores it as a leaf).
        function route(chance) {
            const children = chance.children;
            if (children.length === 0)
                return nodeCount < maxNodes ? newRefill(chance) : null;

            // Textbook progressive widening: keep <= cap distinct refills, always
            // route to the least-visited one, no deep/exploration distinction.
            if (chanceForm === 'pw') {
                const cap = capOf(chance);
                chance.e++;                            // e doubles as the visit count
                if (nodeCount < maxNodes && children.length < cap && children.length < chance.total)
                    return newRefill(chance);
                let bi = 0, bv = children[0].visits;
                for (let i = 1; i < children.length; i++)
                    if (children[i].visits < bv) { bv = children[i].visits; bi = i; }
                return children[bi];
            }

            const n = chance.d + chance.e + 1;
            const cap = capOf(chance);
            const wantExplore = chance.e < Math.pow(n, splitExp);

            if (wantExplore && cap >= 2) {
                chance.e++;
                // Room for another distinct exploration refill? (children - 1
                // exploration refills so far, want up to cap - 1 of them.) Stop
                // growing once the per-decision node budget is spent.
                const canGrow = nodeCount < maxNodes && children.length < chance.total;
                if (canGrow && children.length - 1 < cap - 1)
                    return newRefill(chance);
                // No exploration sibling yet (budget-capped before one was made):
                // fall back to the deep refill.
                if (children.length <= 1) return children[0];
                // Otherwise spread the exploration budget over the existing ones:
                // least-visited exploration refill (indices 1..).
                let bi = 1, bv = children[1].visits;
                for (let i = 2; i < children.length; i++)
                    if (children[i].visits < bv) { bv = children[i].visits; bi = i; }
                return children[bi];
            }
            chance.d++;
            return children[0];        // the deep refill
        }

        // Value handed up to the move: deep refill weighted 1/ln n, the rest
        // (equally likely) sharing the remaining weight equally. With a single
        // child it is just that child.
        function aggregate(chance) {
            const children = chance.children;
            if (children.length === 0) return 0;
            if (children.length === 1) return children[0].node.value;
            // Progressive widening: plain mean over the distinct sampled refills
            // (each drawn from the true distribution, so this is an unbiased
            // Monte-Carlo expectation over which tiles fall).
            if (chanceForm === 'pw') {
                let sum = 0;
                for (let i = 0; i < children.length; i++) sum += children[i].node.value;
                return sum / children.length;
            }
            const n = chance.d + chance.e;
            let w = 1 / Math.log(Math.max(n, 3));      // guard ln n <= 1 near the start
            if (w > 1) w = 1;
            let expSum = 0;
            for (let i = 1; i < children.length; i++) expSum += children[i].node.value;
            const expMean = expSum / (children.length - 1);
            return w * children[0].node.value + (1 - w) * expMean;
        }

        // --- selection at a max node (normalized UCB, enlarged exploration) --
        function selectEdge(node) {
            const edges = node.edges;
            let qmin = Infinity, qmax = -Infinity;
            for (const e of edges) { if (e.Q < qmin) qmin = e.Q; if (e.Q > qmax) qmax = e.Q; }
            const span = qmax - qmin;
            const Np = node.Nvisits;
            let best = null, bestScore = -Infinity, ties = 0;
            for (const e of edges) {
                let score;
                if (e.n === 0) score = Infinity;       // try every move once first
                else {
                    const normQ = span > 0 ? (e.Q - qmin) / span : 0.5;
                    const explore = ucbForm === 'log'
                        ? Math.sqrt(Math.log(Math.max(Np, 2)) / e.n)   // textbook UCB1
                        : Math.sqrt(Math.sqrt(Np) / e.n);              // enlarged (tip 2)
                    score = normQ + c * explore;
                }
                if (score > bestScore) { bestScore = score; best = e; ties = 1; }
                else if (score === bestScore) { ties++; if (rng() < 1 / ties) best = e; }
            }
            return best;
        }

        // --- one simulation -------------------------------------------------
        function simulate(node, depth) {
            if (node.terminal) return 0;
            if (node.edges === null) { expand(node); return node.value; }  // leaf: net.value
            if (depth >= maxDepth) return node.value;                      // safety cap

            const e = selectEdge(node);
            if (e.chance === null) e.chance = new ChanceNode(e.after, e.nextGen);
            const child = route(e.chance);
            if (child === null) {
                // Node budget spent and nothing to descend into: score the
                // afterstate directly (the net is trained on afterstates), grow
                // nothing. Keeps memory bounded by ~maxnodes in hard positions.
                e.chance.value = net.value(e.chance.after);
            } else {
                simulate(child.node, depth + 1);
                child.visits++;
                e.chance.value = aggregate(e.chance);
            }

            e.n++;
            node.Nvisits++;
            e.Q = e.gain + e.chance.value;
            let best = -Infinity;
            for (const ed of node.edges) if (ed.Q > best) best = ed.Q;
            node.value = best;
            return node.value;
        }

        // --- root -----------------------------------------------------------
        function scoreMoves(game) {
            nodeCount = 1;                              // the root
            const root = new MaxNode(game.cells.slice(), game.maxGen);
            expand(root);
            if (root.terminal || root.edges.length === 0) return [];
            root.Nvisits = 0;
            for (const e of root.edges) e.n = 0;       // expand() left Nvisits/n at 0 already
            for (let s = 0; s < sims; s++) simulate(root, 0);
            return root.edges.map(e => ({ move: e.move, value: e.Q }));
        }

        return { scoreMoves };
    }

    return { makeMcts };
});
