#!/usr/bin/env node
// ============================================================================
// Benchmark runner
//
//   node bot/run.js                                     # baselines, seeds 1-25
//   node bot/run.js --agents maxmoves --seeds 100
//   node bot/run.js --agents "linear:preset=tuned" -v
//   node bot/run.js --agents a,b --jobs 4               # use 4 processes
//
// All agents play the same seeds, so the head-to-head is paired.
// Reports mean score with a standard error, plus ms/move so a heuristic that
// buys little for a lot of compute is visible immediately.
// ============================================================================

const path = require('path');
const Collapse = require('./engine.js');
const { createAgent, agentNames } = require('./agents.js');

// An agent entry may carry a display label as `label@spec` (e.g.
// `d3-cvk8@fx:weights=...,depth=3,cvk=8`). The label is only for the output
// tables; the spec after `@` is what actually builds the agent. A leading token
// is treated as a label only when it looks like a plain name (no spec
// punctuation), so a weights path that happens to contain `@` is left alone.
function splitLabel(entry) {
    const at = entry.indexOf('@');
    if (at > 0) {
        const label = entry.slice(0, at), spec = entry.slice(at + 1);
        if (spec && !/[:=,@\\/]/.test(label)) return { spec, label };
    }
    return { spec: entry, label: entry };
}

function parseArgs(argv) {
    const args = { agents: ['random', 'maxmoves'], labels: ['random', 'maxmoves'], seeds: 25, seedBase: 1, verbose: false, jobs: 1, json: false, dist: 0, sub: '' };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--agents') {
            const parts = argv[++i].split(/,(?![^:]*=)/).map(s => s.trim()).filter(Boolean).map(splitLabel);
            args.agents = parts.map(p => p.spec);
            args.labels = parts.map(p => p.label);
        }
        else if (a === '--seeds') args.seeds = parseInt(argv[++i], 10);
        else if (a === '--seed-base') args.seedBase = parseInt(argv[++i], 10);
        else if (a === '--jobs') args.jobs = parseInt(argv[++i], 10);
        else if (a === '--json') args.json = true;
        // --dist N adds the shape of the distribution: the tails, and how often
        // the agent clears N. Mean alone hides whether an agent got there by
        // being reliable or by being lucky.
        else if (a === '--dist') args.dist = parseInt(argv[++i], 10);
        // Shortened games, for studying how a search scales without paying for
        // 1000-move games at a second a move. See subGame().
        else if (a === '--sub') args.sub = argv[++i];
        else if (a === '--verbose' || a === '-v') args.verbose = true;
        else if (a === '--list') { console.log(agentNames().join('\n')); process.exit(0); }
        else { console.error('Unknown option: ' + a); process.exit(1); }
    }
    return args;
}


function stats(xs) {
    const sorted = [...xs].sort((p, q) => p - q);
    const n = sorted.length;
    const mean = xs.reduce((s, x) => s + x, 0) / n;
    const sd = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, n - 1));
    const q = p => sorted[Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))))];
    return {
        mean, sd, se: sd / Math.sqrt(n),
        median: n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2,
        min: sorted[0], max: sorted[n - 1], p10: q(0.1), p90: q(0.9),
        over: t => xs.filter(x => x >= t).length / n
    };
}

// Shortened variants of the game, so that a search costing a second a move can
// still be measured. Two kinds, because they shorten different halves:
//
//   grid54 / grid45 / grid44   wall off a row and/or a column with 6s and play
//                              a full game on what is left. 6s are permanent
//                              and unplayable, so a wall of them is exactly a
//                              smaller board -- and the network already knows
//                              how to read boards full of 6s, so no retraining
//                              is needed. Shorter games, same objective.
//   first6                     stop the moment the first 6 appears. This is the
//                              opening only, and the agent is still playing for
//                              the full-game value, so read it as "how well is
//                              the opening played" rather than as a game.
//
// Whether either correlates with full-game strength is an empirical question
// and is checked before they are used for anything -- a proxy nobody validated
// is worse than no proxy.
function subStart(mode, seed) {
    const g = new Collapse.Game(seed);
    const cells = Array.from(g.cells);
    const W = Collapse.W, H = Collapse.H;
    const wall = k => { cells[k] = 6; };
    if (mode === 'grid54' || mode === 'grid44') for (let i = 0; i < W; i++) wall(i * H);
    if (mode === 'grid45' || mode === 'grid44') for (let j = 0; j < H; j++) wall((W - 1) * H + j);
    return Collapse.fromCells(cells, seed);
}

