#!/usr/bin/env node
// ============================================================================
// Download game replays from Firestore.
//
//   node bot/fetch-replays.js                          # everything -> bot/data/replays.jsonl
//   node bot/fetch-replays.js --limit 25 --out /tmp/sample.jsonl
//   node bot/fetch-replays.js --include-highscores     # also pull the leaderboard docs
//
// The `scores` collection is the full history: every finished game is written
// there with its seed and move string, which is all a replay needs. Reads are
// public (see firestore.rules), so this uses the REST API with the web API key
// and needs no credentials.
//
// Output is JSONL, one game per line, written incrementally so an interrupted
// run still leaves usable data.
// ============================================================================

const fs = require('fs');
const path = require('path');
const { Game } = require('./engine');

const PROJECT = 'collapse-700c3';
const API_KEY = 'AIzaSyAB8uHkJNm_8OtGGCO2f6g_3k2ehFsCzT0';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

// --- args ------------------------------------------------------------------

function parseArgs(argv) {
    const opts = {
        out: path.join(__dirname, 'data', 'replays.jsonl'),
        limit: Infinity,
        pageSize: 300,
        verify: true,
        includeHighscores: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--out') opts.out = argv[++i];
        else if (arg === '--limit') opts.limit = Number(argv[++i]);
        else if (arg === '--page-size') opts.pageSize = Number(argv[++i]);
        else if (arg === '--no-verify') opts.verify = false;
        else if (arg === '--include-highscores') opts.includeHighscores = true;
        else if (arg === '--help' || arg === '-h') { usage(); process.exit(0); }
        else { console.error(`unknown option: ${arg}`); usage(); process.exit(1); }
    }
    return opts;
}

function usage() {
    console.log(`usage: node bot/fetch-replays.js [options]

  --out PATH             output file (default bot/data/replays.jsonl)
  --limit N              stop after N replays (for sampling)
  --page-size N          documents per request, max 300 (default 300)
  --no-verify            skip replaying each game through the engine
  --include-highscores   also pull highscores/ and dailyhighscores/, deduped
                         against scores/ (safety net for games predating the
                         scores collection; normally adds nothing)`);
}

// --- REST plumbing ---------------------------------------------------------

async function get(url, attempt = 0) {
    try {
        const res = await fetch(url);
        if (res.ok) return res.json();
        // 429/5xx are worth retrying; anything else is a real error.
        if (res.status !== 429 && res.status < 500) {
            throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
        }
        throw new Error(`HTTP ${res.status}`);
    } catch (err) {
        if (attempt >= 5) throw err;
        const wait = 500 * 2 ** attempt;
        process.stderr.write(`  retrying in ${wait}ms (${err.message})\n`);
        await new Promise(r => setTimeout(r, wait));
        return get(url, attempt + 1);
    }
}

// Firestore wraps every field in a type tag; unwrap to plain JS.
function decodeValue(v) {
    if ('integerValue' in v) return Number(v.integerValue);
    if ('doubleValue' in v) return v.doubleValue;
    if ('stringValue' in v) return v.stringValue;
    if ('booleanValue' in v) return v.booleanValue;
    if ('timestampValue' in v) return v.timestampValue;
    if ('nullValue' in v) return null;
    if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeValue);
    if ('mapValue' in v) return decodeFields(v.mapValue.fields);
    return null;
}

function decodeFields(fields) {
    const out = {};
    for (const [k, v] of Object.entries(fields || {})) out[k] = decodeValue(v);
    return out;
}

// Walk a collection page by page. Yields {id, data, createTime} per document.
async function* listCollection(collectionPath, pageSize) {
    let pageToken = null;
    do {
        const params = new URLSearchParams({ pageSize: String(pageSize), key: API_KEY });
        if (pageToken) params.set('pageToken', pageToken);
        const body = await get(`${BASE}/${collectionPath}?${params}`);
        for (const doc of body.documents || []) {
            yield {
                id: doc.name.split('/').pop(),
                data: decodeFields(doc.fields),
                createTime: doc.createTime,
            };
        }
        pageToken = body.nextPageToken || null;
    } while (pageToken);
}

