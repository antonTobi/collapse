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
    const { Game, fromCells, W, H } = window.Collapse;
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
    let previewMove = null;              // hovered legal move, if any
    let continuation = null;             // review bot branch from the current replay frame

    // Agents built on the learned value function need their weight file, which
    // in the browser means fetching it. Cached per file, and guarded by a token
    // so that switching agents mid-load cannot install a stale replay.
    const networks = {};
    let loadToken = 0;

    async function loadWeights(file) {
        if (!networks[file]) {
            const res = await fetch(file);
            if (!res.ok) throw new Error('HTTP ' + res.status);
            networks[file] = NTuple.decode(await res.arrayBuffer());
        }
        return networks[file];
    }

    async function networkFor(spec) {
        const entry = SPECS.find(s => s.spec === spec);
        if (!entry || !entry.weights) return null;
        return loadWeights(entry.weights);
    }

    // --- building the replay ------------------------------------------------

    // One frame per position, plus a final frame for the finished board.
    // `created` is where the move that PRODUCED this position put its new tile,
    // so stepping forwards can pop it; `move` is what comes next.
    function capture(game, move, values, created) {
        return {
            cells: game.cells.slice(),
            rngState: game.rngState,
            rngDraws: game.rngDraws,
            maxGen: game.maxGen,
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

    // A walled board: fill a row and/or a column with 6s and play the rest.
    // Nothing about the game changes -- a 6 is permanent and unplayable, so a
    // wall of them just makes the board smaller, and the networks read it with
    // no modification. Matches `run.js --sub` and `ptrain.js --sub`.
    function startFor(mode, seed) {
        if (!mode) return new Game(seed);
        const g = new Game(seed);
        const cells = Array.from(g.cells);
        if (mode === 'grid54' || mode === 'grid44') for (let i = 0; i < W; i++) cells[i * H] = 6;
        if (mode === 'grid45' || mode === 'grid44') for (let j = 0; j < H; j++) cells[(W - 1) * H + j] = 6;
        return fromCells(cells, seed);
    }

    function buildReplay(agent, seed, mode) {
        const game = startFor(mode, seed);
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

    // Rebuild the frames of a saved replay. The engine's refills come from a
    // seeded PRNG consumed in move order, so applying the same moves from the
    // same seed reproduces every board exactly -- the file only has to carry the
    // moves. No agent and no weights are involved, which is what makes a depth-3
    // game watchable here at all.
    //
    // `values` stays null: storing every candidate's evaluation for a
    // 1100-move game would dwarf the replay, and the live agent path is there
    // for anyone who wants them.
    function framesFromReplay(rep) {
        const game = new Game(rep.seed);
        const out = [];
        let created = -1;
        for (let n = 0; n <= rep.moves.length; n++) {
            const move = n < rep.moves.length ? rep.moves[n] : null;
            out.push(capture(game, move, null, created));
            if (!move) break;
            game.apply(move[0], move[1]);
            created = game.lastCreated;
        }
        return out;
    }

    async function loadReplay(file) {
        continuation = null;
        el('continueReview').textContent = '▶ Continue with review bot';
        stop();
        const token = ++loadToken;
        frames = [];
        index = 0;
        lastRendered = -1;
        previewMove = null;
        boardEl.innerHTML = '';
        el('status').innerHTML = 'loading replay…';
        let rep;
        try {
            const res = await fetch('bot/replays/' + file);
            if (!res.ok) throw new Error('HTTP ' + res.status);
            rep = await res.json();
        } catch (err) {
            if (token !== loadToken) return;
            el('status').innerHTML = '<span class="over">could not load replay</span>';
            el('splits').textContent = 'Replays are fetched over http, so this page has to be ' +
                'served rather than opened as a file:// path. (' + err.message + ')';
            return;
        }
        if (token !== loadToken) return;
        frames = framesFromReplay(rep);
        clearReview();
        el('scrub').max = frames.length - 1;
        el('scrub').value = 0;
        render(false);
        const final = frames[frames.length - 1];
        // If this disagrees with the recorded score the replay is not the game
        // it claims to be, and saying so is more useful than showing it anyway.
        const ok = final.score === rep.score;
        el('status').innerHTML = ok
            ? 'replay · ' + final.movesPlayed + ' moves for ' + final.score.toLocaleString()
            : '<span class="over">replay does not reproduce its recorded score (' +
              final.score.toLocaleString() + ' vs ' + rep.score.toLocaleString() + ')</span>';
    }

    // --- review ---------------------------------------------------------------
    //
    // Ask a network what it would have played in every position of the loaded
    // game, and how much it thinks the move actually played gave up. The
    // interesting case is a human replay: the bot outscores every human by a
    // wide margin, so where it disagrees is at least a candidate mistake.
    //
    // Depth-2 expectimax, with `rootk` left off so every legal move is searched
    // to the same depth. The default rootk=6 gives the top six moves a deep
    // value and leaves the rest at depth 1, which is fine for picking a move and
    // wrong for measuring one: the move actually played is often outside that
    // six, and subtracting a shallow value from a deep one would invent a
    // mistake out of the depth difference alone.
    //
    // A position is scored from its own cells alone: `fromCells` reads maxGen
    // back off the board, which is exact here -- maxGen becomes 4 when a 4 is
    // made, and the only way to remove a 4 is to make a 5, so a board whose
    // largest tile is 3 or less has never seen a 4. No seed and no sequential
    // replay is needed. Values are relative (gain + value of the resulting
    // board), so the rebuilt game starting at score 0 changes nothing.
    // Which network reviews, settled by measurement rather than by which one is
    // newest. `bot/reveval.js` rolls out both the reviewer's preferred move and
    // the move actually played, over held-out human games, and asks what the
    // five positions this UI would list are really worth:
    //
    //   reviewer                     corr(pred,true)   mean TRUE loss of a listed position
    //   dom39q  depth 2 cap 16             0.123        +76.4 +- 26
    //   dom39q  depth 2 cap 64             0.148        +82.3 +- 26
    //   dom39q  depth 2 cap 256            0.148        +82.3 +- 26
    //   dom39s  depth 2 cap 64             0.098        +55.4 +- 23
    //   dom21hq depth 2 cap 16            -0.028        -53.1 +- 25
    //
    // `dom21hq` is the network retrained for evaluation accuracy (ANALYSIS.md),
    // and it is *worse here*, badly enough that its list is anti-informative:
    // the positions it calls the biggest mistakes are ones where the human's
    // move was on average better than its own preferred move. The reason is that
    // this feature's job is dominated by picking the best move, not by pricing
    // the gap, and dom21hq is 733 points weaker as a player. Accuracy about
    // its own second and third choices does not transfer to judging a move a
    // human played, which is usually much further down the order.
    //
    // The file itself is `dom39c` sparsely compressed by shrink.js -- 17 MB
    // against 140, which is what makes the feature usable on a phone at all.
    // Two versions of that compression exist and the difference between them is
    // the whole story of this file:
    //
    //                              dom39s      dom39h
    //   counting distribution      self-play   self-play + human positions
    //   size                       15 MB       17 MB
    //   move-gap error, human pos  70.6        14.2
    //   top move differs, human    11.4%       6.3%
    //   move-gap error, bot pos    3.74        3.73
    //   same positions in top 5    94%         97%
    //   same suggested move, listed 94%        98.6%
    //   playing strength here      +36 +- 98   +24 +- 112   (both equal)
    //
    // shrink.js decides which weights to keep by counting reads, and its own
    // header says coverage is the whole result -- but the guarantee is only ever
    // about the distribution the counting pass walked. `dom39s` counted bot
    // self-play, and this feature runs on human positions, which is why it lost
    // most of its accuracy exactly where the feature needs it. Counting over
    // human positions as well (shrink.js --starts) fixes it for 2 MB, and costs
    // the bot distribution nothing.
    //
    // Note the bot top-move disagreement going *up* (7.1% -> 10.9%) while the
    // bot move-gap error stays flat. Those extra disagreements are near-ties
    // worth nothing; a disagreement count is the misleading statistic here and
    // the magnitude is the real one, which is the same lesson as in agree.js.
    const REVIEW_WEIGHTS = 'bot/weights/all7g-Rcq.bin';
    // The review runs in two passes, because the cost of a pass is dominated by
    // `cap` -- the number of sampled refills at a chance node -- and the two
    // things the review has to do want very different amounts of it.
    //
    // Measured per position on this network (bot/timing.js):
    //
    //   greedy (no search)   0.04 ms
    //   depth 2 cap 2        1.03 ms
    //   depth 2 cap 16       2.94 ms
    //   depth 2 cap 64       8.49 ms
    //
    // FINDING THE MISTAKES needs almost no cap. Ranked by a cap-2 search, the
    // top 20 positions of a game contain **100%** of what a cap-16 search would
    // have listed (92.9% are already in its top 5). Greedy, by contrast, is
    // useless for this: its top 5 shares 27% with the searched list and its top
    // 80 still only reaches 84%, because a greedy "loss" is exactly the quantity
    // that V's Bellman residual gets wrong -- see ANALYSIS.md.
    //
    // PRICING them wants all the cap it can get, but only for a handful of
    // positions, so it is nearly free.
    //
    // So: scan everything at cap 2, re-score the top SHORTLIST at cap 64, and
    // apply MISTAKE_MIN to the re-scored number -- which is what drops a
    // position that the cheap pass thought was a blunder and the careful pass
    // does not. A 791-position game costs 0.8 s + 0.3 s instead of 6.7 s.
    //
    // `crn` seeds the chance sampling from the position itself, so every move is
    // judged against the same refills, the same review twice gives the same
    // numbers, and the cheap pass is not just noisy.
    //
    // Depth 2 throughout: depth 3 at full root width is 185 ms per position,
    // 22x the cap-64 cost, and moved the measured total by only 7% when it was
    // tried (23 380 -> 21 643) without changing which positions came out on top.
    const SCAN_SPEC = 'fx:weights=' + REVIEW_WEIGHTS + ',depth=2,cap=2,topk=0,rootk=0,crn=1';
    const FINE_SPEC = 'fx:weights=' + REVIEW_WEIGHTS + ',depth=2,cap=64,topk=0,rootk=0,crn=1';
    const SHORTLIST = 40;
    // Kept after a review so that render() can re-score the position on screen.
    let fineReviewer = null;
    // "Continue with review bot" plays rather than measures, so it always gets
    // the strong configuration -- move quality matters there and speed does not,
    // since it moves on the Speed slider's clock anyway.
    const CONTINUE_SPEC = FINE_SPEC;
    // Below this predicted loss, calling a move a mistake is not supported by
    // anything. Rolled out over 1 604 held-out human positions, the predicted
    // loss sorts into three bands and only the ends of it carry information:
    //
    //   predicted     n     TRUE loss
    //   0-25       1027      -0.8 +- 5     <- not mistakes, at all
    //   25-400      553      25 to 43      <- real but flat; the number inside
    //                                         this band says almost nothing
    //   400+         24     229.7 +- 46    <- the ones worth showing
    //
    // The top five of a whole game land in the last band, so this bar only
    // matters for a clean game -- where without it the list would pad itself
    // out with five positions worth nothing and present them as mistakes.
    // Rolled out, the predicted loss carries signal from about 100 up. The 200
    // here is the conservative choice: `dom39s` (which this used briefly) only
    // supported 400, and although `dom39h` is close enough to `dom39q` that 100
    // would do, the difference in true value between a 100 floor and a 200 one
    // is 38.5 against 42.6 points -- nothing -- while the higher bar is stricter
    // about the thing the list must not do, which is call a harmless move a
    // mistake.
    //
    //   predicted    dom39q true loss    dom39s true loss
    //   0-25               -0.8 +- 5           -2.2 +- 5
    //   25-50              30.7 +- 14          14.0 +- 15
    //   50-100             24.6 +- 14          -4.6 +- 14
    //   100-200            38.5 +- 18          10.2 +- 16
    //   200-400            42.6 +- 28         -19.5 +- 23
    //   400+              229.7 +- 46         170.6 +- 46
    //
    // 200 is a judgement call and not a measurement: the evidence would support
    // 400, but the top five of a full game sit above 400 anyway, so a 400 floor
    // would only ever bite on weaker games, where the list is the most useful.
    const MISTAKE_MIN = 200;
    let mistakes = [];                   // frame indices, biggest loss first
    let reviewSummary = '';              // kept, because render() owns the status line

    // legalMoves() only ever returns the lowest cell of a vertical run of equal
    // tiles; a human clicking such a run may have clicked any cell of it, so map
    // the recorded click onto the cell the engine calls the move.
    function canonicalMove(cells, move) {
        const [i, j] = move;
        let cj = j;
        while (cj > 0 && cells[i * H + cj - 1] === cells[i * H + cj]) cj--;
        return [i, cj];
    }

    function clearReview() {
        fineReviewer = null;
        mistakes = [];
        reviewSummary = '';
        for (const f of frames) f.review = null;
        el('mistakeRow').style.display = 'none';
        el('mistakes').innerHTML = '';
    }

    // Score one frame. Returns { best, bestValue, playedValue, loss } or null if
    // there is nothing to judge (no move, or fewer than two ways to play).
    function reviewFrame(f, agent, fine) {
        if (!f.move) return null;
        const game = fromCells(f.cells, 1);
        const scored = agent.scoreMoves(game);
        if (scored.length < 2) return null;
        const played = canonicalMove(f.cells, f.move);
        let best = null, bestValue = -Infinity, playedValue = null;
        for (const { move, value } of scored) {
            if (value > bestValue) { bestValue = value; best = move; }
            if (move[0] === played[0] && move[1] === played[1]) playedValue = value;
        }
        if (playedValue === null) return null;     // move is not legal here
        // `fine` records which pass produced this, so the shortlist pass and the
        // on-demand refinement below can tell what still needs re-scoring.
        return { best, bestValue, playedValue, loss: bestValue - playedValue, fine: !!fine };
    }

    // Re-entering this would have two passes writing the same frames and
    // sharing the main thread, so the disabled button is backed by a flag.
    let reviewing = false;

    // Recreate a replay frame as a live game, including the RNG state. The
    // continuation is therefore a genuine branch from this exact position,
    // rather than a new game that merely happens to have the same tiles.
    function gameForContinuation(f) {
        const game = fromCells(f.cells, 1);
        if (f.rngState !== undefined) game.rngState = f.rngState;
        if (f.rngDraws !== undefined) game.rngDraws = f.rngDraws;
        if (f.maxGen !== undefined) game.maxGen = f.maxGen;
        game.score = f.score;
        game.moves = Array(f.movesPlayed).fill('');
        if (f.movesPlayed) game.moves[f.movesPlayed - 1] = f.last;
        game.scoreSplits = f.splits.slice();
        game.gameOver = f.over;
        return game;
    }

    function returnToOriginal() {
        if (!continuation) return;
        clearTimeout(timer);
        timer = null;
        running = false;
        continuation = null;
        previewMove = null;
        el('continueReview').textContent = '▶ Continue with review bot';
        lastRendered = -1;
        render(false);
    }

    async function startContinuation() {
        if (continuation) { returnToOriginal(); return; }
        if (!frames.length || reviewing) return;
        stop();
        const source = frames[index];
        const token = loadToken;
        const button = el('continueReview');
        button.disabled = true;
        button.textContent = 'loading review bot…';
        let agent;
        try {
            agent = createAgent(CONTINUE_SPEC, { seed: 1, network: await loadWeights(REVIEW_WEIGHTS) });
        } catch (err) {
            button.disabled = false;
            button.textContent = '▶ Continue with review bot';
            if (token === loadToken) el('status').innerHTML = '<span class="over">could not load review bot</span>';
            return;
        }
        if (token !== loadToken || source !== frames[index]) { button.disabled = false; button.textContent = '▶ Continue with review bot'; return; }
        const game = gameForContinuation(source);
        continuation = { game, agent, sourceIndex: index, created: -1,
            nextMove: game.gameOver ? null : agent.chooseMove(game) };
        button.disabled = false;
        button.textContent = '✕ Return to original position';
        running = true;
        render(false);
        timer = setTimeout(continuationTick, delay());
    }

    function continuationTick() {
        if (!continuation) return;
        const { game, agent, nextMove } = continuation;
        if (game.gameOver || !nextMove) {
            if (!game.gameOver) game.gameOver = true;
            running = false;
            el('continueReview').textContent = '↩ Return to original position';
            render(false);
            return;
        }
        if (!game.apply(nextMove[0], nextMove[1])) {
            game.gameOver = true;
            continuationTick();
            return;
        }
        continuation.created = game.lastCreated;
        continuation.nextMove = game.gameOver ? null : agent.chooseMove(game);
        render(true);
        timer = setTimeout(continuationTick, delay());
    }

    async function runReview() {
        if (continuation) returnToOriginal();
        if (!frames.length || reviewing) return;
        reviewing = true;
        stop();
        const token = loadToken;
        const button = el('review');
        button.disabled = true;
        clearReview();
        el('status').textContent = 'loading review network…';
        await new Promise(r => setTimeout(r, 0));

        let agent, fineAgent;
        try {
            const network = await loadWeights(REVIEW_WEIGHTS);
            agent = createAgent(SCAN_SPEC, { seed: 1, network });
            fineAgent = createAgent(FINE_SPEC, { seed: 1, network });
            fineReviewer = fineAgent;
        } catch (err) {
            reviewing = false;
            button.disabled = false;
            if (token !== loadToken) return;
            el('status').innerHTML = '<span class="over">could not load ' + REVIEW_WEIGHTS + '</span>';
            el('splits').textContent = 'The review network is a large gitignored .bin; it has to be ' +
                'trained locally and the page served over http. (' + err.message + ')';
            return;
        }
        if (token !== loadToken) { reviewing = false; button.disabled = false; return; }

        // Yield on the clock rather than every n frames, and count only the time
        // actually spent searching. A setTimeout(0) is not free: a tab that is
        // not in front clamps it to a second, so a chunk-per-n-frames loop spent
        // far longer waiting than working, and reported the wait as the cost.
        let ms = 0;
        let sliceStart = performance.now();
        for (let n = 0; n < frames.length; n++) {
            frames[n].review = reviewFrame(frames[n], agent);
            const now = performance.now();
            if (now - sliceStart > 250) {
                ms += now - sliceStart;
                el('status').textContent = 'reviewing… ' + (n + 1) + ' / ' + frames.length;
                await new Promise(r => setTimeout(r, 0));
                if (token !== loadToken) { reviewing = false; button.disabled = false; return; }
                sliceStart = performance.now();
            }
        }
        ms += performance.now() - sliceStart;

        // Two different questions, so two different bars. `judged` counts how
        // often the reviewer would have played something else at all, which is
        // a disagreement and not a claim about size. `mistakes` is the list the
        // UI presents as mistakes, and that one has to clear MISTAKE_MIN.
        const judged = [];
        for (let n = 0; n < frames.length; n++) {
            const r = frames[n].review;
            if (r && r.loss > 0.5) judged.push(n);
        }
        judged.sort((a, b) => frames[b].review.loss - frames[a].review.loss);

        // Second pass: re-score the shortlist properly. Measured, a cap-2
        // ranking's top 20 holds everything a cap-16 pass would have listed, so
        // 40 is comfortable headroom; it costs 40 positions of search.
        el('status').textContent = 'checking the biggest ones…';
        await new Promise(r => setTimeout(r, 0));
        if (token !== loadToken) { reviewing = false; button.disabled = false; return; }
        const fineStart = performance.now();
        for (const n of judged.slice(0, SHORTLIST)) {
            const refined = reviewFrame(frames[n], fineAgent, true);
            if (refined) frames[n].review = refined;
        }
        ms += performance.now() - fineStart;
        reviewing = false;
        button.disabled = false;

        // Re-sort on the re-scored numbers, and let MISTAKE_MIN drop anything
        // the careful pass no longer thinks was a mistake.
        judged.sort((a, b) => frames[b].review.loss - frames[a].review.loss);
        mistakes = judged.filter(n => frames[n].review.loss >= MISTAKE_MIN).slice(0, 5);
        renderMistakes();

        const scored = frames.filter(f => f.review).length;
        const total = frames.reduce((s, f) => s + (f.review ? f.review.loss : 0), 0);
        // render() owns the status line and runs on every navigation, so the
        // summary is stored rather than written once.
        // One caveat on the total: it sums the cheap pass everywhere except the
        // shortlist, and the cheap pass reads a few percent high (24 799 against
        // 23 788 for the same game scored entirely at cap 64). It is a
        // game-quality summary, not a measurement, and it is now most of a
        // second cheaper.
        reviewSummary = 'reviewed ' + scored + ' positions in ' + ms.toFixed(0) + ' ms · ' +
            judged.length + ' disagreements · ' + Math.round(total).toLocaleString() + ' total value given up';
        lastRendered = -1;
        render(false);
    }

    function renderMistakes() {
        const box = el('mistakes');
        box.innerHTML = '';
        el('mistakeRow').style.display = mistakes.length ? '' : 'none';
        mistakes.forEach((frameIndex, rank) => {
            const b = document.createElement('button');
            b.textContent = (rank + 1) + ': −' + Math.round(frames[frameIndex].review.loss);
            b.title = 'move ' + frames[frameIndex].movesPlayed + ' (key ' + (rank + 1) + ')';
            b.onclick = () => { stop(); lastRendered = -1; go(frameIndex, false); };
            box.appendChild(b);
        });
    }

    // --- rendering ----------------------------------------------------------

    // Return the board immediately after a move: the chain has collapsed and
    // every column has fallen, but the empty cells at the top have not yet been
    // refilled.  Keeping this separate from Game.apply() is important here:
    // previews must never consume the replay's seeded RNG.
    function afterstate(cells, move) {
        const [i, j] = move;
        const game = fromCells(cells, 1);
        const chain = game.getChain(i, j);
        if (chain.length < 2) return cells;

        const out = cells.slice();
        const n = out[i * H + j];
        for (const [ci, cj] of chain) out[ci * H + cj] = 0;
        out[i * H + j] = n + 1;

        for (let ci = 0; ci < W; ci++) {
            const base = ci * H;
            let write = base;
            for (let cj = 0; cj < H; cj++) {
                if (out[base + cj]) out[write++] = out[base + cj];
            }
            while (write < base + H) out[write++] = 0;
        }
        return out;
    }

    // The cheap scanning pass agrees with the careful one about the best move at
    // 84.5% of positions, against 97.1% on the ones it lists. That is fine for
    // *ranking* the game and not fine for the arrow drawn on the board, which
    // the reader is looking straight at -- so the position on screen gets
    // re-scored properly the first time it is shown. One position of cap-64
    // search is 8.5 ms, invisible even while stepping through on the clock, and
    // the result is cached on the frame, so scrubbing back is free.
    function refineHere(f) {
        if (!f || !f.review || f.review.fine || !fineReviewer) return;
        const refined = reviewFrame(f, fineReviewer, true);
        if (refined) f.review = refined;
    }

    function render(animate) {
        const f = continuation
            ? capture(continuation.game, null, null, continuation.created)
            : frames[index];
        if (!f) return;
        if (!continuation) refineHere(f);
        const legalMoves = fromCells(f.cells, 1).legalMoves();
        const legal = new Set(legalMoves.map(([i, j]) => i * H + j));
        const previewing = previewMove && legal.has(previewMove[0] * H + previewMove[1]);
        const cells = previewing ? afterstate(f.cells, previewMove) : f.cells;
        // The bot's pick, drawn only where it disagrees with what was played.
        const rev = f.review;
        const played = f.move ? canonicalMove(f.cells, f.move) : null;
        const suggest = continuation
            ? continuation.nextMove
            : rev && !(rev.best[0] === played[0] && rev.best[1] === played[1]) ? rev.best : null;

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
                const n = cells[i * 5 + j];
                if (!n) continue;
                const tile = document.createElement('div');
                tile.className = 'tile';
                tile.style.left = (i * CELL + INSET) + 'px';
                tile.style.top = ((4 - j) * CELL + INSET) + 'px';
                tile.style.background = boxColors[n];
                if (n < 6) tile.textContent = n;
                if (!previewing && !continuation && f.move && f.move[0] === i && f.move[1] === j) tile.classList.add('clicked');
                if (animate && f.created === i * 5 + j) tile.classList.add('pop');
                if (!previewing && suggest && suggest[0] === i && suggest[1] === j) {
                    tile.classList.add('suggest');
                    if (rev) {
                        const loss = document.createElement('span');
                        loss.className = 'loss';
                        loss.textContent = '+' + Math.round(rev.loss);
                        tile.appendChild(loss);
                    }
                }
                if (!previewing && values.has(i * 5 + j)) {
                    const v = document.createElement('span');
                    v.className = 'val';
                    v.textContent = values.get(i * 5 + j);
                    tile.appendChild(v);
                }
                if (!previewing && legal.has(i * H + j)) {
                    tile.classList.add('legal');
                    tile.dataset.move = i + ',' + j;
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
        const status = [];
        if (previewing) status.push('previewing after collapse (before refill)');
        if (continuation) status.push('review bot continuation');
        if (f.over && !previewing) status.push('<span class="over">GAME OVER</span>');
        if (reviewSummary) status.push(reviewSummary);
        el('status').innerHTML = status.join('<br>');
        el('scrub').value = index;
        el('frameLabel').textContent = continuation
            ? f.movesPlayed + ' · bot continuation'
            : index + ' / ' + (frames.length - 1);
        lastRendered = index;
    }

    // --- navigation ---------------------------------------------------------

    function go(to, animate) {
        if (continuation) returnToOriginal();
        const clamped = Math.max(0, Math.min(frames.length - 1, to));
        if (clamped === index && lastRendered === index) return false;
        const forwardOne = clamped === index + 1;
        index = clamped;
        previewMove = null;
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
        if (continuation) { returnToOriginal(); return; }
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
        continuation = null;
        el('continueReview').textContent = '▶ Continue with review bot';
        stop();
        const seed = parseInt(el('seed').value, 10) || 1;
        const spec = el('agent').value;
        const token = ++loadToken;

        frames = [];
        index = 0;
        lastRendered = -1;
        previewMove = null;
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
        const built = buildReplay(agent, seed, el('boardmode').value);
        if (token !== loadToken) return;
        frames = built;
        clearReview();
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

    // Replays are optional: if the directory or its index is missing the
    // dropdown simply stays disabled rather than breaking the page.
    const replaySel = el('replay');
    (async function () {
        replaySel.innerHTML = '<option value="">— live agent —</option>';
        try {
            const res = await fetch('bot/replays/index.json');
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const list = await res.json();
            if (!list.length) throw new Error('empty');
            for (const r of list) {
                const opt = document.createElement('option');
                opt.value = r.file;
                opt.textContent = r.label + '  (' + r.moves + ' moves)';
                replaySel.appendChild(opt);
            }
        } catch (err) {
            replaySel.innerHTML = '<option value="">— none saved —</option>';
            replaySel.disabled = true;
        }
    })();

    replaySel.onchange = () => {
        const file = replaySel.value;
        if (file) loadReplay(file); else reset();
    };

    el('play').onclick = () => continuation ? returnToOriginal() : (running ? stop() : play());
    el('step').onclick = () => { stop(); go(index + 1, true); };
    el('back').onclick = () => { stop(); go(index - 1, false); };
    el('first').onclick = () => { stop(); go(0, false); };
    el('last').onclick = () => { stop(); go(frames.length - 1, false); };
    // Touching the agent or the seed means the live path is wanted, so drop
    // whatever replay is selected rather than leaving a stale label on screen.
    const toLive = fn => () => { if (replaySel.value) replaySel.value = ''; fn(); };
    el('review').onclick = runReview;
    el('continueReview').onclick = startContinuation;
    el('reset').onclick = toLive(reset);
    el('agent').onchange = toLive(reset);
    el('seed').onchange = toLive(reset);
    el('boardmode').onchange = toLive(reset);
    el('dice').onclick = toLive(() => { el('seed').value = Math.floor(Math.random() * 1e9); reset(); });
    el('delay').oninput = () => { el('delayLabel').textContent = delay() + 'ms'; };
    el('showValues').onchange = () => { lastRendered = -1; render(false); };
    el('scrub').oninput = () => { stop(); go(parseInt(el('scrub').value, 10), false); };

    // Delegate hover handling to the board so replacing its tiles to show the
    // preview does not leave per-tile listeners attached to stale elements.
    boardEl.addEventListener('mousemove', e => {
        const f = frames[index];
        if (!f) return;
        const rect = boardEl.getBoundingClientRect();
        const i = Math.floor((e.clientX - rect.left) / CELL);
        const j = H - 1 - Math.floor((e.clientY - rect.top) / CELL);
        const legal = fromCells(f.cells, 1).legalMoves();
        const move = legal.some(([mi, mj]) => mi === i && mj === j) ? [i, j] : null;
        if (move && previewMove && move[0] === previewMove[0] && move[1] === previewMove[1]) return;
        if (!move && !previewMove) return;
        previewMove = move || null;
        render(false);
    });
    boardEl.addEventListener('mouseleave', () => {
        if (!previewMove) return;
        previewMove = null;
        render(false);
    });

    document.addEventListener('keydown', e => {
        // Let the seed box have its own keys back.
        if (e.target && e.target.tagName === 'INPUT' && e.target.type === 'number') return;
        if (e.code === 'Space') { e.preventDefault(); continuation ? returnToOriginal() : (running ? stop() : play()); }
        if (e.code === 'ArrowRight') { e.preventDefault(); stop(); go(index + 1, true); }
        if (e.code === 'ArrowLeft') { e.preventDefault(); stop(); go(index - 1, false); }
        if (e.code === 'Home') { e.preventDefault(); stop(); go(0, false); }
        if (e.code === 'End') { e.preventDefault(); stop(); go(frames.length - 1, false); }
        // 1-5 jump to the biggest mistakes the review found, biggest first.
        if (e.key >= '1' && e.key <= '5') {
            const target = mistakes[Number(e.key) - 1];
            if (target !== undefined) { e.preventDefault(); stop(); lastRendered = -1; go(target, false); }
        }
    });

    reset();
})();
