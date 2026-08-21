#!/usr/bin/env node
// ============================================================================
// Where does the bot disagree with strong humans, and what would fix it?
//
//   node bot/disagree.js --agent linear:preset=v4 --min-score 7000
//   node bot/disagree.js --agent linear:preset=v4 --rank 3 --show 6
//
// For every position in a strong human game, rank the legal moves by the
// agent's evaluation and find the human's move in that ranking. The positions
// where the agent ranks it badly are the ones worth looking at.
//
// The aggregate table is the useful part. For the disagreements it reports, per
// feature, the mean of (human move's value - agent's top move's value), scaled
// by that feature's spread within the position. A feature with a large positive
// number is one the human is consistently buying and the agent is not: either
// its weight is wrong, or -- more interestingly -- it is a proxy for something
// the feature set cannot express, which is where a NEW feature comes from.
//
// This is the loop that produced v1 and v4 (watch the bot play, notice what it
// gets wrong), with 40 000 examples instead of a handful of games and with a
// reference stronger than the agent generating them.
// ============================================================================

const Collapse = require('./engine.js');
const Ev = require('./eval.js');
const Replays = require('./replays.js');
const { createAgent } = require('./agents.js');

function parseArgs(argv) {
    const a = { agent: 'linear:preset=v4', minScore: 7000, games: 150, rank: 3, show: 0, top: 18, user: null };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--agent') a.agent = argv[++i];
        else if (k === '--min-score') a.minScore = Number(argv[++i]);
        else if (k === '--games') a.games = Number(argv[++i]);
        else if (k === '--user') a.user = argv[++i];
        else if (k === '--rank') a.rank = Number(argv[++i]);     // "badly ranked" threshold
        else if (k === '--show') a.show = Number(argv[++i]);     // print this many example boards
        else if (k === '--top') a.top = Number(argv[++i]);
        else { console.error('unknown option ' + k); process.exit(1); }
    }
    return a;
}

function boardString(game, marks) {
    let s = '';
    for (let j = 4; j >= 0; j--) {
        let line = '   ';
        for (let i = 0; i < 5; i++) {
            const v = game.at(i, j) || '.';
            const m = marks.find(x => x[0] === i && x[1] === j);
            line += (m ? m[2] : ' ') + v + ' ';
        }
        s += line + '\n';
    }
    return s;
}

function main() {
    const args = parseArgs(process.argv);
    const rows = Replays.load({ minScore: args.minScore, games: args.games, user: args.user });
    console.log(Replays.describe(rows));
    console.log('agent: ' + args.agent + '\n');

    const agent = createAgent(args.agent, { seed: 11 });
    if (!agent.scoreMoves) throw new Error('agent ' + args.agent + ' does not expose scoreMoves');

    const buf = new Float64Array(Ev.NF);
    const sum = new Float64Array(Ev.NF);      // mean scaled (human - agent top) over disagreements
    const rankHist = new Array(12).fill(0);
    let n = 0, bad = 0, top1 = 0;
    const examples = [];

    // Features of the board after `move` is played from `game`.
    function feats(game, move, out) {
        const next = game.preview(move[0], move[1], Collapse.FILL_NONE);
        const made = game.at(move[0], move[1]) + 1;
        const gain = next.score - game.score;
        Ev.extract(next, made, gain, out, gain / (made - 1));
        return out;
    }

    Replays.walkAll(rows, (d, rec) => {
        const scored = agent.scoreMoves(d.game);
        if (scored.length < 2) return;
        const sorted = scored.slice().sort((p, q) => q.value - p.value);
        const rank = sorted.findIndex(s => s.move[0] === d.move[0] && s.move[1] === d.move[1]);
        if (rank < 0) return;
        n++;
        rankHist[Math.min(rank, rankHist.length - 1)]++;
        if (rank === 0) { top1++; return; }
        if (rank < args.rank) return;
        bad++;

        // Scale each feature by its spread across this position's candidates,
        // so a difference counts as "large" relative to the choice on offer,
        // not relative to the feature's absolute magnitude.
        const all = scored.map(s => Float64Array.from(feats(d.game, s.move, buf)));
        const mean = new Float64Array(Ev.NF), sd = new Float64Array(Ev.NF);
        for (const v of all) for (let t = 0; t < Ev.NF; t++) mean[t] += v[t] / all.length;
        for (const v of all) for (let t = 0; t < Ev.NF; t++) sd[t] += (v[t] - mean[t]) ** 2 / all.length;
        for (let t = 0; t < Ev.NF; t++) sd[t] = Math.sqrt(sd[t]);

        const h = Float64Array.from(feats(d.game, d.move, buf));
        const b = Float64Array.from(feats(d.game, sorted[0].move, buf));
        for (let t = 0; t < Ev.NF; t++) if (sd[t] > 1e-9) sum[t] += (h[t] - b[t]) / sd[t];

        if (examples.length < args.show) {
            examples.push({
                seed: rec.seed, score: rec.score, moveIndex: d.moveIndex, rank,
                board: boardString(d.game, [[d.move[0], d.move[1], 'H'], [sorted[0].move[0], sorted[0].move[1], 'B']]),
                humanValue: sorted[rank].value, botValue: sorted[0].value
            });
        }
    });

    console.log('decisions ' + n + '   top-1 agreement ' + (100 * top1 / n).toFixed(1) + '%' +
        '   ranked >=' + args.rank + ': ' + bad + ' (' + (100 * bad / n).toFixed(1) + '%)\n');

    console.log('rank of the human move in the agent ranking');
    for (let r = 0; r < 8; r++) {
        const pct = 100 * rankHist[r] / n;
        console.log('  ' + (r === 7 ? '7+' : String(r)).padStart(2) + '  ' +
            (pct).toFixed(1).padStart(5) + '%  ' + '#'.repeat(Math.round(pct)));
    }

    console.log('\nmean scaled (human move - agent top move) over the ' + bad + ' disagreements');
    console.log('positive = the human consistently takes more of this than the agent does\n');
    const ranked = Ev.FEATURES.map((f, t) => [f, sum[t] / Math.max(1, bad)])
        .filter(x => Math.abs(x[1]) > 0.02)
        .sort((p, q) => Math.abs(q[1]) - Math.abs(p[1]))
        .slice(0, args.top);
    for (const [f, v] of ranked) {
        const bars = Math.min(30, Math.round(Math.abs(v) * 40));
        console.log('  ' + f.padEnd(12) + (v >= 0 ? '+' : '') + v.toFixed(3) + '  ' +
            (v >= 0 ? ' '.repeat(0) : '') + (v >= 0 ? '+'.repeat(bars) : '-'.repeat(bars)));
    }

    for (const e of examples) {
        console.log('\n--- seed ' + e.seed + ' (human scored ' + e.score + '), move ' + e.moveIndex +
            ', agent ranked the human move #' + e.rank);
        console.log('    H = human, B = agent (values ' + e.humanValue.toFixed(2) + ' vs ' + e.botValue.toFixed(2) + ')');
        console.log(e.board);
    }
}

main();
