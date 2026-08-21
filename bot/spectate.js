// ============================================================================
// Spectator — play a whole game out headlessly, then scrub through the replay.
//
// Picking a seed or an agent plays the entire game at full speed (a full game
// is a few hundred moves at well under a millisecond each, so this is a few
// tens of milliseconds) and records one frame per position. Everything after
// that is pure navigation: the slider, the arrow keys and the play button all
// just move an index, so stepping backwards costs the same as stepping
// forwards and nothing is ever recomputed.
//
// A frame holds the position BEFORE a move, together with the move the agent
// plays next from it. So the highlighted tile is always the agent's answer to
// what is currently on screen, and the last frame — the final position, with no
// move left — is the only one without a highlight.
//
// Uses the same engine.js / agents.js as the headless benchmark, so what you
// see here is exactly what run.js measures.
// ============================================================================

(function () {
    const { Game } = window.Collapse;
    const { createAgent, SPECS } = window.CollapseAgents;
    const NTuple = window.CollapseNTuple;

    const CELL = 80, INSET = 2;
    const MAX_MOVES = 20000;             // guard against a pathological agent
    const el = id => document.getElementById(id);
    const boardEl = el('board');

    let frames = [];                     // the whole replay
    let index = 0;                       // which frame is on screen
    let running = false, timer = null;
    let lastRendered = -1;               // to decide whether to animate the new tile

    // Agents built on the learned value function need their weight file, which
    // in the browser means fetching it. Cached per file, and guarded by a token
    // so that switching agents mid-load cannot install a stale replay.
    const networks = {};
    let loadToken = 0;

    async function networkFor(spec) {
        const entry = SPECS.find(s => s.spec === spec);
        if (!entry || !entry.weights) return null;
        if (!networks[entry.weights]) {
            const res = await fetch(entry.weights);
            if (!res.ok) throw new Error('HTTP ' + res.status);
            networks[entry.weights] = NTuple.decode(await res.arrayBuffer());
        }
        return networks[entry.weights];
    }

    // --- building the replay ------------------------------------------------

    // One frame per position, plus a final frame for the finished board.
    // `created` is where the move that PRODUCED this position put its new tile,
    // so stepping forwards can pop it; `move` is what comes next.
    function capture(game, move, values, created) {
        return {
            cells: game.cells.slice(),
            score: game.score,
            movesPlayed: game.moves.length,
            legal: game.countLegalMoves(),
            sixes: game.sixCount,
            splits: game.scoreSplits.slice(),
            last: game.moves.length ? game.moves[game.moves.length - 1] : '—',
            over: game.gameOver,
            move, values, created
        };
    }

    function buildReplay(agent, seed) {
        const game = new Game(seed);
        const out = [];
        let created = -1;
        for (;;) {
            // scoreMoves before chooseMove: the values are wanted for display
            // whether or not the checkbox is on right now, and for the greedy
            // agents this call is pure (it does not touch the agent's rng), so
            // the game played here is the same one run.js would play.
            const values = agent.scoreMoves ? agent.scoreMoves(game) : null;
            const move = game.gameOver ? null : agent.chooseMove(game);
            out.push(capture(game, move, values, created));
            if (!move || out.length > MAX_MOVES) break;
            game.apply(move[0], move[1]);
            created = game.lastCreated;
        }
        return out;
    }

    // --- rendering ----------------------------------------------------------

    function render(animate) {
        const f = frames[index];
        if (!f) return;
        const showValues = el('showValues').checked && f.values;
        const values = new Map();
        if (showValues) {
            for (const { move, value } of f.values) {
                values.set(move[0] * 5 + move[1], Number.isInteger(value) ? value : value.toFixed(1));
            }
        }

        boardEl.innerHTML = '';
        for (let i = 0; i < 5; i++) {
            for (let j = 0; j < 5; j++) {
                const n = f.cells[i * 5 + j];
                if (!n) continue;
                const tile = document.createElement('div');
                tile.className = 'tile';
                tile.style.left = (i * CELL + INSET) + 'px';
                tile.style.top = ((4 - j) * CELL + INSET) + 'px';
                tile.style.background = boxColors[n];
                if (n < 6) tile.textContent = n;
                if (f.move && f.move[0] === i && f.move[1] === j) tile.classList.add('clicked');
                if (animate && f.created === i * 5 + j) tile.classList.add('pop');
                if (values.has(i * 5 + j)) {
                    const v = document.createElement('span');
                    v.className = 'val';
                    v.textContent = values.get(i * 5 + j);
                    tile.appendChild(v);
                }
                boardEl.appendChild(tile);
            }
        }

        el('score').textContent = f.score.toLocaleString();
        el('movecount').textContent = f.movesPlayed;
        el('legalcount').textContent = f.legal;
        el('sixcount').textContent = f.sixes;
        el('lastmove').textContent = f.last;
        el('splits').textContent = f.splits.join(' · ');
        el('status').innerHTML = f.over ? '<span class="over">GAME OVER</span>' : '';
        el('scrub').value = index;
        el('frameLabel').textContent = index + ' / ' + (frames.length - 1);
        lastRendered = index;
    }

    // --- navigation ---------------------------------------------------------

    function go(to, animate) {
        const clamped = Math.max(0, Math.min(frames.length - 1, to));
        if (clamped === index && lastRendered === index) return false;
        const forwardOne = clamped === index + 1;
        index = clamped;
        render(animate && forwardOne);
        return true;
    }

    function delay() { return parseInt(el('delay').value, 10); }

    function tick() {
        if (index >= frames.length - 1) { stop(); return; }
        go(index + 1, true);
        timer = setTimeout(tick, delay());
    }

    function play() {
        if (!frames.length) return;
        if (index >= frames.length - 1) index = 0;   // replay from the top
        running = true;
        el('play').textContent = '⏸ Pause';
        tick();
    }

    function stop() {
        running = false;
        el('play').textContent = '▶ Play';
        clearTimeout(timer);
        timer = null;
    }

    // --- loading ------------------------------------------------------------

    async function reset() {
        stop();
        const seed = parseInt(el('seed').value, 10) || 1;
        const spec = el('agent').value;
        const token = ++loadToken;

        frames = [];
        index = 0;
        lastRendered = -1;
        boardEl.innerHTML = '';
        el('scrub').max = 0;
        el('frameLabel').textContent = '— / —';
        el('status').innerHTML = 'playing out…';
        // Yield once so that message actually paints before the synchronous
        // playthrough blocks the main thread.
        await new Promise(r => setTimeout(r, 0));

        let agent;
        try {
            const network = await networkFor(spec);
            if (token !== loadToken) return;
            agent = createAgent(spec, network ? { seed, network } : { seed });
        } catch (err) {
            if (token !== loadToken) return;
            el('status').innerHTML = '<span class="over">could not load weights</span>';
            el('splits').textContent = 'Learned agents fetch a .bin file, which needs the page ' +
                'served over http rather than opened as a file:// path. (' + err.message + ')';
            return;
        }

        const t0 = performance.now();
        const built = buildReplay(agent, seed);
        if (token !== loadToken) return;
        frames = built;
        const ms = performance.now() - t0;

        el('scrub').max = frames.length - 1;
        el('scrub').value = 0;
        render(false);
        const final = frames[frames.length - 1];
        el('status').innerHTML = 'played ' + final.movesPlayed + ' moves for ' +
            final.score.toLocaleString() + ' in ' + ms.toFixed(0) + ' ms';
    }

    // --- wiring -------------------------------------------------------------

    for (const { spec, label } of SPECS) {
        const opt = document.createElement('option');
        opt.value = spec;
        opt.textContent = label;
        el('agent').appendChild(opt);
    }
    el('agent').value = SPECS[0].spec;

    el('play').onclick = () => running ? stop() : play();
    el('step').onclick = () => { stop(); go(index + 1, true); };
    el('back').onclick = () => { stop(); go(index - 1, false); };
    el('first').onclick = () => { stop(); go(0, false); };
    el('last').onclick = () => { stop(); go(frames.length - 1, false); };
    el('reset').onclick = reset;
    el('agent').onchange = reset;
    el('seed').onchange = reset;
    el('dice').onclick = () => { el('seed').value = Math.floor(Math.random() * 1e9); reset(); };
    el('delay').oninput = () => { el('delayLabel').textContent = delay() + 'ms'; };
    el('showValues').onchange = () => { lastRendered = -1; render(false); };
    el('scrub').oninput = () => { stop(); go(parseInt(el('scrub').value, 10), false); };

    document.addEventListener('keydown', e => {
        // Let the seed box have its own keys back.
        if (e.target && e.target.tagName === 'INPUT' && e.target.type === 'number') return;
        if (e.code === 'Space') { e.preventDefault(); running ? stop() : play(); }
        if (e.code === 'ArrowRight') { e.preventDefault(); stop(); go(index + 1, true); }
        if (e.code === 'ArrowLeft') { e.preventDefault(); stop(); go(index - 1, false); }
        if (e.code === 'Home') { e.preventDefault(); stop(); go(0, false); }
        if (e.code === 'End') { e.preventDefault(); stop(); go(frames.length - 1, false); }
    });

    reset();
})();
