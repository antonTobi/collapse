#!/usr/bin/env node
// ============================================================================
// The value network's Bellman residual, broken down by move rank.
//
//   node bot/residual.js --weights bot/weights/dom21c.bin
//   node bot/residual.js --weights bot/weights/w.bin --sub grid44 --games 40
//
// For an afterstate s the residual is
//
//     R(s) = E_refill[ max_a (gain_a + V) ] - V(s)
//
// i.e. what one Bellman backup adds to V's own opinion of s. At the TD(0)
// fixed point it is zero. It is not an abstraction: a depth-d search scores a
// root move as
//
//     gain_a + chanceValue(after_a, d-1)  =  (gain_a + V(after_a)) + R(after_a)
//
// which is exactly the greedy score plus the residual, so **everything search
// buys over greedy is V's own residual**. Measuring R directly says how much
// room search has, and where.
//
// What it shows on a network trained by on-policy self-play: R is ~0 on the
// move the training policy actually plays and grows steeply with rank, because
// TD only ever updated the afterstate it walked into. The *spread* down the
// rank column is what re-ranks moves -- a constant offset shifts every
// candidate equally and changes nothing -- so the spread, not the level, is the
// number to watch.
//
// Cheap by comparison with a benchmark: 40 grid44 games settle the table in
// seconds and it is nearly noiseless, where separating two strong agents by
// score takes hundreds of full games.
//
// Two sources of positions, and which one you use decides what the table means:
//
//   default        walk the greedy trajectory. Says how much room search has on
//                  the distribution the network trained on.
//   --positions F  read a start pool (starts.js / hstarts.js format) instead.
//                  Says how wrong the network is somewhere else -- the case
//                  that matters when the network is used to *analyse* positions
//                  rather than to reach them.
//
// `--by-sixes` splits the table by how many 6s are on the board, which is the
// control that makes a cross-distribution comparison honest: human positions
// sit much earlier in the game than the bot's own, and without the split a
// stage difference reads as a distribution difference. Measured on dom21q it is
// a distribution difference -- the bot's gap2 is flat at 6-8 across every
// bucket, and the human pool runs 28-37 in the same buckets.
// ============================================================================

const Collapse = require('./engine.js');
const Search = require('./search.js');
const NTuple = require('./ntuple.js');

function parseArgs(argv) {
    const a = {
        weights: 'bot/weights/dom21c.bin', games: 20, every: 5, ranks: 8,
        sub: '', seedBase: 700000, cap: 64, agent: 'greedy',
        positions: null, sample: 400, bySixes: false
    };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--weights') a.weights = argv[++i];
        else if (k === '--games') a.games = parseInt(argv[++i], 10);
        else if (k === '--every') a.every = parseInt(argv[++i], 10);
        else if (k === '--ranks') a.ranks = parseInt(argv[++i], 10);
        else if (k === '--sub') a.sub = argv[++i];
        else if (k === '--seed-base') a.seedBase = parseInt(argv[++i], 10);
        else if (k === '--cap') a.cap = parseInt(argv[++i], 10);
        else if (k === '--positions') a.positions = argv[++i];
        else if (k === '--sample') a.sample = parseInt(argv[++i], 10);
        else if (k === '--by-sixes') a.bySixes = true;
        else { console.error('unknown option ' + k); process.exit(1); }
    }
    return a;
}

// The walled subgames from run.js, repeated here so this tool stands alone.
function startGame(sub, seed) {
    const g = new Collapse.Game(seed);
    if (!sub) return g;
    const cells = Array.from(g.cells);
    if (sub === 'grid54' || sub === 'grid44') for (let i = 0; i < Collapse.W; i++) cells[i * Collapse.H] = 6;
    if (sub === 'grid45' || sub === 'grid44') for (let j = 0; j < Collapse.H; j++) cells[(Collapse.W - 1) * Collapse.H + j] = 6;
    return Collapse.fromCells(cells, seed);
}

