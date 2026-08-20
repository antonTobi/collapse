#!/usr/bin/env node
// ============================================================================
// Weight tuning for the `linear` agent.
//
//   node bot/tune.js sweep                    # 1-D scan of every feature
//   node bot/tune.js ascent --start best      # coordinate ascent
//   node bot/tune.js show best                # print a preset's raw weights
//
// Weights are handled in NORMALIZED units: nw = w * SCALE[f], where SCALE[f] is
// the typical spread of that feature across the legal moves of a single
// position (measured from real play). A normalized weight of 1 therefore means
// "this feature moves the evaluation about as much as the move count does at
// weight 1". This keeps grids comparable across features whose raw magnitudes
// differ by two orders of magnitude (heightsum ~100 vs trapped ~1).
//
// Tune on a seed range disjoint from the leaderboard seeds (1-100).
// ============================================================================

const { Pool, summarize, specOf } = require('./harness.js');
const Ev = require('./eval.js');
const { PRESETS } = require('./agents.js');

// Within-decision spread of each feature, measured over 60 games of maxmoves.
const SCALE = { new5bond: 0.2257, new5colgap: 0.3457, new5blocked: 0.3926, fivebond: 1.2742, fiveblocked: 1.3789, fivecols: 0.9478, fivespan: 0.9298, fivemax: 1.2536, fournear5: 1.0784, s_moves: 8.5, s_pairs: 12, s_made: 5.6, s_sixopen: 2.9, s_gain: 32, s_heightsum: 92, chain5: 0.7, chainlow: 1.0, iso: 1.2, pairlo: 1.2, pairhi: 0.7, distinct: 0.4, gen4: 0.15, chain: 1.0, cnt1: 1.0, cnt2: 1.1, cnt3: 1.1, cnt4: 0.8, cnt5: 0.5, made3: 0.5, made4: 0.5, made5: 0.35, made6: 0.25, moves: 1.4152, pairs: 2.0119, made: 0.9286, gain: 5.3335, comp4: 0.5858, comp5: 0.4154, singles: 0.6994, sixopen: 0.4852, trapped: 0.1634, heightsum: 15.336, lowtiles: 0.6547, sixes: 0.1516 };

const toRaw = nw => {
    const w = {};
    for (const f of Object.keys(nw)) if (nw[f]) w[f] = +(nw[f] / SCALE[f]).toFixed(5);
    return w;
};
const toNorm = w => {
    const nw = {};
    for (const f of Ev.FEATURES) nw[f] = +(((w[f] || 0) * SCALE[f]).toFixed(4));
    return nw;
};

// Box-Muller, so a perturbation is occasionally large.
function gauss() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function parseArgs(argv) {
    const args = { mode: argv[2] || 'sweep', seeds: 200, seedBase: 10001, jobs: 4, start: null, extra: '', rounds: 3 };
    for (let i = 3; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--seeds') args.seeds = parseInt(argv[++i], 10);
        else if (a === '--seed-base') args.seedBase = parseInt(argv[++i], 10);
        else if (a === '--jobs') args.jobs = parseInt(argv[++i], 10);
        else if (a === '--start') args.start = argv[++i];
        else if (a === '--extra') args.extra = argv[++i];
        else if (a === '--rounds') args.rounds = parseInt(argv[++i], 10);
        else if (a === '--grid') args.grid = argv[++i].split(',').map(Number);
        else if (a === '--features') args.features = argv[++i].split(',');
        else if (a === '--iters') args.iters = parseInt(argv[++i], 10);
        else args.positional = (args.positional || []).concat(a);
    }
    return args;
}

