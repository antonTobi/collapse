#!/usr/bin/env node
// ============================================================================
// Learning curve for the from-scratch mini5 run: greedy playing strength vs
// training episodes.
//
//   node bot/bench-curve.js --dir bot/weights/mini5-ckpts --seeds 50 --jobs 8 \
//                           --out bot/data/mini5-curve.csv
//
// For every numbered checkpoint (<base>-ep<N>.bin, as written by
// ptrain.js --checkpoint-every) it benchmarks the RAW network at greedy play
// (depth-1 `td:` agent) over a fixed common seed set, via bot/run.js, and
// records mean +- se. Checkpoints are not annealed: the high-alpha bias is
// roughly constant across them, so the *shape* of the progression is preserved
// (the point of the curve), while absolute strength is best read from a final
// annealed network.
//
// Runs after training; a few hundred games total, so it costs ~nothing next to
// the run it measures.
// ============================================================================

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function parseArgs(argv) {
    const a = { dir: null, seeds: 50, jobs: 8, seedBase: 1, out: null };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--dir') a.dir = argv[++i];
        else if (k === '--seeds') a.seeds = parseInt(argv[++i], 10);
        else if (k === '--jobs') a.jobs = parseInt(argv[++i], 10);
        else if (k === '--seed-base') a.seedBase = parseInt(argv[++i], 10);
        else if (k === '--out') a.out = argv[++i];
        else { console.error('unknown option ' + k); process.exit(1); }
    }
    if (!a.dir) { console.error('--dir <checkpoint dir> is required'); process.exit(1); }
    return a;
}

function stats(scores) {
    const n = scores.length;
    const mean = scores.reduce((x, y) => x + y, 0) / n;
    const variance = scores.reduce((x, y) => x + (y - mean) * (y - mean), 0) / Math.max(1, n - 1);
    const sd = Math.sqrt(variance);
    const sorted = scores.slice().sort((x, y) => x - y);
    return { mean, se: sd / Math.sqrt(n), median: sorted[n >> 1], min: sorted[0], max: sorted[n - 1] };
}

// Run bot/run.js --json for one weight file and return its greedy scores.
function benchmark(weights, seeds, jobs, seedBase) {
    const spec = 'td:weights=' + weights;
    const stdout = execFileSync(process.execPath, [
        path.join(__dirname, 'run.js'),
        '--agents', spec, '--seeds', String(seeds),
        '--seed-base', String(seedBase), '--jobs', String(jobs), '--json'
    ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    // Be robust to any incidental output around the JSON blob.
    const json = stdout.slice(stdout.indexOf('{'), stdout.lastIndexOf('}') + 1);
    return JSON.parse(json)[spec].scores;
}

function main() {
    const args = parseArgs(process.argv);
    const files = fs.readdirSync(args.dir)
        .map(name => ({ name, m: name.match(/-ep(\d+)\.bin$/) }))
        .filter(x => x.m)
        .map(x => ({ episodes: parseInt(x.m[1], 10), file: path.join(args.dir, x.name) }))
        .sort((a, b) => a.episodes - b.episodes);

    if (!files.length) { console.error('no <base>-ep<N>.bin checkpoints in ' + args.dir); process.exit(1); }

    console.log(files.length + ' checkpoints, ' + args.seeds + ' greedy games each (seeds ' +
        args.seedBase + '-' + (args.seedBase + args.seeds - 1) + ')\n');
    console.log('  ' + 'episodes'.padStart(10) + 'mean'.padStart(9) + '±se'.padStart(7) +
        'median'.padStart(9) + 'min'.padStart(8) + 'max'.padStart(8));
    console.log('  ' + '-'.repeat(51));

    const rows = [];
    for (const { episodes, file } of files) {
        const s = stats(benchmark(file, args.seeds, args.jobs, args.seedBase));
        rows.push({ episodes, ...s });
        console.log('  ' + String(episodes).padStart(10) + s.mean.toFixed(0).padStart(9) +
            s.se.toFixed(0).padStart(7) + String(s.median).padStart(9) +
            String(s.min).padStart(8) + String(s.max).padStart(8));
    }

    if (args.out) {
        const csv = 'episodes,mean,se,median,min,max\n' +
            rows.map(r => [r.episodes, r.mean.toFixed(1), r.se.toFixed(1), r.median, r.min, r.max].join(',')).join('\n') + '\n';
        fs.mkdirSync(path.dirname(args.out), { recursive: true });
        fs.writeFileSync(args.out, csv);
        console.log('\nwrote ' + args.out);
    }
}

if (require.main === module) main();
