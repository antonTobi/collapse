// ============================================================================
// Human replay data: loading, filtering, and walking games move by move.
//
// `fetch-replays.js` writes one JSON record per finished game to
// bot/data/replays.jsonl. Everything that learns from human play (fit.js,
// pretrain.js, disagree.js, human.js) reads it through here, so the filtering
// rules and the move decoding live in exactly one place.
//
// Move encoding: the stored string is one char per move, ALPHABET[5 * j + i]
// (see engine.js), where i is the column and j the row counting from 0 at the
// bottom.
// ============================================================================

const fs = require('fs');
const path = require('path');
const Collapse = require('./engine.js');

const DEFAULT_FILE = path.join(__dirname, 'data', 'replays.jsonl');

// Load records, keeping only games that replay cleanly. `minScore` is the main
// quality knob: human play is a mixture of skill levels and of serious versus
// idle games, so a threshold buys move quality at the cost of sample size.
function load(options) {
    const opts = options || {};
    const file = opts.file || DEFAULT_FILE;
    const minScore = opts.minScore || 0;
    const maxScore = opts.maxScore || Infinity;
    let rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
    rows = rows.filter(r =>
        r.illegalMoves === 0 &&
        r.replayScore === r.score &&
        (opts.unfinished || r.gameOver) &&
        r.score >= minScore && r.score <= maxScore &&
        (!opts.user || r.displayName === opts.user));
    // Deterministic order so a --games cap always takes the same games. Best
    // first: if you are going to look at only some of the data, look at the
    // strongest play in it.
    rows.sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : 1));
    if (opts.games && rows.length > opts.games) rows = rows.slice(0, opts.games);
    return rows;
}

// Decode one stored move character to [i, j].
function decodeMove(ch) {
    const k = ch.charCodeAt(0) - 97;
    return [k % 5, Math.floor(k / 5)];
}

// The human clicked some cell of a vertical run of equal tiles; legalMoves()
// only ever returns the lowest cell of that run, so map the click onto it.
function canonical(game, i, j) {
    let cj = j;
    while (cj > 0 && game.at(i, cj - 1) === game.at(i, cj)) cj--;
    return [i, cj];
}

// Walk one game. Calls visit({ game, move, moveIndex, legalMoves, gained,
// scoreBefore, finalScore }) at every position BEFORE the move is applied,
// where `move` is the canonical human choice. Positions with fewer than
// `minLegal` legal moves are skipped (with minLegal = 2, forced moves carry no
// information about preferences).
function walk(record, visit, minLegal) {
    const need = minLegal === undefined ? 2 : minLegal;
    const game = new Collapse.Game(record.seed);
    const final = record.score;
    for (let t = 0; t < record.moves.length; t++) {
        const [i, j] = decodeMove(record.moves[t]);
        const moves = game.legalMoves();
        if (moves.length >= need) {
            const [ci, cj] = canonical(game, i, j);
            const pick = moves.findIndex(m => m[0] === ci && m[1] === cj);
            if (pick >= 0) {
                visit({ game, move: [ci, cj], pick, legalMoves: moves, moveIndex: t, scoreBefore: game.score, finalScore: final });
            }
        }
        if (game.apply(i, j) === 0) break;   // record is corrupt from here on
    }
    return game;
}

// Convenience: walk every record in `rows`.
function walkAll(rows, visit, minLegal) {
    for (const r of rows) walk(r, o => visit(o, r), minLegal);
}

function describe(rows) {
    const n = rows.length;
    const moves = rows.reduce((a, r) => a + r.numMoves, 0);
    const mean = rows.reduce((a, r) => a + r.score, 0) / Math.max(1, n);
    return `${n} games, ${moves} moves, mean score ${mean.toFixed(0)}`;
}

module.exports = { load, walk, walkAll, decodeMove, canonical, describe, DEFAULT_FILE };
