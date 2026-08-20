// ============================================================================
// Evaluation harness for experiments: a persistent pool of worker processes
// that play (agent spec x seed list) batches. Used by tune.js and ad-hoc
// experiment scripts; run.js has its own lightweight forking.
// ============================================================================

const path = require('path');
const { fork } = require('child_process');
const Collapse = require('./engine.js');
const { createAgent } = require('./agents.js');

function play(spec, seeds) {
    return seeds.map(seed => {
        const agent = createAgent(spec, { seed });
        const r = Collapse.playGame(agent, seed);
        return r.score;
    });
}

if (process.env.COLLAPSE_HARNESS_WORKER) {
    process.on('message', msg => process.send({ id: msg.id, scores: play(msg.spec, msg.seeds) }));
}

class Pool {
    constructor(jobs) {
        this.jobs = jobs;
        this.workers = [];
        this.next = 0;
        this.pending = new Map();
        this.id = 0;
        for (let k = 0; k < jobs; k++) {
            const w = fork(path.join(__dirname, 'harness.js'), [], {
                env: Object.assign({}, process.env, { COLLAPSE_HARNESS_WORKER: '1' })
            });
            w.on('message', m => {
                const resolve = this.pending.get(m.id);
                this.pending.delete(m.id);
                resolve(m.scores);
            });
            this.workers.push(w);
        }
    }
    submit(spec, seeds) {
        const w = this.workers[this.next++ % this.jobs];
        const id = ++this.id;
        return new Promise(resolve => { this.pending.set(id, resolve); w.send({ id, spec, seeds }); });
    }
    // Split the seed list across all workers and reassemble in order.
    async evaluate(spec, seeds) {
        const chunks = Array.from({ length: this.jobs }, () => []);
        seeds.forEach((s, k) => chunks[k % this.jobs].push(s));
        const parts = await Promise.all(chunks.map(c => c.length ? this.submit(spec, c) : []));
        const out = new Array(seeds.length);
        chunks.forEach((chunk, w) => chunk.forEach((s, k) => { out[seeds.indexOf(s)] = parts[w][k]; }));
        return out;
    }
    close() { this.workers.forEach(w => w.kill()); }
}

function summarize(scores) {
    const n = scores.length;
    const mean = scores.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(scores.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
    return { mean, sd, se: sd / Math.sqrt(n), n };
}

function specOf(weights, extra) {
    const parts = Object.keys(weights).filter(k => weights[k]).map(k => `${k}=${+weights[k].toFixed(4)}`);
    return `linear:${parts.concat(extra || []).join(',')}`;
}

module.exports = { Pool, play, summarize, specOf };