function playSub(agent, seed, mode) {
    const stopAtSix = mode === 'first6';
    const game = stopAtSix ? new Collapse.Game(seed) : subStart(mode, seed);
    while (!game.gameOver && game.moves.length < 100000) {
        const move = agent.chooseMove(game);
        if (!move) break;
        game.apply(move[0], move[1]);
        if (stopAtSix && game.sixCount > 0) break;
    }
    return { score: game.score, moves: game.moves.length, sixes: game.sixCount };
}

// Play one (agent, seed) game. Returns {seed, score, moves, sixes, ms}.
function runOne(spec, seed, sub) {
    const agent = createAgent(spec, { seed });
    const t0 = process.hrtime.bigint();
    const r = sub ? playSub(agent, seed, sub) : Collapse.playGame(agent, seed);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    return { seed, score: r.score, moves: r.moves, sixes: r.sixes, ms };
}

// --- worker mode -------------------------------------------------------------
// A persistent worker: play one game per message, report it, wait for the next.
// The parent hands out games one at a time (a work queue), so a slow agent's
// games are load-balanced across all workers rather than piled on one.
if (process.env.COLLAPSE_WORKER) {
    process.on('message', msg => {
        if (!msg || msg.stop) { process.exit(0); }
        const r = runOne(msg.spec, msg.seed, msg.sub);
        process.send({ ai: msg.ai, r });
    });
    return;
}

// Run every (agent, seed) game, interleaved by agent so all agents finish
// together and completed-count tracks wall-clock. onResult(ai, r) fires per
// finished game. Distributes over `jobs` workers as a dynamic queue (each free
// worker pulls the next game), which also balances load across uneven agents.
function runAll(agents, seeds, jobs, sub, onResult) {
    // Interleaved queue: seed-major, agent-minor, so the first `agents.length`
    // games are every agent on the first seed, and so on.
    const tasks = [];
    for (const seed of seeds)
        for (let ai = 0; ai < agents.length; ai++) tasks.push({ ai, spec: agents[ai], seed, sub });

    if (jobs <= 1) {
        for (const t of tasks) onResult(t.ai, runOne(t.spec, t.seed, sub));
        return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
        const { fork } = require('child_process');
        let next = 0, active = 0;
        const dispatch = w => {
            if (next >= tasks.length) { w.send({ stop: true }); return; }
            const t = tasks[next++];
            active++;
            w.send({ ai: t.ai, spec: t.spec, seed: t.seed, sub });
        };
        const nWorkers = Math.min(jobs, tasks.length);
        for (let i = 0; i < nWorkers; i++) {
            const w = fork(path.join(__dirname, 'run.js'), [], { env: Object.assign({}, process.env, { COLLAPSE_WORKER: '1' }) });
            w.on('message', ({ ai, r }) => {
                active--;
                onResult(ai, r);
                if (next < tasks.length) dispatch(w);
                else { w.send({ stop: true }); if (active === 0) resolve(); }
            });
            w.on('error', reject);
            dispatch(w);
        }
    });
}

const pad = (s, n) => String(s).padStart(n);