function measure(net, args) {
    let sd = 4242;
    const rng = () => {
        sd ^= sd << 13; sd >>>= 0;
        sd ^= sd >>> 17;
        sd ^= sd << 5; sd >>>= 0;
        return sd / 4294967296;
    };
    // A depth-2 searcher at full root width is exactly the backup oracle: its
    // value for a root move is gain + E_refill[max(gain'+V)], and the depth-1
    // searcher's value for the same move is gain + V. The difference is R.
    // rootk/topk are off so that every move gets the deep treatment; a pruned
    // root would leave most moves holding their shallow value and the
    // difference would read zero for them.
    const oracle = Search.makeSearcher(net, { depth: 2, cap: args.cap, capDeep: args.cap, topk: 0, rootk: 0, rng });
    const shallow = Search.makeSearcher(net, { depth: 1, rng });
    const expander = Search.makeExpander();

    const key = m => m[0] + ',' + m[1];
    const mkBins = () => Array.from({ length: args.ranks }, () => ({ n: 0, sum: 0 }));
    const bins = mkBins();
    // Optional split by 6-count, so a stage difference cannot masquerade as a
    // distribution difference. Buckets match the ones in the header comment.
    const SIX_EDGES = [3, 6, 9, 12];
    const sixBucket = n => { let b = 0; for (const e of SIX_EDGES) if (n >= e) b++; return b; };
    const bySix = args.bySixes ? SIX_EDGES.map(() => ({ bins: mkBins(), pos: 0, moves: 0 }))
        .concat([{ bins: mkBins(), pos: 0, moves: 0 }]) : null;
    const scores = [];
    let positions = 0;

    // One position: rank every move by the shallow value, then ask the oracle
    // what a single Bellman backup does to each. Shared by both position
    // sources so the two tables are produced by identical code.
    function sampleAt(game) {
        const sh = shallow.scoreMoves(game);
        if (sh.length <= 2) return;
        const deep = oracle.scoreMoves(game);
        const shOf = new Map(sh.map(s => [key(s.move), s.value]));
        const ranked = sh.slice().sort((p, q) => q.value - p.value).map(s => key(s.move));
        let slot = null;
        if (bySix) {
            let sixes = 0;
            for (let k = 0; k < game.cells.length; k++) if (game.cells[k] === 6) sixes++;
            slot = bySix[sixBucket(sixes)];
            slot.pos++; slot.moves += sh.length;
        }
        for (const d of deep) {
            const k = key(d.move);
            const bin = Math.min(ranked.indexOf(k), args.ranks - 1);
            const r = d.value - shOf.get(k);
            bins[bin].n++; bins[bin].sum += r;
            if (slot) { slot.bins[bin].n++; slot.bins[bin].sum += r; }
        }
        positions++;
    }

    // Pool mode: no trajectory at all, just the stored boards. Each gets its
    // own seed so the oracle's sampled refills are not correlated across the
    // pool.
    if (args.positions) {
        const pool = require('./starts.js').load(args.positions);
        const total = pool.length / 25;
        const step = Math.max(1, Math.floor(total / args.sample));
        for (let at = 0; at < total && positions < args.sample; at += step) {
            const game = Collapse.fromCells(pool.subarray(at * 25, at * 25 + 25), args.seedBase + at);
            if (!game.gameOver) sampleAt(game);
        }
        return { bins, scores, positions, bySix, SIX_EDGES };
    }

    for (let g = 0; g < args.games; g++) {
        const game = startGame(args.sub, args.seedBase + g);
        let step = 0;
        while (!game.gameOver && game.moves.length < 20000) {
            if (step % args.every === 0) sampleAt(game);
            // Walk the trajectory the training policy walks, so the table
            // describes the distribution TD actually saw.
            const nm = expander.expand(game.cells, game.maxGen);
            if (nm === 0) break;
            let bv = -Infinity, bs = 0;
            for (let s = 0; s < nm; s++) {
                const v = expander.gain(s) + net.value(expander.board(s));
                if (v > bv) { bv = v; bs = s; }
            }
            const c = expander.cell(bs);
            game.apply((c / Collapse.H) | 0, c % Collapse.H);
            step++;
        }
        scores.push(game.score);
    }
    return { bins, scores, positions, bySix, SIX_EDGES };
}

function main() {
    const args = parseArgs(process.argv);
    const net = NTuple.load(args.weights);
    const { bins, scores, positions, bySix, SIX_EDGES } = measure(net, args);

    const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
    const label = r => (r === args.ranks - 1 ? (args.ranks + '+') : String(r + 1));
    const at = r => bins[r].n ? bins[r].sum / bins[r].n : NaN;

    console.log(args.weights + (args.sub ? '  [' + args.sub + ']' : '') +
        (args.positions
            ? '   pool ' + args.positions + ', ' + positions + ' positions'
            : '   ' + args.games + ' games, ' + positions + ' positions, greedy score ' + mean(scores).toFixed(0)));
    console.log('  rank      ' + bins.map((_, r) => label(r).padStart(8)).join(''));
    console.log('  residual  ' + bins.map((_, r) => at(r).toFixed(1).padStart(8)).join(''));
    console.log('  n         ' + bins.map(b => String(b.n).padStart(8)).join(''));
    // Which summary to read, and it is worth being careful because the obvious
    // one misleads. A constant added to the whole column changes no move, so the
    // *level* (rank 1) is noise for policy purposes. The tail is nearly noise
    // too: a depth-2 search plays shallow rank 1/2/3/4 on 57/19/10/7% of
    // decisions and rank 7+ essentially never, so a residual at rank 8 has no
    // decision to change. `gap2` and `gap4` -- how far ranks 2 and 4 sit above
    // rank 1 -- are the numbers that track score. Measured: an arm that cut the
    // rank-6+ residual almost in half while raising `gap2` from 7.5 to 9.5 lost
    // 158 points.
    if (bySix) {
        const names = SIX_EDGES.map((e, k) => (k ? SIX_EDGES[k - 1] : 0) + '-' + (e - 1)).concat([SIX_EDGES[SIX_EDGES.length - 1] + '+']);
        const g = (slot, r) => slot.bins[r].n ? slot.bins[r].sum / slot.bins[r].n : NaN;
        console.log('  by 6-count  ' + '6s'.padEnd(8) + 'pos'.padStart(7) + 'moves'.padStart(8) +
            'level'.padStart(8) + 'gap2'.padStart(8) + 'gap4'.padStart(8));
        bySix.forEach((slot, k) => {
            if (!slot.pos) return;
            console.log('              ' + names[k].padEnd(8) + String(slot.pos).padStart(7) +
                (slot.moves / slot.pos).toFixed(1).padStart(8) + g(slot, 0).toFixed(1).padStart(8) +
                (g(slot, 1) - g(slot, 0)).toFixed(1).padStart(8) +
                (g(slot, Math.min(3, args.ranks - 1)) - g(slot, 0)).toFixed(1).padStart(8));
        });
    }
    console.log('  gap2 (rank 2 - rank 1) ' + (at(1) - at(0)).toFixed(1) +
        '   gap4 ' + (at(Math.min(3, args.ranks - 1)) - at(0)).toFixed(1) +
        '   tail (rank ' + args.ranks + '+ - rank 1) ' + (at(args.ranks - 1) - at(0)).toFixed(1) +
        '   level ' + at(0).toFixed(1));
}

if (require.main === module) main();
module.exports = { measure, startGame };
