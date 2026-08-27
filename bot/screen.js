#!/usr/bin/env node
// ============================================================================
// 500k/600k architecture-screening driver.
//
//   node bot/screen.js --episodes 600000 --anneal 100000 \
//        --starts bot/data/mut-starts.bin --seeds 300 --mut-positions 300 \
//        --jobs 8 --dir bot/weights/screen
//
// Trains each variant set from zeros to --episodes, anneals it a fixed
// --anneal episodes at a constant low alpha, and benchmarks the annealed nets
// against the `mini5` reference on the SAME regular + mutated starts (paired).
//
// The reference is the existing mini5-ep600000 checkpoint. Its main-run alpha
// schedule was not recorded, so it is NOT benchmarked raw: every net (reference
// included) gets the identical --anneal @ --anneal-alpha pass first, which
// drives them all to the same low-alpha stationary regime and washes out the
// schedule-history difference (the anneal.log shows the mean flattening within
// ~20k episodes at 0.002). So the reference costs one anneal, not a 600k
// retrain, and the comparison stays fair.
//
// Each stage is skipped if its output already exists, so the run is resumable.
// ============================================================================

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const NTuple = require('./ntuple.js');
const Collapse = require('./engine.js');
const Starts = require('./starts.js');
const { FILL_NONE } = Collapse;

// name       = label; set = trained set (null => use the reference checkpoint);
// refCkpt    = pre-trained 600k net for the reference (annealed, not retrained).
const VARIANTS = [
    { name: 'mini5', set: null, refCkpt: path.join(__dirname, 'weights/mini5-ckpts/mini5-ep600000.bin') },
    { name: 'mini5_norun5', set: 'mini5_norun5r' },
    { name: 'mini5_nofives', set: 'mini5_nofivesr' },
    { name: 'mini5_domadd', set: 'mini5_domaddr' },
    { name: 'mini5_legal', set: 'mini5_legalr' },
    { name: 'mini5_heights', set: 'mini5_heightsr' },
    // Fair-schedule baseline: full mini5 trained from zeros on the SAME schedule
    // as the arms (the checkpoint 'mini5' above had a stronger main-run schedule,
    // so it is only an absolute anchor, not the comparison point).
    { name: 'mini5_fresh', set: 'mini5r' },
    { name: 'mini5_heightlegal', set: 'mini5_heightlegalr' },
];

function parseArgs(argv) {
    const a = {
        episodes: 600000, anneal: 100000, alpha: 0.02, alphaEnd: 0.002, annealAlpha: 0.002,
        starts: path.join(__dirname, 'data/mut-starts.bin'), startFrac: 0.5,
        seeds: 300, seedBase: 7000000, mutPositions: 300, mutSeed: 12345,
        jobs: 8, report: 50000, dir: path.join(__dirname, 'weights/screen'),
        only: null, benchOnly: false, noBench: false,
    };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--episodes') a.episodes = parseInt(argv[++i], 10);
        else if (k === '--anneal') a.anneal = parseInt(argv[++i], 10);
        else if (k === '--alpha') a.alpha = parseFloat(argv[++i]);
        else if (k === '--alpha-end') a.alphaEnd = parseFloat(argv[++i]);
        else if (k === '--anneal-alpha') a.annealAlpha = parseFloat(argv[++i]);
        else if (k === '--starts') a.starts = argv[++i];
        else if (k === '--start-frac') a.startFrac = parseFloat(argv[++i]);
        else if (k === '--seeds') a.seeds = parseInt(argv[++i], 10);
        else if (k === '--seed-base') a.seedBase = parseInt(argv[++i], 10);
        else if (k === '--mut-positions') a.mutPositions = parseInt(argv[++i], 10);
        else if (k === '--mut-seed') a.mutSeed = parseInt(argv[++i], 10);
        else if (k === '--jobs') a.jobs = parseInt(argv[++i], 10);
        else if (k === '--report') a.report = parseInt(argv[++i], 10);
        else if (k === '--dir') a.dir = argv[++i];
        else if (k === '--only') a.only = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
        else if (k === '--bench-only') a.benchOnly = true;
        else if (k === '--no-bench') a.noBench = true;
        else { console.error('unknown option ' + k); process.exit(1); }
    }
    return a;
}

