#!/usr/bin/env node
// Dump Node ground truth for the Python parity checks (py/verify_parity.py,
// py/verify_fast.py). Run from the repo root after any change to the tuple set
// or the seed net:
//
//   node py/dump_testvec.js
//
// Writes py/_testvec.json (afterstate boards + seed-net values) and
// py/_selfplay_ref.json (greedy self-play score+moves for seeds 1..10).
const nt = require('../bot/ntuple.js');
const C = require('../bot/engine.js');
const S = require('../bot/search.js');
const fs = require('fs');
const path = require('path');

const NET = path.join(__dirname, '../bot/weights/all7h-seed.bin');
const net = nt.load(NET);

// 1. varied afterstates + values
const boards = [], vals = [];
let seed = 1;
while (boards.length < 300) {
    const g = new C.Game(seed++);
    for (let step = 0; step < 200 && boards.length < 300; step++) {
        const mv = g.legalMoves();
        if (!mv.length) break;
        const m = mv[(step * 7 + 3) % mv.length];
        const a = g.preview(m[0], m[1], C.FILL_NONE);
        boards.push(Array.from(a.cells));
        vals.push(net.value(a.cells));
        g.apply(mv[0][0], mv[0][1]);
    }
}
fs.writeFileSync(path.join(__dirname, '_testvec.json'),
    JSON.stringify({ meta: net.meta, wlen: net.w.length, boards, vals }));

// 2. greedy self-play reference
const exp = S.makeExpander();
const res = [];
for (let s = 1; s <= 10; s++) {
    const g = new C.Game(s);
    while (!g.gameOver) {
        const nm = exp.expand(g.cells, g.maxGen);
        if (nm === 0) break;
        let bs = -1, bv = -Infinity;
        for (let x = 0; x < nm; x++) {
            const v = exp.gain(x) + net.value(exp.board(x));
            if (v > bv) { bv = v; bs = x; }
        }
        const k = exp.cell(bs);
        g.apply((k / 5) | 0, k % 5);
    }
    res.push([s, g.score, g.moves.length]);
}
fs.writeFileSync(path.join(__dirname, '_selfplay_ref.json'), JSON.stringify(res));
console.log('wrote py/_testvec.json (%d boards) and py/_selfplay_ref.json', boards.length);
