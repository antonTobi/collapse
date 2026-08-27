#!/usr/bin/env node
// ============================================================================
// Key-moment detection for the review graph, offline (kept in sync with the
// copy in review.js).
//
// Stage 1 -- ONSETS: the depth-2 eval curve is smoothed and its discrete second
//   derivative picks out sharp downward knees; each knee followed by a real fall
//   is an onset.  (findKeyMoments)
// Stage 2 -- REFINE:
//   * snap the onset forward to the first move where the bot disagrees with the
//     human; if the bot agrees for the whole DISAGREE_WIN, the drop was bad luck,
//     not a mistake -- drop it.
//   * play a short bot variation from that move (same RNG as the game); if even
//     the bot's own line falls DRAWDOWN_DROP below its start, the position was
//     lost regardless -- drop it.
//
//   node bot/keymoments.js --seed S --moves STR            detect (refined)
//   node bot/keymoments.js --seed S --moves STR --onsets   stage-1 onsets only
//   node bot/keymoments.js --seed S --moves STR --ddsweep  drawdown-threshold sweep
//   node bot/keymoments.js --survey 40                     random human games
// ============================================================================

const Collapse = require('./engine.js');
const Search = require('./search.js');
const NTuple = require('./ntuple.js');
const Replays = require('./replays.js');

const WEIGHTS = 'bot/weights/all7g-Rcq.bin';
let _d2 = null;
function d2searcher() {
    if (_d2) return _d2;
    const net = NTuple.load(WEIGHTS);
    let sd = 7; const srng = () => { sd ^= sd << 13; sd >>>= 0; sd ^= sd >>> 17; sd ^= sd << 5; sd >>>= 0; return sd / 4294967296; };
    _d2 = Search.makeSearcher(net, { depth: 2, cap: 16, capDeep: 16, topk: 2, rootk: 6, rng: srng, crn: true });
    return _d2;
}

// The bot's depth-2 estimate of the final score AND its chosen move (argmax).
function bestOf(game) {
    if (game.gameOver) return { val: game.score, move: null };
    const s = d2searcher().scoreMoves(game);
    if (!s.length) return { val: game.score, move: null };
    let bv = -Infinity, bm = null;
    for (const x of s) if (x.value > bv) { bv = x.value; bm = x.move; }
    return { val: game.score + bv, move: bm };
}

// Walk the game once, recording per position: the eval E, the bot's move, the
// human's move, and a clone (for replaying a bot variation with the game's rng).
function analyzeGame(seed, moves) {
    const game = new Collapse.Game(seed);
    const E = [], botMoves = [], humanMoves = [], snaps = [];
    for (let t = 0; t < moves.length; t++) {
        const b = bestOf(game);
        E.push(b.val); botMoves.push(b.move); snaps.push(game.clone());
        const [i, j] = Replays.decodeMove(moves[t]);
        humanMoves.push(Replays.canonical(game, i, j));
        if (game.apply(i, j) === 0) break;
    }
    const b = bestOf(game);
    E.push(b.val); botMoves.push(b.move); humanMoves.push(null); snaps.push(game.clone());
    return { E, botMoves, humanMoves, snaps };
}

// --- stage 1: onsets (keep in sync with review.js) --------------------------

function smooth(v, r) {
    const o = new Array(v.length);
    for (let i = 0; i < v.length; i++) {
        let s = 0, c = 0;
        for (let k = Math.max(0, i - r); k <= Math.min(v.length - 1, i + r); k++) { s += v[k]; c++; }
        o[i] = s / c;
    }
    return o;
}

const D = {
    rs: 2, w: 6, curvMin: 300, dropMin: 500, dropWin: 25, gap: 12,
    onsetCap: 10, cap: 5, disagreeWin: 3, ddPlies: 10, ddDrop: 400
};

