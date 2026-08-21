#!/usr/bin/env node
// ============================================================================
// Ask what a specific position is worth, move by move.
//
//   node bot/probe.js --board "13235|51325|55455|55555|55556" --trials 200
//
// For every legal move: play it, then let the agent finish the game, and average
// the score made from that point on over `trials` different tile futures. Each
// candidate sees the *same* list of futures, so the comparison is paired.
//
// This is what settles an argument about one move that a static evaluation
// cannot: an evaluation says which move it prefers, a playout says which move
// actually scores more. It is far too slow to play with (a few hundred games
// per candidate) but it is cheap enough to answer one question.
//
// The board is given top row first, columns left to right, digits 0-6 —
// exactly how the spectator draws it. Row 1 of the string is the TOP row, which
// is `j = 4` in engine coordinates.
//
// Refills during a probe use FILL_SAMPLE: drawn from the real distribution with
// our own RNG, so nothing peeks at a real game's generator.
// ============================================================================

const path = require('path');
const Collapse = require('./engine.js');
const { createAgent } = require('./agents.js');

const DEFAULT_AGENT = 'fx:weights=bot/weights/big-td.bin,depth=2,cap=16,rootk=6';

function parseArgs(argv) {
    const a = { agent: DEFAULT_AGENT, board: null, trials: 100, jobs: 1, seed: 1, maxGen: 4, moves: null };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--agent') a.agent = argv[++i];
        else if (k === '--board') a.board = argv[++i];
        else if (k === '--trials') a.trials = parseInt(argv[++i], 10);
        else if (k === '--jobs') a.jobs = parseInt(argv[++i], 10);
        else if (k === '--seed') a.seed = parseInt(argv[++i], 10);
        else if (k === '--max-gen') a.maxGen = parseInt(argv[++i], 10);
        else if (k === '--moves') a.moves = argv[++i].split(',').map(s => s.trim());
        else { console.error('unknown option ' + k); process.exit(1); }
    }
    if (!a.board) { console.error('--board is required, e.g. --board "13235|51325|55455|55555|55556"'); process.exit(1); }
    return a;
}

// "13235|51325|55455|55555|55556" -> a Game with that position.
// Row 0 of the string is the top row (j = 4).
function boardFrom(spec, maxGen) {
    const rows = spec.split('|').map(r => r.trim().split('').map(Number));
    if (rows.length !== 5 || rows.some(r => r.length !== 5)) {
        throw new Error('board must be 5 rows of 5 digits separated by "|"');
    }
    const g = new Collapse.Game(1);
    for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) g.cells[i * 5 + j] = rows[4 - j][i];
    g.maxGen = maxGen;
    g.score = 0;
    g.scoreSplits = [];
    g.moves = [];
    g.gameOver = !g.hasLegalMove();
    return g;
}

const COLS = 'ABCDE';
const nameOf = m => COLS[m[0]] + (m[1] + 1);

// One playout: apply `move`, then let the agent finish. Returns points scored.
function playout(spec, board, maxGen, move, trialSeed) {
    const g = boardFrom(board, maxGen);
    g.fill = Collapse.FILL_SAMPLE;
    g.sampleRng = makeRng(trialSeed);
    const agent = createAgent(spec, { seed: trialSeed });
    g.apply(move[0], move[1]);
    while (!g.gameOver && g.moves.length < 20000) {
        const m = agent.chooseMove(g);
        if (!m) break;
        g.apply(m[0], m[1]);
    }
    return g.score;
}

function makeRng(seed) {
    let s = (seed >>> 0) || 1;
    return function () {
        s |= 0; s = (s + 0x6D2B79F5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// --- worker mode -------------------------------------------------------------
if (process.env.COLLAPSE_PROBE_WORKER) {
    process.on('message', ({ spec, board, maxGen, jobs }) => {
        process.send(jobs.map(j => playout(spec, board, maxGen, j.move, j.seed)));
        process.exit(0);
    });
    return;
}

function stats(xs) {
    const n = xs.length;
    const mean = xs.reduce((s, x) => s + x, 0) / n;
    const sd = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, n - 1));
    return { mean, se: sd / Math.sqrt(n) };
}

async function main() {
    const args = parseArgs(process.argv);
    const start = boardFrom(args.board, args.maxGen);
    let moves = start.legalMoves();
    if (args.moves) moves = moves.filter(m => args.moves.includes(nameOf(m)));
    if (!moves.length) { console.error('no legal moves match'); process.exit(1); }

    console.log('\n' + start.toString());
    console.log(args.agent);
    console.log(args.trials + ' playouts per move, common tile futures across moves\n');

    // Every candidate sees the same trial seeds, so the comparison is paired.
    const seeds = Array.from({ length: args.trials }, (_, t) => args.seed + t * 7919);
    const jobs = [];
    for (const move of moves) for (const seed of seeds) jobs.push({ move, seed });

    let results;
    if (args.jobs <= 1) {
        results = jobs.map(j => playout(args.agent, args.board, args.maxGen, j.move, j.seed));
    } else {
        const { fork } = require('child_process');
        const chunks = Array.from({ length: args.jobs }, () => []);
        jobs.forEach((j, k) => chunks[k % args.jobs].push({ job: j, at: k }));
        const parts = await Promise.all(chunks.map(chunk => new Promise((resolve, reject) => {
            if (!chunk.length) return resolve([]);
            const child = fork(__filename, [], { env: Object.assign({}, process.env, { COLLAPSE_PROBE_WORKER: '1' }) });
            child.on('message', resolve);
            child.on('error', reject);
            child.send({ spec: args.agent, board: args.board, maxGen: args.maxGen, jobs: chunk.map(c => c.job) });
        })));
        results = new Array(jobs.length);
        chunks.forEach((chunk, w) => chunk.forEach((c, k) => { results[c.at] = parts[w][k]; }));
    }

    const byMove = moves.map((move, mi) => ({
        move,
        scores: results.slice(mi * args.trials, (mi + 1) * args.trials)
    }));
    const best = byMove.reduce((a, b) => stats(b.scores).mean > stats(a.scores).mean ? b : a);
    const bestStats = stats(best.scores);

    console.log('  move    mean    ±se    vs best (paired)');
    console.log('  ' + '-'.repeat(44));
    for (const r of byMove) {
        const s = stats(r.scores);
        const diffs = r.scores.map((x, t) => x - best.scores[t]);
        const d = stats(diffs);
        const tag = r === best ? '' : `${d.mean >= 0 ? '+' : ''}${d.mean.toFixed(0)} ± ${d.se.toFixed(0)}`;
        console.log('  ' + nameOf(r.move).padEnd(6) +
            String(s.mean.toFixed(0)).padStart(7) + String(s.se.toFixed(0)).padStart(7) +
            '    ' + (r === best ? '(best)' : tag));
    }
    console.log();
}

main();
