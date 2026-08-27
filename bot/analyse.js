#!/usr/bin/env node
// ============================================================================
// How much does more search change the answer?
//
//   node bot/analyse.js --seed 7 --at 400            # one position, in detail
//   node bot/analyse.js --seeds 60 --at 400 --jobs 8 # convergence over many
//
// Two questions, and they are the same measurement seen from two sides.
//
// For using the bot as an analyst: when it disagrees with you, is that a
// considered opinion or an artefact of a shallow search? Running one position
// up the ladder and watching whether the recommendation moves -- and whether
// the value estimate settles -- says which.
//
// For deciding where to spend effort: if the chosen move stops changing as
// search deepens, the search has converged and whatever remains between the bot
// and perfect play is in the *evaluator*, not the lookahead. More search would
// then be wasted, and the ceiling seen in bot/SCALING.md would be explained.
// If it keeps changing, deeper search is still finding real things and a better
// scaling strategy is worth chasing.
//
// The value column deserves suspicion. V is trained to predict the score from a
// position to the end of the game under the *training* policy, so it is not a
// calibrated forecast of the final score under search play. Watch how it moves,
// not what it equals.
// ============================================================================

const path = require('path');
const Collapse = require('./engine.js');
const { createAgent } = require('./agents.js');

const DEFAULT_W = 'bot/weights/all7g-Rcq.bin';

// The ladder from search.js, as separate agent specs so each can be timed.
const RUNGS = (process.env.CRN ? [
    ['d2c8', 'depth=2,cap=8,capDeep=2,topk=2,rootk=6,crn=1'],
    ['d2c16', 'depth=2,cap=16,capDeep=2,topk=2,rootk=6,crn=1'],
    ['d2c32', 'depth=2,cap=32,capDeep=4,topk=2,rootk=8,crn=1'],
    ['d3c16', 'depth=3,cap=16,capDeep=2,topk=2,rootk=6,crn=1'],
    ['d3c32', 'depth=3,cap=32,capDeep=4,topk=2,rootk=6,crn=1'],
    ['d3c64', 'depth=3,cap=64,capDeep=4,topk=3,rootk=8,crn=1'],
    ['d4c32', 'depth=4,cap=32,capDeep=2,topk=2,rootk=6,crn=1'],
    ['d4c64', 'depth=4,cap=64,capDeep=2,topk=3,rootk=8,crn=1']
] : [
    ['d1', 'depth=1'],
    ['d2c4', 'depth=2,cap=4,capDeep=2,topk=2,rootk=6'],
    ['d2c8', 'depth=2,cap=8,capDeep=2,topk=2,rootk=6'],
    ['d2c16', 'depth=2,cap=16,capDeep=2,topk=2,rootk=6'],
    ['d2c32', 'depth=2,cap=32,capDeep=4,topk=2,rootk=8'],
    ['d2c96', 'depth=2,cap=96,capDeep=4,topk=2,rootk=16'],
    ['d3c16', 'depth=3,cap=16,capDeep=2,topk=2,rootk=6'],
    ['d3c32', 'depth=3,cap=32,capDeep=4,topk=2,rootk=6'],
    ['d3c64', 'depth=3,cap=64,capDeep=4,topk=3,rootk=8'],
    ['d4c32', 'depth=4,cap=32,capDeep=2,topk=2,rootk=6'],
    ['d4c64', 'depth=4,cap=64,capDeep=2,topk=3,rootk=8']
]);

function parseArgs(argv) {
    const a = { seed: 1, seeds: 0, at: 400, weights: DEFAULT_W, jobs: 1, top: 4, rungs: 0, playouts: 1 };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--seed') a.seed = parseInt(argv[++i], 10);
        else if (k === '--seeds') a.seeds = parseInt(argv[++i], 10);
        else if (k === '--at') a.at = parseInt(argv[++i], 10);
        else if (k === '--weights') a.weights = argv[++i];
        else if (k === '--jobs') a.jobs = parseInt(argv[++i], 10);
        else if (k === '--top') a.top = parseInt(argv[++i], 10);
        else if (k === '--rungs') a.rungs = parseInt(argv[++i], 10);
        else if (k === '--playouts') a.playouts = parseInt(argv[++i], 10);
        else { console.error('unknown option ' + k); process.exit(1); }
    }
    return a;
}

