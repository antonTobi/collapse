// Review a finished main-game replay. The position scan follows the proven
// spectator configuration: dom39h, a cheap full scan, then careful scoring of
// only the likely mistakes. Values stay internal; this UI shows the moves.
//
// The board is drawn to a <canvas> with the main game's falling-tile physics
// (config.js gravity/bounceFactor, and the dt = frame time / 18 clamp from
// game.js). Two timelines share a single `frames` array and `index`:
//
//   * replay mode — the recorded game, scored for mistakes. It is the only
//     timeline stored in the forward direction, so stepping ahead walks the
//     recorded moves. Clicking the recorded move stays on it; any other legal
//     click branches off it.
//   * variation mode — a branching line of the user's own making. Only the moves
//     actually reached are kept (it ends exactly where the user is), so
//     navigating back trims the line and there is never a stored future move.
//     Forward navigation (play / fast-forward / next / jump to end) uses the
//     review bot to generate the next move.
//
// Playback has three states: paused, playing (animated, next move on settle)
// and fast-forward (no animation, one move every FF_DELAY ms). While paused the
// bot's suggestion is outlined as a dashed marker when "Show bot suggestion" is
// on; the solid marker of the move about to be played appears only on the
// recorded game line.
(function () {
    const REVIEW_WEIGHTS = 'bot/weights/dom39h.bins'
    const SCAN_SPEC = 'fx:weights=' + REVIEW_WEIGHTS + ',depth=2,cap=2,topk=0,rootk=0,crn=1'
    const FINE_SPEC = 'fx:weights=' + REVIEW_WEIGHTS + ',depth=2,cap=64,topk=0,rootk=0,crn=1'
    const SHORTLIST = 40
    const MISTAKE_MIN = 200
    const FF_DELAY = 300                 // ms between fast-forward steps
    const SUGGESTION_KEY = 'collapse-review-show-suggestion'

    // Inline Lucide icon bodies (24x24, stroke on currentColor) so the controls
    // are real icons rather than font-dependent glyphs, with no network fetch.
    const ICONS = {
        skipBack: '<polygon points="19 20 9 12 19 4 19 20"/><line x1="5" x2="5" y1="19" y2="5"/>',
        skipForward: '<polygon points="5 4 15 12 5 20 5 4"/><line x1="19" x2="19" y1="5" y2="19"/>',
        chevronLeft: '<path d="m15 18-6-6 6-6"/>',
        chevronRight: '<path d="m9 18 6-6-6-6"/>',
        play: '<polygon points="6 3 20 12 6 21 6 3"/>',
        pause: '<rect x="14" y="3" width="5" height="18" rx="1"/><rect x="5" y="3" width="5" height="18" rx="1"/>',
        fastForward: '<polygon points="13 19 22 12 13 5 13 19"/><polygon points="2 19 11 12 2 5 2 19"/>',
        arrowLeft: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
        x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'
    }
    const icon = name => '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[name] + '</svg>'

    // The board is drawn in a fixed 400x400 space (5 cells of 80px), matching
    // the main game so the physics constants carry over unchanged; the canvas is
    // then scaled to the column width by CSS.
    const CELL = 80, INSET = 1
    const GRAV = gravity, BOUNCE = bounceFactor   // from config.js

    const el = id => document.getElementById(id)
    const { Game, fromCells, W, H, ALPHABET } = window.Collapse
    const { createAgent } = window.CollapseAgents

    let replayFrames = []                // the recorded human game (built once)
    let frames = []                      // active timeline: replayFrames or variationFrames
    let index = 0
    let mistakes = []
    let branchName = 'You'
    let network = null
    let fineAgent = null                 // FINE_SPEC agent, shared by review + variation play

    // Board rendering state.
    const canvas = el('board')
    const ctx = canvas.getContext('2d')
    let animBoard = null                 // columns of { n, y, vy } currently on screen
    let animating = false
    let animDone = null                  // called once the fall settles
    let rafId = null
    let lastTime = 0
    // Markers to draw while a fall is in flight — the destination frame's, each
    // drawn at its tile's current height so a highlight rides the tile it names.
    let animPrimary = null, animSecondary = null

    let playState = 'paused'             // 'paused' | 'playing' | 'ff'
    let ffTimer = null
    let skipping = false                 // variation "skip to end": one move per frame
    let skipRaf = null

    // Two timelines share `frames` and `index`. In variation mode the line is
    // always trimmed so the user sits on its final (frontier) frame.
    let mode = 'replay'                  // 'replay' | 'variation'
    let variationFrames = null           // the branching line, or null on the main path
    let branchIndex = 0                  // replay frame the current variation left from
    let showSuggestion = true            // "Show bot suggestion" checkbox

    // The game to review is passed entirely in the URL: displayName, seed and
    // the move list as separate parameters, so a game can be linked to directly.
    function readGame() {
        const p = new URLSearchParams(window.location.search)
        if (!p.has('seed')) return null
        return { seed: Number(p.get('seed')), moves: p.get('moves') || '', displayName: p.get('displayName') || 'You' }
    }

    function capture(game, move) {
        return {
            cells: game.cells.slice(), score: game.score, movesPlayed: game.moves.length,
            over: game.gameOver, move, review: null,
            // Kept so a variation can continue from this exact position, rng and all.
            rngState: game.rngState, rngDraws: game.rngDraws, maxGen: game.maxGen
        }
    }

    function decodeMove(char) {
        const k = ALPHABET.indexOf(char)
        return k < 0 ? null : [k % W, (k / W) | 0]
    }

    function buildFrames(replay) {
        const game = new Game(replay.seed)
        const out = []
        for (let n = 0; n <= replay.moves.length; n++) {
            const move = n < replay.moves.length ? decodeMove(replay.moves[n]) : null
            out.push(capture(game, move))
            if (!move) break
            if (!game.apply(move[0], move[1])) throw new Error('The recorded replay contains an illegal move.')
        }
        return out
    }

    // legalMoves() only ever returns the lowest cell of a vertical run of equal
    // tiles; a human clicking such a run may have clicked any cell of it, so map
    // the recorded click onto the cell the engine calls the move.
    function canonicalMove(cells, move) {
        const [i, j] = move
        let row = j
        while (row > 0 && cells[i * H + row - 1] === cells[i * H + row]) row--
        return [i, row]
    }

    function scoreFrame(frame, agent, fine) {
        if (!frame.move) return null
        const game = fromCells(frame.cells, 1)
        const scored = agent.scoreMoves(game)
        if (scored.length < 2) return null
        const played = canonicalMove(frame.cells, frame.move)
        let best = null, bestValue = -Infinity, playedValue = null
        for (const { move, value } of scored) {
            if (value > bestValue) { bestValue = value; best = move }
            if (move[0] === played[0] && move[1] === played[1]) playedValue = value
        }
        return playedValue === null ? null : { best, loss: bestValue - playedValue, fine }
    }

    // --- loading status -----------------------------------------------------

    function setLoadingMessage(text) {
        const box = el('loading')
        box.textContent = text
        box.hidden = false
    }

    function clearLoadingMessage() {
        el('loading').hidden = true
    }

    // The bot is not usable until the weights are decoded; keep the suggestion
    // checkbox hidden (but reserving its layout space) until then.
    function revealSuggestion() {
        el('suggestion').classList.add('on')
    }

    // The Cache API only exists in secure contexts (https or localhost), so it
    // silently fails when the page is served over plain http on the LAN — the
    // phone-testing setup. IndexedDB works on every origin, so cache the raw
    // weights buffer there instead.
    const DB_NAME = 'collapse-review-weights'
    const DB_STORE = 'weights'
    let idb = null

    function idbOpen() {
        if (idb) return Promise.resolve(idb)
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, 1)
            req.onupgradeneeded = () => {
                if (!req.result.objectStoreNames.contains(DB_STORE)) req.result.createObjectStore(DB_STORE)
            }
            req.onsuccess = () => { idb = req.result; resolve(idb) }
            req.onerror = () => reject(req.error)
        })
    }

    function idbGet(key) {
        return idbOpen().then(db => new Promise((resolve, reject) => {
            const tx = db.transaction(DB_STORE, 'readonly')
            const req = tx.objectStore(DB_STORE).get(key)
            req.onsuccess = () => resolve(req.result)
            req.onerror = () => reject(req.error)
        }))
    }

    function idbPut(key, value) {
        return idbOpen().then(db => new Promise((resolve, reject) => {
            const tx = db.transaction(DB_STORE, 'readwrite')
            tx.objectStore(DB_STORE).put(value, key)
            tx.oncomplete = () => resolve()
            tx.onerror = () => reject(tx.error)
        }))
    }

    function idbDelete(key) {
        return idbOpen().then(db => new Promise((resolve, reject) => {
            const tx = db.transaction(DB_STORE, 'readwrite')
            tx.objectStore(DB_STORE).delete(key)
            tx.oncomplete = () => resolve()
            tx.onerror = () => reject(tx.error)
        }))
    }

    // Stream the response so the download can report progress. `onProgress` gets
    // a fraction in [0,1], or -1 when the total size is unknown.
    async function fetchWithProgress(url, onProgress) {
        const response = await fetch(url)
        if (!response.ok) throw new Error('HTTP ' + response.status)
        const total = Number(response.headers.get('Content-Length')) || 0
        if (!response.body || !total) {
            if (onProgress) onProgress(-1)
            return response.arrayBuffer()
        }
        const reader = response.body.getReader()
        const chunks = []
        let received = 0
        for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            chunks.push(value)
            received += value.length
            if (onProgress) onProgress(received / total)
        }
        const buffer = new Uint8Array(received)
        let offset = 0
        for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length }
        return buffer.buffer
    }

    let networkPromise = null

    function loadReviewNetwork() {
        if (network) return Promise.resolve(network)
        if (!networkPromise) networkPromise = doLoadReviewNetwork()
        return networkPromise
    }

    async function doLoadReviewNetwork() {
        // A cache hit loads silently: the status line is only for a real fetch.
        try {
            const cached = await idbGet(REVIEW_WEIGHTS)
            if (cached) {
                try {
                    network = window.CollapseNTuple.decode(cached)
                    revealSuggestion()
                    return network
                } catch (_) {
                    try { await idbDelete(REVIEW_WEIGHTS) } catch (_) {}   // drop a corrupt entry
                }
            }
        } catch (_) { /* cache unavailable; fetch below */ }

        setLoadingMessage('Loading review bot…')
        const buffer = await fetchWithProgress(REVIEW_WEIGHTS, fraction => {
            setLoadingMessage(fraction < 0
                ? 'Loading review bot…'
                : 'Loading review bot… ' + Math.round(fraction * 100) + '%')
        })
        network = window.CollapseNTuple.decode(buffer)
        try { await idbPut(REVIEW_WEIGHTS, buffer) } catch (_) {}
        clearLoadingMessage()
        revealSuggestion()
        return network
    }

    async function ensureFineAgent() {
        if (fineAgent) return fineAgent
        try {
            fineAgent = createAgent(FINE_SPEC, { seed: 1, network: await loadReviewNetwork() })
        } catch (error) {
            setLoadingMessage('Could not load the review bot (' + error.message + ').')
            return null
        }
        return fineAgent
    }

    async function review() {
        let scan, fine
        try {
            const weights = await loadReviewNetwork()
            scan = createAgent(SCAN_SPEC, { seed: 1, network: weights })
            fine = createAgent(FINE_SPEC, { seed: 1, network: weights })
            fineAgent = fine             // reused for variation suggestions/play
        } catch (error) {
            setLoadingMessage('Could not load the review bot (' + error.message + ').')
            return
        }

        let sliceStart = performance.now()
        for (let n = 0; n < replayFrames.length; n++) {
            replayFrames[n].review = scoreFrame(replayFrames[n], scan, false)
            if (performance.now() - sliceStart > 150) {
                await new Promise(resolve => setTimeout(resolve, 0))
                sliceStart = performance.now()
            }
        }

        const ranked = replayFrames.map((frame, n) => ({ frame, n }))
            .filter(({ frame }) => frame.review && frame.review.loss > .5)
            .sort((a, b) => b.frame.review.loss - a.frame.review.loss)
        await new Promise(resolve => setTimeout(resolve, 0))
        for (const { frame } of ranked.slice(0, SHORTLIST)) frame.review = scoreFrame(frame, fine, true)
        ranked.sort((a, b) => b.frame.review.loss - a.frame.review.loss)
        // The five biggest by loss, but presented in move order so they read as a
        // path through the game rather than a ranking.
        mistakes = ranked.filter(({ frame }) => frame.review.loss >= MISTAKE_MIN).slice(0, 5).map(({ n }) => n).sort((a, b) => a - b)
        renderMistakes()
        if (playState === 'paused' && !animating) renderFrame()
    }

    // A row of jump buttons, one per mistake, in move order. Replay only.
    function renderMistakes() {
        const box = el('mistakes')
        box.innerHTML = ''
        if (mode !== 'replay' || !mistakes.length) { box.classList.remove('on'); return }
        box.classList.add('on')
        const label = document.createElement('span')
        label.className = 'mlabel'
        label.textContent = 'Mistakes:'
        box.appendChild(label)
        for (const n of mistakes) {
            const b = document.createElement('button')
            b.className = 'mbtn'
            b.textContent = 'Move ' + n
            b.onclick = () => snap(n)
            box.appendChild(b)
        }
    }

    // --- board model & drawing ----------------------------------------------

    function targetY(row) { return (H - 1 - row) * CELL }

    function buildBoard(cells) {
        const cols = []
        for (let i = 0; i < W; i++) {
            cols[i] = []
            for (let j = 0; j < H; j++) cols[i].push({ n: cells[i * H + j], y: targetY(j), vy: 0 })
        }
        return cols
    }

    // Set up the falling animation for playing `move` on `prevCells`, landing on
    // `nextCells`. Mirrors game.js's do()/refill() with the incoming values read
    // off nextCells rather than drawn from the RNG.
    function setupCollapse(prevCells, move, nextCells) {
        const [mi, mj] = canonicalMove(prevCells, move)
        const clicked = mi * H + mj
        const n = prevCells[clicked]
        const chain = fromCells(prevCells, 1).getChain(mi, mj)
        const removed = new Set(chain.map(([ci, cj]) => ci * H + cj))
        removed.delete(clicked)          // the clicked cell survives, upgraded

        const cols = buildBoard(prevCells)
        for (let i = 0; i < W; i++) {
            const survivors = []
            for (let j = 0; j < H; j++) {
                const idx = i * H + j
                if (removed.has(idx)) continue
                const box = cols[i][j]
                if (idx === clicked) box.n = n + 1
                survivors.push(box)
            }
            // Read incoming tiles off nextCells' top cells. `kept` is fixed
            // before the loop because pushing grows survivors.length underfoot.
            const kept = survivors.length
            for (let t = 0; kept + t < H; t++) {
                survivors.push({ n: nextCells[i * H + kept + t], y: -(t + 1) * CELL, vy: 0 })
            }
            cols[i] = survivors
        }
        return cols
    }

    function drawBox(i, y, n) {
        if (n === 0 || y <= -CELL) return
        const x = i * CELL
        ctx.fillStyle = boxColors[n]
        ctx.fillRect(x + INSET, y + INSET, CELL - 2 * INSET, CELL - 2 * INSET)
        if (n < 6) {
            ctx.fillStyle = 'rgba(255,255,255,0.9)'
            const metrics = ctx.measureText(String(n))
            const off = (metrics.actualBoundingBoxAscent - metrics.actualBoundingBoxDescent) / 2
            ctx.fillText(String(n), x + CELL / 2, y + CELL / 2 + off)
        }
    }

    // A move outline, drawn at the height of the tile currently occupying the
    // marked slot so it rides that tile down while it is still falling. The
    // dashed variant strokes each side separately from its corner with a dash
    // that divides the side into an odd number of segments — so a dash lands on
    // every corner and the pattern reads identically at all four (a plain dashed
    // strokeRect walks one path and lands each side on a different phase).
    function outlineMarker(cols, move, dashed) {
        const [i, j] = move
        const box = cols[i] && cols[i][j]
        const y = box ? box.y : targetY(j)
        const inset = 6, x = i * CELL + inset, top = y + inset, size = CELL - 2 * inset
        ctx.save()
        ctx.strokeStyle = '#fff'
        ctx.lineWidth = 4
        ctx.lineCap = 'butt'
        if (!dashed) {
            ctx.setLineDash([])
            ctx.strokeRect(x, top, size, size)
        } else {
            const n = 5                        // dashes per side (odd segment count)
            const d = size / (2 * n - 1)       // dash length == gap, a dash at each corner
            ctx.setLineDash([d, d])
            ctx.lineDashOffset = 0
            const seg = (x1, y1, x2, y2) => { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke() }
            seg(x, top, x + size, top)
            seg(x + size, top, x + size, top + size)
            seg(x + size, top + size, x, top + size)
            seg(x, top + size, x, top)
            // The four butt-capped dash ends leave a tiny notch at each corner;
            // paint a solid square (the stroke's own width) over each so every
            // corner reads as one clean block where the two dashes join.
            const lw = ctx.lineWidth
            ctx.setLineDash([])
            ctx.fillStyle = '#fff'
            for (const [cx, cy] of [[x, top], [x + size, top], [x + size, top + size], [x, top + size]]) {
                ctx.fillRect(cx - lw / 2, cy - lw / 2, lw, lw)
            }
        }
        ctx.restore()
    }

    // Paint the given board plus the move about to be played (primary, solid)
    // and the bot's suggestion (secondary, dashed) when shown.
    function paint(cols, primary, secondary) {
        ctx.clearRect(0, 0, W * CELL, H * CELL)
        ctx.textAlign = 'center'
        ctx.textBaseline = 'alphabetic'
        ctx.font = (0.7 * CELL) + 'px Roboto, sans-serif'
        for (let i = 0; i < W; i++) for (let j = 0; j < cols[i].length; j++) drawBox(i, cols[i][j].y, cols[i][j].n)
        if (primary) outlineMarker(cols, primary, false)
        if (secondary) outlineMarker(cols, secondary, true)
    }

    // The bot's best move at a position. Replay frames carry it precomputed in
    // `review.best`; variation frames compute it on demand (and cache it) so the
    // dashed suggestion works off the main line too.
    function bestMoveFor(cells, agent) {
        const scored = agent.scoreMoves(fromCells(cells, 1))
        if (!scored.length) return null
        let best = null, bestValue = -Infinity
        for (const { move, value } of scored) {
            if (value > bestValue) { bestValue = value; best = move }
        }
        return best
    }

    function suggestionFor(frame) {
        if (!showSuggestion || !frame || frame.over) return null
        if (frame.review && frame.review.best) return frame.review.best
        if (mode === 'variation' && fineAgent) {
            if (!frame.suggestion) frame.suggestion = bestMoveFor(frame.cells, fineAgent)
            return frame.suggestion
        }
        return null
    }

    // Markers for a frame: the solid move about to be played (recorded game line
    // only) and the dashed bot suggestion. The suggestion is computed only when
    // the caller asks for it (includeSuggestion), i.e. while paused.
    function markersFor(frame, includeSuggestion) {
        const primary = (mode === 'replay' && frame.move) ? canonicalMove(frame.cells, frame.move) : null
        let secondary = null
        if (includeSuggestion) {
            secondary = suggestionFor(frame)
            if (secondary && primary && secondary[0] === primary[0] && secondary[1] === primary[1]) secondary = null
        }
        return { primary, secondary }
    }

    function updateLabels(frame) {
        el('score').textContent = frame.score
        el('scrub').max = frames.length - 1
        el('scrub').value = index
        if (mode === 'variation') {
            el('move').textContent = frame.over
                ? 'Game over · ' + frame.movesPlayed + ' moves'
                : 'Move ' + frame.movesPlayed
        } else {
            el('move').textContent = 'Move ' + frame.movesPlayed + ' of ' + (frames.length - 1)
        }
    }

    // The settled render for the current frame. While advancing, only the move
    // about to be played shows; the bot's suggestion appears only when paused.
    function renderFrame() {
        const frame = frames[index]
        if (!frame) return
        animBoard = buildBoard(frame.cells)
        // Show the suggestion on every displayed frame except during the rapid
        // skip-to-end jump, where a per-frame suggestion would be too costly.
        const m = markersFor(frame, !skipping)
        paint(animBoard, m.primary, m.secondary)
        updateLabels(frame)
    }

    // --- animation ----------------------------------------------------------

    function stepPhysics(cols, dt) {
        let settled = true
        for (let i = 0; i < W; i++) for (let j = 0; j < cols[i].length; j++) {
            const box = cols[i][j]
            const target = targetY(j)
            if (box.y < target || box.vy !== 0) {
                settled = false
                box.vy += GRAV * dt
                box.y += box.vy * dt
                if (box.y >= target && box.vy > 0) {
                    box.y = target
                    if (box.vy > 1) box.vy *= -BOUNCE; else box.vy = 0
                }
            }
        }
        return settled
    }

    function animLoop(now) {
        const dt = Math.min(2, (now - lastTime) / 18)
        lastTime = now
        const settled = stepPhysics(animBoard, dt)
        paint(animBoard, animPrimary, animSecondary)
        if (!settled) { rafId = requestAnimationFrame(animLoop); return }
        rafId = null
        animating = false
        const done = animDone; animDone = null
        if (done) done()
    }

    // Abort an in-flight fall so a settling animation cannot fire its completion
    // (resume a loop, or paint over a new frame) after navigation or a mode swap.
    function cancelAnim() {
        if (rafId) cancelAnimationFrame(rafId)
        rafId = null
        animating = false
        animDone = null
    }

    // --- timeline advance ---------------------------------------------------

    // Ensure a frame exists at index+1. On the recorded line it is already
    // stored; in a variation the next move is generated by the review bot.
    // Returns false at the end of the line (replay end, or variation game over).
    async function ensureNext() {
        if (index < frames.length - 1) return true
        if (mode !== 'variation') return false
        const last = frames[frames.length - 1]
        if (last.over) return false
        const agent = await ensureFineAgent()
        if (!agent) return false
        const game = gameFor(last)
        const move = agent.chooseMove(game)
        if (!move) return false
        game.apply(move[0], move[1])
        last.move = move
        frames.push(capture(game, null))
        return true
    }

    // Animate one move forward (index already advanced by the caller path). The
    // bot's dashed suggestion is drawn during the fall (subject to the checkbox)
    // so the highlight appears before the animation ends.
    function animateForward(prev, next) {
        animBoard = setupCollapse(prev.cells, prev.move, next.cells)
        const m = markersFor(next, true)
        animPrimary = m.primary
        animSecondary = m.secondary
        updateLabels(next)
        animating = true
        lastTime = performance.now()
        rafId = requestAnimationFrame(animLoop)
    }

    // --- navigation (snaps; manual stepping is not a move being played) ------

    function snap(to) {
        stopPlayback()
        cancelAnim()
        if (mode === 'variation') {
            // No future moves are stored in a branch: stepping back trims the
            // line so the user ends on its final (frontier) frame.
            const t = Math.max(0, Math.min(to, frames.length - 1))
            if (t === 0) { returnToReplay(); return }
            variationFrames.length = t + 1
            index = t
        } else {
            index = Math.max(0, Math.min(frames.length - 1, to))
        }
        renderFrame()
    }

    async function stepForward() {
        stopPlayback()
        cancelAnim()
        if (await ensureNext()) { index++; renderFrame() }
    }

    // --- playback (paused / playing / ff) -----------------------------------

    function updatePlayButtons() {
        el('play').innerHTML = icon(playState === 'playing' ? 'pause' : 'play')
        el('play').classList.toggle('active', playState === 'playing')
        el('ff').classList.toggle('active', playState === 'ff')
        el('last').classList.toggle('active', skipping)
    }

    // Stop every kind of auto-advance: the animation, the fast-forward interval,
    // and the bot skip-to-end frame loop.
    function clearMotion() {
        cancelAnim()
        if (ffTimer) { clearTimeout(ffTimer); ffTimer = null }
        if (skipRaf) { cancelAnimationFrame(skipRaf); skipRaf = null }
        skipping = false
    }

    function stopPlayback() {
        playState = 'paused'
        clearMotion()
        updatePlayButtons()
    }

    // Play / fast-forward are two toggles; pressing the active one pauses,
    // pressing the other switches straight over.
    function setPlayState(state) {
        if (playState === state && !skipping) { stopPlayback(); renderFrame(); return }
        clearMotion()
        if (mode === 'replay' && index >= frames.length - 1) index = 0   // replay from the top
        playState = state
        updatePlayButtons()
        renderFrame()                    // drop the suggestion marker at once
        if (state === 'playing') playLoop()
        else ffLoop()
    }

    // Variation mode: run the branch to game over as fast as the display allows
    // — one move per animation frame, no fall animation. On the recorded line it
    // just jumps to the end. Any control cancels it.
    function skipToEnd() {
        if (mode !== 'variation') { snap(frames.length - 1); return }
        stopPlayback()
        skipping = true
        updatePlayButtons()
        const loop = async () => {
            if (!skipping) return
            if (!(await ensureNext())) { skipping = false; updatePlayButtons(); renderFrame(); return }
            if (!skipping) return
            index++
            renderFrame()
            skipRaf = requestAnimationFrame(loop)
        }
        loop()
    }

    async function playLoop() {
        if (playState !== 'playing') return
        if (!(await ensureNext())) { stopPlayback(); renderFrame(); return }
        if (playState !== 'playing') { renderFrame(); return }   // paused while the bot thought
        const prev = frames[index]
        index++
        animateForward(prev, frames[index])
        animDone = () => { if (playState === 'playing') playLoop(); else renderFrame() }
    }

    function ffLoop() {
        const tick = async () => {
            if (playState !== 'ff') return
            if (!(await ensureNext())) { stopPlayback(); renderFrame(); return }
            if (playState !== 'ff') { renderFrame(); return }     // paused mid-advance
            index++
            renderFrame()
            ffTimer = setTimeout(tick, FF_DELAY)
        }
        tick()                           // advance at once, then on the delay
    }

    // --- variation mode -----------------------------------------------------

    // Recreate a frame as a live game, rng and all, so a variation is a genuine
    // continuation from this exact position.
    function gameFor(frame) {
        const game = fromCells(frame.cells, 1)
        game.rngState = frame.rngState
        game.rngDraws = frame.rngDraws
        game.maxGen = frame.maxGen
        game.score = frame.score
        game.moves = Array(frame.movesPlayed).fill('')
        game.gameOver = frame.over
        return game
    }

    // Leave the recorded line: `frame` is the replay frame on screen and `move`
    // the different move the user clicked. The variation starts as the branch
    // position plus the result of that move, and only ever grows by appending.
    function enterVariation(frame, move) {
        stopPlayback()
        const game = gameFor(frame)
        game.apply(move[0], move[1])
        const branchFrame = Object.assign({}, frame, { move })
        const frontier = capture(game, null)
        variationFrames = [branchFrame, frontier]
        frames = variationFrames
        mode = 'variation'
        index = 1
        el('app').classList.add('variation')
        el('reviewer').textContent = 'Variation from move ' + frame.movesPlayed
        applyModeUI()
        renderMistakes()                            // clears the row (replay-only)
        animateForward(branchFrame, frontier)
        animDone = () => renderFrame()
    }

    // Add the user's clicked move onto the end of the current variation.
    function appendVariationMove(frame, move) {
        stopPlayback()
        const game = gameFor(frame)
        game.apply(move[0], move[1])
        frame.move = move
        const frontier = capture(game, null)
        frames.push(frontier)
        index++
        animateForward(frame, frontier)
        animDone = () => renderFrame()
    }

    // Clicking the board plays a move with animation. On the recorded line the
    // recorded move keeps the user on it; any other legal move branches into a
    // variation. Inside a variation a click appends another move.
    function playBoardMove(i, j) {
        if (playState !== 'paused') return
        // Accept a move mid-animation: snap the in-flight fall to its end, then
        // play the new move on top of it.
        if (animating) { cancelAnim(); renderFrame() }
        const frame = frames[index]
        if (!frame || frame.over) return
        const move = canonicalMove(frame.cells, [i, j])
        if (fromCells(frame.cells, 1).getChain(move[0], move[1]).length < 2) return

        if (mode === 'replay') {
            const recorded = frame.move ? canonicalMove(frame.cells, frame.move) : null
            if (recorded && recorded[0] === move[0] && recorded[1] === move[1]) {
                index++
                animateForward(frame, frames[index])
                animDone = () => renderFrame()
                return
            }
            branchIndex = index
            enterVariation(frame, move)
        } else {
            appendVariationMove(frame, move)
        }
    }

    function returnToReplay() {
        stopPlayback()
        cancelAnim()
        mode = 'replay'
        variationFrames = null
        frames = replayFrames
        index = branchIndex
        el('app').classList.remove('variation')
        el('reviewer').textContent = 'Reviewing game by ' + branchName
        applyModeUI()
        renderMistakes()
        renderFrame()
    }

    // Mode-dependent chrome: in a variation the first control becomes an "X" that
    // exits the variation, and the scrubber is hidden (only the move number shows).
    function applyModeUI() {
        if (mode === 'variation') {
            el('first').innerHTML = icon('x')
            el('first').title = 'Exit variation'
            el('first').onclick = returnToReplay
        } else {
            el('first').innerHTML = icon('skipBack')
            el('first').title = 'First (Home)'
            el('first').onclick = () => snap(0)
        }
        el('timeline').hidden = (mode === 'variation')
    }

    // --- wiring -------------------------------------------------------------

    function wire() {
        el('back').innerHTML = icon('arrowLeft') + '<span>Back to game</span>'
        el('backMove').innerHTML = icon('chevronLeft')
        el('ff').innerHTML = icon('fastForward')
        el('step').innerHTML = icon('chevronRight')
        el('last').innerHTML = icon('skipForward')

        el('back').onclick = () => { window.location.href = 'index.html' }
        el('backMove').onclick = () => snap(index - 1)
        el('play').onclick = () => setPlayState('playing')
        el('ff').onclick = () => setPlayState('ff')
        el('step').onclick = stepForward
        el('last').onclick = skipToEnd
        el('scrub').oninput = () => snap(Number(el('scrub').value))

        const suggestion = el('showSuggestion')
        suggestion.checked = showSuggestion
        suggestion.onchange = () => {
            showSuggestion = suggestion.checked
            try { localStorage.setItem(SUGGESTION_KEY, showSuggestion ? '1' : '0') } catch (_) {}
            renderFrame()
        }

        canvas.addEventListener('click', event => {
            const rect = canvas.getBoundingClientRect()
            const x = (event.clientX - rect.left) / rect.width * W
            const y = (event.clientY - rect.top) / rect.height * H
            const i = Math.floor(x)
            const j = H - 1 - Math.floor(y)      // row 0 is the bottom row
            if (i >= 0 && i < W && j >= 0 && j < H) playBoardMove(i, j)
        })

        document.addEventListener('keydown', event => {
            if (event.code === 'Space') { event.preventDefault(); setPlayState('playing') }
            else if (event.key === 'f' || event.key === 'F') { event.preventDefault(); setPlayState('ff') }
            else if (event.code === 'ArrowLeft') { event.preventDefault(); snap(index - 1) }
            else if (event.code === 'ArrowRight') { event.preventDefault(); stepForward() }
            else if (event.code === 'Home') { event.preventDefault(); snap(0) }
            else if (event.code === 'End') { event.preventDefault(); skipToEnd() }
        })

        applyModeUI()
    }

    // Match the canvas backing store to the device pixel ratio so tiles and text
    // stay crisp when CSS scales the element to the column width.
    function sizeCanvas() {
        const dpr = window.devicePixelRatio || 1
        canvas.width = W * CELL * dpr
        canvas.height = H * CELL * dpr
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    function start() {
        const replay = readGame()
        if (!replay || !Number.isFinite(replay.seed) || typeof replay.moves !== 'string') {
            el('empty').hidden = false
            return
        }
        try { replayFrames = buildFrames(replay) }
        catch (error) { el('empty').hidden = false; return }
        frames = replayFrames
        branchName = replay.displayName || 'You'
        try { showSuggestion = localStorage.getItem(SUGGESTION_KEY) !== '0' } catch (_) {}
        el('app').hidden = false
        el('reviewer').textContent = 'Reviewing game by ' + branchName
        el('scrub').max = frames.length - 1
        sizeCanvas()
        wire()
        updatePlayButtons()
        renderFrame()
        review()
    }

    start()
})()
