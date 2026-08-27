#!/usr/bin/env node
// ============================================================================
// Freeze a set of real-game decisions to a file, so a value function can be
// judged without playing anything.
//
//   node bot/corpus.js --agent "fx:weights=...,depth=2,cap=8" --games 200 --out c.bin
//
// For every position a real game passes through we store the afterstate of each
// legal move (`preview(i, j, none)`) and the score that move gains. That is
// exactly the input a depth-1 agent sees: its choice is
// argmax_m (gain_m + V(afterstate_m)). So any candidate V can be scored against
// any reference V over identical decisions, at the cost of a table lookup per
// move rather than a game.
//
// Format: u32 magic, u32 nPositions, then per position u8 nMoves, and per move
// u16 gain, u8 stage-irrelevant 25 cells.
// ============================================================================

const fs = require('fs');
const Collapse = require('./engine.js');
const { createAgent } = require('./agents.js');

function parseArgs(argv) {
    const a = { agent: 'td:weights=bot/weights/all7g-Rcq.bin', games: 100, seedBase: 900000, out: null, stride: 1, maxPos: 1e9 };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--agent') a.agent = argv[++i];
        else if (k === '--games') a.games = +argv[++i];
        else if (k === '--seed-base') a.seedBase = +argv[++i];
        else if (k === '--stride') a.stride = +argv[++i];
        else if (k === '--max-pos') a.maxPos = +argv[++i];
        else if (k === '--out') a.out = argv[++i];
        else { console.error('unknown option ' + k); process.exit(1); }
    }
    return a;
}

function main() {
    const a = parseArgs(process.argv);
    const chunks = [];
    let nPos = 0, nMovesTotal = 0, scoreSum = 0, done = 0;
    for (let s = 0; s < a.games && nPos < a.maxPos; s++) {
        const seed = a.seedBase + s;
        const agent = createAgent(a.agent, { seed });
        const g = new Collapse.Game(seed);
        let ply = 0;
        while (!g.gameOver && ply < 20000) {
            const moves = g.legalMoves();
            if (!moves.length) break;
            if (moves.length > 1 && ply % a.stride === 0 && nPos < a.maxPos) {
                const buf = Buffer.allocUnsafe(1 + moves.length * 27);
                buf[0] = moves.length;
                let o = 1;
                for (const m of moves) {
                    const after = g.preview(m[0], m[1], Collapse.FILL_NONE);
                    buf.writeUInt16LE(after.score - g.score, o); o += 2;
                    for (let k = 0; k < 25; k++) buf[o + k] = after.cells[k];
                    o += 25;
                }
                chunks.push(buf);
                nPos++; nMovesTotal += moves.length;
            }
            const mv = agent.chooseMove(g);
            if (!mv) break;
            g.apply(mv[0], mv[1]);
            ply++;
        }
        scoreSum += g.score; done++;
        if (done % 25 === 0) process.stderr.write(`  ${done} games, ${nPos} positions, mean score ${(scoreSum / done).toFixed(0)}\n`);
    }
    const head = Buffer.allocUnsafe(8);
    head.writeUInt32LE(0x50524f43, 0); head.writeUInt32LE(nPos, 4);
    fs.writeFileSync(a.out, Buffer.concat([head, ...chunks]));
    console.log(`${nPos} positions, ${(nMovesTotal / nPos).toFixed(2)} moves each, ${done} games, mean score ${(scoreSum / done).toFixed(0)} -> ${a.out}`);
}

main();
