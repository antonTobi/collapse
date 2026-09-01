#!/usr/bin/env node
// ============================================================================
// Build a compact corpus for residual-guided tuple discovery.
//
// Every stored position is a REAL position on an agent trajectory. For the top
// shallow moves (plus the depth-2 oracle's choice) the record contains:
//   - the ordinary afterstate's prepared n-tuple input bytes,
//   - q = gain + V(afterstate),
//   - q* = gain + E_refill[max(gain' + V)].
//
// The discovery script uses only within-position differences q*-q, so a common
// Bellman-residual level cannot masquerade as decision-relevant signal.
// ============================================================================

const fs = require('fs');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const Collapse = require('./engine.js');
const NTuple = require('./ntuple.js');
const Search = require('./search.js');
const Freeze = require('./freeze.js');
const { createAgent } = require('./agents.js');

const MAGIC = 0x43545252; // "RRTC" little-endian; Residual Real-Trajectory Corpus
const VERSION = 1;

function unpackTuples(t) {
    const out = [];
    for (let k = 0; k < t.n; k++) {
        const tuple = [];
        for (let c = 0; c < t.len[k]; c++) tuple.push(t.cells[t.off[k] + c]);
        out.push(tuple);
    }
    return out;
}

function parseArgs(argv) {
    const a = {
        weights: 'bot/weights/anneal14-Rcq.bin', agent: null,
        games: 40, seedBase: 8100000, every: 5, top: 4, cap: 256,
        jobs: 8, maxPositions: 20000, freeze: true,
        out: 'bot/data/residual-corpus.bin'
    };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--weights') a.weights = argv[++i];
        else if (k === '--agent') a.agent = argv[++i];
        else if (k === '--games') a.games = parseInt(argv[++i], 10);
        else if (k === '--seed-base') a.seedBase = parseInt(argv[++i], 10);
        else if (k === '--every') a.every = parseInt(argv[++i], 10);
        else if (k === '--top') a.top = parseInt(argv[++i], 10);
        else if (k === '--cap') a.cap = parseInt(argv[++i], 10);
        else if (k === '--jobs') a.jobs = parseInt(argv[++i], 10);
        else if (k === '--max-positions') a.maxPositions = parseInt(argv[++i], 10);
        else if (k === '--freeze') a.freeze = true;
        else if (k === '--no-freeze') a.freeze = false;
        else if (k === '--out') a.out = argv[++i];
        else { console.error('unknown option ' + k); process.exit(1); }
    }
    if (a.games < 1 || a.jobs < 1 || a.every < 1 || a.top < 2 || a.cap < 1) {
        console.error('--games, --jobs, --every and --cap must be positive; --top must be >=2');
        process.exit(1);
    }
    if (a.maxPositions < 1) {
        console.error('--max-positions must be positive');
        process.exit(1);
    }
    a.weights = path.resolve(a.weights);
    if (!a.agent) a.agent = 'fx:weights=' + a.weights + ',depth=2,cap=16,rootk=6' +
        (a.freeze ? ',freeze=1,esc=6' : ',esc=6');
    return a;
}

function key(move) { return move[0] + ',' + move[1]; }

function encodePosition(seed, ply, candidates, featureCount) {
    const out = Buffer.allocUnsafe(12 + candidates.length * (1 + featureCount + 8));
    out.writeUInt32LE(seed >>> 0, 0);
    out.writeUInt32LE(ply >>> 0, 4);
    out.writeUInt32LE(candidates.length, 8);
    let at = 12;
    for (const c of candidates) {
        out[at++] = c.cell;
        Buffer.from(c.features.buffer, c.features.byteOffset, c.features.byteLength).copy(out, at);
        at += featureCount;
        out.writeFloatLE(c.shallow, at); at += 4;
        out.writeFloatLE(c.deep, at); at += 4;
    }
    return out;
}

