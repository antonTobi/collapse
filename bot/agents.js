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
        module.exports = factory(require('./engine.js'), require('./eval.js'), require('./ntuple.js'));
    } else {
        root.CollapseAgents = factory(root.Collapse, root.CollapseEval, root.CollapseNTuple);
    }
})(typeof self !== 'undefined' ? self : this, function (Collapse, Ev, NTuple) {

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
        v4: { moves: 0.70661, pairs: 0.86982, made: -17.49946, made4: 1.24, made5: 2.48571, made6: -1, gain: 0.23437, comp5: -1.20366, singles: 0.7149, sixopen: -4.12201, trapped: 0.73439, heightsum: -0.0652, lowtiles: -0.38185, sixes: 2.44063, cnt1: -1.12, cnt3: -0.45455, cnt4: -0.1625, cnt5: -0.76, distinct: 0.625, s_moves: 0.05882, s_made: 0.06786, s_sixopen: 0.3, new5blocked: 0.63678, fiveblocked: 0.54391, fournear5: 0.23182 }
    };

    // Curated specs for the spectator dropdown: full specs (so the preset is
    // never ambiguous), best first, and only agents that run in the browser --
    // `td`/`blend` need a weights file from disk.
    const SPECS = [
        { spec: 'linear:preset=v4', label: 'linear v4  (best)' },
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
        const [name, rest] = String(spec).split(':');
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

    function weightsFromOptions(options) {
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
    const netCache = {};
    function loadNetwork(file) {
        if (netCache[file]) return netCache[file];
        if (typeof require !== 'function') throw new Error('td agent needs Node (or a preloaded network)');
        const fs = require('fs'), path = require('path');
        const full = path.isAbsolute(file) ? file : path.join(__dirname, '..', file);
        const buf = fs.readFileSync(full);
        netCache[file] = new NTuple.Network(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
        return netCache[file];
    }

    register('td', function (options) {
        const rng = makeRng(options.seed != null ? options.seed : 1);
        const net = options.network || loadNetwork(options.weights || 'bot/weights/td1.bin');
        net.sym = !!options.sym;
        return {
            name: 'td',
            scoreMoves(game) {
                return game.legalMoves().map(move => {
                    const after = game.preview(move[0], move[1], FILL_NONE);
                    return { move, value: (after.score - game.score) + net.value(after.cells) };
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
        const net = options.network || loadNetwork(options.weights || 'bot/weights/td1.bin');
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

    return {
        createAgent, parseSpec, register, registry, agentNames, SPECS, PRESETS, BEST_PRESET,
        greedy, linearEvaluator, weightsFromOptions, makeRng
    };
});
