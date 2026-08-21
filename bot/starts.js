#!/usr/bin/env node
// ============================================================================
// Sample positions from search play, to start training episodes from.
//
//   node bot/starts.js --agent "fx:weights=bot/weights/bigx-s7.bin,depth=2,cap=8,rootk=4" \
//                      --games 300 --out bot/data/starts.bin
//
// The network is trained on the states 1-ply greedy self-play reaches — 850
// moves and 13.8 sixes — and then deployed on the states depth-3 search
// reaches: 1063 moves and 14.9 sixes. The deep endgame is out of distribution,
// which is the one place a bigger network cannot help, because the data simply
// is not there.
//
// Training with search as the behaviour policy fixes that and costs ~25x the
// episodes (measured: 6 ep/s against 170). This is the cheap version of the
// same idea: play a few hundred games with the search agent once, keep the
// positions, and let training start a fraction of its episodes from them. The
// coverage is bought once instead of on every move of every episode.
//
// Format: 'CSTA' | u32 count | count * 25 bytes of cells. maxGen is not stored
// because it is recoverable from the board (see Collapse.fromCells).
// ============================================================================

const fs = require('fs');
const path = require('path');
const Collapse = require('./engine.js');
const { createAgent } = require('./agents.js');

const MAGIC = 0x41545343;   // 'CSTA' little-endian

function parseArgs(argv) {
    const a = {
        agent: 'fx:weights=bot/weights/bigx-s7.bin,depth=2,cap=8,rootk=4',
        games: 200, out: path.join(__dirname, 'data/starts.bin'),
        seedBase: 4000000, every: 8, minMove: 0, jobs: 1
    };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--agent') a.agent = argv[++i];
        else if (k === '--games') a.games = parseInt(argv[++i], 10);
        else if (k === '--out') a.out = argv[++i];
        else if (k === '--seed-base') a.seedBase = parseInt(argv[++i], 10);
        else if (k === '--every') a.every = parseInt(argv[++i], 10);
        else if (k === '--min-move') a.minMove = parseInt(argv[++i], 10);
        else if (k === '--jobs') a.jobs = parseInt(argv[++i], 10);
        else { console.error('unknown option ' + k); process.exit(1); }
    }
    return a;
}

function collect(spec, seeds, every, minMove) {
    const out = [];
    let moves = 0, score = 0, sixes = 0;
    for (const seed of seeds) {
        const agent = createAgent(spec, { seed });
        const game = new Collapse.Game(seed);
        while (!game.gameOver && game.moves.length < 20000) {
            if (game.moves.length >= minMove && game.moves.length % every === 0) {
                out.push(game.cells.slice());
            }
            const m = agent.chooseMove(game);
            if (!m) break;
            game.apply(m[0], m[1]);
        }
        moves += game.moves.length;
        score += game.score;
        sixes += game.sixCount;
    }
    return { out, moves, score, sixes };
}

// --- worker mode -------------------------------------------------------------
if (process.env.COLLAPSE_STARTS_WORKER) {
    process.on('message', ({ spec, seeds, every, minMove }) => {
        const r = collect(spec, seeds, every, minMove);
        process.send({ cells: r.out.map(c => Array.from(c)), moves: r.moves, score: r.score, sixes: r.sixes });
        process.exit(0);
    });
    return;
}

function save(file, positions) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const buf = Buffer.alloc(8 + positions.length * 25);
    buf.writeUInt32LE(MAGIC, 0);
    buf.writeUInt32LE(positions.length, 4);
    positions.forEach((c, n) => Buffer.from(c).copy(buf, 8 + n * 25));
    fs.writeFileSync(file, buf);
}

// Returns a Uint8Array of count*25 cells, or null if the file is not a pool.
function load(file) {
    const buf = fs.readFileSync(file);
    if (buf.length < 8 || buf.readUInt32LE(0) !== MAGIC) throw new Error(file + ' is not a starts pool');
    const count = buf.readUInt32LE(4);
    if (buf.length !== 8 + count * 25) throw new Error(file + ' is truncated');
    return new Uint8Array(buf.buffer, buf.byteOffset + 8, count * 25).slice();
}

async function main() {
    const args = parseArgs(process.argv);
    const seeds = Array.from({ length: args.games }, (_, k) => args.seedBase + k);
    console.log(args.agent);
    console.log(args.games + ' games, keeping every ' + args.every + 'th position from move ' + args.minMove);

    let positions = [], moves = 0, score = 0, sixes = 0;
    if (args.jobs <= 1) {
        const r = collect(args.agent, seeds, args.every, args.minMove);
        positions = r.out; moves = r.moves; score = r.score; sixes = r.sixes;
    } else {
        const { fork } = require('child_process');
        const chunks = Array.from({ length: args.jobs }, () => []);
        seeds.forEach((s, k) => chunks[k % args.jobs].push(s));
        const parts = await Promise.all(chunks.map(chunk => new Promise((resolve, reject) => {
            if (!chunk.length) return resolve({ cells: [], moves: 0, score: 0, sixes: 0 });
            const child = fork(__filename, [], { env: Object.assign({}, process.env, { COLLAPSE_STARTS_WORKER: '1' }) });
            child.on('message', resolve);
            child.on('error', reject);
            child.send({ spec: args.agent, seeds: chunk, every: args.every, minMove: args.minMove });
        })));
        for (const p of parts) {
            for (const c of p.cells) positions.push(Uint8Array.from(c));
            moves += p.moves; score += p.score; sixes += p.sixes;
        }
    }

    save(args.out, positions);

    // What the pool actually looks like, so a mismatch is visible at a glance.
    const hist = new Array(20).fill(0);
    for (const c of positions) { let n = 0; for (let k = 0; k < 25; k++) if (c[k] === 6) n++; hist[n]++; }
    console.log('\nsource games: mean score ' + (score / args.games).toFixed(0) +
        ', mean length ' + (moves / args.games).toFixed(0) + ' moves, mean 6s ' + (sixes / args.games).toFixed(1));
    console.log('saved ' + positions.length.toLocaleString() + ' positions to ' + args.out +
        ' (' + ((8 + positions.length * 25) / 1048576).toFixed(1) + ' MB)');
    console.log('\n6-count distribution of the pool:');
    console.log('  ' + hist.map((n, k) => n ? k + ':' + (100 * n / positions.length).toFixed(1) + '%' : null)
        .filter(Boolean).join('  '));
}

module.exports = { load, save, MAGIC };
if (require.main === module) main();