async function main() {
    const args = parseArgs(process.argv);
    const seeds = Array.from({ length: args.seeds }, (_, k) => args.seedBase + k);
    const pool = new Pool(args.jobs);
    const extra = args.extra ? args.extra.split(',') : [];
    const evalNorm = async nw => summarize(await pool.evaluate(specOf(toRaw(nw), extra), seeds));

    if (args.mode === 'show') {
        const name = args.positional[0];
        console.log(JSON.stringify(PRESETS[name], null, 1));
        console.log('normalized:', JSON.stringify(toNorm(PRESETS[name])));
        pool.close(); return;
    }

    const base = args.start ? toNorm(PRESETS[args.start] || JSON.parse(args.start)) : toNorm({ moves: 1 });
    base.moves = base.moves || 1;

    if (args.mode === 'sweep') {
        const grid = args.grid || [-1.5, -1, -0.5, -0.25, -0.1, 0, 0.1, 0.25, 0.5, 1, 1.5];
        const ref = await evalNorm(base);
        console.log(`\nbase ${JSON.stringify(base)}\nbase mean ${ref.mean.toFixed(0)} ± ${ref.se.toFixed(0)} over ${seeds.length} seeds\n`);
        console.log('feature'.padEnd(11) + grid.map(g => String(g).padStart(7)).join(''));
        for (const f of (args.features || Ev.FEATURES)) {
            if (f === 'moves') continue;
            const row = [];
            for (const g of grid) {
                const nw = Object.assign({}, base); nw[f] = g;
                // Only reuse the base score for the 0 column when the base
                // really has this feature off, otherwise "0" would print the
                // base score instead of the score with the feature disabled.
                row.push(g === 0 && !base[f] ? ref : await evalNorm(nw));
            }
            const best = Math.max(...row.map(r => r.mean));
            console.log(f.padEnd(11) + row.map(r => (r.mean === best ? '*' : ' ') + r.mean.toFixed(0).padStart(6)).join(''));
        }
        pool.close(); return;
    }

    if (args.mode === 'ascent') {
        let current = Object.assign({}, base);
        let best = await evalNorm(current);
        console.log(`start ${best.mean.toFixed(0)} ± ${best.se.toFixed(0)}  ${JSON.stringify(current)}`);
        const features = Ev.FEATURES.filter(f => f !== 'moves');
        for (let round = 0; round < args.rounds; round++) {
            const step = [0.5, 0.25, 0.12][Math.min(round, 2)];
            for (const f of features) {
                let improved = false;
                for (const d of [step, -step]) {
                    const nw = Object.assign({}, current);
                    nw[f] = +((nw[f] || 0) + d).toFixed(4);
                    const r = await evalNorm(nw);
                    if (r.mean > best.mean) { best = r; current = nw; improved = true; break; }
                }
                process.stdout.write(`  r${round} ${f}${improved ? '=' + current[f] : ''} -> ${best.mean.toFixed(0)}\n`);
            }
            console.log(`round ${round}: ${best.mean.toFixed(0)} ± ${best.se.toFixed(0)}  ${JSON.stringify(current)}`);
        }
        console.log('\nnormalized: ' + JSON.stringify(current));
        console.log('raw preset: ' + JSON.stringify(toRaw(current)));
        pool.close(); return;
    }

    if (args.mode === 'climb') {
        // Random-direction hill climbing: perturb every active weight at once.
        // Coordinate ascent stalls as soon as no single axis helps; a random
        // direction can still find the diagonal.
        const features = args.features || Ev.FEATURES.filter(f => f !== 'moves');
        let current = Object.assign({}, base);
        let best = await evalNorm(current);
        console.log(`start ${best.mean.toFixed(0)} ± ${best.se.toFixed(0)}`);
        let sigma = 0.4, since = 0;
        for (let it = 0; it < (args.iters || 120); it++) {
            const trial = Object.assign({}, current);
            for (const f of features) {
                // perturb a random third of the active axes each step
                if (Math.random() < 0.34) trial[f] = +((trial[f] || 0) + sigma * gauss()).toFixed(4);
            }
            const r = await evalNorm(trial);
            if (r.mean > best.mean) { best = r; current = trial; since = 0; console.log(`  it${it} -> ${best.mean.toFixed(0)} (sigma ${sigma.toFixed(2)})`); }
            else if (++since >= 15) { sigma *= 0.7; since = 0; if (sigma < 0.05) break; }
        }
        console.log(`\nbest ${best.mean.toFixed(0)} ± ${best.se.toFixed(0)}`);
        console.log('normalized: ' + JSON.stringify(current));
        console.log('raw preset: ' + JSON.stringify(toRaw(current)));
        pool.close(); return;
    }

    console.error('modes: sweep | ascent | climb | show');
    pool.close();
}

main();
