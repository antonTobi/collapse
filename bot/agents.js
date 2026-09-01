// ============================================================================
// Agents
//
// An agent is an object { name, chooseMove(game) -> [i, j] }.
// Agents exposing scoreMoves(game) -> [{move, value}] get their evaluations
// drawn on the board in the spectator.
//
// Agents are addressed by a spec string, so run.js and spectate.js can build
// any configuration without code changes:
//
//     random
//     maxmoves
//     linear:preset=tuned
//     linear:moves=1,made=-2.5,comp5=-1
//     search:depth=3,preset=tuned
//
// IMPORTANT: lookahead must not peek at the real tile generator. `preview`
// takes a fill mode; agents use FILL_NONE / FILL_SIX (no information about
// upcoming tiles) or FILL_SAMPLE (fair: samples the known distribution with the
// agent's own RNG). FILL_RANDOM would be cheating.
// ============================================================================

(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory(require('./engine.js'), require('./eval.js'), require('./ntuple.js'), require('./search.js'), require('./mcts.js'), require('./freeze.js'), require('./cheat.js'));
    } else {
        root.CollapseAgents = factory(root.Collapse, root.CollapseEval, root.CollapseNTuple, root.CollapseSearch, root.CollapseMCTS, root.CollapseFreeze, root.CollapseCheat);
    }
})(typeof self !== 'undefined' ? self : this, function (Collapse, Ev, NTuple, Search, MCTS, Freeze, Cheat) {

    const { FILL_NONE, FILL_SIX, FILL_SAMPLE } = Collapse;

    // Deterministic PRNG for agent-side randomness, separate from the game's.
    function makeRng(seed) {
        let s = (seed >>> 0) || 1;
        return function () {
            s |= 0; s = (s + 0x6D2B79F5) | 0;
            let t = Math.imul(s ^ (s >>> 15), 1 | s);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    // ---- named weight sets -------------------------------------------------
    // Recorded here so a leaderboard entry is reproducible from its name alone.
    const PRESETS = {
        maxmoves: { moves: 1 },
        // v1: prefer creating the smallest possible tile, break ties on legal
        // move count. The `made` weight is large enough to be lexicographic.
        v1: { moves: 0.70661, made: -17.2302 },
        // v2: v1 plus positional features, coordinate-ascent tuned on seeds
        // 10001-10300. `pairs` (adjacent same-value tiles) turned out to be a
        // better "potential" measure than the legal move count alone.
        v2: { moves: 0.70661, pairs: 0.86982, made: -17.76868, made4: 1, made5: 1.42857, gain: 0.14062, sixopen: -1.79308, heightsum: -0.0326, lowtiles: 0.38185 },
        // v3: longer coordinate ascent from v2 (seeds 10001-10400).
        v3: { moves: 0.70661, pairs: 0.6213, made: -17.76868, made4: 1, made5: 1.42857, gain: 0.14062, sixopen: -2.82358, heightsum: -0.0652, lowtiles: -0.38185, cnt1: -0.5, cnt3: -0.45455 },
        // v4: adds 5-placement. A 5 is nearly inert -- it can only ever be
        // consumed by merging with another 5 -- so it wants to be tucked
        // against walls and 6s (`new5blocked`, `fiveblocked`) rather than left
        // in open board. With those present, keeping the 5s in one group
        // (`comp5`) finally pays too; on its own it never did.
        v4: { moves: 0.70661, pairs: 0.86982, made: -17.49946, made4: 1.24, made5: 2.48571, made6: -1, gain: 0.23437, comp5: -1.20366, singles: 0.7149, sixopen: -4.12201, trapped: 0.73439, heightsum: -0.0652, lowtiles: -0.38185, sixes: 2.44063, cnt1: -1.12, cnt3: -0.45455, cnt4: -0.1625, cnt5: -0.76, distinct: 0.625, s_moves: 0.05882, s_made: 0.06786, s_sixopen: 0.3, new5blocked: 0.63678, fiveblocked: 0.54391, fournear5: 0.23182 },
        // h1: not tuned by playing at all -- fitted by bot/fit.js to which move
        // strong humans chose, over the 1831 replays scoring 6000+. One gradient
        // sets all 45 weights at once from 100k real decisions, instead of one
        // axis at a time against a noisy game mean, which is why it reaches
        // v4's level in minutes rather than hours.
        h1: { moves: 0.70661, pairs: 9.52882, made: -21.82548, made3: 15.96336, made4: 23.62997, made5: -62.11384, made6: -36.16061, gain: -0.13075, comp4: -10.34639, comp5: -15.33058, singles: 9.54933, sixopen: -22.13343, trapped: -2.19205, heightsum: -0.16771, lowtiles: 4.06426, sixes: -36.16061, chain: 1.79651, cnt1: -10.88994, cnt2: -6.78763, cnt3: 1.21821, cnt4: 2.39909, cnt5: 0.05238, iso: -2.76318, pairlo: 4.99425, pairhi: -4.99356, distinct: -8.47303, gen4: -27.88141, chain5: -1.30217, chainlow: 5.56417, s_moves: 0.0643, s_pairs: 0.68012, s_made: 0.04841, s_sixopen: 1.03591, s_gain: 0.00943, s_heightsum: -0.09317, new5bond: 26.9321, new5colgap: -6.05424, new5blocked: 22.53527, fivebond: -4.85985, fiveblocked: 3.28176, fivecols: 0.81931, fivespan: 0.33844, fivemax: -1.39534, fournear5: 0.78087 },
        // h2: coordinate ascent from h1, 400 games on seeds 10001-10400. Kept
        // as a warning, not as an improvement: it gained +197 on the seeds it
        // was tuned on and LOST 169 +- 109 on 300 held-out ones. Forty-five
        // features x 2 directions x 3 rounds is a lot of selection against a
        // +-69 estimate, and what it selected was mostly noise. h1 is the
        // better agent; see LEADERBOARD.md.
        h2: { moves: 0.70661, pairs: 9.77732, made: -21.82544, made3: 16.9634, made4: 23.87, made5: -62.11371, made6: -35.6808, gain: -0.13076, comp4: -10.34636, comp5: -15.33052, singles: 9.54933, sixopen: -23.16385, trapped: -2.19217, heightsum: -0.16771, lowtiles: 4.82801, sixes: -33.65369, chain: 1.7965, cnt1: -10.8899, cnt2: -6.33309, cnt3: 1.21818, cnt4: 2.39912, cnt5: 0.0524, iso: -2.76317, pairlo: 4.99425, pairhi: -4.99357, distinct: -8.473, gen4: -22.88133, chain5: -1.30214, chainlow: 5.5642, s_moves: 0.15253, s_pairs: 0.68012, s_made: 0.04841, s_sixopen: 0.77728, s_gain: 0.00162, s_heightsum: -0.09317, new5bond: 26.93221, new5colgap: -6.05438, new5blocked: 22.53515, fivebond: -4.85983, fiveblocked: 3.28175, fivecols: 1.3468, fivespan: -0.19929, fivemax: -1.39534, fournear5: 0.78088 }
    };

    // Curated specs for the spectator dropdown: full specs (so the preset is
    // never ambiguous), best first, labelled with their seeds 1-100 mean.
    // Entries with `weights` need that file fetched before the agent can be
    // built; spectate.js loads it and passes it in as `options.network`, which
    // is why those agents work in the browser at all.
    // SPECS[0] is what the spectate page opens on, so it must be an agent whose
    // weight file is in the repository. `anneal14-Rcq.bin` is the deployed net
    // (all7h tuple set, virtual-cell globals, trained freeze-root then a low-alpha
    // anneal, reduce->compact->quantize; see bot/README.md). It is FREEZE-
    // DEPENDENT -- trained with --freeze-root, so every deployed spec passes
    // `freeze=1`; without it the net plays materially worse. The d2 config also
    // carries `esc=6` (re-search one ply deeper when the best move makes a 6):
    // worth +170 +-60 over plain d2 at ~2x per-move cost (a cost-matched cap
    // increase ties it, so esc is the default). Depth 2 comes before depth 3
    // because building a replay is synchronous: ~1000 moves at ~10ms is a few
    // seconds, at depth 3 it is the better part of a minute of frozen page.
    const SPECS = [
        { spec: 'fx:weights=bot/weights/anneal14-Rcq.bin,depth=2,cap=16,rootk=6,freeze=1,esc=6', weights: 'bot/weights/anneal14-Rcq.bin', label: 'expectimax depth 2, deployed net  (11067)' },
        { spec: 'fx:weights=bot/weights/anneal14-Rcq.bin,depth=3,cap=32,capDeep=4,topk=2,rootk=6,freeze=1', weights: 'bot/weights/anneal14-Rcq.bin', label: 'expectimax depth 3, deployed net' },
        // Clairvoyant yardsticks: same net, but the lookahead peeks at the tiles
        // the RNG will actually drop (see cheat.js) -- an out-of-competition
        // ceiling, not a real agent, which is why they sit here rather than at the
        // top despite outscoring everything. depth 2 is slow (~12 ms/move, so a
        // full game is a ~35 s frozen page, like fx depth 3).
        { spec: 'cheat:weights=bot/weights/anneal14-Rcq.bin,depth=2,freeze=1', weights: 'bot/weights/anneal14-Rcq.bin', label: 'CHEAT depth 2 (sees the future), deployed net  (14388)' },
        { spec: 'cheat:weights=bot/weights/anneal14-Rcq.bin,depth=1,freeze=1', weights: 'bot/weights/anneal14-Rcq.bin', label: 'CHEAT depth 1 (sees the future), deployed net  (13161)' },
        { spec: 'td:weights=bot/weights/anneal14-Rcq.bin,freeze=1', weights: 'bot/weights/anneal14-Rcq.bin', label: 'deployed net, greedy, no search  (9308)' },
        { spec: 'td:weights=bot/weights/mini5.bin', weights: 'bot/weights/mini5.bin', label: 'mini5 net, greedy  (7598)' },
        { spec: 'td:weights=bot/weights/c_base.bin', weights: 'bot/weights/c_base.bin', label: 'minimal control net, greedy  (5735)' },
        { spec: 'linear:preset=h1', label: 'linear h1  (5351, fitted to humans)' },
        { spec: 'linear:preset=v4', label: 'linear v4  (5160)' },
        { spec: 'linear:preset=v3', label: 'linear v3  (4265)' },
        { spec: 'linear:preset=v2', label: 'linear v2  (3759)' },
        { spec: 'linear:preset=v1', label: 'linear v1  (2619)' },
        { spec: 'maxmoves', label: 'maxmoves  (855)' },
        { spec: 'random', label: 'random  (469)' }
    ];

    // ---- registry ----------------------------------------------------------
    const registry = {};
    function register(name, factory) { registry[name] = factory; }
    function agentNames() { return Object.keys(registry); }

    // "linear:moves=1,made=-2" -> { name: 'linear', options: {moves: 1, made: -2} }
    function parseSpec(spec) {
        // Split on the FIRST colon only: the name is before it, everything after
        // is the parameter list. A plain split(':') would also break on the
        // colon in a Windows absolute path (weights=C:\...), truncating it.
        const s = String(spec);
        const c = s.indexOf(':');
        const name = c < 0 ? s : s.slice(0, c);
        const rest = c < 0 ? '' : s.slice(c + 1);
        const options = {};
        if (rest) {
            for (const part of rest.split(',')) {
                if (!part) continue;
                const eq = part.indexOf('=');
                const key = eq < 0 ? part : part.slice(0, eq);
                const raw = eq < 0 ? 'true' : part.slice(eq + 1);
                options[key] = raw === 'true' ? true : raw === 'false' ? false
                    : (raw !== '' && !isNaN(Number(raw)) ? Number(raw) : raw);
            }
        }
        return { name, options };
    }

    function createAgent(spec, extra) {
        const { name, options } = parseSpec(spec);
        const factory = registry[name];
        if (!factory) throw new Error(`Unknown agent "${name}". Available: ${agentNames().join(', ')}`);
        const agent = factory(Object.assign({}, options, extra || {}));
        agent.spec = String(spec);
        return agent;
    }

    // Pull a weight vector out of agent options: start from a preset (if any),
    // then let explicit feature=value options override individual weights.
    const BEST_PRESET = 'v4';

    // Weight vectors produced by fit.js are 45 numbers long, which makes for an
    // unreadable spec string (and an unreadable benchmark table). `json=PATH`
    // loads one from disk instead, so a fitted agent is still addressable by a
    // short spec: linear:json=bot/weights/fit8000.json
    const jsonCache = {};
    function loadWeightsFile(file) {
        if (jsonCache[file]) return jsonCache[file];
        if (typeof require !== 'function') throw new Error('linear:json= needs Node');
        const fs = require('fs'), path = require('path');
        const full = path.isAbsolute(file) ? file : path.join(__dirname, '..', file);
        jsonCache[file] = JSON.parse(fs.readFileSync(full, 'utf8'));
        return jsonCache[file];
    }

    function weightsFromOptions(options) {
        if (options.json) {
            const weights = Object.assign({}, loadWeightsFile(options.json));
            for (const key of Ev.FEATURES) if (key in options) weights[key] = options[key];
            return weights;
        }
        const explicit = Ev.FEATURES.some(f => f in options);
        // With no preset and no explicit weights, use the strongest preset --
        // a bare `linear` should be the best agent, not an arbitrary default.
        // With explicit weights (as the tuner emits) take them as the whole
        // vector, so a tuning run is never silently seeded by a preset.
        const name = options.preset || (explicit ? null : BEST_PRESET);
        const base = name ? PRESETS[name] : {};
        if (name && !base) throw new Error(`Unknown preset "${name}"`);
        const weights = Object.assign({}, base);
        for (const key of Ev.FEATURES) {
            if (key in options) weights[key] = options[key];
        }
        return weights;
    }

    // ---- generic 1-ply greedy ---------------------------------------------
    // evaluate(next, move, game) -> number (higher is better)
    function greedy(name, evaluate, opts) {
        const options = opts || {};
        const fill = options.fill || FILL_NONE;
        const rng = options.rng || Math.random;
        // With samples > 0 the position is evaluated on boards where the
        // incoming tiles have actually been drawn (from the known distribution,
        // using our own RNG) and the values averaged, instead of on a board
        // with an empty top. Every candidate move in one decision sees the same
        // draws, so the comparison stays paired.
        const samples = options.samples || 0;
        return {
            name,
            scoreMoves(game) {
                const moves = game.legalMoves();
                if (!samples) {
                    return moves.map(move => ({
                        move,
                        value: evaluate(game.preview(move[0], move[1], fill), move, game)
                    }));
                }
                const draws = [];
                for (let s = 0; s < samples; s++) draws.push((rng() * 2 ** 32) >>> 0);
                return moves.map(move => {
                    let sum = 0;
                    for (const d of draws) {
                        game.sampleRng = makeRng(d);
                        sum += evaluate(game.preview(move[0], move[1], FILL_SAMPLE), move, game);
                    }
                    return { move, value: sum / samples };
                });
            },
            chooseMove(game) {
                const scored = this.scoreMoves(game);
                if (!scored.length) return null;
                let best = -Infinity;
                for (const s of scored) if (s.value > best) best = s.value;
                const tied = scored.filter(s => s.value === best);
                return tied[Math.floor(rng() * tied.length)].move;
            }
        };
    }

    // Linear evaluation over eval.js features.
    function linearEvaluator(weights) {
        const w = Ev.toVector(weights);
        const buf = new Float64Array(Ev.NF);
        return function (next, move, game) {
            const n = game.at(move[0], move[1]);
            const gain = next.score - game.score;
            Ev.extract(next, n + 1, gain, buf, gain / n);
            let sum = 0;
            for (let k = 0; k < Ev.NF; k++) sum += w[k] * buf[k];
            return sum;
        };
    }

    // ---- agents ------------------------------------------------------------

    register('random', function (options) {
        const rng = makeRng(options.seed != null ? options.seed : 1);
        return {
            name: 'random',
            chooseMove(game) {
                const moves = game.legalMoves();
                return moves.length ? moves[Math.floor(rng() * moves.length)] : null;
            }
        };
    });

    // Maximize the number of legal moves after the collapse. Ties broken randomly.
    register('maxmoves', function (options) {
        const rng = makeRng(options.seed != null ? options.seed : 1);
        return greedy('maxmoves', next => next.countLegalMoves(), { rng });
    });

    // Weighted sum of eval.js features, 1-ply.
    register('linear', function (options) {
        const rng = makeRng(options.seed != null ? options.seed : 1);
        const weights = weightsFromOptions(options);
        const agent = greedy('linear', linearEvaluator(weights), { rng, samples: options.samples, fill: options.fill });
        agent.weights = weights;
        return agent;
    });

    // ---- n-ply search ------------------------------------------------------
    // Value of a line = sum of the move terms along it + the positional term of
    // the leaf. A line that runs out of legal moves scores -death, so deeper
    // search is mostly buying survival: with fill=six every unknown tile is an
    // unusable blocker, so "still has moves at depth d" means "guaranteed to
    // survive d plies no matter what falls in".
    register('search', function (options) {
        const rng = makeRng(options.seed != null ? options.seed : 1);
        const weights = weightsFromOptions(options);
        const w = Ev.toVector(weights);
        const depth = options.depth || 2;
        const death = options.death != null ? options.death : 200;
        const fill = options.fill || FILL_NONE;
        const buf = new Float64Array(Ev.NF);

        // Returns [moveTerm, positionTerm] for playing `move` in `game`.
        function parts(next, move, game) {
            const n = game.at(move[0], move[1]);
            const gain = next.score - game.score;
            Ev.extract(next, n + 1, gain, buf, gain / n);
            let mv = 0, pv = 0;
            for (let k = 0; k < Ev.NF; k++) {
                if (w[k] === 0) continue;
                if (Ev.IS_MOVE_FEATURE[k]) mv += w[k] * buf[k]; else pv += w[k] * buf[k];
            }
            return [mv, pv];
        }

        function value(game, d) {
            const moves = game.legalMoves();
            if (!moves.length) return -death;
            let best = -Infinity;
            for (const m of moves) {
                const next = game.preview(m[0], m[1], fill);
                const [mv, pv] = parts(next, m, game);
                const v = d <= 1 ? mv + pv : mv + value(next, d - 1);
                if (v > best) best = v;
            }
            return best;
        }

        return {
            name: 'search',
            scoreMoves(game) {
                game.sampleRng = rng;
                return game.legalMoves().map(move => {
                    const next = game.preview(move[0], move[1], fill);
                    const [mv, pv] = parts(next, move, game);
                    return { move, value: depth <= 1 ? mv + pv : mv + value(next, depth - 1) };
                });
            },
            chooseMove(game) {
                const scored = this.scoreMoves(game);
                if (!scored.length) return null;
                let best = -Infinity;
                for (const s of scored) if (s.value > best) best = s.value;
                const tied = scored.filter(s => s.value === best);
                return tied[Math.floor(rng() * tied.length)].move;
            },
            weights
        };
    });

    // ---- learned n-tuple value function ------------------------------------
    // Picks the move maximizing (points scored now) + V(resulting afterstate),
    // where V is the network trained by bot/train.js. Evaluation is 36 table
    // lookups per candidate move, so this is no slower than the linear agent.
    // Weight files carry their own architecture (tuple set, symmetry, stages),
    // so a spec only has to name the file. `sym=` is still accepted, because the
    // original headerless files predate the header and cannot say.
    const netCache = {};
    function loadNetwork(file, override) {
        const key = file + '|' + JSON.stringify(override || null);
        if (netCache[key]) return netCache[key];
        if (typeof require !== 'function') throw new Error('td agent needs Node (or a preloaded network)');
        const path = require('path');
        const full = path.isAbsolute(file) ? file : path.join(__dirname, '..', file);
        netCache[key] = NTuple.load(full, override);
        return netCache[key];
    }

    register('td', function (options) {
        const rng = makeRng(options.seed != null ? options.seed : 1);
        const override = 'sym' in options ? { sym: !!options.sym } : null;
        const net = options.network || loadNetwork(options.weights || 'bot/weights/td1.bin', override);
        // Freeze-root, as in fx: show provably-dead tiles to the net as 6s
        // (see bot/freeze.js). Behaviour-preserving -- legal moves are unchanged,
        // so the chosen move is still legal on the real board. Nets trained with
        // --freeze-root expect this and play worse without it.
        const freeze = !!options.freeze;
        const froze = freeze ? game => { const g = game.clone(); g.cells = Freeze.freezeBoard(game.cells); return g; }
            : game => game;
        return {
            name: 'td',
            scoreMoves(game) {
                const g = froze(game);
                return g.legalMoves().map(move => {
                    const after = g.preview(move[0], move[1], FILL_NONE);
                    return { move, value: (after.score - g.score) + net.value(after.cells) };
                });
            },
            chooseMove(game) {
                const scored = this.scoreMoves(game);
                if (!scored.length) return null;
                let best = -Infinity;
                for (const s of scored) if (s.value > best) best = s.value;
                const tied = scored.filter(s => s.value === best);
                return tied[Math.floor(rng() * tied.length)].move;
            }
        };
    });

    // Blend of the hand-tuned linear evaluation and the learned value function.
    // The two are trained on completely different principles and make different
    // mistakes, so the combination can beat either. `beta` scales the learned
    // term (which is in points) against the linear term (arbitrary units).
    register('blend', function (options) {
        const rng = makeRng(options.seed != null ? options.seed : 1);
        const net = options.network || loadNetwork(options.weights || 'bot/weights/td1.bin',
            'sym' in options ? { sym: !!options.sym } : null);
        const beta = options.beta != null ? options.beta : 1;
        const evaluate = linearEvaluator(weightsFromOptions(options));
        const agent = greedy('blend', (next, move, game) =>
            evaluate(next, move, game) + beta * ((next.score - game.score) + net.value(next.cells)),
            { rng });
        return agent;
    });

    // ---- Monte Carlo policy rollouts --------------------------------------
    // One step of policy improvement over `base`: rank the top `cands` moves by
    // playing the base policy forward from each and comparing the outcome.
    // Refills use FILL_SAMPLE, which draws from the same distribution as the
    // game using the agent's own RNG — fair, since the bot learns nothing about
    // the tiles that will actually fall.
    //
    // Options: rolls (samples per candidate), horizon (0 = play to game over),
    // cands (candidates kept from the base ranking), death (penalty for a
    // rollout that ends the game), obj ('score' | 'steps').
    register('rollout', function (options) {
        const rng = makeRng(options.seed != null ? options.seed : 1);
        const baseSpec = options.base || 'linear:preset=' + (options.preset || 'v3');
        const base = createAgent(baseSpec, { seed: options.seed });
        const rolls = options.rolls || 1;
        const horizon = options.horizon || 0;
        const cands = options.cands || 4;
        const death = options.death != null ? options.death : 300;
        const obj = options.obj || 'score';
        // Only roll out moves the base policy considers near-equivalent. Without
        // this the noisy rollout estimate happily picks a move from a worse
        // `made` class, throwing away the base policy's strongest prior.
        const eps = options.eps != null ? options.eps : Infinity;

        // Common random numbers: every candidate in one decision is rolled out
        // against the SAME sampled tile sequence, so the comparison is paired
        // and the sampling noise largely cancels.
        function rollFrom(game, move, rollSeed) {
            const sim = game.preview(move[0], move[1], FILL_SAMPLE);
            sim.sampleRng = makeRng(rollSeed);
            let steps = 1;
            while (!sim.gameOver && (horizon === 0 || steps < horizon)) {
                const m = base.chooseMove(sim);
                if (!m) break;
                sim.apply(m[0], m[1]);
                steps++;
            }
            const outcome = obj === 'steps' ? steps : sim.score - game.score;
            return outcome + (sim.gameOver ? -death : 0);
        }

        return {
            name: 'rollout',
            scoreMoves(game) {
                game.sampleRng = rng;
                let ranked = base.scoreMoves(game).sort((p, q) => q.value - p.value);
                ranked = ranked.filter(r => r.value >= ranked[0].value - eps).slice(0, cands);
                if (ranked.length === 1) return ranked;
                const rollSeeds = [];
                for (let r = 0; r < rolls; r++) rollSeeds.push((rng() * 2 ** 32) >>> 0);
                return ranked.map(({ move }) => {
                    let total = 0;
                    for (let r = 0; r < rolls; r++) total += rollFrom(game, move, rollSeeds[r]);
                    return { move, value: total / rolls };
                });
            },
            chooseMove(game) {
                const scored = this.scoreMoves(game);
                if (!scored.length) return null;
                let best = scored[0];
                for (const s of scored) if (s.value > best.value) best = s;
                return best.move;
            }
        };
    });

    // ---- expectimax over the value network ---------------------------------
    // The `search` agent above searches the LINEAR evaluation with a fixed,
    // pessimistic refill, which is why it never paid: it optimises a line that
    // the real tile generator will not produce. This one is the proper thing.
    //
    //   max node   a position with a full board -- pick the best legal move
    //   chance node an afterstate (holes where the chain collapsed) -- average
    //               over the tiles that could drop into those holes
    //
    // The network is trained on afterstates, so a leaf is exactly one
    // `net.value(cells)` and depth 1 reduces to the plain `td` agent.
    //
    // Refill order: apply() compacts every column downwards and then tops it up
    // from the generator, columns left to right, bottom to top within a column.
    // After a FILL_NONE preview the holes are exactly the zeros, and scanning
    // them in index order (i ascending, then j ascending) visits them in the
    // same order the generator would fill them -- so assigning a tile vector to
    // that scan reproduces a genuine successor state.
    function chanceOutcomes(cells, maxGen, cap, rng) {
        const holes = [];
        for (let k = 0; k < 25; k++) if (cells[k] === 0) holes.push(k);
        const h = holes.length;
        if (h === 0) return { holes, combos: [[]], weight: 1 };
        const total = Math.pow(maxGen, h);
        if (total <= cap) {
            // Full enumeration: every refill is equally likely.
            const combos = [];
            for (let n = 0; n < total; n++) {
                const c = new Uint8Array(h);
                let x = n;
                for (let t = 0; t < h; t++) { c[t] = (x % maxGen) + 1; x = (x / maxGen) | 0; }
                combos.push(c);
            }
            return { holes, combos, weight: 1 / total };
        }
        // Too wide to enumerate: sample it. Unbiased, and the variance only has
        // to be small enough to order the root moves.
        const combos = [];
        for (let n = 0; n < cap; n++) {
            const c = new Uint8Array(h);
            for (let t = 0; t < h; t++) c[t] = ((rng() * maxGen) | 0) + 1;
            combos.push(c);
        }
        return { holes, combos, weight: 1 / cap };
    }

    register('ex', function (options) {
        const rng = makeRng(options.seed != null ? options.seed : 1);
        const net = options.network || loadNetwork(options.weights || 'bot/weights/all7g-Rcq.bin',
            'sym' in options ? { sym: !!options.sym } : null);
        const depth = options.depth || 2;
        const cap = options.cap || 16;          // chance branches per node
        // Only the top `cands` moves (by the depth-1 value) are searched deeper;
        // the rest keep their depth-1 score. 0 = search everything.
        const cands = options.cands || 0;
        const beta = options.beta != null ? options.beta : 0;
        const evaluate = beta ? linearEvaluator(weightsFromOptions(options)) : null;

        // Value of a full-board position, looking `d` max-levels ahead.
        function maxValue(game, d) {
            const moves = game.legalMoves();
            if (!moves.length) return 0;                 // dead: no more score
            let best = -Infinity;
            for (const m of moves) {
                const after = game.preview(m[0], m[1], FILL_NONE);
                const r = after.score - game.score;
                let v = r + net.value(after.cells);
                if (beta) v += evaluate(after, m, game) / beta;
                if (d > 1) v = r + chanceValue(after, d);
                if (v > best) best = v;
            }
            return best;
        }

        // Expected value of an afterstate whose holes have not been filled yet.
        function chanceValue(after, d) {
            const { holes, combos, weight } = chanceOutcomes(after.cells, after.maxGen, cap, rng);
            let sum = 0;
            for (const c of combos) {
                const g = after.clone(FILL_NONE);
                for (let t = 0; t < holes.length; t++) g.cells[holes[t]] = c[t];
                sum += maxValue(g, d - 1);
            }
            return sum * weight;
        }

        return {
            name: 'ex',
            scoreMoves(game) {
                const moves = game.legalMoves();
                const shallow = moves.map(move => {
                    const after = game.preview(move[0], move[1], FILL_NONE);
                    const r = after.score - game.score;
                    let value = r + net.value(after.cells);
                    if (beta) value += evaluate(after, move, game) / beta;
                    return { move, after, r, value };
                });
                if (depth <= 1) return shallow;
                let searched = shallow;
                if (cands && shallow.length > cands) {
                    searched = shallow.slice().sort((p, q) => q.value - p.value).slice(0, cands);
                }
                for (const s of searched) s.value = s.r + chanceValue(s.after, depth);
                return shallow;
            },
            chooseMove(game) {
                const scored = this.scoreMoves(game);
                if (!scored.length) return null;
                let best = -Infinity;
                for (const s of scored) if (s.value > best) best = s.value;
                const tied = scored.filter(s => s.value === best);
                return tied[Math.floor(rng() * tied.length)].move;
            }
        };
    });

    // Expectimax over the value network, on the fast board representation in
    // search.js. `depth` counts max-levels: 1 is plain greedy `td`, 2 averages
    // over the tiles that drop in and then looks one move further.
    //
    //   cap      chance branches at the first chance node (full enumeration
    //            when maxGen^holes fits, sampling when it does not)
    //   capDeep  the same at every deeper chance node
    // `weights=a.bin+b.bin` averages several networks. Nets trained on
    // different tuple sets make different mistakes, and the search only needs
    // something with a `value(cells)` method.
    function loadNetworks(spec, override) {
        const files = String(spec).split('+');
        if (files.length === 1) return loadNetwork(files[0], override);
        const nets = files.map(f => loadNetwork(f, override));
        const k = 1 / nets.length;
        return { value(cells) { let s = 0; for (const n of nets) s += n.value(cells); return s * k; } };
    }

    // ---- the exposed-6 rule ------------------------------------------------
    // A 6 is permanent and unplayable, so where it sits is a decision the board
    // has to live with for the rest of the game. STRATEGY.md says to seal them
    // against walls and other 6s; `sixopen` is the linear agents' version of
    // that, and the value network is supposed to have learned it.
    //
    // As a hard override: if some legal move makes a 6 with at least two of its
    // four sides against a wall or another 6, then no move may make a 6 with
    // three or four sides open. Everything else is left to the base agent,
    // which still picks among what survives.
    //
    // Openness is counted on the afterstate, where the cells the chain vacated
    // are still holes: a hole is going to be refilled with an ordinary tile, so
    // it counts as open. Only walls and existing 6s block.
    function openSidesOf(cells, k) {
        const i = (k / 5) | 0, j = k % 5;
        let open = 0;
        if (j < 4 && cells[k + 1] !== 6) open++;
        if (j > 0 && cells[k - 1] !== 6) open++;
        if (i > 0 && cells[k - 5] !== 6) open++;
        if (i < 4 && cells[k + 5] !== 6) open++;
        return open;
    }

    // For each scored move, how exposed the 6 it creates would be (null if it
    // creates no 6). Then drop the exposed ones when a sealed one exists.
    //
    // `eps` softens the override: the exposed move survives if the agent rates
    // it more than `eps` points above the best move that obeys the rule. The
    // hypothesis the rule encodes is that the network under-values a permanent
    // liability, which is a claim about the cases where it is nearly
    // indifferent, not about the cases where it sees a concrete reason.
    // eps = Infinity is the hard rule.
    function applySixRule(game, scored, eps) {
        let bestSealed = 5, anySix = false;
        const open = new Array(scored.length).fill(null);
        for (let t = 0; t < scored.length; t++) {
            const m = scored[t].move;
            if (game.at(m[0], m[1]) !== 5) continue;
            const after = game.preview(m[0], m[1], FILL_NONE);
            open[t] = openSidesOf(after.cells, after.lastCreated);
            anySix = true;
            if (open[t] < bestSealed) bestSealed = open[t];
        }
        if (!anySix || bestSealed > 2) return scored;
        const kept = scored.filter((s, t) => open[t] === null || open[t] <= 2);
        if (!kept.length) return scored;
        if (eps !== Infinity) {
            let bestAll = -Infinity, bestKept = -Infinity;
            for (const s of scored) if (s.value > bestAll) bestAll = s.value;
            for (const s of kept) if (s.value > bestKept) bestKept = s.value;
            if (bestAll - bestKept > eps) return scored;
        }
        return kept;
    }

    register('fx', function (options) {
        const rng = makeRng(options.seed != null ? options.seed : 1);
        const net = options.network || loadNetworks(options.weights || 'bot/weights/all7g-Rcq.bin',
            'sym' in options ? { sym: !!options.sym } : null);
        // Softmax move selection. Only useful when the metric is the best of
        // many games rather than the average of them: it costs mean score and
        // buys spread, and the best of 100 tries cares about spread.
        const temp = options.temp || 0;
        const sixRule = !!options.sixrule || options.sixeps != null;
        const sixEps = options.sixeps != null ? options.sixeps : Infinity;
        // Show provably-dead tiles to the net as 6s, once at the search root
        // (see bot/freeze.js). Behaviour-preserving: legal moves are unchanged,
        // so the chosen move is still legal on the real board.
        const freeze = !!options.freeze;
        const froze = freeze ? game => { const g = game.clone(); g.cells = Freeze.freezeBoard(game.cells); return g; }
            : game => game;
        const searcher = Search.makeSearcher(net, {
            depth: options.depth || 2,
            cap: options.cap,
            capDeep: options.capDeep,
            topk: options.topk,
            rootk: options.rootk,
            risk: options.risk,
            norefill: options.norefill,
            esc: options.esc,
            escdepth: options.escdepth,
            cvk: options.cvk,
            grade: options.grade,
            ms: options.ms,
            crn: options.crn,
            gap: options.gap,
            rng
        });
        return {
            name: 'fx',
            scoreMoves(game) { return searcher.scoreMoves(froze(game)); },
            chooseMove(game) {
                const g = froze(game);
                let scored = searcher.scoreMoves(g);
                if (!scored.length) return null;
                if (sixRule) scored = applySixRule(g, scored, sixEps);
                let best = -Infinity;
                for (const s of scored) if (s.value > best) best = s.value;
                if (temp > 0) {
                    // Softmax relative to the best move, so the scale of the
                    // values does not matter -- only the gaps do.
                    let total = 0;
                    const wts = scored.map(s => { const w = Math.exp((s.value - best) / temp); total += w; return w; });
                    let r = rng() * total;
                    for (let t = 0; t < scored.length; t++) { r -= wts[t]; if (r <= 0) return scored[t].move; }
                    return scored[scored.length - 1].move;
                }
                const tied = scored.filter(s => s.value === best);
                return tied[Math.floor(rng() * tied.length)].move;
            }
        };
    });

    // Visible-tactics search. Unlike `fx:norefill=1`, every synthetic depth has
    // its own evaluator and every node retains the option to stop the visible
    // line and refill normally. `weights` is V1, `weights2` is V2, and
    // `weights3` is V3. Each option may still use `a.bin+b.bin` ensembling.
    register('nf', function (options) {
        const rng = makeRng(options.seed != null ? options.seed : 1);
        const override = 'sym' in options ? { sym: !!options.sym } : null;
        const depth = options.depth || (options.weights3 ? 3 : options.weights2 ? 2 : 1);
        const nets = [options.network || loadNetworks(
            options.weights || 'bot/weights/all7g-Rcq.bin', override)];
        if (depth >= 2) {
            if (!options.weights2 && !options.network2)
                throw new Error('nf depth 2+ needs weights2=FILE');
            nets.push(options.network2 || loadNetworks(options.weights2, override));
        }
        if (depth >= 3) {
            if (!options.weights3 && !options.network3)
                throw new Error('nf depth 3 needs weights3=FILE');
            nets.push(options.network3 || loadNetworks(options.weights3, override));
        }
        if (depth > 3) throw new Error('nf currently supports depth 1..3');

        const freeze = !!options.freeze;
        const froze = freeze ? game => {
            const g = game.clone();
            g.cells = Freeze.freezeBoard(game.cells);
            return g;
        } : game => game;
        const searcher = Search.makeNoRefillSearcher(nets, {
            depth,
            beta: options.beta,
            beta1: options.beta1,
            beta2: options.beta2
        });
        return {
            name: 'nf',
            scoreMoves(game) { return searcher.scoreMoves(froze(game)); },
            chooseMove(game) {
                const scored = searcher.scoreMoves(froze(game));
                if (!scored.length) return null;
                let best = -Infinity;
                for (const s of scored) if (s.value > best) best = s.value;
                const tied = scored.filter(s => s.value === best);
                return tied[Math.floor(rng() * tied.length)].move;
            }
        };
    });

    // ---- MCTS with the network at the leaves -------------------------------
    // Monte Carlo Tree Search that grows an asymmetric, budget-shaped tree and
    // evaluates leaves directly with net.value instead of rolling out. Max nodes
    // use an enlarged UCB exploration term (sqrt(sqrt(N)/n)); chance nodes look
    // at only ~n^0.2 refills, drive most visits down a single "deep" refill, and
    // value a move as a weighted average that down-weights that deep line to
    // 1/log n. See mcts.js for the full rationale. `weights=a.bin+b.bin`
    // averages several networks, like fx.
    register('mcts', function (options) {
        const rng = makeRng(options.seed != null ? options.seed : 1);
        const net = options.network || loadNetworks(options.weights || 'bot/weights/all7g-Rcq.bin',
            'sym' in options ? { sym: !!options.sym } : null);
        const searcher = MCTS.makeMcts(net, {
            sims: options.sims,
            c: options.c,
            capExp: options.capExp,
            splitExp: options.splitExp,
            ucb: options.ucb,
            chance: options.chance,
            maxdepth: options.maxdepth,
            maxnodes: options.maxnodes,
            rng
        });
        return {
            name: 'mcts',
            scoreMoves(game) { return searcher.scoreMoves(game); },
            chooseMove(game) {
                const scored = searcher.scoreMoves(game);
                if (!scored.length) return null;
                let best = -Infinity;
                for (const s of scored) if (s.value > best) best = s.value;
                const tied = scored.filter(s => s.value === best);
                return tied[Math.floor(rng() * tied.length)].move;
            }
        };
    });

    // --- sh: Sequential-Halving root sampling (Idea 1) -----------------------
    // A fixed-depth expectimax, but instead of spending an equal refill budget
    // on every root move (what fx does), it treats the root moves as bandit
    // arms and allocates a total sample budget adaptively: sample all arms,
    // drop the worst half, repeat, so nearly all samples land on the few real
    // contenders. Anytime in `budget` (total root refill samples), parameter
    // free (no exploration constant). Each sample of an arm draws a refill of
    // that move's afterstate and evaluates the resulting board at depth d-1
    // (greedy for d=2; a fixed-cap expectimax for d>=3). The point it tests:
    // for a fixed depth, is smart allocation of the chance budget worth more
    // per unit compute than fx's uniform cap?
    register('sh', function (options) {
        const rng = makeRng(options.seed != null ? options.seed : 1);
        const net = options.network || loadNetworks(options.weights || 'bot/weights/all7g-Rcq.bin',
            'sym' in options ? { sym: !!options.sym } : null);
        const d = options.depth || 2;
        const budget = options.budget || 256;      // total root refill samples
        const capInner = options.capinner || 8;    // inner cap for d >= 3

        const rootExp = Search.makeExpander();
        const greedyExp = Search.makeExpander();
        // For d >= 3, evaluate a board at depth d-1 with a plain fixed-cap fx.
        const inner = d >= 3
            ? Search.makeSearcher(net, { depth: d - 1, cap: capInner, capDeep: capInner, rng })
            : null;
        const buf = new Uint8Array(25);

        // maxValue(board, d-1): the value of a full board with (d-1) plies left.
        function evalBoard(cells, maxGen) {
            if (d === 2) {
                const nm = greedyExp.expand(cells, maxGen);
                if (nm === 0) return 0;              // dead board: no future score
                let best = -Infinity;
                for (let s = 0; s < nm; s++) {
                    const v = greedyExp.gain(s) + net.value(greedyExp.board(s));
                    if (v > best) best = v;
                }
                return best;
            }
            const out = inner.scoreMoves({ cells, maxGen });
            if (!out.length) return 0;
            let best = -Infinity;
            for (const r of out) if (r.value > best) best = r.value;
            return best;
        }

        function pull(arm) {
            if (arm.holes.length === 0) { arm.sum += evalBoard(arm.after, arm.maxGen); arm.cnt++; return; }
            buf.set(arm.after);
            for (let t = 0; t < arm.holes.length; t++) buf[arm.holes[t]] = ((rng() * arm.maxGen) | 0) + 1;
            arm.sum += evalBoard(buf, arm.maxGen);
            arm.cnt++;
        }
        const score = a => a.gain + (a.cnt ? a.sum / a.cnt : 0);

        function scoreMoves(game) {
            const nm = rootExp.expand(game.cells, game.maxGen);
            if (nm === 0) return [];
            const arms = [];
            for (let s = 0; s < nm; s++) {
                const after = rootExp.copy(s);
                const holes = [];
                for (let k = 0; k < 25; k++) if (after[k] === 0) holes.push(k);
                const k = rootExp.cell(s);
                arms.push({ move: [(k / 5) | 0, k % 5], gain: rootExp.gain(s), maxGen: rootExp.nextGen(s), after, holes, sum: 0, cnt: 0 });
            }

            if (arms.length === 1) { pull(arms[0]); return arms.map(a => ({ move: a.move, value: score(a) })); }

            // Sequential Halving: `rounds` halving stages, each stage splitting an
            // equal share of the budget over the arms still alive.
            let S = arms.slice();
            const rounds = Math.ceil(Math.log2(S.length));
            let used = 0;
            while (S.length > 1 && used < budget) {
                const perArm = Math.max(1, Math.floor(budget / (S.length * rounds)));
                for (const a of S) {
                    for (let i = 0; i < perArm && used < budget; i++) { pull(a); used++; }
                }
                S.sort((p, q) => score(q) - score(p));
                S = S.slice(0, Math.max(1, Math.floor(S.length / 2)));
            }
            while (used < budget) { pull(S[0]); used++; }   // remainder to the survivor

            return arms.map(a => ({ move: a.move, value: score(a) }));
        }

        return {
            name: 'sh',
            scoreMoves,
            chooseMove(game) {
                const scored = scoreMoves(game);
                if (!scored.length) return null;
                let best = -Infinity;
                for (const s of scored) if (s.value > best) best = s.value;
                const tied = scored.filter(s => s.value === best);
                return tied[Math.floor(rng() * tied.length)].move;
            }
        };
    });

    // ---- clairvoyant ("cheating") search -----------------------------------
    // A yardstick, not a real agent: it looks `depth` moves ahead using the
    // game's ACTUAL upcoming tiles (preview with FILL_RANDOM advances the real
    // PRNG), so there is no chance node -- the tree is a plain max-tree. Leaves
    // are full boards, evaluated by the deployed net's ordinary greedy no-refill
    // reading (see cheat.js). depth=1 is one clairvoyant ply on top of `td`.
    register('cheat', function (options) {
        const rng = makeRng(options.seed != null ? options.seed : 1);
        const net = options.network || loadNetworks(options.weights || 'bot/weights/all7g-Rcq.bin',
            'sym' in options ? { sym: !!options.sym } : null);
        const freeze = !!options.freeze;
        const froze = freeze ? game => { const g = game.clone(); g.cells = Freeze.freezeBoard(game.cells); return g; }
            : game => game;
        const searcher = Cheat.makeCheat(net, { depth: options.depth || 1, freeze });
        return {
            name: 'cheat',
            scoreMoves(game) { return searcher.scoreMoves(froze(game)); },
            chooseMove(game) {
                const scored = searcher.scoreMoves(froze(game));
                if (!scored.length) return null;
                let best = -Infinity;
                for (const s of scored) if (s.value > best) best = s.value;
                const tied = scored.filter(s => s.value === best);
                return tied[Math.floor(rng() * tied.length)].move;
            }
        };
    });

    return {
        createAgent, parseSpec, register, registry, agentNames, SPECS, PRESETS, BEST_PRESET,
        greedy, linearEvaluator, weightsFromOptions, makeRng
    };
});
