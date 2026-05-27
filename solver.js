// ============================================================================
// Solver — shared between editor.js and puzzle.js
// All functions are pure: they take a solver state and return a new one.
// Solver state: array of w columns, each a dense array of tile values (no zeros),
// index 0 = bottom tile.
// ============================================================================

function solverGetChain (state, startI, startJ) {
  const n = state[startI][startJ]
  if (!n || n > 5) return []

  const visited = new Set()
  const stack = [[startI, startJ]]
  const key = (ci, cj) => ci * 10 + cj // safe for w,h <= 9
  visited.add(key(startI, startJ))

  while (stack.length) {
    const [ci, cj] = stack.pop()
    for (const [di, dj] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const ni = ci + di, nj = cj + dj
      if (
        ni >= 0 && ni < state.length &&
        nj >= 0 && nj < state[ni].length &&
        state[ni][nj] === n && !visited.has(key(ni, nj))
      ) {
        visited.add(key(ni, nj))
        stack.push([ni, nj])
      }
    }
  }
  return [...visited].map(k => [Math.floor(k / 10), k % 10])
}

function solverIsSolved (state) {
  return state.reduce((sum, col) => sum + col.length, 0) === 1
}

function solverApplyMove (state, clickI, clickJ) {
  const n = state[clickI][clickJ]
  const chain = solverGetChain(state, clickI, clickJ)
  const next = state.map(col => [...col])
  for (const [ci, cj] of chain) next[ci][cj] = 0
  next[clickI][clickJ] = n + 1
  return next.map(col => col.filter(v => v !== 0))
}

function solverFindMoves (state) {
  const seenStates = new Set()
  const moves = []
  for (let i = 0; i < state.length; i++) {
    for (let j = 0; j < state[i].length; j++) {
      const n = state[i][j]
      if (n < 1 || n > 5) continue
      const chain = solverGetChain(state, i, j)
      if (chain.length < 2) continue
      // Deduplicate by resulting state — different cells in the same chain
      // can place the upgraded tile at different positions, yielding distinct states.
      const next = solverApplyMove(state, i, j)
      const stateKey = next.map(col => col.join('.')).join('|')
      if (seenStates.has(stateKey)) continue
      seenStates.add(stateKey)
      moves.push([i, j])
    }
  }
  return moves
}

// Returns solution length (number of moves) or null if unsolvable.
// memo is shared across all recursive calls within one solve attempt.
function solveState (state, memo = new Map()) {
  if (solverIsSolved(state)) return 0
  const key = state.map(col => col.join('.')).join('|')
  if (memo.has(key)) return memo.get(key)
  const moves = solverFindMoves(state)
  if (moves.length === 0) { memo.set(key, null); return null }
  let result = null
  for (const [i, j] of moves) {
    const sub = solveState(solverApplyMove(state, i, j), memo)
    if (sub !== null) { result = sub + 1; break }
  }
  memo.set(key, result)
  return result
}

// Generates a random solvable solver state meeting the uniqueness constraint:
// exactly one solvable state is reachable from the initial position via one move
// (moves that produce the same resulting state are counted once), and the
// minimum solution requires at least 3 moves total.
// Returns the solver state array, or null if no puzzle found within MAX_ATTEMPTS.
function generateSolverState () {
  const MAX_ATTEMPTS = 10000
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const tileCount = 10 + Math.floor(Math.random() * 6) // 10-15 tiles
    const positions = Array.from({ length: w * h }, (_, k) => k)
    for (let k = positions.length - 1; k > 0; k--) {
      const r = Math.floor(Math.random() * (k + 1))
      ;[positions[k], positions[r]] = [positions[r], positions[k]]
    }
    const state = Array.from({ length: w }, () => [])
    for (const pos of positions.slice(0, tileCount)) {
      state[pos % w].push(Math.floor(Math.random() * 4) + 1)
    }

    // Count distinct first moves and how many lead to a solvable state
    const firstMoves = solverFindMoves(state)
    if (firstMoves.length === 0) continue
    const memo = new Map()
    let solvableCount = 0
    let solutionLength = 0
    for (const [i, j] of firstMoves) {
      const sub = solveState(solverApplyMove(state, i, j), memo)
      if (sub !== null) {
        solvableCount++
        solutionLength = sub + 1
      }
    }
    if (solvableCount === 1 && solutionLength >= 3) {
      console.log(`Puzzle found in ${attempt + 1} attempts, solution length: ${solutionLength}`)
      return state
    }
  }
  console.warn('Could not find a valid puzzle after', MAX_ATTEMPTS, 'attempts')
  return null
}
