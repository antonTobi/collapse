#!/usr/bin/env node
// ============================================================================
// Do the deployed nets differ in how BUMPY their in-game evaluation curve is,
// not just in final score? `run.js` only sees the final number; a net can be
// stronger on average yet slide into (and climb out of) more holes along the
// way. This plays the old and new deployed nets on the same seeds, records the
// eval-graph curve the review page draws -- E_t = banked score + the searcher's
// best-move value (the depth-2 estimate of the FINAL score reachable) -- and
// measures its DIPS.
//
//   node bot/evaldips.js --seeds 120 --seed-base 700000 --jobs 8
//
// Dip metric = DRAWDOWN. At each move, drawdown = (best eval seen so far) - (eval
// now). This captures a fall whether it happened in one move or crept over ten
// (the running peak persists while the curve slides), and whether it is later
// recovered (a temporary dip) or not (a permanent setback):
//   maxDD    the single worst peak-to-trough fall in the game
//   meanDD   mean "underwater" depth over the game (cumulative dip burden:
//            many/long dips cost more than one brief one)
//   downVol  RMS of the negative K-move changes (local downside jitter)
//   nTemp    # dips >= TAU that recovered back to their pre-dip peak
//   nPerm    1 if the game ended still >= TAU below its running peak, else 0
// The curve is lightly smoothed first (radius R) so single-move refill noise is
// not counted as a dip -- matching what the eye reads off the graph.
//
// Each game is ALSO scored by the OTHER net's evaluator (same positions), so we
// can tell a genuinely bumpier TRAJECTORY (a fixed judge sees more dips in one
// net's games) from a merely jumpier EVAL (a net that just reads its own
// positions more nervously). Four series per seed:
//   O|O old game, old eval (self)     N|N new game, new eval (self)
//   O|N old game, new eval (cross)    N|O new game, old eval (cross)
// The hypothesis "old net has flatter curves" is O|O vs N|N; O|O-vs-N|O and
// O|N-vs-N|N are the same-judge controls.
// ============================================================================

const path = require('path');
const { fork } = require('child_process');
const Collapse = require('./engine.js');
const { createAgent } = require('./agents.js');

const OLD_SPEC = 'fx:weights=bot/weights/all7g-Rcq.bin,depth=2,cap=16,rootk=6';
const NEW_SPEC = 'fx:weights=bot/weights/anneal14-Rcq.bin,depth=2,cap=16,rootk=6,freeze=1,esc=6';

// ---- eval curve + dip metrics ---------------------------------------------

function smooth(v, r) {
    if (r <= 0) return v.slice();
    const n = v.length, out = new Array(n);
    for (let i = 0; i < n; i++) {
        let s = 0, c = 0;
        for (let k = Math.max(0, i - r); k <= Math.min(n - 1, i + r); k++) { s += v[k]; c++; }
        out[i] = s / c;
    }
    return out;
}

function metrics(E, R, tau, K) {
    if (E.length < 3) return { maxDD: 0, meanDD: 0, downVol: 0, nTemp: 0, nPerm: 0 };
    const S = smooth(E, R), n = S.length;
    let peak = S[0], maxDD = 0, sumDD = 0, inDip = false, dipMax = 0, nTemp = 0, nPerm = 0;
    for (let t = 0; t < n; t++) {
        if (S[t] >= peak) {
            if (inDip) { if (dipMax >= tau) nTemp++; inDip = false; dipMax = 0; }
            peak = S[t];
        } else {
            inDip = true;
            if (peak - S[t] > dipMax) dipMax = peak - S[t];
        }
        const dd = peak - S[t];
        if (dd > maxDD) maxDD = dd;
        sumDD += dd;
    }
    if (inDip && dipMax >= tau) nPerm++;   // ended in an unrecovered dip
    let s2 = 0, c = 0;
    for (let t = 0; t + K < n; t++) { const ch = S[t + K] - S[t]; if (ch < 0) s2 += ch * ch; c++; }
    return { maxDD, meanDD: sumDD / n, downVol: c ? Math.sqrt(s2 / c) : 0, nTemp, nPerm };
}

// ---- play a game, recording the self eval curve and every position ---------

function lcg(seed) { let s = (seed >>> 0) || 1; return () => (s = (s * 1103515245 + 12345) >>> 0) / 4294967296; }

