#!/usr/bin/env node
// Fast architecture invariants for the n-tuple network. This is intentionally a
// unit/smoke test; score claims require the multi-seed experiment in the doc.

const assert = require('assert');
const NT = require('./ntuple.js');

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

// --- mini5 virtual-cell features (indices 25..29) --------------------------
// GLOBAL = { ZEROES:25, FIVES:26, SIXES:27, FIVE_COMP:28, EXPOSED:29 }, each 0..6
// (five-components 0..3). idx = i*5 + j, i = column, j = row (0 = bottom).
const mini = new NT.Network(null, { set: 'mini5r', sym: true });

// A full board of 1s: no holes, fives, sixes, components or exposures.
const ones = new Uint8Array(25).fill(1);
assert.deepStrictEqual(Array.from(mini.prepare(ones).slice(25, 30)), [0, 0, 0, 0, 0]);

// A board with a 2x2 block of 5s (one component) + a lone 5 (second component),
// a center 6 (4 non-6 nbrs -> exposed), an edge 6 (3 non-6 nbrs -> exposed) and
// a corner 6 (only 2 nbrs -> never exposed). 5 fives -> FIVES bucket 2,
// 3 sixes -> SIXES bucket 1, components 2 (cap 3), exposed 2, no holes.
const rich = new Uint8Array(25).fill(1);
const put = (i, j, v) => rich[i * 5 + j] = v;
put(0, 0, 5); put(0, 1, 5); put(1, 0, 5); put(1, 1, 5); put(3, 3, 5);
put(2, 2, 6);   // center: exposed
put(2, 4, 6);   // top edge: exposed
put(4, 4, 6);   // corner: not exposed
assert.deepStrictEqual(Array.from(mini.prepare(rich).slice(25, 30)), [0, 2, 1, 2, 2]);

// Features are mirror-invariant, and a sym net with any weights is too.
for (let k = 0; k < mini.w.length; k++) mini.w[k] = ((k * 37) % 101 - 50) / 17;
for (let n = 0; n < 40; n++) {
    const c = randomBoard();
    const fa = Array.from(mini.prepare(c).slice(25, 30));
    const fb = Array.from(mini.prepare(mirror(c)).slice(25, 30));
    assert.deepStrictEqual(fa, fb, 'global features are mirror-invariant');
    assert(Math.abs(mini.value(c) - mini.value(mirror(c))) < 1e-5, 'sym value is mirror-invariant');
}

// --- feature-aware codec roundtrip on a global (mini5r) net ----------------
const roundtrip = NT.decode(NT.encode(mini));
for (let n = 0; n < 10; n++) {
    const c = randomBoard();
    assert(Math.abs(roundtrip.value(c) - mini.value(c)) < 1e-5, 'codec preserves the feature-aware value');
}

console.log('n-tuple architecture invariants: ok');

if (process.argv.includes('--timing')) {
    const names = ['baser', 'mini5rc', 'mini5_all7grc'];
    const boards = Array.from({ length: 4096 }, (_, n) =>
        Uint8Array.from({ length: 25 }, (__, k) => 1 + ((n * 17 + k * 11 + (n >> 3)) % 6)));
    const nets = names.map(name => {
        const net = new NT.Network(undefined, { set: name, sym: true, selfOnce: true });
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