function findKeyMoments(series, opt) {
    const o = Object.assign({}, D, opt || {});
    const N = series.length;
    if (N < 2 * o.w + 1) return [];
    const S = smooth(series, o.rs);
    const d2 = new Array(N).fill(0);
    for (let n = o.w; n < N - o.w; n++) d2[n] = S[n + o.w] - 2 * S[n] + S[n - o.w];
    const hits = [];
    for (let n = o.w; n < N - o.w; n++) {
        if (d2[n] >= -o.curvMin) continue;
        let lm = true;
        for (let p = n - 2; p <= n + 2; p++) if (p >= 0 && p < N && d2[p] < d2[n]) lm = false;
        if (!lm) continue;
        let mn = S[n];
        for (let m = n; m <= Math.min(N - 1, n + o.dropWin); m++) if (S[m] < mn) mn = S[m];
        const drop = S[n] - mn;
        if (drop < o.dropMin) continue;
        let bn = n, bv = series[n];
        for (let m = Math.max(0, n - 1); m <= Math.min(N - 1, n + o.w); m++) if (series[m] > bv) { bv = series[m]; bn = m; }
        hits.push({ n: bn, d2: d2[n], drop });
    }
    hits.sort((a, b) => b.drop - a.drop);
    const kept = [];
    for (const h of hits) if (kept.every(x => Math.abs(x.n - h.n) >= o.gap)) kept.push(h);
    const capped = kept.slice(0, o.onsetCap);
    capped.sort((a, b) => a.n - b.n);
    return capped;
}

// --- stage 2: refine (keep in sync with review.js) --------------------------

const sameMove = (a, b) => !!a && !!b && a[0] === b[0] && a[1] === b[1];

// Snap an onset forward to the first move where the bot disagrees with the human
// within DISAGREE_WIN moves; null if the bot agreed the whole window.
function firstDisagreement(ctx, n, win) {
    const end = Math.min(n + win - 1, ctx.humanMoves.length - 1);
    for (let t = n; t <= end; t++) {
        if (ctx.botMoves[t] && ctx.humanMoves[t] && !sameMove(ctx.botMoves[t], ctx.humanMoves[t])) return t;
    }
    return null;
}

// How far the bot's OWN line falls below its starting eval over `plies` moves,
// played from position m with the game's rng.
function botLineDrawdown(ctx, m, plies) {
    const start = ctx.E[m];
    const game = ctx.snaps[m].clone();
    let worst = start;
    for (let k = 0; k < plies && !game.gameOver; k++) {
        const b = bestOf(game);
        if (b.val < worst) worst = b.val;
        if (!b.move) break;
        game.apply(b.move[0], b.move[1]);
    }
    return start - worst;
}

function refineKeyMoments(onsets, ctx, opt) {
    const o = Object.assign({}, D, opt || {});
    const out = [];
    for (const on of onsets) {
        const m = firstDisagreement(ctx, on.n, o.disagreeWin);
        if (m === null) continue;                                  // bot agreed -> bad luck
        const dd = botLineDrawdown(ctx, m, o.ddPlies);
        if (dd >= o.ddDrop) continue;                              // bot also craters -> lost anyway
        out.push({ n: m, drop: on.drop, dd });
    }
    out.sort((a, b) => b.drop - a.drop);
    const kept = [];
    for (const h of out) if (kept.every(x => Math.abs(x.n - h.n) >= o.gap)) kept.push(h);
    const capped = kept.slice(0, o.cap);
    capped.sort((a, b) => a.n - b.n);
    return capped;
}

function keyMomentsFull(ctx, opt) {
    return refineKeyMoments(findKeyMoments(ctx.E, opt), ctx, opt);
}

// --- CLI --------------------------------------------------------------------

function parseArgs(argv) {
    const a = { seed: null, moves: null, onsets: false, ddsweep: false, survey: 0, holdout: 10, opt: {} };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--seed') a.seed = Number(argv[++i]);
        else if (k === '--moves') a.moves = argv[++i];
        else if (k === '--onsets') a.onsets = true;
        else if (k === '--ddsweep') a.ddsweep = true;
        else if (k === '--survey') a.survey = parseInt(argv[++i], 10);
        else if (k === '--holdout') a.holdout = parseInt(argv[++i], 10);
        else if (k === '--curv') a.opt.curvMin = Number(argv[++i]);
        else if (k === '--drop') a.opt.dropMin = Number(argv[++i]);
        else if (k === '--dd') a.opt.ddDrop = Number(argv[++i]);
    }
    return a;
}