// Replicates the deployed fx chooseMove (freeze is applied inside scoreMoves;
// deterministic argmax with a seeded tie-break -- ties are effectively absent in
// fx, so the played line matches deployment). Returns the self eval curve, a
// snapshot of every position for cross-evaluation, and the final score.
function playRecord(agent, seed) {
    const g = new Collapse.Game(seed), rng = lcg(seed);
    const Eself = [], snaps = [];
    while (!g.gameOver) {
        const scored = agent.scoreMoves(g);
        if (!scored.length) break;
        let best = -Infinity;
        for (const s of scored) if (s.value > best) best = s.value;
        Eself.push(g.score + best);
        snaps.push({ cells: g.cells.slice(), maxGen: g.maxGen, score: g.score });
        const tied = scored.filter(s => s.value === best);
        const mv = tied.length === 1 ? tied[0].move : tied[Math.floor(rng() * tied.length)].move;
        const gain = g.apply(mv[0], mv[1]);
        if (!gain) throw new Error(`illegal move by ${agent.name} on seed ${seed}`);
    }
    return { Eself, snaps, finalScore: g.score, moves: g.moves.length };
}

// The other net's opinion of the same positions (E = banked score + its best value).
function crossEval(agent, snaps) {
    return snaps.map(p => {
        const g = Collapse.fromCells(p.cells, 1);
        g.maxGen = p.maxGen;                       // keep the real generation
        g.gameOver = !g.hasLegalMove();
        if (g.gameOver) return p.score;
        const scored = agent.scoreMoves(g);
        let best = -Infinity;
        for (const s of scored) if (s.value > best) best = s.value;
        return p.score + (scored.length ? best : 0);
    });
}

// ---- worker ----------------------------------------------------------------

if (process.env.EVALDIPS_WORKER) {
    const R = +process.env.EVALDIPS_R, TAU = +process.env.EVALDIPS_TAU, K = +process.env.EVALDIPS_K;
    const oldA = createAgent(OLD_SPEC, { seed: 1 });
    const newA = createAgent(NEW_SPEC, { seed: 1 });
    process.on('message', msg => {
        const rows = msg.seeds.map(seed => {
            const og = playRecord(oldA, seed);
            const ng = playRecord(newA, seed);
            const oGnE = crossEval(newA, og.snaps);   // old game, new eval
            const nGoE = crossEval(oldA, ng.snaps);   // new game, old eval
            return {
                seed,
                oldScore: og.finalScore, newScore: ng.finalScore,
                oldMoves: og.moves, newMoves: ng.moves,
                OO: metrics(og.Eself, R, TAU, K),   // old game / old eval (self)
                ON: metrics(oGnE, R, TAU, K),        // old game / new eval
                NO: metrics(nGoE, R, TAU, K),        // new game / old eval
                NN: metrics(ng.Eself, R, TAU, K)     // new game / new eval (self)
            };
        });
        process.send({ id: msg.id, rows });
    });
    return;
}

// ---- main ------------------------------------------------------------------

function parseArgs(argv) {
    const a = { seeds: 120, seedBase: 700000, jobs: 8, r: 3, tau: 500, k: 5, csv: null };
    for (let i = 2; i < argv.length; i++) {
        const key = argv[i];
        if (key === '--seeds') a.seeds = parseInt(argv[++i], 10);
        else if (key === '--seed-base') a.seedBase = parseInt(argv[++i], 10);
        else if (key === '--jobs') a.jobs = parseInt(argv[++i], 10);
        else if (key === '--smooth') a.r = parseInt(argv[++i], 10);
        else if (key === '--dip-threshold') a.tau = parseFloat(argv[++i]);
        else if (key === '--vol-window') a.k = parseInt(argv[++i], 10);
        else if (key === '--csv') a.csv = argv[++i];
        else { console.error('unknown option ' + key); process.exit(1); }
    }
    return a;
}

function mean(xs) { return xs.reduce((s, x) => s + x, 0) / xs.length; }
function se(xs) { const m = mean(xs); return Math.sqrt(xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (xs.length * (xs.length - 1))); }
function pairedSE(d) { const m = mean(d); return Math.sqrt(d.reduce((s, x) => s + (x - m) * (x - m), 0) / (d.length * (d.length - 1))); }