// Play a fast agent to move `at`, so the analysed positions are ones a real
// game reaches rather than anything synthetic.
function positionAt(weights, seed, at) {
    const agent = createAgent(`fx:weights=${weights},depth=2,cap=8,capDeep=2,topk=2,rootk=6`, { seed });
    const g = new Collapse.Game(seed);
    while (!g.gameOver && g.moves.length < at) {
        const m = agent.chooseMove(g);
        if (!m) break;
        g.apply(m[0], m[1]);
    }
    return g;
}

const key = m => m ? m[0] + ',' + m[1] : '-';

// Score every move at one rung. Returns { move, value, ranked, ms }.
function atRung(weights, spec, game, seed) {
    const agent = createAgent(`fx:weights=${weights},${spec}`, { seed });
    return runScored(agent, game);
}

function runScored(agent, game) {
    const t0 = process.hrtime.bigint();
    const scored = agent.scoreMoves(game);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const ranked = scored.slice().sort((p, q) => q.value - p.value);
    return { move: ranked.length ? ranked[0].move : null, value: ranked.length ? ranked[0].value : 0, ranked, ms };
}

function one(args) {
    const game = positionAt(args.weights, args.seed, args.at);
    console.log(`seed ${args.seed}, after ${game.moves.length} moves, score ${game.score}, ` +
        `${game.countLegalMoves()} legal moves\n`);
    for (let j = Collapse.H - 1; j >= 0; j--) {
        let row = '  ';
        for (let i = 0; i < Collapse.W; i++) row += (game.cells[i * Collapse.H + j] || '.') + ' ';
        console.log(row);
    }
    console.log('');
    const rungs = args.rungs ? RUNGS.slice(0, args.rungs) : RUNGS;
    const head = 'rung'.padEnd(8) + 'ms'.padStart(9) + '  best'.padEnd(9) + 'value'.padStart(9) + '   next best (gap)';
    console.log(head);
    console.log('-'.repeat(head.length + 12));
    let prev = null;
    for (const [name, spec] of rungs) {
        const r = atRung(args.weights, spec, game, args.seed);
        const second = r.ranked[1];
        const gap = second ? (r.value - second.value) : 0;
        const changed = prev && key(prev) !== key(r.move) ? '  <- changed' : '';
        console.log(name.padEnd(8) + r.ms.toFixed(1).padStart(9) + '  ' +
            key(r.move).padEnd(7) + r.value.toFixed(0).padStart(9) + '   ' +
            (second ? key(second.move) + ' (' + gap.toFixed(0) + ')' : '—') + changed);
        prev = r.move;
    }
    console.log('\nA move that stops changing, and a gap to the runner-up that grows, is a');
    console.log('converged opinion. One that keeps flipping is not, however deep the search.');
}

// --- many positions: does the recommendation settle? ------------------------

function convergence(args) {
    const rungs = args.rungs ? RUNGS.slice(0, args.rungs) : RUNGS;
    const seeds = Array.from({ length: args.seeds }, (_, k) => 900000 + k);
    const agree = rungs.map(() => 0);        // matches the deepest rung's move
    const msSum = rungs.map(() => 0);
    const flips = rungs.map(() => 0);        // differs from the rung below
    const self = rungs.map(() => 0);         // differs from ITSELF, resampled
    let n = 0;
    for (const seed of seeds) {
        const game = positionAt(args.weights, seed, args.at);
        if (game.gameOver) continue;
        const picks = rungs.map(([, spec]) => atRung(args.weights, spec, game, seed));
        // The control that makes the rest readable. These searches sample at
        // chance nodes, so a rung disagrees with itself when the sampler rolls
        // differently. Without this noise floor there is no way to separate
        // "deeper search found something" from "the dice came up differently".
        const again = rungs.map(([, spec]) => atRung(args.weights, spec, game, seed + 7777777));
        const deepest = picks[picks.length - 1].move;
        picks.forEach((p, i) => {
            msSum[i] += p.ms;
            if (key(p.move) === key(deepest)) agree[i]++;
            if (i > 0 && key(p.move) !== key(picks[i - 1].move)) flips[i]++;
            if (key(p.move) !== key(again[i].move)) self[i]++;
        });
        n++;
    }
    console.log(`${n} positions at move ${args.at}\n`);
    console.log('rung'.padEnd(8) + 'ms'.padStart(9) + 'agrees deepest'.padStart(16) +
        'vs rung below'.padStart(15) + 'vs ITSELF'.padStart(12));
    console.log('-'.repeat(60));
    rungs.forEach(([name], i) => {
        console.log(name.padEnd(8) + (msSum[i] / n).toFixed(1).padStart(9) +
            ((100 * agree[i] / n).toFixed(0) + '%').padStart(16) +
            (i ? ((100 * flips[i] / n).toFixed(0) + '%').padStart(15) : '-'.padStart(15)) +
            ((100 * self[i] / n).toFixed(0) + '%').padStart(12));
    });
    console.log('');
    console.log('Read the last two columns together. "vs rung below" only means deeper');
    console.log('search changed something REAL to the extent it exceeds "vs itself", which');
    console.log('is the same search disagreeing with itself on a fresh sample. If the two');
    console.log('columns match, extra depth is buying nothing but different dice.');
}

