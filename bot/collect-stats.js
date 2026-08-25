#!/usr/bin/env node

// Run reproducible games and preserve the per-game split scores for analysis.
// Usage: node bot/collect-stats.js --games 1000 --jobs 4 --out path/to/results.json

const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
const Collapse = require('./engine.js');
const { createAgent } = require('./agents.js');

const SPEC = 'fx:weights=bot/weights/dom39h.bins,depth=2,cap=16,topk=2,rootk=6,crn=1';

function args(argv) {
    const out = { games: 1000, jobs: 4, seedBase: 1, out: 'bot/data/dom39h-depth2-1000.json' };
    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === '--games') out.games = Number(argv[++i]);
        else if (argv[i] === '--jobs') out.jobs = Number(argv[++i]);
        else if (argv[i] === '--seed-base') out.seedBase = Number(argv[++i]);
        else if (argv[i] === '--out') out.out = argv[++i];
        else throw new Error(`Unknown option: ${argv[i]}`);
    }
    return out;
}

function play(seeds) {
    return seeds.map(seed => {
        const result = Collapse.playGame(createAgent(SPEC, { seed }), seed);
        return { seed, score: result.score, moves: result.moves, splits: result.splits };
    });
}

if (process.env.COLLAPSE_STATS_WORKER) {
    process.on('message', seeds => {
        process.send(play(seeds));
        process.exit(0);
    });
} else {
    const options = args(process.argv);
    const seeds = Array.from({ length: options.games }, (_, i) => options.seedBase + i);
    const chunks = Array.from({ length: Math.max(1, options.jobs) }, () => []);
    seeds.forEach((seed, i) => chunks[i % chunks.length].push(seed));
    const started = Date.now();
    const runs = chunks.filter(chunk => chunk.length).map(chunk => new Promise((resolve, reject) => {
        const child = fork(__filename, [], {
            env: { ...process.env, COLLAPSE_STATS_WORKER: '1' },
            stdio: ['ignore', 'inherit', 'inherit', 'ipc']
        });
        child.on('message', resolve);
        child.on('error', reject);
        child.send(chunk);
    }));
    Promise.all(runs).then(parts => {
        const games = parts.flat().sort((a, b) => a.seed - b.seed);
        const payload = {
            configuration: SPEC,
            seedBase: options.seedBase,
            gameCount: games.length,
            elapsedSeconds: (Date.now() - started) / 1000,
            games
        };
        fs.mkdirSync(path.dirname(options.out), { recursive: true });
        fs.writeFileSync(options.out, JSON.stringify(payload));
        console.log(`Wrote ${games.length} games to ${options.out} in ${payload.elapsedSeconds.toFixed(1)} s`);
    }).catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}
