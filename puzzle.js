// ============================================================================
// Stubs for game.js callbacks not needed in the puzzle player
// ============================================================================

function checkAchievements () {}
function updateStatisticsLive () {}

// ============================================================================
// State
// ============================================================================

let puzzleGrid
let initialState = null  // saved on puzzle load for Retry
let gameState = 'playing' // 'playing' | 'solved' | 'failed'

// ============================================================================
// p5.js Setup
// ============================================================================

function setup () {
  createCanvas(w * S, h * S)
  textAlign(CENTER, CENTER)
  textFont('Roboto')
  strokeWeight(2)

  puzzleGrid = new NumberGrid(w, h, 0, '', false, { noRefill: true, offsetY: 0 })

  const params = new URLSearchParams(window.location.search)
  const p = params.get('p')
  if (p && p.length === w * h) {
    applyState(p)
  } else {
    generatePuzzle()
  }
  initialState = captureState()

  document.getElementById('btn-next').addEventListener('click', () => {
    setGameState('playing')
    generatePuzzle()
  })
  document.getElementById('btn-retry').addEventListener('click', () => {
    setGameState('playing')
    restoreInitial()
    redraw()
  })

  noLoop()
}

// ============================================================================
// p5.js Draw Loop
// ============================================================================

function draw () {
  background(bgLight)
  puzzleGrid.draw()

  // Detect end state before drawing overlay so it shows in this same frame
  if (puzzleGrid.settled && gameState === 'playing') {
    checkEndState()
  }

  if (gameState === 'solved') {
    fill(255, 255, 255, 160)
    noStroke()
    rect(0, 0, w * S, h * S)
    fill(60, 180, 60)
    noStroke()
    textSize(120)
    text('\u2713', (w * S) / 2, (h * S) / 2)
  } else if (gameState === 'failed') {
    fill(255, 255, 255, 160)
    noStroke()
    rect(0, 0, w * S, h * S)
    fill(210, 50, 50)
    noStroke()
    textSize(100)
    text('\u2715', (w * S) / 2, (h * S) / 2)
  }

  if (puzzleGrid.settled) {
    noLoop()
  }
}

// ============================================================================
// Input Handler
// ============================================================================

function mousePressed () {
  if (gameState !== 'playing') return
  const [i, j] = puzzleGrid.getCoordinates(mouseX, mouseY)
  if (i < 0 || i >= puzzleGrid.w || j < 0 || j >= puzzleGrid.h) return
  puzzleGrid.do(i, j)
  loop()
}

// ============================================================================
// Win / Fail Detection
// ============================================================================

function checkEndState () {
  const totalTiles = Array.from({ length: puzzleGrid.w }, (_, i) =>
    Array.from({ length: puzzleGrid.h }, (_, j) => puzzleGrid[i][j].n)
  ).flat().filter(n => n > 0).length

  if (totalTiles <= 1) {
    setGameState('solved')
  } else if (puzzleGrid.noLegalMoves()) {
    setGameState('failed')
  }
}

function setGameState (state) {
  gameState = state
  document.getElementById('btn-next').style.visibility = state === 'solved' ? 'visible' : 'hidden'
  document.getElementById('btn-retry').style.visibility = state === 'failed' ? 'visible' : 'hidden'
}

// ============================================================================
// State Helpers
// ============================================================================

function encodeGrid () {
  let str = ''
  for (let i = 0; i < puzzleGrid.w; i++) {
    for (let j = 0; j < puzzleGrid.h; j++) {
      str += puzzleGrid[i][j].n
    }
  }
  return str
}

function captureState () {
  return Array.from({ length: puzzleGrid.w }, (_, i) =>
    Array.from({ length: puzzleGrid.h }, (_, j) => puzzleGrid[i][j].n)
  )
}

function applyState (str) {
  let k = 0
  for (let i = 0; i < puzzleGrid.w; i++) {
    for (let j = 0; j < puzzleGrid.h; j++) {
      puzzleGrid[i][j].n = parseInt(str[k++]) || 0
      puzzleGrid[i][j].y = puzzleGrid.offsetY + S * (puzzleGrid.h - 1 - j)
      puzzleGrid[i][j].vy = 0
    }
  }
}

function restoreInitial () {
  if (!initialState) return
  for (let i = 0; i < puzzleGrid.w; i++) {
    for (let j = 0; j < puzzleGrid.h; j++) {
      puzzleGrid[i][j].n = initialState[i][j]
      puzzleGrid[i][j].y = puzzleGrid.offsetY + S * (puzzleGrid.h - 1 - j)
      puzzleGrid[i][j].vy = 0
    }
  }
}

function saveToURL () {
  history.replaceState(null, '', '?p=' + encodeGrid())
}

// ============================================================================
// Generator
// ============================================================================

function gridToSolverState () {
  return Array.from({ length: puzzleGrid.w }, (_, i) =>
    Array.from({ length: puzzleGrid.h }, (_, j) => puzzleGrid[i][j].n).filter(v => v !== 0)
  )
}

function applySolverStateToGrid (solverState) {
  for (let i = 0; i < puzzleGrid.w; i++) {
    const col = solverState[i] || []
    for (let j = 0; j < puzzleGrid.h; j++) {
      puzzleGrid[i][j].n = j < col.length ? col[j] : 0
      puzzleGrid[i][j].y = puzzleGrid.offsetY + S * (puzzleGrid.h - 1 - j)
      puzzleGrid[i][j].vy = 0
    }
  }
}

function generatePuzzle () {
  const state = generateSolverState()
  if (state === null) return
  applySolverStateToGrid(state)
  initialState = captureState()
  saveToURL()
  redraw()
}
