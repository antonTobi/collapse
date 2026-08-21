#!/usr/bin/env node
// ============================================================================
// TD(0) training of the n-tuple network on afterstates (Szubert & Jaskowski's
// 2048 scheme).
//
//   node bot/train.js --episodes 20000 --alpha 0.1 --out bot/weights/td.bin
//   node bot/train.js --episodes 20000 --resume bot/weights/td.bin
//   node bot/train.js --set big --stages 3 --sym --tc --episodes 200000
//
// At state s the agent picks the move maximizing r(m) + V(afterstate(m)). After
// playing it and letting new tiles fall to s', the value of the afterstate we
// landed on is moved towards r(next best) + V(afterstate(next best)), or 0 when
// s' is terminal. Training seeds are disjoint from the leaderboard seeds.
//
// `--resume` takes the architecture from the file, so a run continues exactly
// what it loaded; --set/--stages/--sym only apply to a fresh network. Starting
// from bot/pretrain.js (human-return regression) rather than from zeros gives
// TD a value function that already knows roughly what a good board looks like.
// ============================================================================

const path = require('path');
const Collapse = require('./engine.js');
const NTuple = require('./ntuple.js');

function parseArgs(argv) {
    const a = {
        episodes: 20000, alpha: 0.1, out: path.join(__dirname, 'weights/td.bin'), resume: null,
        seedBase: 100000, report: 1000, decay: 1, maxMoves: 5000,
        set: 'base', stages: 1, sym: false, tc: false
    };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--episodes') a.episodes = parseInt(argv[++i], 10);
        else if (k === '--alpha') a.alpha = parseFloat(argv[++i]);
        else if (k === '--decay') a.decay = parseFloat(argv[++i]);
        else if (k === '--out') a.out = argv[++i];
        else if (k === '--resume') a.resume = argv[++i];
        else if (k === '--seed-base') a.seedBase = parseInt(argv[++i], 10);
        else if (k === '--report') a.report = parseInt(argv[++i], 10);
        else if (k === '--sym') a.sym = true;
        else if (k === '--set') a.set = argv[++i];
        else if (k === '--stages') a.stages = parseInt(argv[++i], 10);
        else if (k === '--tc') a.tc = true;
        else if (k === '--max-moves') a.maxMoves = parseInt(argv[++i], 10);
        else { console.error('unknown option ' + k); process.exit(1); }
    }
    return a;
}

// Best (reward + V(afterstate)) from a position. Returns null when terminal.
function best(net, game) {
    const moves = game.legalMoves();
    if (!moves.length) return null;
    let bv = -Infinity, bm = null, bafter = null, br = 0;
    for (const m of moves) {
        const after = game.preview(m[0], m[1], Collapse.FILL_NONE);
        const r = after.score - game.score;
        const v = r + net.value(after.cells);
        if (v > bv) { bv = v; bm = m; bafter = after.cells; br = r; }
    }
    return { move: bm, cells: bafter, reward: br, value: bv };
}

function main() {
    const args = parseArgs(process.argv);
    const net = args.resume
        ? NTuple.load(args.resume, args.sym ? { sym: true } : null)
        : new NTuple.Network(undefined, { set: args.set, sym: args.sym, stages: args.stages });
    const tc = args.tc ? new NTuple.TC(net) : null;
    const apply = tc ? (cells, d) => tc.update(cells, d) : (cells, d) => net.update(cells, d);

    console.log('network: set=' + net.setName + ' sym=' + net.sym + ' stages=' + net.stages +
        ' weights=' + net.w.length + (tc ? ' (temporal coherence)' : ''));

    let alpha = args.alpha;
    const window = [];
    let capped = 0;
    const t0 = Date.now();

    for (let ep = 0; ep < args.episodes; ep++) {
        const game = new Collapse.Game(args.seedBase + ep);
        let cur = best(net, game);
        while (cur && game.moves.length < args.maxMoves) {
            const cells = cur.cells;                       // afterstate we commit to
            game.apply(cur.move[0], cur.move[1]);
            const next = best(net, game);                  // greedy from the new state
            const target = next ? next.reward + net.value(next.cells) : 0;
            apply(cells, alpha * (target - net.value(cells)));
            cur = next;
        }
        if (game.moves.length >= args.maxMoves) capped++;
        window.push(game.score);
        if (window.length > args.report) window.shift();
        if ((ep + 1) % args.report === 0) {
            const mean = window.reduce((a, b) => a + b, 0) / window.length;
            console.log('ep ' + (ep + 1) + '  mean(last ' + window.length + ') ' + mean.toFixed(0) +
                '  alpha ' + alpha.toFixed(4) + '  capped ' + capped + '  ' +
                ((Date.now() - t0) / 1000).toFixed(0) + 's');
            NTuple.save(args.out, net);
        }
        alpha *= args.decay;
    }
    NTuple.save(args.out, net);
    console.log('saved ' + args.out + ' (' + net.t.n + ' tuples, ' + net.w.length + ' weights)');
}

main();
