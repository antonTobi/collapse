#!/usr/bin/env node
// ============================================================================
// Record a game as a replay the spectator can load.
//
//   node bot/record.js --agent "fx:weights=bot/weights/dom21c.bin,depth=3,cap=64,capDeep=4,topk=3,rootk=8" \
//                      --seed 301234 --out bot/replays/12413-d3.json
//
// A replay is a seed and a list of moves, and nothing else. The engine's refills
// come from a seeded PRNG consumed in move order, so replaying the same moves
// from the same seed reproduces the game exactly, board for board -- which means
// a 1100-move game is a few kilobytes rather than a few megabytes of positions.
//
// The point is the strong agents. Watching one of those in the spectator
// normally means playing the game out in the page first, and at 37 ms a move
// that is the better part of a minute of frozen tab. A recorded replay loads
// instantly and needs no weights file at all.
//
// `--scan` plays a range of seeds and records the best few, which is how the
// interesting games get found in the first place.
// ============================================================================

const fs = require('fs');
const path = require('path');
const Collapse = require('./engine.js');
const { createAgent } = require('./agents.js');

function parseArgs(argv) {
    const a = {
        agent: null, seed: 1, out: null, label: null,
        scan: 0, seedBase: 1, top: 3, outdir: null, jobs: 1
    };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--agent') a.agent = argv[++i];
        else if (k === '--seed') a.seed = parseInt(argv[++i], 10);
        else if (k === '--out') a.out = argv[++i];
        else if (k === '--label') a.label = argv[++i];
        else if (k === '--scan') a.scan = parseInt(argv[++i], 10);
        else if (k === '--seed-base') a.seedBase = parseInt(argv[++i], 10);
        else if (k === '--top') a.top = parseInt(argv[++i], 10);
        else if (k === '--outdir') a.outdir = argv[++i];
        else { console.error('unknown option ' + k); process.exit(1); }
    }
    if (!a.agent) { console.error('--agent is required'); process.exit(1); }
    return a;
}

// Play one game, keeping the moves. Returns { score, moves, movesPlayed }.
function record(spec, seed) {
    const agent = createAgent(spec, { seed });
    const game = new Collapse.Game(seed);
    const moves = [];
    while (!game.gameOver && moves.length < 20000) {
        const m = agent.chooseMove(game);
        if (!m) break;
        moves.push([m[0], m[1]]);
        game.apply(m[0], m[1]);
    }
    return { score: game.score, moves, movesPlayed: game.moves.length, sixes: game.sixCount };
}

// Replaying the moves has to reproduce the score, or the file is worthless --
// and it is exactly the property the spectator relies on.
function verify(seed, moves, expected) {
    const game = new Collapse.Game(seed);
    for (const [i, j] of moves) game.apply(i, j);
    return game.score === expected;
}

function write(file, obj) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj));
}

// The spectator reads this to populate its dropdown.
function reindex(dir) {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'index.json');
    const entries = files.map(f => {
        const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        return { file: f, label: r.label, score: r.score, seed: r.seed, moves: r.moves.length, agent: r.agent };
    }).sort((a, b) => b.score - a.score);
    write(path.join(dir, 'index.json'), entries);
    console.log(`index.json: ${entries.length} replays`);
    return entries;
}

function main() {
    const args = parseArgs(process.argv);

    if (args.scan) {
        const dir = args.outdir || path.join(__dirname, 'replays');
        const results = [];
        for (let n = 0; n < args.scan; n++) {
            const seed = args.seedBase + n;
            const r = record(args.agent, seed);
            results.push({ seed, ...r });
            if ((n + 1) % 25 === 0) process.stderr.write(`  ${n + 1}/${args.scan}\r`);
        }
        results.sort((a, b) => b.score - a.score);
        console.log(`scanned ${args.scan} seeds, best ${results[0].score}`);
        for (const r of results.slice(0, args.top)) {
            if (!verify(r.seed, r.moves, r.score)) {
                console.error(`seed ${r.seed} does not replay to ${r.score} — skipping`);
                continue;
            }
            const file = path.join(dir, `${r.score}-${r.seed}.json`);
            write(file, {
                seed: r.seed, agent: args.agent, score: r.score,
                label: args.label ? `${r.score.toLocaleString()} · ${args.label}` : String(r.score),
                moves: r.moves
            });
            console.log(`  ${r.score}  seed ${r.seed}  ${r.moves.length} moves  -> ${path.basename(file)}`);
        }
        reindex(dir);
        return;
    }

    const r = record(args.agent, args.seed);
    if (!verify(args.seed, r.moves, r.score)) {
        console.error('replaying the moves does not reproduce the score — not writing');
        process.exit(1);
    }
    const out = args.out || path.join(__dirname, 'replays', `${r.score}-${args.seed}.json`);
    write(out, {
        seed: args.seed, agent: args.agent, score: r.score,
        label: args.label ? `${r.score.toLocaleString()} · ${args.label}` : String(r.score),
        moves: r.moves
    });
    console.log(`${r.score} over ${r.movesPlayed} moves -> ${out}`);
    reindex(path.dirname(out));
}

main();
