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
// Feed the result to ptrain with --resume. Named sets can use --freeze-prefix;
// manifest-grown/custom sets use --freeze-first N (printed by this script) to
// protect the known-strong evaluator while the new features learn.
// ============================================================================

const fs = require('fs');
const NTuple = require('./ntuple.js');

function parseArgs(argv) {
    const a = { in: null, set: null, appendTuples: null, initResidual: false, out: null };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--in') a.in = argv[++i];
        else if (k === '--set') a.set = argv[++i];
        else if (k === '--append-tuples') a.appendTuples = argv[++i];
        else if (k === '--init-residual') a.initResidual = true;
        else if (k === '--out') a.out = argv[++i];
        else { console.error('unknown option ' + k); process.exit(1); }
    }
    if (!a.in || (!a.set && !a.appendTuples) || (a.set && a.appendTuples) || !a.out) {
        console.error('usage: grow.js --in <net.bin> (--set <bigger-set> | ' +
            '--append-tuples <manifest.json> [--init-residual]) --out <net.bin>');
        process.exit(1);
    }
    if (a.initResidual && !a.appendTuples) {
        console.error('--init-residual only applies with --append-tuples');
        process.exit(1);
    }
    return a;
}

function unpack(t) {
    const out = [];
    for (let k = 0; k < t.n; k++) {
        const tuple = [];
        for (let c = 0; c < t.len[k]; c++) tuple.push(t.cells[t.off[k] + c]);
        out.push(tuple);
    }
    return out;
}

function manifestGrowth(old, file, initResidual) {
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    const entries = manifest.selected || [];
    if (!entries.length) throw new Error('tuple manifest contains no selected tuples');
    if (!!manifest.sym !== old.sym || (!!manifest.selfOnce) !== old.selfOnce)
        throw new Error('manifest symmetry/selfOnce convention does not match the source network');
    if (manifest.baseTupleCount != null && manifest.baseTupleCount !== old.t.n)
        throw new Error('manifest was screened against ' + manifest.baseTupleCount +
            ' base tuples, but the source network has ' + old.t.n);
    const existing = new Set(unpack(old.t).map(t => t.slice().sort((a, b) => a - b).join(',')));
    const appended = entries.map((entry, i) => {
        const tuple = entry.tuple || entry;
        if (!Array.isArray(tuple) || tuple.length === 0)
            throw new Error('manifest entry ' + i + ' has no tuple');
        const key = tuple.slice().sort((a, b) => a - b).join(',');
        if (existing.has(key)) throw new Error('manifest entry ' + i + ' duplicates an existing tuple');
        existing.add(key);
        return tuple;
    });
    const tuples = unpack(old.t).concat(appended);
    const name = manifest.name || (old.setName + '+discover' + appended.length);
    const grown = new NTuple.Network(undefined, {
        set: name, tuples, baseTupleCount: old.t.n,
        sym: old.sym, selfOnce: old.selfOnce
    });
    grown.w.set(old.w);

    for (let i = 0; initResidual && i < entries.length; i++) {
        const init = entries[i].weights || entries[i].initialWeights;
        if (!init) continue;
        const k = old.t.n + i;
        const from = grown.t.wbase[k];
        const need = Math.pow(7, grown.t.len[k]);
        if (init.length !== need)
            throw new Error('manifest tuple ' + i + ' has ' + init.length +
                ' initial weights; expected ' + need);
        grown.w.set(init, from);
    }
    return { grown, label: name, appended: appended.length };
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
    const small = old.t;
    if (old.q16) {
        console.error('grow.js needs a float32 training network, not a quantised deployment file');
        process.exit(1);
    }

    if (args.appendTuples) {
        let result;
        try { result = manifestGrowth(old, args.appendTuples, args.initResidual); }
        catch (e) { console.error(e.message); process.exit(1); }
        const grown = result.grown;
        NTuple.save(args.out, grown);
        console.log(`grew ${old.setName} (${small.n} tuples, ${old.w.length.toLocaleString()} w) ` +
            `-> ${result.label} (${grown.t.n} tuples, ${grown.w.length.toLocaleString()} w)`);
        console.log(`  appended ${result.appended} discovered tuples from ${args.appendTuples}`);
        console.log(`  appended tables start ${args.initResidual ? 'from the fitted residual weights' : 'at zero'}`);
        console.log(`  baseTupleCount=${small.n}; ${grown.w.length - old.w.length} appended weights`);
        console.log(`  saved ${args.out}`);
        console.log(`  next: node bot/ptrain.js --resume ${args.out} --freeze-first ${small.n} --episodes ...`);
        return;
    }

    const big = NTuple.tupleSet(args.set);

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
