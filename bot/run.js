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

function parseArgs(argv) {
    const args = { agents: ['random', 'maxmoves'], seeds: 25, seedBase: 1, verbose: false, jobs: 1, json: false };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--agents') args.agents = argv[++i].split(/,(?![^:]*=)/).map(s => s.trim()).filter(Boolean);
        else if (a === '--seeds') args.seeds = parseInt(argv[++i], 10);
        else if (a === '--seed-base') args.seedBase = parseInt(argv[++i], 10);
        else if (a === '--jobs') args.jobs = parseInt(argv[++i], 10);
        else if (a === '--json') args.json = true;
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
    return { mean, sd, se: sd / Math.sqrt(n), median: n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2, min: sorted[0], max: sorted[n - 1] };
}

// Run one agent over a list of seeds. Returns [{seed, score, moves, sixes, ms}]
function runAgent(spec, seeds) {
    return seeds.map(seed => {
        const agent = createAgent(spec, { seed });
        const t0 = process.hrtime.bigint();
        const r = Collapse.playGame(agent, seed);
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        return { seed, score: r.score, moves: r.moves, sixes: r.sixes, ms };
    });
}

// --- worker mode -------------------------------------------------------------
if (process.env.COLLAPSE_WORKER) {
    process.on('message', ({ spec, seeds }) => {
        process.send(runAgent(spec, seeds));
        process.exit(0);
    });
    return;
}

function runAgentParallel(spec, seeds, jobs) {
    if (jobs <= 1) return Promise.resolve(runAgent(spec, seeds));
    const { fork } = require('child_process');
    const chunks = Array.from({ length: jobs }, () => []);
    seeds.forEach((s, k) => chunks[k % jobs].push(s));
    return Promise.all(chunks.map(chunk => new Promise((resolve, reject) => {
        if (!chunk.length) return resolve([]);
        const child = fork(path.join(__dirname, 'run.js'), [], { env: Object.assign({}, process.env, { COLLAPSE_WORKER: '1' }) });
        child.on('message', resolve);
        child.on('error', reject);
        child.send({ spec, seeds: chunk });
    }))).then(parts => {
        const byseed = new Map();
        parts.flat().forEach(r => byseed.set(r.seed, r));
        return seeds.map(s => byseed.get(s));
    });
}

const pad = (s, n) => String(s).padStart(n);

async function main() {
    const args = parseArgs(process.argv);
    const seeds = Array.from({ length: args.seeds }, (_, k) => args.seedBase + k);
    const results = {};

    for (const spec of args.agents) {
        results[spec] = await runAgentParallel(spec, seeds, args.jobs);
    }

    if (args.json) {
        console.log(JSON.stringify(Object.fromEntries(args.agents.map(s =>
            [s, { scores: results[s].map(r => r.score), mean: stats(results[s].map(r => r.score)).mean }])), null, 1));
        return;
    }

    if (args.verbose) {
        console.log('\nPer-seed scores');
        console.log('  seed  ' + args.agents.map(n => pad(n.slice(0, 22), 24)).join(''));
        seeds.forEach((seed, k) => {
            console.log('  ' + pad(seed, 4) + '  ' + args.agents.map(n => pad(results[n][k].score, 24)).join(''));
        });
    }

    const nameWidth = Math.max(12, ...args.agents.map(a => a.length));
    console.log(`\n${args.seeds} games per agent (seeds ${seeds[0]}-${seeds[seeds.length - 1]})\n`);
    console.log('  ' + 'agent'.padEnd(nameWidth) + pad('mean', 9) + pad('±se', 7) + pad('median', 9) +
        pad('min', 8) + pad('max', 8) + pad('moves', 8) + pad('6s', 6) + pad('ms/move', 10) + pad('s/game', 9));
    console.log('  ' + '-'.repeat(nameWidth + 74));
    for (const spec of args.agents) {
        const rs = results[spec];
        const s = stats(rs.map(r => r.score));
        const moves = stats(rs.map(r => r.moves));
        const sixes = stats(rs.map(r => r.sixes));
        const totalMs = rs.reduce((a, r) => a + r.ms, 0);
        const totalMoves = rs.reduce((a, r) => a + r.moves, 0);
        console.log('  ' + spec.padEnd(nameWidth) + pad(s.mean.toFixed(0), 9) + pad(s.se.toFixed(0), 7) +
            pad(s.median.toFixed(0), 9) + pad(s.min, 8) + pad(s.max, 8) +
            pad(moves.mean.toFixed(1), 8) + pad(sixes.mean.toFixed(1), 6) +
            pad((totalMs / totalMoves).toFixed(3), 10) + pad((totalMs / rs.length / 1000).toFixed(3), 9));
    }

    if (args.agents.length >= 2) {
        console.log();
        const base = args.agents[0];
        for (const spec of args.agents.slice(1)) {
            const diffs = seeds.map((_, k) => results[spec][k].score - results[base][k].score);
            const d = stats(diffs);
            const wins = diffs.filter(x => x > 0).length, losses = diffs.filter(x => x < 0).length;
            console.log(`  ${spec} vs ${base}: ${wins}W ${seeds.length - wins - losses}D ${losses}L, ` +
                `mean diff ${d.mean >= 0 ? '+' : ''}${d.mean.toFixed(0)} ± ${d.se.toFixed(0)} (paired)`);
        }
    }
    console.log();
}

main();
