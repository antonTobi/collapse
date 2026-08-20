// ============================================================================
// Spectator — watch a single agent play one seed, live, at a chosen speed.
// Uses the same engine.js / agents.js as the headless benchmark, so what you
// see here is exactly what run.js measures.
// ============================================================================

(function () {
    const { Game } = window.Collapse;
    const { createAgent, SPECS } = window.CollapseAgents;

    const CELL = 80, INSET = 2;
    const el = id => document.getElementById(id);
    const boardEl = el('board');

    let game, agent, running = false, timer = null, pending = null;

    // --- rendering ----------------------------------------------------------

    function render(clicked, popIndex, values) {
        boardEl.innerHTML = '';
        for (let i = 0; i < 5; i++) {
            for (let j = 0; j < 5; j++) {
                const n = game.at(i, j);
                if (!n) continue;
                const tile = document.createElement('div');
                tile.className = 'tile';
                tile.style.left = (i * CELL + INSET) + 'px';
                tile.style.top = ((4 - j) * CELL + INSET) + 'px';
                tile.style.background = boxColors[n];
                if (n < 6) tile.textContent = n;
                if (clicked && clicked[0] === i && clicked[1] === j) tile.classList.add('clicked');
                if (popIndex === i * 5 + j) tile.classList.add('pop');
                if (values && values.has(i * 5 + j)) {
                    const v = document.createElement('span');
                    v.className = 'val';
                    v.textContent = values.get(i * 5 + j);
                    tile.appendChild(v);
                }
                boardEl.appendChild(tile);
            }
        }
        el('score').textContent = game.score.toLocaleString();
        el('movecount').textContent = game.moves.length;
        el('legalcount').textContent = game.countLegalMoves();
        el('sixcount').textContent = game.sixCount;
        el('lastmove').textContent = game.moves.length ? game.moves[game.moves.length - 1] : '—';
        el('splits').textContent = game.scoreSplits.join(' · ');
        el('status').innerHTML = game.gameOver ? '<span class="over">GAME OVER</span>' : '';
    }

    function moveValues() {
        if (!el('showValues').checked || !agent.scoreMoves) return null;
        const map = new Map();
        for (const { move, value } of agent.scoreMoves(game)) {
            map.set(move[0] * 5 + move[1], Number.isInteger(value) ? value : value.toFixed(1));
        }
        return map;
    }

    // --- game loop ----------------------------------------------------------

    function delay() { return parseInt(el('delay').value, 10); }

    function step() {
        if (game.gameOver) { stop(); return; }
        const move = agent.chooseMove(game);
        if (!move) { stop(); return; }

        const d = delay();
        const flash = Math.min(d * 0.5, 350);
        if (flash > 30) {
            render(move, null, moveValues());
            pending = setTimeout(() => { commit(move, d - flash); }, flash);
        } else {
            commit(move, d);
        }
    }

    function commit(move, rest) {
        pending = null;
        game.apply(move[0], move[1]);
        render(null, move[0] * 5 + move[1], moveValues());
        if (running && !game.gameOver) timer = setTimeout(step, Math.max(rest, 0));
        else if (game.gameOver) stop();
    }

    function play() { if (game.gameOver) return; running = true; el('play').textContent = '⏸ Pause'; step(); }

    function stop() {
        running = false;
        el('play').textContent = '▶ Play';
        clearTimeout(timer); clearTimeout(pending);
        timer = pending = null;
    }

    function reset() {
        stop();
        const seed = parseInt(el('seed').value, 10) || 1;
        game = new Game(seed);
        agent = createAgent(el('agent').value, { seed });
        render(null, null, moveValues());
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
    el('step').onclick = () => { stop(); step(); };
    el('reset').onclick = reset;
    el('agent').onchange = reset;
    el('seed').onchange = reset;
    el('dice').onclick = () => { el('seed').value = Math.floor(Math.random() * 1e9); reset(); };
    el('delay').oninput = () => { el('delayLabel').textContent = delay() + 'ms'; };
    el('showValues').onchange = () => render(null, null, moveValues());
    document.addEventListener('keydown', e => {
        if (e.code === 'Space') { e.preventDefault(); running ? stop() : play(); }
        if (e.code === 'ArrowRight') { e.preventDefault(); stop(); step(); }
    });

    reset();
})();
