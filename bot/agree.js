#!/usr/bin/env node
// ============================================================================
// Does a candidate value function make the same moves as a reference one?
//
//   node bot/agree.js --corpus c.bin --ref bot/weights/dom39c.bin --cand small.bin
//
// Over every decision in a corpus (see bot/corpus.js) both value functions pick
// argmax_m (gain_m + V(afterstate_m)). Three numbers come out:
//
//   agree    fraction of positions where the candidate picks the reference move
//   regret   mean shortfall of the candidate's move, measured by the REFERENCE
//            value function -- the size of the mistakes, not just their count
//   corr     correlation of the two value functions across the corpus, after
//            removing each position's own mean (a constant per position cannot
//            change any decision, so the raw correlation flatters everything)
//
// `agree` alone is misleading in both directions: many disagreements are ties
// worth nothing, and one catastrophic swap counts the same as one harmless one.
// `regret` in points-of-V is the number that tracks playing strength.
// ============================================================================

const fs = require('fs');

function loadCorpus(file) {
    const b = fs.readFileSync(file);
    if (b.readUInt32LE(0) !== 0x50524f43) throw new Error('not a corpus file');
    const nPos = b.readUInt32LE(4);
    const pos = [];
    let o = 8;
    for (let p = 0; p < nPos; p++) {
        const n = b[o++];
        const gains = new Float64Array(n);
        const boards = [];
        for (let m = 0; m < n; m++) {
            gains[m] = b.readUInt16LE(o); o += 2;
            boards.push(b.subarray(o, o + 25)); o += 25;
        }
        pos.push({ n, gains, boards });
    }
    return pos;
}

// Score every (position, move) pair under one value function.
function scoreAll(corpus, valueOf) {
    const out = [];
    for (const p of corpus) {
        const v = new Float64Array(p.n);
        for (let m = 0; m < p.n; m++) v[m] = p.gains[m] + valueOf(p.boards[m]);
        out.push(v);
    }
    return out;
}

function argmax(v) { let b = 0; for (let i = 1; i < v.length; i++) if (v[i] > v[b]) b = i; return b; }

// Compare a candidate's scores against the reference's. Both are arrays of
// Float64Array, one per position, aligned move for move.
function compare(refScores, candScores) {
    let agree = 0, top2 = 0, regret = 0, n = 0, nTie = 0;
    let sxy = 0, sxx = 0, syy = 0, cnt = 0;
    for (let p = 0; p < refScores.length; p++) {
        const r = refScores[p], c = candScores[p];
        const rb = argmax(r), cb = argmax(c);
        if (rb === cb) agree++;
        else {
            // second-best under the reference
            let s = -Infinity;
            for (let i = 0; i < r.length; i++) if (i !== rb && r[i] > s) s = r[i];
            if (cb !== rb && r[cb] === s) top2++;
        }
        regret += r[rb] - r[cb];
        if (r[rb] - r[cb] < 1e-9) nTie++;
        n++;
        // centred correlation, per position
        let mr = 0, mc = 0;
        for (let i = 0; i < r.length; i++) { mr += r[i]; mc += c[i]; }
        mr /= r.length; mc /= c.length;
        for (let i = 0; i < r.length; i++) {
            const a = r[i] - mr, b = c[i] - mc;
            sxy += a * b; sxx += a * a; syy += b * b; cnt++;
        }
    }
    return {
        agree: agree / n,
        agreeOrTie: (agree + nTie - agree * 0) / n,     // includes exact-tie picks
        top2: (agree + top2) / n,
        regret: regret / n,
        corr: sxy / Math.sqrt(sxx * syy),
        n
    };
}

module.exports = { loadCorpus, scoreAll, compare, argmax };

if (require.main === module) {
    const NT = require('./ntuple.js');
    const a = { corpus: null, ref: 'bot/weights/dom39c.bin', cand: null };
    for (let i = 2; i < process.argv.length; i++) {
        const k = process.argv[i];
        if (k === '--corpus') a.corpus = process.argv[++i];
        else if (k === '--ref') a.ref = process.argv[++i];
        else if (k === '--cand') a.cand = process.argv[++i];
    }
    const corpus = loadCorpus(a.corpus);
    const ref = NT.load(a.ref);
    const refS = scoreAll(corpus, c => ref.value(c));
    const cand = NT.load(a.cand);
    const candS = scoreAll(corpus, c => cand.value(c));
    const r = compare(refS, candS);
    console.log(`positions ${r.n}  agree ${(100 * r.agree).toFixed(2)}%  top2 ${(100 * r.top2).toFixed(2)}%  regret ${r.regret.toFixed(2)}  corr ${r.corr.toFixed(5)}`);
}