function generate(args, seeds, positionLimit) {
    const net = NTuple.load(args.weights);
    const featureCount = net.featureInput ? net.featureInput.length : NTuple.BOARD_CELLS;
    const shallow = Search.makeSearcher(net, { depth: 1, crn: true });
    const oracle = Search.makeSearcher(net, {
        depth: 2, cap: args.cap, capDeep: args.cap,
        topk: 0, rootk: 0, crn: true
    });
    const expander = Search.makeExpander();
    const chunks = [];
    let positions = 0, candidates = 0, moves = 0, score = 0, games = 0;

    for (const seed of seeds) {
        if (positions >= positionLimit) break;
        const game = new Collapse.Game(seed);
        const trajectory = createAgent(args.agent, { seed });
        while (!game.gameOver && game.moves.length < 20000) {
            if (game.moves.length % args.every === 0 && positions < positionLimit) {
                const view = game.clone();
                if (args.freeze) view.cells = Freeze.freezeBoard(game.cells);
                const sh = shallow.scoreMoves(view);
                if (sh.length >= 2) {
                    const deep = oracle.scoreMoves(view);
                    const deepOf = new Map(deep.map(x => [key(x.move), x.value]));
                    const ranked = sh.slice().sort((a, b) => b.value - a.value);
                    const keep = ranked.slice(0, args.top);
                    let deepBest = deep[0];
                    for (const d of deep) if (d.value > deepBest.value) deepBest = d;
                    if (!keep.some(x => key(x.move) === key(deepBest.move))) {
                        const extra = sh.find(x => key(x.move) === key(deepBest.move));
                        if (extra) keep.push(extra);
                    }

                    expander.expand(view.cells, view.maxGen);
                    const slotOf = new Map();
                    for (let s = 0; s < expander.count; s++) {
                        const k = expander.cell(s);
                        slotOf.set(((k / 5) | 0) + ',' + (k % 5), s);
                    }
                    const rows = [];
                    for (const s of keep) {
                        const slot = slotOf.get(key(s.move));
                        if (slot == null) continue;
                        const prep = net.prepare(expander.board(slot));
                        rows.push({
                            cell: expander.cell(slot),
                            features: Uint8Array.from(prep),
                            shallow: s.value,
                            deep: deepOf.get(key(s.move))
                        });
                    }
                    if (rows.length >= 2 && rows.every(r => Number.isFinite(r.deep))) {
                        chunks.push(encodePosition(seed, game.moves.length, rows, featureCount));
                        positions++; candidates += rows.length;
                    }
                }
            }
            const move = trajectory.chooseMove(game);
            if (!move) break;
            game.apply(move[0], move[1]);
        }
        moves += game.moves.length; score += game.score;
        games++;
    }
    return { body: Buffer.concat(chunks), positions, candidates, moves, score, featureCount, games };
}

if (!isMainThread) {
    const result = generate(workerData.args, workerData.seeds, workerData.positionLimit);
    const body = Uint8Array.from(result.body);
    delete result.body;
    parentPort.postMessage({ ...result, body }, [body.buffer]);
} else {
    async function main() {
        const args = parseArgs(process.argv);
        const jobs = Math.min(args.jobs, args.games, args.maxPositions);
        const buckets = Array.from({ length: jobs }, () => []);
        for (let k = 0; k < args.games; k++) buckets[k % jobs].push(args.seedBase + k);
        const results = await Promise.all(buckets.map((seeds, index) => new Promise((resolve, reject) => {
            const positionLimit = Math.floor(args.maxPositions / jobs) +
                (index < args.maxPositions % jobs ? 1 : 0);
            const w = new Worker(__filename, { workerData: { args, seeds, positionLimit } });
            w.on('message', m => { process.stderr.write('  worker ' + (index + 1) + '/' + jobs +
                ': ' + m.positions + ' positions\n'); resolve(m); });
            w.on('error', reject);
        })));

        const featureCount = results[0].featureCount;
        if (!results.every(r => r.featureCount === featureCount))
            throw new Error('workers disagreed about feature count');
        const positions = results.reduce((s, r) => s + r.positions, 0);
        const candidates = results.reduce((s, r) => s + r.candidates, 0);
        if (positions === 0) throw new Error('no positions with at least two legal moves were collected');
        const games = results.reduce((s, r) => s + r.games, 0);
        const source = NTuple.load(args.weights);
        const metadata = {
            weights: args.weights, agent: args.agent, cap: args.cap, top: args.top,
            freeze: args.freeze, games, gamesRequested: args.games, seedBase: args.seedBase,
            every: args.every, featureCount, set: source.setName,
            tuples: unpackTuples(source.t), selfOnce: source.selfOnce
        };
        const json = Buffer.from(JSON.stringify(metadata));
        const pad = (4 - json.length % 4) % 4;
        const head = Buffer.alloc(32 + json.length + pad);
        head.writeUInt32LE(MAGIC, 0); head.writeUInt32LE(VERSION, 4);
        head.writeUInt32LE(featureCount, 8); head.writeUInt32LE(positions, 12);
        head.writeUInt32LE(candidates, 16); head.writeUInt32LE(args.top, 20);
        head.writeUInt32LE(json.length + pad, 24); head.writeUInt32LE(0, 28);
        json.copy(head, 32);
        fs.mkdirSync(path.dirname(args.out), { recursive: true });
        fs.writeFileSync(args.out, Buffer.concat([head, ...results.map(r => Buffer.from(r.body))]));
        const moves = results.reduce((s, r) => s + r.moves, 0);
        const score = results.reduce((s, r) => s + r.score, 0);
        console.log('wrote ' + args.out);
        console.log('  ' + positions.toLocaleString() + ' positions, ' + candidates.toLocaleString() +
            ' candidate afterstates, ' + featureCount + ' input cells');
        console.log('  trajectory: ' + games + ' games, mean ' + (score / games).toFixed(0) +
            ' score, ' + (moves / games).toFixed(0) + ' moves');
    }
    main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
}
