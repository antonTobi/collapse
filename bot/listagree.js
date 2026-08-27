#!/usr/bin/env node
// ============================================================================
// Do two reviewers highlight the same mistakes?
//
//   node bot/listagree.js --a bot/weights/all7g-Rcq.bin --b bot/weights/all7g-Rcq.bin
//
// The criterion the spectator's review is actually judged by is not "is the
// number right" but "is this the same list". This runs both networks over whole
// held-out human games exactly as spectate.html does -- depth 2, full root
// width, the same MISTAKE_MIN floor -- and compares the top-N lists position by
// position. No rollouts, so it costs seconds rather than an hour.
// ============================================================================

const Collapse = require('./engine.js');
const Search = require('./search.js');
const NTuple = require('./ntuple.js');
const Replays = require('./replays.js');

const a = { a: 'bot/weights/all7g-Rcq.bin', b: 'bot/weights/all7g-Rcq.bin',
    depth: 2, cap: 64, depthA: 0, capA: 0, crn: true, games: 6, top: 5, min: 100,
    holdout: 10, spread: false };
for (let i = 2; i < process.argv.length; i++) {
    const k = process.argv[i];
    if (k === '--a') a.a = process.argv[++i];
    else if (k === '--b') a.b = process.argv[++i];
    else if (k === '--games') a.games = +process.argv[++i];
    else if (k === '--cap') a.cap = +process.argv[++i];
    else if (k === '--depth') a.depth = +process.argv[++i];
    // A and B default to the same settings; these override them for A only, so
    // one run can compare two *configurations* of one network as easily as two
    // networks.
    else if (k === '--depth-a') a.depthA = +process.argv[++i];
    else if (k === '--cap-a') a.capA = +process.argv[++i];
    else if (k === '--top') a.top = +process.argv[++i];
    else if (k === '--min') a.min = +process.argv[++i];
    else if (k === '--spread') a.spread = true;
    else { console.error('unknown option ' + k); process.exit(1); }
}

function reviewer(file, depth, cap) {
    const net = NTuple.load(file);
    if (depth <= 1) {
        // Plain greedy: gain + V(afterstate), no search at all.
        return { scoreMoves(game) {
            return game.legalMoves().map(m => {
                const after = game.preview(m[0], m[1], Collapse.FILL_NONE);
                return { move: m, value: (after.score - game.score) + net.value(after.cells) };
            });
        } };
    }
    let sd = 20260824;
    const rng = () => { sd ^= sd << 13; sd >>>= 0; sd ^= sd >>> 17; sd ^= sd << 5; sd >>>= 0; return sd / 4294967296; };
    return Search.makeSearcher(net, { depth, cap, capDeep: cap, topk: 0, rootk: 0, rng, crn: a.crn });
}
const RA = reviewer(a.a, a.depthA || a.depth, a.capA || a.cap);
const RB = reviewer(a.b, a.depth, a.cap);

// Loss of the played move under one reviewer, at every position of a game.
function losses(rec, R) {
    const out = [];
    Replays.walk(rec, ({ game, move, moveIndex }) => {
        const scored = R.scoreMoves(game);
        if (scored.length < 2) return;
        let best = scored[0];
        for (const s of scored) if (s.value > best.value) best = s;
        const played = scored.find(s => s.move[0] === move[0] && s.move[1] === move[1]);
        if (!played) return;
        out.push({ at: moveIndex, loss: best.value - played.value, best: best.move });
    }, 2);
    return out;
}
const listOf = rows => rows.slice().sort((x, y) => y.loss - x.loss)
    .filter(r => r.loss >= a.min).slice(0, a.top);

// Replays.load sorts best-first, so slicing the front gives the strongest human
// games -- which are the ones closest to the bot's own distribution and the
// easiest case for a compressed network. Spread across the whole held-out set
// instead; the review is used on ordinary games, whose mean score is 4 101.
const held = Replays.load({}).filter((_, k) => k % a.holdout === 0);
const stride = a.spread ? Math.max(1, Math.floor(held.length / a.games)) : 1;
const rows = [];
for (let k = 0; k < held.length && rows.length < a.games; k += stride) rows.push(held[k]);
const RECALL_K = [5, 10, 20, 40, 80];
const games = [];
let overlap = 0, nList = 0, sameBest = 0, nPos = 0, bothTop = 0, sameBestListed = 0, nListed = 0;
console.log('A: ' + a.a + ' depth ' + (a.depthA || a.depth) + ' cap ' + (a.capA || a.cap) +
    '    B: ' + a.b + ' depth ' + a.depth + ' cap ' + a.cap);
console.log('  ' + 'game'.padEnd(6) + 'moves'.padStart(7) + 'shared of top ' + a.top +
    '   ' + a.a.split('/').pop() + ' losses -> ' + a.b.split('/').pop());
for (const rec of rows) {
    const la = losses(rec, RA), lb = losses(rec, RB);
    games.push({ la, lb });
    const byAt = new Map(lb.map(r => [r.at, r]));
    for (const r of la) {
        const o = byAt.get(r.at);
        if (!o) continue;
        nPos++;
        if (r.best[0] === o.best[0] && r.best[1] === o.best[1]) sameBest++;
    }
    const A = listOf(la), B = listOf(lb);
    const setB = new Set(B.map(r => r.at));
    const shared = A.filter(r => setB.has(r.at)).length;
    overlap += shared; nList += Math.max(A.length, B.length); bothTop += Math.min(A.length, B.length);
    // The other half of the feature: the arrow showing where the bot would have
    // played instead. Only meaningful on the positions the UI actually lists.
    for (const r of A) {
        const o = byAt.get(r.at);
        if (!o) continue;
        nListed++;
        if (r.best[0] === o.best[0] && r.best[1] === o.best[1]) sameBestListed++;
    }
    console.log('  ' + String(rec.score).padEnd(6) + String(rec.numMoves).padStart(7) +
        ('  ' + shared + ' / ' + A.length).padStart(16) + '      ' +
        A.map(r => Math.round(r.loss)).join(',') + '  ->  ' +
        A.map(r => { const o = byAt.get(r.at); return o ? Math.round(o.loss) : '-'; }).join(','));
}
console.log('  shared entries ' + overlap + ' / ' + nList + '  (' + (100 * overlap / nList).toFixed(0) + '%)');
// For a two-stage reviewer: scan the whole game with A (cheap), shortlist its
// top K, and re-score only those with B (expensive). The shortlist is only
// worth anything if it *contains* what B would have found on its own, so this
// is the number that sizes K. Both rankings are deterministic, so unlike the
// rollout measurements in reveval.js there is no selection-on-noise here.
console.log('  recall of B top-' + a.top + ' inside A top-K:');
for (const K of RECALL_K) {
    let hit = 0, tot = 0;
    for (const g of games) {
        const short = new Set(g.la.slice().sort((x, y) => y.loss - x.loss).slice(0, K).map(r => r.at));
        for (const r of listOf(g.lb)) { tot++; if (short.has(r.at)) hit++; }
    }
    console.log('    K=' + String(K).padEnd(4) + hit + ' / ' + tot + '  (' + (100 * hit / tot).toFixed(1) + '%)');
}
console.log('  same preferred move, all positions   ' + sameBest + ' / ' + nPos + '  (' +
    (100 * sameBest / nPos).toFixed(1) + '%)');
console.log('  same preferred move, LISTED positions ' + sameBestListed + ' / ' + nListed + '  (' +
    (100 * sameBestListed / nListed).toFixed(1) + '%)');