// --- is the predicted score worth anything? ---------------------------------
//
// The search reports a root value. Taken at face value it reads as "the score
// this game will finish on", and that is the number an analyst would want to
// trust. But V was trained by TD to predict the score-to-go under the *training*
// policy -- greedy, no search -- so there is no reason it should be calibrated
// for a game that will actually be played out with search. Measuring it is the
// only way to know whether to believe it.
function calibrate(args) {
    const spec = `fx:weights=${args.weights},depth=2,cap=16,capDeep=2,topk=2,rootk=6,crn=1`;
    const rows = [];
    for (let k = 0; k < args.seeds; k++) {
        const seed = 700000 + k;
        const game = positionAt(args.weights, seed, args.at);
        if (game.gameOver) continue;
        const agent = createAgent(spec, { seed });
        const r = runScored(agent, game);
        const predicted = game.score + r.value;
        // Average over several futures, not one. Correlating a prediction with a
        // single realised outcome conflates "the estimate is bad" with "the
        // outcome is not yet determined by the position" -- and at move 200 the
        // realised spread is 970 while V's spread across positions is 198, which
        // is exactly what it looks like when most of the variance is future luck
        // rather than present position. Varying the engine's rng state gives
        // independent futures from the identical board.
        const K = args.playouts;
        let sum = 0;
        for (let t = 0; t < K; t++) {
            const g = game.clone();
            g.rngState = (game.rngState + 0x9E3779B1 * (t + 1)) >>> 0;
            const a2 = createAgent(spec, { seed: seed + 1000 * t });
            while (!g.gameOver) {
                const m = a2.chooseMove(g);
                if (!m) break;
                g.apply(m[0], m[1]);
            }
            sum += g.score;
        }
        rows.push({ predicted, actual: sum / K, at: args.at });
    }
    const n = rows.length;
    const mp = rows.reduce((a, r) => a + r.predicted, 0) / n;
    const ma = rows.reduce((a, r) => a + r.actual, 0) / n;
    const sp = Math.sqrt(rows.reduce((a, r) => a + (r.predicted - mp) ** 2, 0) / n);
    const sa = Math.sqrt(rows.reduce((a, r) => a + (r.actual - ma) ** 2, 0) / n);
    const cov = rows.reduce((a, r) => a + (r.predicted - mp) * (r.actual - ma), 0) / n;
    const rho = cov / (sp * sa);
    const rmse = Math.sqrt(rows.reduce((a, r) => a + (r.predicted - r.actual) ** 2, 0) / n);
    console.log(`${n} positions at move ${args.at}, each averaged over ${args.playouts} futures
`);
    console.log(`predicted  mean ${mp.toFixed(0)}  sd ${sp.toFixed(0)}`);
    console.log(`actual     mean ${ma.toFixed(0)}  sd ${sa.toFixed(0)}`);
    console.log(`bias (predicted - actual)  ${(mp - ma).toFixed(0)}`);
    console.log(`correlation  ${rho.toFixed(3)}`);
    console.log(`rmse         ${rmse.toFixed(0)}`);
    console.log('');
    console.log('A high correlation means the number ranks positions correctly even if');
    console.log('the level is off; a large bias with high correlation is fixable with an');
    console.log('offset, and low correlation is not fixable at all.');
}

const args = parseArgs(process.argv);
if (process.env.CALIB) calibrate(args);
else if (args.seeds) convergence(args); else one(args);
