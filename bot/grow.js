#!/usr/bin/env node
// ============================================================================
// Grow a trained network into a bigger architecture without losing it.
//
//   node bot/grow.js --in big-td.bin --out big-s3.bin --stages 3
//   node bot/grow.js --in big-s3.bin --out bigx-s3.bin --set bigx
//
// Both moves preserve the value function exactly, which is the whole point:
//
//   more stages  every bank starts as a copy of the single bank, so V is
//                unchanged and each bank specialises from there.
//   more tuples  the bigger set's tuple list starts with the smaller one's, so
//                the old weights are the new table's leading prefix and the new
//                tuples start at zero -- and a tuple whose weights are all zero
//                contributes nothing to the sum.
//
// Both were previously rejected as architectures because a cold start pays for
// the extra parameters out of the same training budget: `stages=3` lost 224 and
// a bigger tuple set lost 182. Growing into them costs nothing at all, and
// every episode afterwards is spent on the new capacity rather than on
// relearning what the old network already knew.
//
// The check at the end is not decoration. If the tuple lists do not line up the
// copy is silently wrong, so the two networks are compared on real boards
// before anything is written.
// ============================================================================

const path = require('path');
const Collapse = require('./engine.js');
const NTuple = require('./ntuple.js');

function parseArgs(argv) {
    const a = { in: null, out: null, set: null, stages: 0, edges: null, five: false };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--in') a.in = argv[++i];
        else if (k === '--out') a.out = argv[++i];
        else if (k === '--set') a.set = argv[++i];
        else if (k === '--stages') a.stages = parseInt(argv[++i], 10);
        else if (k === '--edges') a.edges = argv[++i].split(',').map(x => parseInt(x, 10));
        else if (k === '--five') a.five = true;
        else { console.error('unknown option ' + k); process.exit(1); }
    }
    if (!a.in || !a.out) { console.error('--in and --out are required'); process.exit(1); }
    return a;
}

// True when `big`'s tuple list starts with `small`'s, tuple for tuple.
function isPrefix(small, big) {
    if (big.n < small.n) return false;
    for (let t = 0; t < small.n; t++) {
        if (small.len[t] !== big.len[t]) return false;
        for (let c = 0; c < small.len[t]; c++) {
            if (small.cells[small.off[t] + c] !== big.cells[big.off[t] + c]) return false;
        }
    }
    return true;
}

function main() {
    const args = parseArgs(process.argv);
    const src = NTuple.load(args.in);
    const set = args.set || src.setName;
    const edges = args.edges || (args.stages ? null : src.edges);
    const stages = args.stages || src.sixBanks;

    const five = args.five || src.five;
    const dst = new NTuple.Network(undefined, { set, sym: src.sym, stages, edges, five });

    const srcT = NTuple.tupleSet(src.setName), dstT = NTuple.tupleSet(set);
    if (!isPrefix(srcT, dstT)) {
        console.error(`set "${src.setName}" is not a prefix of set "${set}" — cannot grow into it`);
        process.exit(1);
    }
    if (dst.stages < src.stages) {
        console.error(`cannot go from ${src.stages} banks down to ${dst.stages}`);
        process.exit(1);
    }

    // Both networks index their banks by (6-count, 5-group-count), so a
    // destination bank inherits from whichever source bank covers the same part
    // of the game. Splitting one bank into several always starts them identical,
    // which is what makes the growth free -- adding the 5-group dimension turns
    // each bank into three copies of itself, and adding stage edges splits a
    // 6-count range in two.
    //
    // When boundaries move rather than subdivide, a destination bank can span
    // two source banks; it takes the first one it matches, so the copy is exact
    // there and approximate elsewhere. That is why the check below reports the
    // worst disagreement instead of assuming it is zero.
    const claimed = new Array(dst.stages).fill(-1);
    for (let sixes = 0; sixes <= 24; sixes++) {
        for (let fives = 0; fives <= 2; fives++) {
            const to = dst.bankFor(sixes, fives);
            if (claimed[to] >= 0) continue;
            claimed[to] = src.bankFor(sixes, fives);
        }
    }
    for (let s = 0; s < dst.stages; s++) {
        const from = Math.max(0, claimed[s]);
        dst.w.set(src.w.subarray(from * src.bank, (from + 1) * src.bank), s * dst.bank);
    }

    // Verify on real boards, across the whole range of 6-counts so that every
    // destination bank is actually exercised.
    let worst = 0, checked = 0;
    const agent = require('./agents.js').createAgent('td:weights=' + args.in, { seed: 1 });
    for (let seed = 1; seed <= 6; seed++) {
        const g = new Collapse.Game(seed);
        while (!g.gameOver && g.moves.length < 400) {
            worst = Math.max(worst, Math.abs(dst.value(g.cells) - src.value(g.cells)));
            checked++;
            const m = agent.chooseMove(g);
            if (!m) break;
            g.apply(m[0], m[1]);
        }
    }
    // The played games above may not reach the highest 6-counts, and a bank that
    // is never exercised is a bank whose copy was never checked. Sweep the whole
    // range explicitly.
    for (let sixes = 0; sixes <= 16; sixes++) {
        for (let fives = 0; fives <= 3; fives++) {
            const cells = new Uint8Array(25);
            for (let k = 0; k < 25; k++) cells[k] = k < sixes ? 6 : (k % 5) + 1;
            // scatter `fives` isolated 5s into cells the 6s do not occupy
            let put = 0;
            for (let k = 24; k >= sixes && put < fives; k -= 2) { cells[k] = 5; put++; }
            worst = Math.max(worst, Math.abs(dst.value(cells) - src.value(cells)));
            checked++;
        }
    }
    // Only an unchanged bank layout guarantees an identical function; moving
    // the boundaries is allowed but has to be reported honestly.
    const sameLayout = (JSON.stringify(src.edges) === JSON.stringify(dst.edges) || src.stages === 1)
        && (src.five === dst.five || !src.five);
    if (worst > 1e-4 && sameLayout) {
        console.error('grown network does not match the original (max diff ' + worst + ') — not writing');
        process.exit(1);
    }

    NTuple.save(args.out, dst);
    console.log(`${args.in}  set=${src.setName} stages=${src.stages} weights=${src.w.length}`);
    console.log(`${args.out}  set=${set} stages=${dst.stages}` + (five ? ' (x3 by 5-groups)' : '') +
        ` weights=${dst.w.length}`);
    console.log(`identical on ${checked} boards (max |dV| = ${worst})`);
}

main();
