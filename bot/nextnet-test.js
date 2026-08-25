#!/usr/bin/env node
// Fast architecture invariants for NEXT_NETWORK.md. This is intentionally a
// unit/smoke test; score claims require the multi-seed experiment in the doc.

const assert = require('assert');
const NT = require('./ntuple.js');

function isPrefix(a, b) {
    if (a.n > b.n) return false;
    for (let k = 0; k < a.n; k++) {
        if (a.len[k] !== b.len[k]) return false;
        for (let c = 0; c < a.len[k]; c++)
            if (a.cells[a.off[k] + c] !== b.cells[b.off[k] + c]) return false;
    }
    return true;
}

function mirror(cells) {
    const out = new Uint8Array(25);
    for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) out[(4 - i) * 5 + j] = cells[i * 5 + j];
    return out;
}

let seed = 1234567;
function randomBoard() {
    const c = new Uint8Array(25);
    for (let k = 0; k < 25; k++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        c[k] = seed % 7;
    }
    return c;
}

for (const base of ['doms', 'domsrc']) for (const suffix of ['far', 'global'])
    assert(isPrefix(NT.tupleSet(base), NT.tupleSet(base + suffix)), base + ' prefix of ' + base + suffix);
assert(isPrefix(NT.tupleSet('doms'), NT.tupleSet('domshybrid')));
assert(isPrefix(NT.tupleSet('domsrc'), NT.tupleSet('domsrchybrid')));

// Known global bins on simple boards.
const global = new NT.Network(undefined, { set: 'domsrcglobal', sym: true, selfOnce: true });
const ones = new Uint8Array(25).fill(1);
let f = global.prepare(ones);
assert.deepStrictEqual(Array.from(f.slice(25)), [0, 0, 6, 6, 0, 0, 0, 0]);
const checker = Uint8Array.from({ length: 25 }, (_, k) => (((k / 5) | 0) + k % 5) % 2 + 1);
f = global.prepare(checker);
assert.deepStrictEqual(Array.from(f.slice(25)), [0, 0, 0, 0, 0, 6, 0, 0]);

// Exact growth in memory: arbitrary old weights plus zero new tables must be
// the same function on ordinary and mirrored boards.
const old = new NT.Network(undefined, { set: 'domsrc', sym: true, selfOnce: true });
for (let k = 0; k < old.w.length; k++) old.w[k] = ((k * 37) % 101 - 50) / 17;
const grown = new NT.Network(undefined, { set: 'domsrchybrid', sym: true, selfOnce: true });
grown.w.set(old.w);
for (let n = 0; n < 40; n++) {
    const c = randomBoard();
    assert(Math.abs(old.value(c) - grown.value(c)) < 1e-5);
    assert(Math.abs(grown.value(c) - grown.value(mirror(c))) < 1e-5);
}

// A frozen-prefix update must not touch a single inherited weight and must
// change at least one appended weight.
const prefix = old.t;
const before = grown.w.slice(0, prefix.size);
grown.update(randomBoard(), 100, prefix.n);
assert.deepStrictEqual(grown.w.slice(0, prefix.size), before);
let changed = false;
for (let k = prefix.size; k < grown.w.length; k++) if (grown.w[k] !== 0) { changed = true; break; }
assert(changed, 'tail update changed an appended weight');

// The feature-aware architecture survives the unchanged file codec.
const roundtrip = NT.decode(NT.encode(grown));
for (let n = 0; n < 10; n++) {
    const c = randomBoard();
    assert(Math.abs(roundtrip.value(c) - grown.value(c)) < 1e-5);
}

console.log('next-network architecture invariants: ok');

if (process.argv.includes('--timing')) {
    const names = ['domsrc', 'domsrcfarrc', 'domsrcglobalrc', 'domsrchybridrc'];
    const boards = Array.from({ length: 4096 }, (_, n) =>
        Uint8Array.from({ length: 25 }, (__, k) => 1 + ((n * 17 + k * 11 + (n >> 3)) % 6)));
    const nets = names.map(name => {
        const net = new NT.Network(undefined, { set: name, sym: true, selfOnce: true, stages: 3, five: true });
        net.w.fill(0.03125);
        return net;
    });
    let sink = 0;
    function pass(net, count) {
        const start = process.hrtime.bigint();
        for (let n = 0; n < count; n++) sink += net.value(boards[n & 4095]);
        return Number(process.hrtime.bigint() - start) / 1000 / count;
    }
    for (let r = 0; r < 3; r++) for (const net of nets) pass(net, 30000);
    const times = names.map(() => []);
    for (let r = 0; r < 8; r++) for (let k = 0; k < nets.length; k++) {
        const q = (k + r) % nets.length;
        times[q].push(pass(nets[q], 200000));
    }
    const median = xs => xs.slice().sort((a, b) => a - b)[xs.length >> 1];
    const base = median(times[0]);
    console.log('interleaved evaluator timing (median of 8 rounds):');
    names.forEach((name, k) => console.log('  ' + name.padEnd(18) + median(times[k]).toFixed(3) +
        ' us  ' + (median(times[k]) / base).toFixed(2) + 'x'));
    if (sink === -1) console.log('');
}
