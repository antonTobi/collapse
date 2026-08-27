#!/usr/bin/env node
// Mine human replays for sharp upward evaluation jumps. Collapse has noisy
// refills, so a jump alone is only a candidate. We keep it when search also
// finds a large Bellman lift on the post-jump position:
//
//   jump = E_depth2(position after human move) - E_depth2(position before)
//   lift = E_depth2(position after human move) - E_depth1(position after)
//
// A large positive lift says the shallow network undervalues continuations
// that one extra ply can already see, which is the operational blindspot we
// want a scalable evaluator to repair.
//
//   node bot/blindspots.js --weights bot/weights/all7g-Rcq.bin \
//       --partition train --out bot/data/blindspots-train.bin

const path = require('path');
const Collapse = require('./engine.js');
const NTuple = require('./ntuple.js');
const Replays = require('./replays.js');
const Search = require('./search.js');
const Starts = require('./starts.js');

function parseArgs(argv) {
    const a = {
        weights: path.join(__dirname, 'weights/all7g-Rcq.bin'),
        replays: Replays.DEFAULT_FILE,
        out: path.join(__dirname, 'data/blindspots-train.bin'),
        games: 0, minScore: 0, jump: 300, lift: 200,
        cap: 16, rootk: 6, topk: 2, holdout: 10, partition: 'train', context: 'both'
    };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--weights') a.weights = argv[++i];
        else if (k === '--replays') a.replays = argv[++i];
        else if (k === '--out') a.out = argv[++i];
        else if (k === '--games') a.games = parseInt(argv[++i], 10);
        else if (k === '--min-score') a.minScore = parseInt(argv[++i], 10);
        else if (k === '--jump') a.jump = parseFloat(argv[++i]);
        else if (k === '--lift') a.lift = parseFloat(argv[++i]);
        else if (k === '--cap') a.cap = parseInt(argv[++i], 10);
        else if (k === '--rootk') a.rootk = parseInt(argv[++i], 10);
        else if (k === '--topk') a.topk = parseInt(argv[++i], 10);
        else if (k === '--holdout') a.holdout = parseInt(argv[++i], 10);
        else if (k === '--partition') a.partition = argv[++i];
        else if (k === '--context') a.context = argv[++i];
        else { console.error('unknown option ' + k); process.exit(1); }
    }
    if (!['train', 'test', 'all'].includes(a.partition)) {
        console.error('--partition must be train, test or all'); process.exit(1);
    }
    if (!['pre', 'post', 'both'].includes(a.context)) {
        console.error('--context must be pre, post or both'); process.exit(1);
    }
    return a;
}

function main() {
    const args = parseArgs(process.argv);
    let rows = Replays.load({ file: args.replays, minScore: args.minScore });
    rows = rows.filter((_, k) => args.partition === 'all' ||
        (args.partition === 'test' ? k % args.holdout === 0 : k % args.holdout !== 0));
    if (args.games && rows.length > args.games) rows = rows.slice(0, args.games);

    const net = NTuple.load(args.weights);
    let sd = 0x9e3779b9;
    const rng = () => {
        sd ^= sd << 13; sd >>>= 0; sd ^= sd >>> 17; sd ^= sd << 5; sd >>>= 0;
        return sd / 4294967296;
    };
    const deep = Search.makeSearcher(net, {
        depth: 2, cap: args.cap, capDeep: args.cap, topk: args.topk,
        rootk: args.rootk, crn: true, rng
    });
    const shallow = Search.makeSearcher(net, { depth: 1, crn: true, rng });

    function evaluation(game, searcher) {
        if (game.gameOver) return game.score;
        const moves = searcher.scoreMoves(game);
        let best = -Infinity;
        for (const m of moves) if (m.value > best) best = m.value;
        return best === -Infinity ? game.score : game.score + best;
    }

    const positions = [], seen = new Set(), hits = [];
    let moves = 0;
    function keep(cells) {
        const key = Buffer.from(cells).toString('base64');
        if (!seen.has(key)) { seen.add(key); positions.push(cells.slice()); }
    }

    for (let r = 0; r < rows.length; r++) {
        const record = rows[r], game = new Collapse.Game(record.seed);
        let beforeDeep = evaluation(game, deep);
        for (let t = 0; t < record.moves.length; t++) {
            const pre = game.cells.slice();
            const [i, j] = Replays.decodeMove(record.moves[t]);
            if (!game.apply(i, j)) break;
            moves++;
            const afterDeep = evaluation(game, deep);
            const jump = afterDeep - beforeDeep;
            if (jump >= args.jump && !game.gameOver) {
                const afterShallow = evaluation(game, shallow);
                const lift = afterDeep - afterShallow;
                if (lift >= args.lift) {
                    if (args.context !== 'post') keep(pre);
                    if (args.context !== 'pre') keep(game.cells);
                    hits.push({ jump, lift, game: r, move: t });
                }
            }
            beforeDeep = afterDeep;
        }
        if ((r + 1) % 25 === 0) process.stdout.write('\rscanned ' + (r + 1) + '/' + rows.length + ' games');
    }
    if (rows.length >= 25) process.stdout.write('\n');
    Starts.save(args.out, positions);
    hits.sort((a, b) => b.lift - a.lift);
    const mean = key => hits.reduce((s, h) => s + h[key], 0) / Math.max(1, hits.length);
    console.log('scanned ' + rows.length + ' games / ' + moves.toLocaleString() + ' moves (' + args.partition + ')');
    console.log('kept ' + hits.length + ' jumps and ' + positions.length + ' unique ' + args.context +
        ' positions: mean jump ' + mean('jump').toFixed(0) + ', mean lift ' + mean('lift').toFixed(0));
    console.log('top lifts: ' + hits.slice(0, 10).map(h =>
        Math.round(h.lift) + ' (jump ' + Math.round(h.jump) + ', game ' + h.game + ', move ' + h.move + ')').join('  '));
    console.log('saved ' + args.out);
}

if (require.main === module) main();
module.exports = { parseArgs };
