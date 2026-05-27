// ============================================================================
// Stubs for game.js callbacks not needed in the editor
// ============================================================================

function checkAchievements () {}
function updateStatisticsLive () {}

// ============================================================================
// Editor State
// ============================================================================

let editorGrid
let savedState = null
let hintCells = new Set() // 'i,j' keys of cells in hint-worthy chains
let needsHintRefresh = false // set when a move with animation is pending

// ============================================================================
// p5.js Setup
// ============================================================================

function setup () {
  createCanvas(w * S, h * S)
  textAlign(CENTER, CENTER)
  textFont('Roboto')
  strokeWeight(2)

  // Create a 5×5 grid with no refill and no top-bar offset
  editorGrid = new NumberGrid(w, h, 0, '', false, {
    noRefill: true,
    offsetY: 0
  })

  // Load position from URL if present
  const params = new URLSearchParams(window.location.search)
  const p = params.get('p')
  if (p && p.length === w * h) {
    applyGridState(p)
    savedState = captureState()
  }

  document.getElementById('btn-save').addEventListener('click', savePosition)
  document.getElementById('btn-reset').addEventListener('click', resetToSaved)
  document.getElementById('btn-random').addEventListener('click', generateRandomPuzzle)
  document.getElementById('chk-hints').addEventListener('change', () => {
    refreshHints()
  })

  noLoop()
}

// ============================================================================
// p5.js Draw Loop
// ============================================================================

function draw () {
  background(bgLight)
  editorGrid.draw()

  // When the grid has just settled, compute hints in this same frame
  // so they are rendered below without needing an extra redraw().
  if (editorGrid.settled && needsHintRefresh) {
    needsHintRefresh = false
    if (document.getElementById('chk-hints').checked) computeHints()
    else hintCells = new Set()
  }

  // Draw hint highlights on good cells
  if (hintCells.size > 0) {
    noFill()
    stroke(0)
    strokeWeight(3)
    for (const key of hintCells) {
      const [i, j] = key.split(',').map(Number)
      const box = editorGrid[i][j]
      if (box && box.n > 0 && box.n < 6) {
        rect(box.x + 3, box.y + 3, S - 6, S - 6)
      }
    }
  }

  if (editorGrid.settled) {
    noLoop()
  }
}

// ============================================================================
// Input Handlers
// ============================================================================

function mousePressed () {
  let [i, j] = editorGrid.getCoordinates(mouseX, mouseY)
  if (i < 0 || i >= editorGrid.w || j < 0 || j >= editorGrid.h) return

  hintCells = new Set() // clear stale hints immediately so they don't show during animation
  needsHintRefresh = true
  editorGrid.do(i, j)
  loop()
}

function keyPressed () {
  let [i, j] = editorGrid.getCoordinates(mouseX, mouseY)
  if (i < 0 || i >= editorGrid.w || j < 0 || j >= editorGrid.h) return

  if (key === '0') {
    editorGrid[i][j].n = 0
    refreshHints()
  } else {
    let n = parseInt(key)
    if (!isNaN(n) && n >= 1 && n <= 6) {
      editorGrid[i][j].n = editorGrid[i][j].n === n ? 0 : n
      refreshHints()
    }
  }
}

// ============================================================================
// Save / Reset
// ============================================================================

// Encode grid as a 25-digit string, column-major bottom-to-top
function encodeGrid () {
  let str = ''
  for (let i = 0; i < editorGrid.w; i++) {
    for (let j = 0; j < editorGrid.h; j++) {
      str += editorGrid[i][j].n
    }
  }
  return str
}

function captureState () {
  const state = []
  for (let i = 0; i < editorGrid.w; i++) {
    state[i] = []
    for (let j = 0; j < editorGrid.h; j++) {
      state[i][j] = editorGrid[i][j].n
    }
  }
  return state
}

