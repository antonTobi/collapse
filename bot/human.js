#!/usr/bin/env node
// ============================================================================
// Play an agent on the seeds real people played, and compare.
//
//   node bot/human.js --agent linear:preset=h1 --games 400
//   node bot/human.js --agent td:weights=bot/weights/c_tc.bin --user antonTobi
//   node bot/human.js --agent linear:preset=h1 --min-score 8000
//
// The replays carry the seed of the game that was played, so the bot can be run
// on exactly the same seeds. That turns "humans get about 10 000 in a good
// game" into a mean with a standard error, against a named reference set.
//
// Read the two means as the headline. The per-seed pairing is reported as a
// secondary column only: most of the score variance in this game comes from
// luck late in a run, long after the two players' boards have diverged
// completely, so sharing a seed removes far less variance than it would in a
// game where both sides see the same position throughout.
//
// Note what the comparison is and is not. The human sample is filtered by
// score, so it is a sample of their good games, not of their play in general.
// Against --min-score 6000 the bot is being asked to match a human's better
// days, every single time.
// ============================================================================

const Collapse = require('./engine.js');
const Replays = require('./replays.js');
const { Pool, summarize } = require('./harness.js');

function parseArgs(argv) {
    const a = { agent: 'linear:preset=h1', minScore: 0, games: 400, user: null, jobs: 4, verbose: false };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--agent') a.agent = argv[++i];
        else if (k === '--min-score') a.minScore = Number(argv[++i]);
        else if (k === '--games') a.games = Number(argv[++i]);
        else if (k === '--user') a.user = argv[++i];
        else if (k === '--jobs') a.jobs = Number(argv[++i]);
        else if (k === '--verbose' || k === '-v') a.verbose = true;
        else { console.error('unknown option ' + k); process.exit(1); }
    }
    return a;
}

async function main() {
    const args = parseArgs(process.argv);
    let rows = Replays.load({ minScore: args.minScore, user: args.user });
    // load() sorts best-first; for a fair sample of the filtered pool take an
    // even spread over it rather than only the very top games.
    if (args.games && rows.length > args.games) {
        const step = rows.length / args.games;
        rows = Array.from({ length: args.games }, (_, k) => rows[Math.floor(k * step)]);
    }
    console.log(Replays.describe(rows));
    console.log('agent: ' + args.agent + '\n');

    const pool = new Pool(args.jobs);
    const seeds = rows.map(r => r.seed);
    const scores = await pool.evaluate(args.agent, seeds);
    pool.close();

    const human = summarize(rows.map(r => r.score));
    const bot = summarize(scores);
    const diffs = scores.map((s, k) => s - rows[k].score);
    const d = summarize(diffs);
    const wins = diffs.filter(x => x > 0).length;

    console.log('  human  mean ' + human.mean.toFixed(0) + ' +- ' + human.se.toFixed(0));
    console.log('  agent  mean ' + bot.mean.toFixed(0) + ' +- ' + bot.se.toFixed(0));
    console.log('  ratio  ' + (bot.mean / human.mean).toFixed(3));
    console.log('\n  same-seed difference ' + (d.mean >= 0 ? '+' : '') + d.mean.toFixed(0) +
        ' +- ' + d.se.toFixed(0) + ', agent ahead on ' + wins + '/' + seeds.length + ' seeds (secondary)');

    if (args.verbose) {
        const byUser = new Map();
        rows.forEach((r, k) => {
            const key = r.displayName || r.userId || '?';
            if (!byUser.has(key)) byUser.set(key, []);
            byUser.get(key).push([r.score, scores[k]]);
        });
        const table = [...byUser.entries()]
            .filter(e => e[1].length >= 5)
            .map(e => [e[0], e[1].length,
                e[1].reduce((a, x) => a + x[0], 0) / e[1].length,
                e[1].reduce((a, x) => a + x[1], 0) / e[1].length])
            .sort((p, q) => q[2] - p[2]);
        console.log('\n  player'.padEnd(26) + 'games'.padStart(7) + 'human'.padStart(9) + 'agent'.padStart(9));
        for (const [name, n, h, b] of table) {
            console.log('  ' + String(name).slice(0, 22).padEnd(24) + String(n).padStart(6) +
                h.toFixed(0).padStart(9) + b.toFixed(0).padStart(9));
        }
    }
}

main();
