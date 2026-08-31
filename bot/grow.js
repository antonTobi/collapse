#!/usr/bin/env node
// ============================================================================
// Grow a trained network onto a larger tuple set by transplanting its weights.
//
//   node bot/grow.js --in bot/weights/all7g-3M-anneal300k.bin \
//                    --set mini5_all7hr --out bot/weights/all7h-seed.bin
//
// The larger set must have the input set as an exact PREFIX: every tuple of the
// old set appears first, in the same order, and the new tuples are appended
// after. When that holds the weight tables line up index-for-index over the
// prefix, so copying the old weights into the front of a fresh (zeroed) table
// for the new set reproduces the old evaluator exactly and leaves the appended
// tables at zero, ready to learn. This is the counterpart of reduce.js /
// compact.js: those shrink a trained net for deployment, this widens one for
// more training.
//
// Feed the result to ptrain with --resume; add --freeze-prefix <old-set> to
// train only the appended tables first (protecting the known-strong evaluator
// while the new features learn), or omit it to fine-tune everything.
// ============================================================================

const NTuple = require('./ntuple.js');

function parseArgs(argv) {
    const a = { in: null, set: null, out: null };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--in') a.in = argv[++i];
        else if (k === '--set') a.set = argv[++i];
        else if (k === '--out') a.out = argv[++i];
        else { console.error('unknown option ' + k); process.exit(1); }
    }
    if (!a.in || !a.set || !a.out) {
        console.error('usage: grow.js --in <net.bin> --set <bigger-set> --out <net.bin>');
        process.exit(1);
    }
    return a;
}

// The old set's packed tuples must match the big set's leading tuples exactly
// (same lengths, same cell indices in the same order).
function isPrefix(small, big) {
    if (small.n > big.n) return false;
    for (let t = 0; t < small.n; t++) {
        if (small.len[t] !== big.len[t]) return false;
        for (let c = 0; c < small.len[t]; c++)
            if (small.cells[small.off[t] + c] !== big.cells[big.off[t] + c]) return false;
    }
    return true;
}

function main() {
    const args = parseArgs(process.argv);
    const old = NTuple.load(args.in);
    const big = NTuple.tupleSet(args.set);
    const small = old.t;

    if (small.n >= big.n) {
        console.error(`set "${args.set}" (${big.n} tuples) is not larger than "${old.setName}" (${small.n})`);
        process.exit(1);
    }
    if (!isPrefix(small, big)) {
        console.error(`"${old.setName}" is not an exact prefix of "${args.set}"; ` +
            'the new set must append its tuples after every old one, in order.');
        process.exit(1);
    }

    // Fresh zeroed table on the big set, prefix filled from the old weights.
    const grown = new NTuple.Network(undefined, { set: args.set, sym: old.sym });
    if (grown.w.length < old.w.length) {
        console.error('internal: grown table is smaller than the source'); process.exit(1);
    }
    grown.w.set(old.w);   // prefix aligns index-for-index; the tail stays zero

    NTuple.save(args.out, grown);
    console.log(`grew ${old.setName} (${small.n} tuples, ${old.w.length.toLocaleString()} w) ` +
        `-> ${args.set} (${big.n} tuples, ${grown.w.length.toLocaleString()} w)`);
    console.log(`  transplanted ${old.w.length.toLocaleString()} weights, ` +
        `${(grown.w.length - old.w.length).toLocaleString()} new weights at zero`);
    console.log(`  saved ${args.out}`);
    console.log(`  next: node bot/ptrain.js --resume ${args.out} --sym ` +
        `[--freeze-prefix ${old.setName}] --episodes ...`);
}

main();