function applyGridState (str) {
  let k = 0
  for (let i = 0; i < editorGrid.w; i++) {
    for (let j = 0; j < editorGrid.h; j++) {
      editorGrid[i][j].n = parseInt(str[k++]) || 0
      editorGrid[i][j].y = editorGrid.offsetY + S * (editorGrid.h - 1 - j)
      editorGrid[i][j].vy = 0
    }
  }
}

function savePosition () {
  savedState = captureState()
  const encoded = encodeGrid()
  history.replaceState(null, '', '?p=' + encoded)
}

function resetToSaved () {
  if (!savedState) return
  for (let i = 0; i < editorGrid.w; i++) {
    for (let j = 0; j < editorGrid.h; j++) {
      editorGrid[i][j].n = savedState[i][j]
      editorGrid[i][j].y = editorGrid.offsetY + S * (editorGrid.h - 1 - j)
      editorGrid[i][j].vy = 0
    }
  }
  refreshHints()
}

// ============================================================================
// Puzzle Generator
// ============================================================================

function gridToSolverState () {
  return Array.from({ length: editorGrid.w }, (_, i) =>
    Array.from({ length: editorGrid.h }, (_, j) => editorGrid[i][j].n).filter(
      v => v !== 0
    )
  )
}

function applySolverStateToGrid (solverState) {
  for (let i = 0; i < editorGrid.w; i++) {
    const col = solverState[i] || []
    for (let j = 0; j < editorGrid.h; j++) {
      editorGrid[i][j].n = j < col.length ? col[j] : 0
      editorGrid[i][j].y = editorGrid.offsetY + S * (editorGrid.h - 1 - j)
      editorGrid[i][j].vy = 0
    }
  }
}

function generateRandomPuzzle () {
  const state = generateSolverState()
  if (state === null) return
  applySolverStateToGrid(state)
  savePosition()
  hintCells = new Set()
  refreshHints()
}

// ============================================================================
// Hints
// ============================================================================

// Returns the dense solver-column index for grid cell (colI, gridJ).
function gridToSolverJ (colI, gridJ) {
  let count = 0
  for (let j = 0; j < gridJ; j++) {
    if (editorGrid[colI][j].n !== 0) count++
  }
  return count
}

// Returns grid [i, j] pairs for the chain containing grid cell (startI, startJ).
function findChainGridCoords (startI, startJ) {
  const n = editorGrid[startI][startJ].n
  if (n === 0 || n > 5) return []

  const visited = new Set()
  const coords = []
  const stack = [[startI, startJ]]
  const key = (ci, cj) => ci * 10 + cj

  visited.add(key(startI, startJ))
  while (stack.length) {
    const [ci, cj] = stack.pop()
    coords.push([ci, cj])
    for (const [di, dj] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const ni = ci + di, nj = cj + dj
      if (ni >= 0 && ni < editorGrid.w && nj >= 0 && nj < editorGrid.h &&
          editorGrid[ni][nj]?.n === n && !visited.has(key(ni, nj))) {
        visited.add(key(ni, nj))
        stack.push([ni, nj])
      }
    }
  }
  return coords
}

function computeHints () {
  hintCells = new Set()
  const currentState = gridToSolverState()
  const memo = new Map()

  for (let i = 0; i < editorGrid.w; i++) {
    for (let j = 0; j < editorGrid.h; j++) {
      const n = editorGrid[i][j].n
      if (n < 1 || n > 5) continue

      const chainCoords = findChainGridCoords(i, j)
      if (chainCoords.length < 2) continue

      const sj = gridToSolverJ(i, j)
      const nextState = solverApplyMove(currentState, i, sj)
      const result = solveState(nextState, memo)

      if (result !== null) {
        hintCells.add(`${i},${j}`)
      }
    }
  }
}

// Recompute or clear hints depending on checkbox state, then redraw.
function refreshHints () {
  if (document.getElementById('chk-hints').checked) computeHints()
  else hintCells = new Set()
  redraw()
}
