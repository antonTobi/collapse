#!/usr/bin/env node
// ============================================================================
// Compare how fast agents pick a move, on the same positions and one clock.
//
//   node bot/timing.js --agents "td:weights=bot/weights/dom21q.bin,td:weights=bot/weights/dom39q.bin"
//   node bot/timing.js --agents "..." --positions 300 --rounds 7
//
// `run.js` reports ms/move too, and its number is the wrong one to trust for a
// speed comparison, for three separate reasons:
//
//   1. It benchmarks agents *sequentially* -- every seed for agent 1, then
//      agent 2 -- so anything else happening on the machine lands on whichever
//      agent was running at the time and does not cancel out.
//   2. Each agent plays its *own* games. A stronger agent reaches longer games
//      with more 6s on the board, and those positions cost a different amount
//      to evaluate, so the comparison mixes speed with trajectory.
//   3. Timings from separate invocations are not comparable at all, which the
//      README says but which is easy to forget when the numbers are printed in
//      the same format.
//
// This fixes all three. One fixed set of positions, sampled once from real
// play, replayed by every agent; agents interleaved round-robin with the order
// rotated each round, so load drifting over the run is spread evenly; and the
// **minimum** across rounds reported alongside the median, because the fastest
// observed pass is the one least polluted by whatever else the machine was
// doing. Timing only needs positions, not whole games, so it takes seconds.
// ============================================================================

const Collapse = require('./engine.js');
const { createAgent } = require('./agents.js');

function parseArgs(argv) {
    const a = { agents: [], positions: 200, rounds: 5, games: 3, every: 7, seedBase: 900000, sub: '' };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i];
        // Same split as run.js: a comma starts a new agent only when what
        // follows is not `option=value` (so "depth=2,cap=16" stays together).
        if (k === '--agents') a.agents = argv[++i].split(/,(?![^:]*=)/).map(s => s.trim()).filter(Boolean);
        else if (k === '--positions') a.positions = parseInt(argv[++i], 10);
        else if (k === '--rounds') a.rounds = parseInt(argv[++i], 10);
        else if (k === '--games') a.games = parseInt(argv[++i], 10);
        else if (k === '--every') a.every = parseInt(argv[++i], 10);
        else if (k === '--seed-base') a.seedBase = parseInt(argv[++i], 10);
        else if (k === '--sub') a.sub = argv[++i];
        else { console.error('unknown option ' + k); process.exit(1); }
    }
    if (a.agents.length < 1) { console.error('--agents is required'); process.exit(1); }
    return a;
}

function startGame(sub, seed) {
    const g = new Collapse.Game(seed);
    if (!sub) return g;
    const cells = Array.from(g.cells);
    if (sub === 'grid54' || sub === 'grid44') for (let i = 0; i < Collapse.W; i++) cells[i * Collapse.H] = 6;
    if (sub === 'grid45' || sub === 'grid44') for (let j = 0; j < Collapse.H; j++) cells[(Collapse.W - 1) * Collapse.H + j] = 6;
    return Collapse.fromCells(cells, seed);
}

// Positions from real play by the first agent, so the mix of chain sizes, hole
// counts and 6-counts is the one the agents actually meet. Sampled once and
// shared, which is the whole point -- every agent is then timed on identical
// work rather than on its own trajectory.
function collectPositions(args) {
    const agent = createAgent(args.agents[0], { seed: 1 });
    const out = [];
    for (let g = 0; g < args.games && out.length < args.positions; g++) {
        const game = startGame(args.sub, args.seedBase + g);
        let step = 0;
        while (!game.gameOver && game.moves.length < 20000 && out.length < args.positions) {
            if (step % args.every === 0) out.push({ cells: game.cells.slice(), maxGen: game.maxGen });
            const m = agent.chooseMove(game);
            if (!m) break;
            game.apply(m[0], m[1]);
            step++;
        }
    }
    return out;
}

function timeOne(agent, positions, seedBase) {
    // fromCells rebuilds a Game around stored cells; maxGen is restored from
    // the board, which is exact (see the comment on Collapse.fromCells).
    const games = positions.map((p, i) => Collapse.fromCells(p.cells, seedBase + i));
    const t0 = process.hrtime.bigint();
    let sink = 0;
    for (const g of games) {
        const m = agent.chooseMove(g);
        if (m) sink += m[0];
    }
    const t1 = process.hrtime.bigint();
    if (sink === -1) console.log('');          // keep the calls from being optimised away
    return Number(t1 - t0) / 1e6;              // ms for the whole pass
}

function main() {
    const args = parseArgs(process.argv);
    const positions = collectPositions(args);
    const agents = args.agents.map(spec => ({ spec, agent: createAgent(spec, { seed: 1 }), times: [] }));

    // Warm-up, untimed: the first pass over a 280 MB weight table is mostly
    // page faults and would be charged to whichever agent went first.
    for (const a of agents) timeOne(a.agent, positions.slice(0, Math.min(40, positions.length)), 1);

    for (let r = 0; r < args.rounds; r++) {
        // Rotate the order every round so no agent is systematically first or
        // last, in case load drifts during the run.
        for (let k = 0; k < agents.length; k++) {
            const a = agents[(k + r) % agents.length];
            a.times.push(timeOne(a.agent, positions, 1));
        }
    }

    const n = positions.length;
    const med = xs => { const s = xs.slice().sort((p, q) => p - q); const m = s.length >> 1;
        return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
    const base = Math.min(...agents[0].times) / n;

    console.log(n + ' positions' + (args.sub ? ' [' + args.sub + ']' : '') +
        ', ' + args.rounds + ' rounds, same positions for every agent');
    console.log('  ' + 'agent'.padEnd(52) + 'ms/move'.padStart(10) + 'median'.padStart(10) + 'rel'.padStart(8));
    for (const a of agents) {
        const best = Math.min(...a.times) / n;
        console.log('  ' + a.spec.slice(0, 50).padEnd(52) +
            best.toFixed(4).padStart(10) + (med(a.times) / n).toFixed(4).padStart(10) +
            (best / base).toFixed(2).padStart(7) + 'x');
    }
    console.log('  (ms/move is the best of ' + args.rounds + ' passes -- least polluted by other load;' +
        ' a median far above it means the machine was busy)');
}

if (require.main === module) main();
module.exports = { collectPositions, timeOne };