// --- greedy playout (shared with ablate.js) --------------------------------
function greedyEval(net, game) {
    let best = null, bq = -Infinity;
    for (const [i, j] of game.legalMoves()) {
        const after = game.preview(i, j, FILL_NONE);
        const q = (after.score - game.score) + net.value(after.cells);
        if (q > bq) { bq = q; best = [i, j]; }
    }
    return best;
}
function playout(net, cells, seed) {
    const g = Collapse.fromCells(Uint8Array.from(cells), seed);
    while (!g.gameOver && g.moves.length < 20000) {
        const m = greedyEval(net, g);
        if (!m) break;
        g.apply(m[0], m[1]);
    }
    return g.score;
}

if (process.env.COLLAPSE_SCREEN_WORKER) {
    process.on('message', ({ netFile, boards, seeds }) => {
        const net = NTuple.load(netFile);
        process.send({ scores: boards.map((arr, n) => playout(net, arr, seeds[n])) });
        process.exit(0);
    });
    return;
}

const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const seOf = a => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / (a.length - 1) / a.length); };
function xorshift(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; }; }

function evalNet(netFile, starts, jobs) {
    const { fork } = require('child_process');
    const chunks = Array.from({ length: jobs }, () => []);
    starts.forEach((s, k) => chunks[k % jobs].push({ ...s, idx: k }));
    const scores = new Array(starts.length);
    return Promise.all(chunks.map(chunk => new Promise((resolve, reject) => {
        if (!chunk.length) return resolve();
        const child = fork(__filename, [], { env: Object.assign({}, process.env, { COLLAPSE_SCREEN_WORKER: '1' }) });
        child.on('message', ({ scores: sc }) => { chunk.forEach((c, n) => { scores[c.idx] = sc[n]; }); resolve(); });
        child.on('error', reject);
        child.send({ netFile, boards: chunk.map(c => c.cells), seeds: chunk.map(c => c.seed) });
    }))).then(() => scores);
}

function buildStarts(args) {
    const reg = [];
    for (let i = 0; i < args.seeds; i++)
        reg.push({ cells: Array.from(new Collapse.Game(args.seedBase + i).cells), seed: args.seedBase + i, group: 'regular' });
    const mut = [];
    const pool = Starts.load(args.starts), poolN = pool.length / 25, rng = xorshift(args.mutSeed);
    for (let i = 0; i < args.mutPositions; i++) {
        const at = ((rng() * poolN) | 0) * 25;
        mut.push({ cells: Array.from(pool.subarray(at, at + 25)), seed: args.seedBase + 500000 + i, group: 'mutated' });
    }
    return { reg, mut };
}

// Spawn ptrain, streaming its progress into this process's output. Returns the
// wall-clock seconds it took, or -1 if the output already existed (skipped).
function ptrain(argsList, outFile, label) {
    if (fs.existsSync(outFile)) { console.log('  [cached] ' + label + ' -> ' + path.basename(outFile)); return -1; }
    console.log('\n=== ' + label + ' -> ' + path.basename(outFile) + ' ===');
    const t0 = Date.now();
    execFileSync(process.execPath, [path.join(__dirname, 'ptrain.js'), ...argsList], { stdio: 'inherit' });
    return (Date.now() - t0) / 1000;
}

function trainMain(v, args) {
    const out = path.join(args.dir, v.name + '-' + kEp(args.episodes) + '.bin');
    if (v.set === null) return v.refCkpt;  // reference: existing checkpoint, no main train
    ptrain([
        '--jobs', String(args.jobs), '--set', v.set, '--sym',
        '--episodes', String(args.episodes), '--alpha', String(args.alpha), '--alpha-end', String(args.alphaEnd),
        '--starts', args.starts, '--start-frac', String(args.startFrac), '--start-moves', '0',
        '--report', String(args.report), '--out', out,
    ], out, 'train ' + v.name + ' ' + kEp(args.episodes));
    return out;
}

const kEp = n => n % 1000 === 0 ? (n / 1000) + 'k' : String(n);
const annealPath = (v, args) => path.join(args.dir, v.name + '-' + kEp(args.episodes) + '-anneal' + kEp(args.anneal) + '.bin');