async function main() {
    const args = parseArgs(process.argv);
    const seeds = Array.from({ length: args.seeds }, (_, k) => args.seedBase + k);
    const env = Object.assign({}, process.env, {
        EVALDIPS_WORKER: '1', EVALDIPS_R: String(args.r), EVALDIPS_TAU: String(args.tau), EVALDIPS_K: String(args.k)
    });
    const workers = Array.from({ length: args.jobs }, () => fork(__filename, [], { env }));
    const pending = new Map(); let id = 0;
    workers.forEach(w => w.on('message', m => { const r = pending.get(m.id); pending.delete(m.id); r(m.rows); }));
    const submit = (w, ss) => new Promise(res => { const i = ++id; pending.set(i, res); w.send({ id: i, seeds: ss }); });

    const chunks = Array.from({ length: args.jobs }, () => []);
    seeds.forEach((s, k) => chunks[k % args.jobs].push(s));
    let done = 0;
    const parts = await Promise.all(chunks.map((c, w) => c.length
        ? submit(workers[w], c).then(rows => { done += rows.length; process.stderr.write(`\r  played ${done}/${seeds.length} seeds`); return rows; })
        : []));
    workers.forEach(w => w.kill());
    process.stderr.write('\n');
    const rows = [].concat(...parts).sort((a, b) => a.seed - b.seed);

    if (args.csv) {
        const fs = require('fs');
        const hdr = 'seed,oldScore,newScore,' + ['OO', 'ON', 'NO', 'NN'].flatMap(s => ['maxDD', 'meanDD', 'downVol', 'nTemp', 'nPerm'].map(m => s + '_' + m)).join(',');
        const lines = rows.map(r => [r.seed, r.oldScore, r.newScore,
            ...['OO', 'ON', 'NO', 'NN'].flatMap(s => [r[s].maxDD, r[s].meanDD, r[s].downVol, r[s].nTemp, r[s].nPerm])].map(x => Math.round(x * 100) / 100).join(','));
        fs.writeFileSync(args.csv, hdr + '\n' + lines.join('\n') + '\n');
        console.log('wrote ' + args.csv);
    }

    const col = (series, field) => rows.map(r => r[series][field]);
    console.log(`\n${rows.length} seeds (${args.seedBase}-${args.seedBase + rows.length - 1})  deploy configs`);
    console.log(`  OLD  ${OLD_SPEC}`);
    console.log(`  NEW  ${NEW_SPEC}`);
    console.log(`  eval curve E = score + best-value; smoothed radius ${args.r}; dip threshold ${args.tau}; vol window ${args.k}\n`);

    const oS = rows.map(r => r.oldScore), nS = rows.map(r => r.newScore);
    console.log(`  final score:   old ${Math.round(mean(oS))} +-${Math.round(se(oS))}   ` +
        `new ${Math.round(mean(nS))} +-${Math.round(se(nS))}   ` +
        `(new-old ${mean(nS) >= mean(oS) ? '+' : ''}${Math.round(mean(nS) - mean(oS))} +-${Math.round(pairedSE(rows.map(r => r.newScore - r.oldScore)))} paired)`);

    const metricsList = [['maxDD', 'worst peak-to-trough fall'], ['meanDD', 'mean underwater depth'],
    ['downVol', `downside ${args.k}-move volatility`], ['nTemp', `# temporary dips >=${args.tau}`], ['nPerm', `# ended in setback >=${args.tau}`]];

    function panel(title, A, B, labA, labB) {
        console.log(`\n  ${title}   (${labA} vs ${labB};  lower = flatter)`);
        console.log('    metric      ' + labA.padStart(9) + labB.padStart(11) + '     diff (B-A) +-se     what');
        for (const [f, desc] of metricsList) {
            const a = col(A, f), b = col(B, f), d = a.map((x, i) => b[i] - x);
            console.log('    ' + f.padEnd(9) + String(mean(a).toFixed(f.startsWith('n') ? 2 : 0)).padStart(9)
                + String(mean(b).toFixed(f.startsWith('n') ? 2 : 0)).padStart(11)
                + ('   ' + (mean(d) >= 0 ? '+' : '') + mean(d).toFixed(f.startsWith('n') ? 2 : 0) + ' +-' + pairedSE(d).toFixed(f.startsWith('n') ? 2 : 0)).padStart(20)
                + '   ' + desc);
        }
    }

    panel('HYPOTHESIS  (self eval of own game)', 'OO', 'NN', 'old', 'new');
    panel('same judge = OLD net (is the new game really bumpier?)', 'OO', 'NO', 'oldGame', 'newGame');
    panel('same judge = NEW net', 'ON', 'NN', 'oldGame', 'newGame');
}

main();
