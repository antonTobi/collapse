// Review a finished main-game replay. The whole game is evaluated up front with
// the deployed net at depth 2 and drawn as an evaluation graph; the sharp downward
// turns in that curve are picked out as "key moments" (see findKeyMoments).
//
// The board is drawn to a <canvas> with the main game's falling-tile physics
// (config.js gravity/bounceFactor, and the dt = frame time / 18 clamp from
// game.js). Two timelines share a single `frames` array and `index`:
//
//   * replay mode — the recorded game. It is the only
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
    const REVIEW_WEIGHTS = 'bot/weights/anneal14-Rcq.bin'
    // Evaluation graph: the bot's depth-2 estimate of the final score reachable
    // from a position. rootk keeps it cheap -- only the best move's value is read,
    // and that move is among the few the root search keeps at full depth.
    // freeze=1: the deployed net is trained freeze-root and must be run that way.
    // esc=6: deepen on 6-making moves, matching how the deployed bot plays (+170
    // over plain d2). Roughly doubles the eval-graph compute, which is acceptable
    // for an offline, one-pass graph.
    const GRAPH_SPEC = 'fx:weights=' + REVIEW_WEIGHTS + ',depth=2,cap=16,topk=2,rootk=6,crn=1,freeze=1,esc=6'
    const COL_DEPTH2 = '#e67e22'
    const COL_KEY = '#c0392b'
    // Key-moment detection: the onset of a sustained downward turn in the eval.
    // The curve is smoothed over +-SMOOTH_R moves, then its discrete second
    // derivative over +-CURV_WIN (S[n+w] - 2S[n] + S[n-w]) picks out sharp
    // downward *knees* -- concave-down points, more negative the sharper the
    // turn. A knee counts only if it clears CURV_MIN and is followed by a real
    // fall of DROP_MIN within DROP_WIN moves (so a rise-into-plateau does not
    // register); near-duplicates within KEY_GAP are suppressed, and only the
    // KEY_CAP strongest (by curvature) are kept. Tuned across a range of human
    // games (see bot/keymoments.js).
    const SMOOTH_R = 2
    const CURV_WIN = 6
    const CURV_MIN = 300
    const DROP_MIN = 500
    const DROP_WIN = 25
    const KEY_GAP = 12
    const ONSET_CAP = 10                 // knees kept before refinement
    const KEY_CAP = 5                    // key moments shown after refinement
    // Refinement of each onset (see refineKeyMoments): snap forward to the first
    // move within DISAGREE_WIN where the bot disagrees with the human (if it
    // agrees the whole window, the drop was bad luck, not a mistake); then play
    // DD_PLIES bot moves from there and drop the moment if the bot's own line
    // also falls DD_DROP below its start (the position was lost regardless).
    const DISAGREE_WIN = 3
    const DD_PLIES = 10
    const DD_DROP = 400
    const FF_DELAY = 300                 // ms between fast-forward steps
    const SUGGESTION_KEY = 'collapse-review-show-suggestion'
    const GRAPH_KEY = 'collapse-review-show-graph'

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
        x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
        link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>' +
            '<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
        check: '<path d="M20 6 9 17l-5-5"/>'
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
    let branchName = 'You'
    let network = null
    let graphAgent = null                // GRAPH_SPEC agent: eval + bot move, one per position
    let evalSeries = []                  // { g, d2 } per replay frame, computed up front
    let graphZoom = 1                    // x zoom: 1 = whole game
    let graphView = null                 // geometry from the last draw, for hit-testing
    let keyMoments = []                  // [{ n, drop }] onsets of sustained eval declines

    // Board rendering state.
    const canvas = el('board')
    const ctx = canvas.getContext('2d')
    const graphCanvas = el('graph')
    const gctx = graphCanvas.getContext('2d')
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
    let showSuggestion = true            // "Move suggestions" checkbox
    let showGraph = true                 // "Eval graph" checkbox

    // The game to review is passed entirely in the URL: displayName, seed, the
    // move list, and an optional `at` move number to open on.
    function readGame() {
        const p = new URLSearchParams(window.location.search)
        if (!p.has('seed')) return null
        return {
            seed: Number(p.get('seed')), moves: p.get('moves') || '',
            displayName: p.get('displayName') || 'You',
            at: p.has('at') ? Number(p.get('at')) : null
        }
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
        let shapeAt = new Array(W * H).fill(null)   // per-cell polyomino, null unless a 6-tile
        for (let n = 0; n <= replay.moves.length; n++) {
            const move = n < replay.moves.length ? decodeMove(replay.moves[n]) : null
            const frame = capture(game, move)
            frame.shapes = shapeAt.slice()
            out.push(frame)
            if (!move) break

            // Track the polyomino each 6-tile was collapsed from, in game.js's
            // coordinate convention ([col, -row]), so the review can redraw it.
            const [mi, mj] = canonicalMove(game.cells, move)
            const chain = game.getChain(mi, mj)
            const clicked = mi * H + mj
            const makesSix = game.at(mi, mj) === 5
            const newShape = makesSix ? chain.map(([ci, cj]) => [ci, -cj]) : null
            const removed = new Set(chain.map(([ci, cj]) => ci * H + cj))
            removed.delete(clicked)      // the clicked cell survives, upgraded

            if (!game.apply(mi, mj)) throw new Error('The recorded replay contains an illegal move.')

            // Reconcile shapeAt with the compacted board: survivors keep their
            // shape (they only fall), the upgraded tile gains the new shape, and
            // the refilled cells at the top have none.
            const nextShapeAt = new Array(W * H).fill(null)
            for (let i = 0; i < W; i++) {
                const base = i * H
                let write = base
                for (let j = 0; j < H; j++) {
                    const k = base + j
                    if (removed.has(k)) continue
                    nextShapeAt[write++] = (k === clicked && makesSix) ? newShape : shapeAt[k]
                }
            }
            shapeAt = nextShapeAt
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

    // --- evaluation graph ---------------------------------------------------

    // The bot's depth-2 estimate of the final score reachable from a position
    // (banked score plus the value of its best move), AND the move it would play.
    // Computed together from one search so the eval, the dashed suggestion, and
    // the move played into a variation can never disagree. Deterministic argmax.
    function evalOf(cells, score) {
        const g = fromCells(cells, 1)
        if (g.gameOver) return { d2: score, move: null }
        const scored = graphAgent.scoreMoves(g)
        if (!scored.length) return { d2: score, move: null }
        let bv = -Infinity, bm = null
        for (const s of scored) if (s.value > bv) { bv = s.value; bm = s.move }
        return { d2: score + bv, move: bm }
    }

    // Both eval lines for the whole recorded game, up front. Yields so the page
    // stays responsive on a long replay.
    async function computeEvalSeries() {
        evalSeries = new Array(replayFrames.length)
        setLoadingMessage('Computing evaluation graph…')
        let slice = performance.now()
        for (let n = 0; n < replayFrames.length; n++) {
            const f = replayFrames[n]
            f.evalPt = evalOf(f.cells, f.score)
            evalSeries[n] = f.evalPt
            if (performance.now() - slice > 120) {
                drawGraph()
                await new Promise(resolve => setTimeout(resolve, 0))
                slice = performance.now()
            }
        }
        clearLoadingMessage()
        keyMoments = refineKeyMoments(findKeyMoments(evalSeries.map(p => p.d2)))
        updateGraphVisibility()          // reveal the graph (or keep the slider)
    }

    // Centred moving average, to average out the per-move noise before looking
    // for trends.
    function smoothSeries(vals, radius) {
        const out = new Array(vals.length)
        for (let i = 0; i < vals.length; i++) {
            let s = 0, c = 0
            for (let k = Math.max(0, i - radius); k <= Math.min(vals.length - 1, i + radius); k++) { s += vals[k]; c++ }
            out[i] = s / c
        }
        return out
    }

    // The onset of every sharp downward turn. On the smoothed curve S, the
    // discrete second derivative d2[n] = S[n+w] - 2 S[n] + S[n-w] is most negative
    // at the sharpest concave-down knees -- which is where a steep slide begins,
    // as opposed to a gently rounded top. A knee is kept when it clears CURV_MIN,
    // is a local minimum of d2 (the sharpest point of its turn), and is followed
    // by a genuine fall of DROP_MIN within DROP_WIN moves (so the top of a rise
    // into a plateau, which is also concave-down, does not count). The reported
    // move is snapped to the raw local peak at the lip of the drop, and knees
    // closer than KEY_GAP are collapsed to the sharpest one.
    function findKeyMoments(series) {
        const N = series.length
        if (N < 2 * CURV_WIN + 1) return []
        const S = smoothSeries(series, SMOOTH_R)
        const d2 = new Array(N).fill(0)
        for (let n = CURV_WIN; n < N - CURV_WIN; n++) d2[n] = S[n + CURV_WIN] - 2 * S[n] + S[n - CURV_WIN]

        const hits = []
        for (let n = CURV_WIN; n < N - CURV_WIN; n++) {
            if (d2[n] >= -CURV_MIN) continue
            let localMin = true
            for (let o = n - 2; o <= n + 2; o++) if (o >= 0 && o < N && d2[o] < d2[n]) localMin = false
            if (!localMin) continue
            let mn = S[n]
            for (let m = n; m <= Math.min(N - 1, n + DROP_WIN); m++) if (S[m] < mn) mn = S[m]
            const drop = S[n] - mn
            if (drop < DROP_MIN) continue
            // Snap to the raw local peak at the lip of the drop.
            let bn = n, bv = series[n]
            for (let m = Math.max(0, n - 1); m <= Math.min(N - 1, n + CURV_WIN); m++) if (series[m] > bv) { bv = series[m]; bn = m }
            hits.push({ n: bn, d2: d2[n], drop })
        }
        // Rank by the size of the fall (the eval actually lost, the most
        // interpretable "how big a mistake"); suppress near-duplicates within
        // KEY_GAP, keep the ONSET_CAP biggest for the refinement stage.
        hits.sort((a, b) => b.drop - a.drop)
        const kept = []
        for (const h of hits) if (kept.every(x => Math.abs(x.n - h.n) >= KEY_GAP)) kept.push(h)
        return kept.slice(0, ONSET_CAP)
    }

    // The bot's move and the human's move at replay position n (both canonical).
    function botMoveAt(n) { return evalSeries[n] ? evalSeries[n].move : null }
    function humanMoveAt(n) {
        const f = replayFrames[n]
        return f && f.move ? canonicalMove(f.cells, f.move) : null
    }
    const sameMove = (a, b) => !!a && !!b && a[0] === b[0] && a[1] === b[1]

    // Snap an onset forward to the first move within DISAGREE_WIN where the bot
    // disagrees with the human; null if the bot agreed the whole window (the drop
    // was bad luck, not a decision the player got wrong).
    function firstDisagreement(n) {
        const end = Math.min(n + DISAGREE_WIN - 1, replayFrames.length - 1)
        for (let t = n; t <= end; t++) if (botMoveAt(t) && humanMoveAt(t) && !sameMove(botMoveAt(t), humanMoveAt(t))) return t
        return null
    }

    // How far the bot's OWN line falls below its starting eval over DD_PLIES
    // moves played from position m with the game's rng. A large fall means the
    // position was already lost, so the human's move there is not the mistake.
    function botLineDrawdown(m) {
        if (!evalSeries[m]) return 0
        const start = evalSeries[m].d2
        const game = gameFor(replayFrames[m])
        let worst = start
        for (let k = 0; k < DD_PLIES && !game.gameOver; k++) {
            const ev = evalOf(game.cells, game.score)
            if (ev.d2 < worst) worst = ev.d2
            if (!ev.move) break
            game.apply(ev.move[0], ev.move[1])
        }
        return start - worst
    }

    // Turn the raw onsets into shown key moments: disagreement snap, bad-luck and
    // lost-anyway filters, then the KEY_CAP biggest falls in move order.
    function refineKeyMoments(onsets) {
        const out = []
        for (const on of onsets) {
            const m = firstDisagreement(on.n)
            if (m === null) continue
            if (botLineDrawdown(m) >= DD_DROP) continue
            out.push({ n: m, drop: on.drop })
        }
        out.sort((a, b) => b.drop - a.drop)
        const kept = []
        for (const h of out) if (kept.every(x => Math.abs(x.n - h.n) >= KEY_GAP)) kept.push(h)
        const capped = kept.slice(0, KEY_CAP)
        capped.sort((a, b) => a.n - b.n)
        return capped
    }

    // Lazily fill in a variation frame's eval (variations grow one move at a
    // time, so this is cheap per call).
    function evalForFrame(frame) {
        if (!frame.evalPt) frame.evalPt = evalOf(frame.cells, frame.score)
        return frame.evalPt
    }

    // Match the graph backing store to its displayed size and the device pixel
    // ratio. Called on every draw so it also picks up visibility and resize.
    function sizeGraph() {
        const dpr = window.devicePixelRatio || 1
        const cssW = graphCanvas.clientWidth || 400
        const cssH = cssW * 150 / 400
        const w = Math.round(cssW * dpr), h = Math.round(cssH * dpr)
        if (graphCanvas.width !== w || graphCanvas.height !== h) { graphCanvas.width = w; graphCanvas.height = h }
        gctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    const MINWIN = 8                     // narrowest x window (moves) at max zoom

    // Plot the eval lines. The x range is a zoom window centred on the current
    // position (so scrubbing pans); the y range fits the values actually visible,
    // rounded out to whole thousands with a gridline at each. In a variation the
    // recorded lines fade and the variation's own lines are drawn bold from the
    // branch point, so the "what if" is read against the actual game it left.
    function drawGraph() {
        if (!evalSeries.length) return
        sizeGraph()
        const dpr = window.devicePixelRatio || 1
        const Wg = graphCanvas.width / dpr, Hg = graphCanvas.height / dpr
        const padL = 32, padR = 6, padT = 6, padB = 4
        const plotW = Wg - padL - padR, plotH = Hg - padT - padB
        const inVar = mode === 'variation' && variationFrames

        const lastReplay = replayFrames.length - 1
        const varEnd = inVar ? branchIndex + variationFrames.length - 1 : 0
        const axisMax = Math.max(lastReplay, varEnd, 1)
        const curX = inVar ? branchIndex + index : index

        // X zoom window, centred on the current position and clamped to the game.
        const windowW = Math.max(Math.min(MINWIN, axisMax), Math.min(axisMax, axisMax / graphZoom))
        let xStart = curX - windowW / 2
        if (xStart < 0) xStart = 0
        if (xStart + windowW > axisMax) xStart = axisMax - windowW
        const xEnd = xStart + windowW
        const i0 = Math.max(0, Math.floor(xStart)), i1 = Math.ceil(xEnd)

        // Y range: fit the visible depth-2 points, to whole 1000s.
        let lo = Infinity, hi = -Infinity
        const consider = p => {
            if (!p) return
            if (p.d2 < lo) lo = p.d2; if (p.d2 > hi) hi = p.d2
        }
        for (let i = i0; i <= i1 && i <= lastReplay; i++) consider(evalSeries[i])
        if (inVar) for (let i = 0; i < variationFrames.length; i++) {
            const g = branchIndex + i
            if (g >= i0 && g <= i1) consider(evalForFrame(variationFrames[i]))
        }
        if (!isFinite(lo)) { lo = 0; hi = 1000 }
        let yMin = Math.floor(lo / 1000) * 1000, yMax = Math.ceil(hi / 1000) * 1000
        if (yMax - yMin < 1000) yMax = yMin + 1000
        const xFor = g => padL + ((g - xStart) / windowW) * plotW
        const yFor = v => padT + (1 - (v - yMin) / (yMax - yMin)) * plotH
        // Geometry for hit-testing (scrub + snap-to-key-moment).
        graphView = { padL, plotW, xStart, windowW, axisMax, padT, plotH, yMin, yMax }

        gctx.clearRect(0, 0, Wg, Hg)

        // Gridlines + labels every 1000 points.
        gctx.font = '10px Roboto, sans-serif'
        gctx.textAlign = 'right'; gctx.textBaseline = 'middle'
        for (let g = yMin; g <= yMax; g += 1000) {
            const y = yFor(g)
            gctx.strokeStyle = '#e0e0e0'; gctx.lineWidth = 1
            gctx.beginPath(); gctx.moveTo(padL, y); gctx.lineTo(Wg - padR, y); gctx.stroke()
            gctx.fillStyle = '#999'; gctx.fillText(String(g), padL - 4, y)
        }

        // Clip to the plot area so panned lines do not spill over the labels.
        gctx.save()
        gctx.beginPath(); gctx.rect(padL, 0, plotW, Hg); gctx.clip()

        const drawLine = (getV, count, xOff, color, width, alpha) => {
            gctx.strokeStyle = color; gctx.lineWidth = width; gctx.globalAlpha = alpha
            gctx.beginPath()
            let started = false
            for (let i = 0; i < count; i++) {
                const v = getV(i); if (v == null) continue
                const x = xFor(xOff + i), y = yFor(v)
                if (started) gctx.lineTo(x, y); else { gctx.moveTo(x, y); started = true }
            }
            gctx.stroke(); gctx.globalAlpha = 1
        }

        const actAlpha = inVar ? 0.28 : 1
        const aFrom = Math.max(0, i0 - 1), aTo = Math.min(evalSeries.length, i1 + 2)
        drawLine(i => evalSeries[aFrom + i] && evalSeries[aFrom + i].d2, aTo - aFrom, aFrom, COL_DEPTH2, 1.5, actAlpha)

        // Key moments: a dot on the curve where each sustained decline begins.
        if (!inVar) for (const km of keyMoments) {
            if (km.n < i0 || km.n > i1 || !evalSeries[km.n]) continue
            gctx.fillStyle = COL_KEY
            gctx.beginPath(); gctx.arc(xFor(km.n), yFor(evalSeries[km.n].d2), 3.5, 0, 2 * Math.PI); gctx.fill()
        }

        if (inVar) {
            drawLine(i => evalForFrame(variationFrames[i]).d2, variationFrames.length, branchIndex, COL_DEPTH2, 2, 1)
            gctx.strokeStyle = '#111'; gctx.lineWidth = 1; gctx.globalAlpha = 0.35
            gctx.beginPath(); gctx.moveTo(xFor(branchIndex), padT); gctx.lineTo(xFor(branchIndex), Hg - padB); gctx.stroke()
            gctx.globalAlpha = 1
        }

        // Current-position marker (light) plus a dot where it meets the curve.
        gctx.strokeStyle = '#bbb'; gctx.lineWidth = 1
        gctx.beginPath(); gctx.moveTo(xFor(curX), padT); gctx.lineTo(xFor(curX), Hg - padB); gctx.stroke()
        const curPt = frames[index] ? evalForFrame(frames[index]) : null
        if (curPt) {
            gctx.fillStyle = COL_DEPTH2
            gctx.beginPath(); gctx.arc(xFor(curX), yFor(curPt.d2), 4, 0, 2 * Math.PI); gctx.fill()
            gctx.strokeStyle = '#fff'; gctx.lineWidth = 1.5; gctx.stroke()
        }
        gctx.restore()
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
        for (; ;) {
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
                    try { await idbDelete(REVIEW_WEIGHTS) } catch (_) { }   // drop a corrupt entry
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
        try { await idbPut(REVIEW_WEIGHTS, buffer) } catch (_) { }
        clearLoadingMessage()
        revealSuggestion()
        return network
    }

    async function review() {
        try {
            const weights = await loadReviewNetwork()
            graphAgent = createAgent(GRAPH_SPEC, { seed: 1, network: weights })
        } catch (error) {
            setLoadingMessage('Could not load the review bot (' + error.message + ').')
            return
        }
        await computeEvalSeries()          // eval graph + key moments
        if (playState === 'paused' && !animating) renderFrame()
    }

    // Show the graph when it is enabled and ready; otherwise fall back to the
    // move slider. The two are redundant, so only one is visible at a time.
    function updateGraphVisibility() {
        const graphShown = showGraph && evalSeries.length > 0
        el('graphWrap').classList.toggle('on', graphShown)
        el('timeline').hidden = graphShown || mode === 'variation'
        if (graphShown) drawGraph()
        if (frames[index]) updateLabels(frames[index])
    }

    // --- board model & drawing ----------------------------------------------

    function targetY(row) { return (H - 1 - row) * CELL }

    function buildBoard(cells, shapes) {
        const cols = []
        for (let i = 0; i < W; i++) {
            cols[i] = []
            for (let j = 0; j < H; j++) cols[i].push({ n: cells[i * H + j], y: targetY(j), vy: 0, shape: shapes ? shapes[i * H + j] : null })
        }
        return cols
    }

    // Set up the falling animation for playing `move` on `prevCells`, landing on
    // `nextCells`. Mirrors game.js's do()/refill() with the incoming values read
    // off nextCells rather than drawn from the RNG.
    function setupCollapse(prevCells, move, nextCells, nextShapes) {
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
                survivors.push({ n: nextCells[i * H + kept + t], y: -(t + 1) * CELL, vy: 0, shape: null })
            }
            cols[i] = survivors
            // Every tile takes its destination shape: survivors keep theirs, the
            // upgraded tile and the incoming tiles match the next frame.
            if (nextShapes) for (let j = 0; j < H; j++) cols[i][j].shape = nextShapes[i * H + j]
        }
        return cols
    }

    function drawBox(i, y, n, shape) {
        if (n === 0 || y <= -CELL) return
        const x = i * CELL
        ctx.fillStyle = boxColors[n]
        ctx.fillRect(x + INSET, y + INSET, CELL - 2 * INSET, CELL - 2 * INSET)
        if (n < 6) {
            ctx.fillStyle = 'rgba(255,255,255,0.9)'
            const metrics = ctx.measureText(String(n))
            const off = (metrics.actualBoundingBoxAscent - metrics.actualBoundingBoxDescent) / 2
            ctx.fillText(String(n), x + CELL / 2, y + CELL / 2 + off)
        } else if (shape && shape.length) {
            drawTileShape(x, y, shape)
        }
    }

    // Draw the polyomino a 6-tile was collapsed from, centred in the tile,
    // matching the main game's drawShape(shape, cx, cy, 9, 200).
    function drawTileShape(tileX, tileY, shape) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
        for (const [cx, cy] of shape) {
            if (cx < minX) minX = cx
            if (cx > maxX) maxX = cx
            if (cy < minY) minY = cy
            if (cy > maxY) maxY = cy
        }
        const cellSize = 9
        const pixelWidth = (maxX - minX + 1) * cellSize
        const pixelHeight = (maxY - minY + 1) * cellSize
        const startX = tileX + CELL / 2 - Math.floor(pixelWidth / 2)
        const startY = tileY + CELL / 2 - Math.floor(pixelHeight / 2)
        ctx.fillStyle = 'rgb(200,200,200)'
        for (const [cx, cy] of shape) {
            const xPos = startX + (cx - minX) * cellSize
            const yPos = startY + (cy - minY) * cellSize
            ctx.fillRect(xPos + 1, yPos + 1, cellSize - 2, cellSize - 2)
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
        for (let i = 0; i < W; i++) for (let j = 0; j < cols[i].length; j++) drawBox(i, cols[i][j].y, cols[i][j].n, cols[i][j].shape)
        if (primary) outlineMarker(cols, primary, false)
        if (secondary) outlineMarker(cols, secondary, true)
    }

    // The bot's suggested move at a frame: exactly the move evalOf computed for
    // the graph, so the dashed marker and the move played into a variation match.
    function suggestionFor(frame) {
        if (!showSuggestion || !frame || frame.over || !graphAgent) return null
        return evalForFrame(frame).move
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
        let text = mode === 'variation'
            ? (frame.over ? 'Game over · ' + frame.movesPlayed + ' moves' : 'Move ' + frame.movesPlayed)
            : 'Move ' + frame.movesPlayed + ' of ' + (frames.length - 1)
        // With the graph shown, the move label carries the eval too (the slider
        // and its bare move number are hidden).
        if (showGraph && evalSeries.length && !frame.over) {
            const pt = evalForFrame(frame)
            if (pt && pt.d2 != null) text += ', eval ' + Math.round(pt.d2)
        }
        el('move').textContent = text
    }

    // The settled render for the current frame. While advancing, only the move
    // about to be played shows; the bot's suggestion appears only when paused.
    function renderFrame() {
        const frame = frames[index]
        if (!frame) return
        animBoard = buildBoard(frame.cells, frame.shapes)
        // Show the suggestion on every displayed frame except during the rapid
        // skip-to-end jump, where a per-frame suggestion would be too costly.
        const m = markersFor(frame, !skipping)
        paint(animBoard, m.primary, m.secondary)
        updateLabels(frame)
        drawGraph()                      // update the marker / variation line (also while skipping)
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
    // stored; in a variation the next move is the bot's suggested move for the
    // frontier position -- the exact move shown as the dashed marker, so playing
    // forward always follows the highlighted suggestion. Returns false at the end
    // of the line (replay end, or variation game over).
    function ensureNext() {
        if (index < frames.length - 1) return true
        if (mode !== 'variation') return false
        const last = frames[frames.length - 1]
        if (last.over || !graphAgent) return false
        const move = evalForFrame(last).move
        if (!move) return false
        const game = gameFor(last)
        game.apply(move[0], move[1])
        last.move = move
        frames.push(capture(game, null))
        return true
    }

    // Animate one move forward (index already advanced by the caller path). The
    // bot's dashed suggestion is drawn during the fall (subject to the checkbox)
    // so the highlight appears before the animation ends.
    function animateForward(prev, next) {
        animBoard = setupCollapse(prev.cells, prev.move, next.cells, next.shapes)
        const m = markersFor(next, true)
        animPrimary = m.primary
        animSecondary = m.secondary
        updateLabels(next)
        drawGraph()                      // move the position marker as each move plays
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
        el('ff').innerHTML = icon(playState === 'ff' ? 'pause' : 'fastForward')
        el('ff').classList.toggle('active', playState === 'ff')
        el('last').innerHTML = icon(skipping ? 'pause' : 'skipForward')
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
        if (skipping) { stopPlayback(); renderFrame(); return }
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
        el('reviewer').textContent = 'Game by ' + branchName
        applyModeUI()
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
        updateGraphVisibility()
    }

    // --- wiring -------------------------------------------------------------

    function wire() {
        el('back').innerHTML = icon('arrowLeft')
        el('share').innerHTML = icon('link')
        el('backMove').innerHTML = icon('chevronLeft')
        el('step').innerHTML = icon('chevronRight')
        el('last').innerHTML = icon('skipForward')

        el('back').onclick = () => { window.location.href = 'index.html' }
        el('share').onclick = shareLink
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
            try { localStorage.setItem(SUGGESTION_KEY, showSuggestion ? '1' : '0') } catch (_) { }
            renderFrame()
        }

        const graphToggle = el('showGraph')
        graphToggle.checked = showGraph
        graphToggle.onchange = () => {
            showGraph = graphToggle.checked
            try { localStorage.setItem(GRAPH_KEY, showGraph ? '1' : '0') } catch (_) { }
            updateGraphVisibility()
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

        el('zoom').oninput = e => { graphZoom = Number(e.target.value); drawGraph() }

        // Graph pointer handling. A tap jumps to the point (snapping to a nearby
        // key moment); a drag while zoomed pans the view, keeping the move marker
        // centred; a drag while unzoomed scrubs to the cursor.
        const SNAP_X = 16, SNAP_Y = 16
        const cssOf = e => {
            const rect = graphCanvas.getBoundingClientRect()
            const cssW = graphCanvas.width / (window.devicePixelRatio || 1)
            return { x: (e.clientX - rect.left) / rect.width * cssW, y: (e.clientY - rect.top) / rect.height * (cssW * 150 / 400) }
        }
        const pxToMove = cssX => Math.round(graphView.xStart + (cssX - graphView.padL) / graphView.plotW * graphView.windowW)
        const goTo = target => {
            const clamped = Math.max(0, Math.min(graphView.axisMax, Math.round(target)))
            snap(mode === 'variation' ? clamped - branchIndex : clamped)
        }
        // Tap: jump to the move under the cursor, or to a key moment if the tap
        // landed close to its dot in both axes.
        const tapTo = (cssX, cssY) => {
            let target = pxToMove(cssX)
            if (mode !== 'variation') {
                const v = graphView
                let bestD = Infinity, bestN = null
                for (const km of keyMoments) {
                    if (!evalSeries[km.n]) continue
                    const dx = Math.abs(cssX - (v.padL + ((km.n - v.xStart) / v.windowW) * v.plotW))
                    const dy = Math.abs(cssY - (v.padT + (1 - (evalSeries[km.n].d2 - v.yMin) / (v.yMax - v.yMin)) * v.plotH))
                    if (dx <= SNAP_X && dy <= SNAP_Y && dx < bestD) { bestD = dx; bestN = km.n }
                }
                if (bestN !== null) target = bestN
            }
            goTo(target)
        }
        let drag = null
        graphCanvas.addEventListener('pointerdown', e => {
            if (!graphView) return
            const c = cssOf(e)
            drag = { x0: c.x, y0: c.y, center0: mode === 'variation' ? branchIndex + index : index, moved: false }
            try { graphCanvas.setPointerCapture(e.pointerId) } catch (_) { }
        })
        graphCanvas.addEventListener('pointermove', e => {
            if (!drag) return
            const c = cssOf(e)
            if (!drag.moved && Math.abs(c.x - drag.x0) < 4 && Math.abs(c.y - drag.y0) < 4) return
            drag.moved = true
            const zoomed = graphView.windowW < graphView.axisMax - 0.5
            if (zoomed) goTo(drag.center0 - (c.x - drag.x0) * (graphView.windowW / graphView.plotW))  // drag right -> earlier
            else goTo(pxToMove(c.x))                                                                   // unzoomed: scrub
        })
        const endDrag = e => {
            if (drag && !drag.moved) tapTo(drag.x0, drag.y0)   // a tap, not a drag
            drag = null
        }
        graphCanvas.addEventListener('pointerup', endDrag)
        graphCanvas.addEventListener('pointercancel', endDrag)

        applyModeUI()
    }

    // Copy a link to the current position: this review's URL with an `at` move
    // parameter (the branch point when inside a variation). Flip the icon to a
    // checkmark and show a short toast to confirm.
    let toastTimer = null, shareResetTimer = null
    function shareLink() {
        const at = mode === 'variation' ? branchIndex : index
        const p = new URLSearchParams(window.location.search)
        p.set('at', String(at))
        const url = window.location.origin + window.location.pathname + '?' + p.toString()
        const done = () => {
            el('share').innerHTML = icon('check')
            const toast = el('toast')
            toast.hidden = false
            toast.style.opacity = '1'
            clearTimeout(toastTimer)
            toastTimer = setTimeout(() => {
                toast.style.opacity = '0'
                setTimeout(() => { toast.hidden = true }, 300)
            }, 1600)
            clearTimeout(shareResetTimer)
            shareResetTimer = setTimeout(() => { el('share').innerHTML = icon('link') }, 1600)
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(url).then(done, done)
        } else {
            const ta = document.createElement('textarea')
            ta.value = url; document.body.appendChild(ta); ta.select()
            try { document.execCommand('copy') } catch (_) { }
            document.body.removeChild(ta); done()
        }
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
        // Open on the shared move, if any.
        if (Number.isFinite(replay.at)) index = Math.max(0, Math.min(replayFrames.length - 1, replay.at))
        try { showSuggestion = localStorage.getItem(SUGGESTION_KEY) !== '0' } catch (_) { }
        try { showGraph = localStorage.getItem(GRAPH_KEY) !== '0' } catch (_) { }
        el('app').hidden = false
        el('reviewer').textContent = 'Game by ' + branchName
        el('scrub').max = frames.length - 1
        sizeCanvas()
        wire()
        updatePlayButtons()
        renderFrame()
        review()
    }

    start()
})()