// --- replay verification ---------------------------------------------------

// Re-run the stored moves through the headless engine. This both checks the
// record is intact and derives the per-game facts that are cheap here and
// annoying to recompute later.
function replay(seed, moves) {
    const game = new Game(seed);
    let illegal = 0;
    for (const ch of moves || '') {
        const k = ch.charCodeAt(0) - 97;
        if (k < 0 || k > 24) { illegal++; continue; }
        if (game.apply(k % 5, Math.floor(k / 5)) === 0) illegal++;
    }
    return {
        replayScore: game.score,
        sixes: game.sixCount,
        splits: game.scoreSplits,
        gameOver: game.gameOver,
        illegalMoves: illegal,
    };
}

// --- main ------------------------------------------------------------------

async function main() {
    const opts = parseArgs(process.argv.slice(2));

    process.stderr.write('fetching display names...\n');
    const names = new Map();
    for await (const doc of listCollection('users', 300)) {
        if (doc.data.displayName) names.set(doc.id, doc.data.displayName);
    }
    process.stderr.write(`  ${names.size} users\n`);

    fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
    const out = fs.createWriteStream(opts.out);
    const write = line => new Promise(r => out.write(line, r));

    const seen = new Set();          // userId|seed|moves, for dedup across sources
    const stats = { written: 0, duplicates: 0, empty: 0, mismatched: 0 };

    async function emit(source, doc) {
        const d = doc.data;
        if (!d.moves || d.seed === undefined || d.seed === null) { stats.empty++; return; }
        const key = `${d.userId}|${d.seed}|${d.moves}`;
        if (seen.has(key)) { stats.duplicates++; return; }
        seen.add(key);

        const record = {
            id: doc.id,
            source,
            userId: d.userId ?? null,
            displayName: d.displayName ?? names.get(d.userId) ?? null,
            score: d.score ?? null,
            seed: d.seed,
            moves: d.moves,
            numMoves: d.moves.length,
            // `timestamp` is the client-written field; createTime is Firestore's
            // own and is always present, so keep both.
            timestamp: d.timestamp ?? null,
            createTime: doc.createTime,
        };
        if (opts.verify) {
            Object.assign(record, replay(d.seed, d.moves));
            if (record.replayScore !== record.score) stats.mismatched++;
        }
        await write(JSON.stringify(record) + '\n');
        stats.written++;
        if (stats.written % 500 === 0) process.stderr.write(`  ${stats.written} replays\n`);
    }

    process.stderr.write('fetching scores...\n');
    for await (const doc of listCollection('scores', opts.pageSize)) {
        await emit('scores', doc);
        if (stats.written >= opts.limit) break;
    }

    if (opts.includeHighscores && stats.written < opts.limit) {
        process.stderr.write('fetching highscores...\n');
        for await (const doc of listCollection('highscores', opts.pageSize)) {
            await emit('highscores', doc);
            if (stats.written >= opts.limit) break;
        }
        process.stderr.write('fetching dailyhighscores...\n');
        // dailyhighscores/{date}/scores/{userId} — one subcollection per day.
        for await (const day of listCollection('dailyhighscores', 300)) {
            for await (const doc of listCollection(`dailyhighscores/${day.id}/scores`, opts.pageSize)) {
                await emit(`dailyhighscores/${day.id}`, doc);
            }
            if (stats.written >= opts.limit) break;
        }
    }

    await new Promise(r => out.end(r));
    process.stderr.write(
        `\ndone: ${stats.written} replays -> ${opts.out}\n` +
        `  skipped ${stats.duplicates} duplicates, ${stats.empty} without seed/moves\n` +
        (opts.verify ? `  ${stats.mismatched} score mismatches on replay\n` : '')
    );
}

main().catch(err => { console.error(err); process.exit(1); });
