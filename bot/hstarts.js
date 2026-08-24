#!/usr/bin/env node
// ============================================================================
// Start positions drawn from human games, for training a value network that
// has to evaluate positions it would never have reached itself.
//
//   node bot/hstarts.js --part train --out bot/data/human-train.bin
//   node bot/hstarts.js --part test  --out bot/data/human-test.bin --every 23
//
// Why: `bot/starts.js` samples the positions a *search* agent reaches, to cover
// the deep endgame. This covers a different hole. Measured with residual.js on
// dom21q, at matched 6-count, human positions carry 4-5x the Bellman residual
// of the bot's own:
//
//   6s on board   bot gap2   human gap2   bot gap4   human gap4
//   0-2               7.6         37.1       21.8        127.2
//   3-5               5.8         28.8       24.0         72.6
//   6-8               7.3         28.1       29.3         83.6
//   9-11              5.7         30.6       24.7         59.6
//
// The residual is positive and grows with rank, so V under-values moves and
// under-values bad moves most: an analysis tool reporting "this move loses X"
// from a depth-1 evaluation *overstates* X by roughly the gap. On the bot's own
// distribution gap2 ~ 7 is the architecture's floor; on human positions ~30 is
// a data deficit, and data is the only thing that fixes a data deficit.
//
// Mutation: after picking a position, a few tiles are optionally replaced with
// random values. Measured, one mutation of a *bot* position gets about halfway
// to the human residual (gap2 6.8 -> ~15), so it is a real diversifier and not
// just noise -- but the human corpus is the bigger half, which is why mutation
// is a fraction of the pool rather than all of it.
//
// Writes the same 'CSTA' format as starts.js, so `ptrain.js --starts` reads it
// with no changes.
//
// The train/test split is by game, not by position: positions from one game
// share a board lineage, so splitting by position would leak. Anything that
// *measures* this network (residual.js, calib.js) must use --part test.
// ============================================================================

const path = require('path');
const Collapse = require('./engine.js');
const Replays = require('./replays.js');
const Starts = require('./starts.js');

function parseArgs(argv) {
    const a = {
        out: path.join(__dirname, 'data/human-starts.bin'),
        every: 5, minLegal: 2, minScore: 0, games: 0,
        part: 'train', holdout: 10,
        mutateFrac: 0.5, mutateMax: 3, seed: 20260824, maxPos: 0
    };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--out') a.out = argv[++i];
        else if (k === '--every') a.every = parseInt(argv[++i], 10);
        else if (k === '--min-score') a.minScore = parseInt(argv[++i], 10);
        else if (k === '--games') a.games = parseInt(argv[++i], 10);
        else if (k === '--part') a.part = argv[++i];
        else if (k === '--holdout') a.holdout = parseInt(argv[++i], 10);
        else if (k === '--mutate-frac') a.mutateFrac = parseFloat(argv[++i]);
        else if (k === '--mutate-max') a.mutateMax = parseInt(argv[++i], 10);
        else if (k === '--max-pos') a.maxPos = parseInt(argv[++i], 10);
        else if (k === '--seed') a.seed = parseInt(argv[++i], 10);
        else { console.error('unknown option ' + k); process.exit(1); }
    }
    if (!['train', 'test', 'all'].includes(a.part)) {
        console.error("--part must be train, test or all");
        process.exit(1);
    }
    return a;
}

function main() {
    const a = parseArgs(process.argv);
    let sd = a.seed >>> 0;
    const rng = () => { sd ^= sd << 13; sd >>>= 0; sd ^= sd >>> 17; sd ^= sd << 5; sd >>>= 0; return sd / 4294967296; };

    const rows = Replays.load({ minScore: a.minScore, games: a.games || undefined });
    // Deterministic split by game index in replays.js's own (best-first) order.
    const keep = rows.filter((_, k) => a.part === 'all' ||
        (a.part === 'test') === (k % a.holdout === 0));

    const positions = [];
    let raw = 0, mutated = 0, dropped = 0, maxGenLost = 0;

    for (const r of keep) {
        let step = 0;
        Replays.walk(r, ({ game }) => {
            if (step++ % a.every !== 0) return;
            if (a.maxPos && positions.length >= a.maxPos) return;
            raw++;
            const cells = game.cells.slice();

            if (rng() < a.mutateFrac) {
                // 1..mutateMax tiles, uniform. More than one because a single
                // mutation only closes about half the residual gap.
                const n = 1 + ((rng() * a.mutateMax) | 0);
                const had4 = cells.some(c => c > 3);
                for (let m = 0; m < n; m++) cells[(rng() * 25) | 0] = 1 + ((rng() * 6) | 0);
                // A mutation can strand the board with no legal move at all --
                // fromCells would mark it gameOver and the episode would train
                // on nothing. It can also erase the last tile above 3, which
                // silently drops maxGen back to 3 for the whole episode (see
                // Collapse.fromCells); rare, but it changes the refill
                // distribution, so count it rather than let it hide.
                const probe = Collapse.fromCells(cells, 1);
                if (probe.countLegalMoves() < a.minLegal) { dropped++; return; }
                if (had4 && !cells.some(c => c > 3)) maxGenLost++;
                mutated++;
            }
            positions.push(cells);
        }, a.minLegal);
    }

    Starts.save(a.out, positions);

    const hist = new Array(26).fill(0);
    for (const c of positions) { let n = 0; for (let k = 0; k < 25; k++) if (c[k] === 6) n++; hist[n]++; }
    const meanScore = keep.reduce((s, r) => s + r.score, 0) / Math.max(1, keep.length);
    console.log(`${a.part}: ${keep.length} of ${rows.length} games (holdout 1 in ${a.holdout}), mean score ${meanScore.toFixed(0)}`);
    console.log(`every ${a.every}th position, ${raw} sampled, ${mutated} mutated (1-${a.mutateMax} tiles), ` +
        `${dropped} dropped as dead, ${maxGenLost} lost maxGen 4`);
    console.log(`saved ${positions.length.toLocaleString()} positions to ${a.out} ` +
        `(${((8 + positions.length * 25) / 1048576).toFixed(1)} MB)`);
    console.log('6-count distribution:');
    console.log('  ' + hist.map((n, k) => n ? k + ':' + (100 * n / positions.length).toFixed(1) + '%' : null)
        .filter(Boolean).join('  '));
}

if (require.main === module) main();