function main() {
    const args = parseArgs(process.argv);

    if (args.survey) {
        const rows = Replays.load({});
        const held = rows.filter((_, k) => k % args.holdout === 0);
        const pick = [];
        for (let i = 0; i < args.survey; i++) pick.push(held[Math.floor(i * (held.length - 1) / (args.survey - 1))]);
        console.log('score  moves  onset  final   removed(dis/dd)   moments');
        const finals = [], removedDis = [], removedDd = [];
        for (const rec of pick) {
            const ctx = analyzeGame(rec.seed, rec.moves);
            const onsets = findKeyMoments(ctx.E, args.opt);
            let nDis = 0, nDd = 0;
            for (const on of onsets) {
                const m = firstDisagreement(ctx, on.n, D.disagreeWin);
                if (m === null) { nDis++; continue; }
                if (botLineDrawdown(ctx, m, D.ddPlies) >= (args.opt.ddDrop || D.ddDrop)) nDd++;
            }
            const km = refineKeyMoments(onsets, ctx, args.opt);
            finals.push(km.length); removedDis.push(nDis); removedDd.push(nDd);
            console.log(String(rec.score).padStart(5) + '  ' + String(rec.numMoves).padStart(5) + '  ' +
                String(onsets.length).padStart(5) + '  ' + String(km.length).padStart(5) + '     ' +
                (nDis + '/' + nDd).padStart(8) + '     ' + km.map(k => k.n).join(' '));
        }
        const sum = a => a.reduce((x, y) => x + y, 0);
        console.log('\nmean onsets ' + (sum(finals.map((_, i) => finals[i] + removedDis[i] + removedDd[i])) / finals.length).toFixed(1) +
            '   mean final ' + (sum(finals) / finals.length).toFixed(1) +
            '   removed by disagree ' + sum(removedDis) + ', by drawdown ' + sum(removedDd) +
            '   finals with 0: ' + finals.filter(c => c === 0).length + '/' + finals.length);
        return;
    }

    if (!args.seed || !args.moves) { console.error('need --seed and --moves (or --survey N)'); process.exit(1); }
    const ctx = analyzeGame(args.seed, args.moves);
    const onsets = findKeyMoments(ctx.E, args.opt);
    console.log('N=' + ctx.E.length + '   onsets: ' + onsets.map(o => o.n + '(' + Math.round(o.drop) + ')').join(' '));

    if (args.onsets) return;

    if (args.ddsweep) {
        // Show, per onset, the disagreement move and the bot-line drawdown, then
        // how each threshold would prune.
        console.log('\nonset -> disagree move -> bot-line drawdown (over ' + D.ddPlies + ' plies):');
        for (const on of onsets) {
            const m = firstDisagreement(ctx, on.n, D.disagreeWin);
            if (m === null) { console.log('  onset ' + on.n + ': bot AGREES ' + D.disagreeWin + ' in a row -> dropped'); continue; }
            const dd = botLineDrawdown(ctx, m, D.ddPlies);
            console.log('  onset ' + on.n + ' -> move ' + m + '  drawdown ' + Math.round(dd));
        }
        console.log('\nsurvivors by drawdown threshold:');
        for (const thr of [300, 400, 500, 700]) {
            const km = refineKeyMoments(onsets, ctx, { ddDrop: thr });
            console.log('  ddDrop=' + thr + ': ' + km.map(k => k.n).join(' '));
        }
        return;
    }

    const km = refineKeyMoments(onsets, ctx, args.opt);
    console.log('refined key moments: ' + km.map(k => k.n + '(drop ' + Math.round(k.drop) + ', dd ' + Math.round(k.dd) + ')').join('  '));
}

if (require.main === module) main();
module.exports = { analyzeGame, findKeyMoments, refineKeyMoments, firstDisagreement, botLineDrawdown, keyMomentsFull, smooth, D };