function annealNet(v, mainNet, args) {
    const out = annealPath(v, args);
    ptrain([
        '--jobs', String(args.jobs), '--resume', mainNet,
        '--episodes', String(args.anneal), '--alpha', String(args.annealAlpha), '--alpha-end', String(args.annealAlpha),
        '--starts', args.starts, '--start-frac', String(args.startFrac), '--start-moves', '0',
        '--report', String(args.report), '--out', out,
    ], out, 'anneal ' + v.name + ' ' + kEp(args.anneal) + ' @ ' + args.annealAlpha);
    return out;
}

async function main() {
    const args = parseArgs(process.argv);
    fs.mkdirSync(args.dir, { recursive: true });

    // 1) train + anneal the selected variants (resumable). --only picks a subset
    // so each arm can run as its own job; --bench-only skips straight to (2).
    const sel = args.only ? VARIANTS.filter(v => args.only.includes(v.name)) : VARIANTS;
    if (!args.benchOnly) {
        for (const v of sel) { const mainNet = trainMain(v, args); annealNet(v, mainNet, args); }
    }
    if (args.noBench) { console.log('\ntraining/anneal done (--no-bench); skipping benchmark.'); return; }

    // 2) benchmark every variant whose annealed net exists on disk.
    const avail = VARIANTS.filter(v => fs.existsSync(annealPath(v, args)));
    if (!avail.some(v => v.name === 'mini5')) { console.error('reference mini5 annealed net missing; cannot benchmark'); process.exit(1); }

    const { reg, mut } = buildStarts(args);
    const all = reg.concat(mut);
    const regIdx = all.map((s, i) => s.group === 'regular' ? i : -1).filter(i => i >= 0);
    const mutIdx = all.map((s, i) => s.group === 'mutated' ? i : -1).filter(i => i >= 0);

    console.log('\n\n================ screen results ================');
    console.log(reg.length + ' regular + ' + mut.length + ' mutated starts, greedy, annealed nets\n');

    const scores = {};
    for (const v of avail) scores[v.name] = await evalNet(annealPath(v, args), all, args.jobs);
    // Prefer the fair-schedule baseline as the comparison point; fall back to the
    // checkpoint mini5 when the fresh baseline has not been trained yet.
    const refName = avail.some(v => v.name === 'mini5_fresh') ? 'mini5_fresh' : 'mini5';
    const ref = scores[refName];
    const refReg = mean(regIdx.map(i => ref[i])), refMut = mean(mutIdx.map(i => ref[i]));

    const head = '  ' + 'variant'.padEnd(16) + 'tuples'.padStart(7) + 'weights'.padStart(11) +
        'regular'.padStart(10) + 'Δ vs ref'.padStart(14) + 'mutated'.padStart(10) + 'Δ vs ref'.padStart(14);
    console.log(head);
    console.log('  ' + '-'.repeat(head.length - 2));
    for (const v of avail) {
        const net = NTuple.load(annealPath(v, args));
        const sc = scores[v.name];
        const r = mean(regIdx.map(i => sc[i])), m = mean(mutIdx.map(i => sc[i]));
        let dReg = '', dMut = '';
        if (v.name !== refName) {
            const drr = regIdx.map(i => sc[i] - ref[i]), dmm = mutIdx.map(i => sc[i] - ref[i]);
            dReg = fmt(mean(drr), seOf(drr)); dMut = fmt(mean(dmm), seOf(dmm));
        }
        console.log('  ' + v.name.padEnd(16) + String(net.t.n).padStart(7) + net.w.length.toLocaleString().padStart(11) +
            r.toFixed(0).padStart(10) + dReg.padStart(14) + m.toFixed(0).padStart(10) + dMut.padStart(14));
    }
    console.log('\n  reference (' + refName + '): regular ' + refReg.toFixed(0) + '  mutated ' + refMut.toFixed(0));
    console.log('  Δ = variant - reference, paired over identical starts. +ve = the change helped.');
}

function fmt(m, se) { return (m >= 0 ? '+' : '') + m.toFixed(0) + ' ±' + se.toFixed(0); }

if (require.main === module) main();