async function main() {
    const args = parseArgs(process.argv);
    const seeds = Array.from({ length: args.seeds }, (_, k) => args.seedBase + k);
    const idx = new Map(seeds.map((s, i) => [s, i]));
    // Indexed by agent position (not spec), so duplicate specs and labels never
    // collide. results[ai][seedIdx] = one game's record.
    const results = args.agents.map(() => new Array(seeds.length));
    const labels = args.labels;

    // Per-agent running tally, and an interim table on stderr (so it never
    // mingles with --json/piped stdout) roughly every 10% of the whole run.
    const total = args.agents.length * seeds.length;
    const tally = args.agents.map(() => ({ n: 0, sum: 0 }));
    const nameWidth0 = Math.max(12, ...labels.map(a => Math.min(a.length, 44)));
    let done = 0;
    const step = Math.max(1, Math.floor(total / 10));
    const printInterim = () => {
        process.stderr.write(`\n  --- ${Math.round(100 * done / total)}% (${done}/${total} games) ---\n`);
        labels.forEach((label, ai) => {
            const t = tally[ai];
            const nm = label.length > 44 ? label.slice(0, 43) + '…' : label;
            process.stderr.write('  ' + nm.padEnd(nameWidth0) +
                pad('n=' + t.n, 7) + pad(t.n ? (t.sum / t.n).toFixed(0) : '-', 9) + '\n');
        });
    };
    const onResult = (ai, r) => {
        results[ai][idx.get(r.seed)] = r;
        tally[ai].n++; tally[ai].sum += r.score;
        done++;
        if (!args.json && (done % step === 0 || done === total)) printInterim();
    };
    await runAll(args.agents, seeds, args.jobs, args.sub, onResult);

    if (args.json) {
        console.log(JSON.stringify(Object.fromEntries(args.agents.map((spec, ai) =>
            [labels[ai], { spec, scores: results[ai].map(r => r.score), mean: stats(results[ai].map(r => r.score)).mean }])), null, 1));
        return;
    }

    if (args.verbose) {
        console.log('\nPer-seed scores');
        console.log('  seed  ' + labels.map(n => pad(n.slice(0, 22), 24)).join(''));
        seeds.forEach((seed, k) => {
            console.log('  ' + pad(seed, 4) + '  ' + results.map(rs => pad(rs[k].score, 24)).join(''));
        });
    }

    const nameWidth = Math.max(12, ...labels.map(a => a.length));
    console.log(`\n${args.seeds} games per agent (seeds ${seeds[0]}-${seeds[seeds.length - 1]})\n`);
    const distHead = args.dist ? pad('sd', 7) + pad('p10', 8) + pad('p90', 8) + pad('≥' + args.dist, 8) : '';
    console.log('  ' + 'agent'.padEnd(nameWidth) + pad('mean', 9) + pad('±se', 7) + pad('median', 9) +
        pad('min', 8) + pad('max', 8) + distHead + pad('moves', 8) + pad('6s', 6) + pad('ms/move', 10) + pad('s/game', 9));
    console.log('  ' + '-'.repeat(nameWidth + 74 + (args.dist ? 31 : 0)));
    results.forEach((rs, ai) => {
        const s = stats(rs.map(r => r.score));
        const moves = stats(rs.map(r => r.moves));
        const sixes = stats(rs.map(r => r.sixes));
        const totalMs = rs.reduce((a, r) => a + r.ms, 0);
        const totalMoves = rs.reduce((a, r) => a + r.moves, 0);
        const distRow = args.dist
            ? pad(s.sd.toFixed(0), 7) + pad(s.p10, 8) + pad(s.p90, 8) + pad((100 * s.over(args.dist)).toFixed(0) + '%', 8)
            : '';
        console.log('  ' + labels[ai].padEnd(nameWidth) + pad(s.mean.toFixed(0), 9) + pad(s.se.toFixed(0), 7) +
            pad(s.median.toFixed(0), 9) + pad(s.min, 8) + pad(s.max, 8) + distRow +
            pad(moves.mean.toFixed(1), 8) + pad(sixes.mean.toFixed(1), 6) +
            pad((totalMs / totalMoves).toFixed(3), 10) + pad((totalMs / rs.length / 1000).toFixed(3), 9));
    });

    if (args.agents.length >= 2) {
        console.log();
        for (let ai = 1; ai < args.agents.length; ai++) {
            const diffs = seeds.map((_, k) => results[ai][k].score - results[0][k].score);
            const d = stats(diffs);
            const wins = diffs.filter(x => x > 0).length, losses = diffs.filter(x => x < 0).length;
            console.log(`  ${labels[ai]} vs ${labels[0]}: ${wins}W ${seeds.length - wins - losses}D ${losses}L, ` +
                `mean diff ${d.mean >= 0 ? '+' : ''}${d.mean.toFixed(0)} ± ${d.se.toFixed(0)} (paired)`);
        }
    }
    console.log();
}

main();
