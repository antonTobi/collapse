"""Collapse engine -- Python port of bot/engine.js.

Board: flat uint8[25], k = i*H + j, i = column (0 left), j = row (0 BOTTOM).
0 empty, 1..5 collapsible, 6 finished (never clickable). Normal boards are full.

Faithful to the JS default LCG tile generator, so a game played from a given
seed matches Node move-for-move (py/verify_selfplay.py checks this). expand()
is the training hot path: the FILL_NONE afterstates (collapse + gravity, holes
as zeros at the column tops) that the value net scores, with their gains.
"""

import numpy as np

W = H = 5
BOARD = W * H
M = 4294967296
A = 1664525
C = 1013904223


def _chain_at(cells, start, stamp, stack, chain, stamp_id):
    """Flood-fill equal values from `start`; fill `chain`, return its length."""
    n = cells[start]
    sp = 0
    ln = 0
    stack[sp] = start
    sp += 1
    stamp[start] = stamp_id
    while sp:
        sp -= 1
        k = stack[sp]
        chain[ln] = k
        ln += 1
        i = k // H
        j = k - i * H
        if j < H - 1 and cells[k + 1] == n and stamp[k + 1] != stamp_id:
            stamp[k + 1] = stamp_id; stack[sp] = k + 1; sp += 1
        if j > 0 and cells[k - 1] == n and stamp[k - 1] != stamp_id:
            stamp[k - 1] = stamp_id; stack[sp] = k - 1; sp += 1
        if i > 0 and cells[k - H] == n and stamp[k - H] != stamp_id:
            stamp[k - H] = stamp_id; stack[sp] = k - H; sp += 1
        if i < W - 1 and cells[k + H] == n and stamp[k + H] != stamp_id:
            stamp[k + H] = stamp_id; stack[sp] = k + H; sp += 1
    return ln


class Game:
    def __init__(self, seed):
        self.seed = seed
        self.rng_state = seed % M
        self.max_gen = 3
        self.score = 0
        self.cells = np.zeros(BOARD, np.uint8)
        self.nmoves = 0
        self._stamp = np.zeros(BOARD, np.int32)
        self._stack = np.zeros(BOARD, np.int32)
        self._chain = np.zeros(BOARD, np.int32)
        self._sid = 0
        self.refill()
        self.game_over = not self.has_legal_move()

    def next_tile(self):
        self.rng_state = (self.rng_state * A + C) % M
        return (self.max_gen * self.rng_state) // M + 1

    def refill(self):
        cells = self.cells
        for i in range(W):
            base = i * H
            write = base
            for j in range(H):
                v = cells[base + j]
                if v != 0:
                    cells[write] = v
                    write += 1
            for t in range(base + H - write):
                cells[write + t] = self.next_tile()

    def _cid(self):
        self._sid += 1
        return self._sid

    def has_legal_move(self):
        cells = self.cells
        for i in range(W):
            for j in range(H):
                k = i * H + j
                n = cells[k]
                if n < 1 or n > 5:
                    continue
                if not (j == 0 or cells[k - 1] != cells[k]):
                    continue
                if _chain_at(cells, k, self._stamp, self._stack, self._chain, self._cid()) >= 2:
                    return True
        return False

    def legal_moves(self):
        cells = self.cells
        out = []
        for i in range(W):
            for j in range(H):
                k = i * H + j
                n = cells[k]
                if n < 1 or n > 5:
                    continue
                if not (j == 0 or cells[k - 1] != cells[k]):
                    continue
                if _chain_at(cells, k, self._stamp, self._stack, self._chain, self._cid()) >= 2:
                    out.append((i, j))
        return out

    def apply(self, i, j):
        cells = self.cells
        k = i * H + j
        n = int(cells[k])
        if n < 1 or n > 5:
            return 0
        ln = _chain_at(cells, k, self._stamp, self._stack, self._chain, self._cid())
        if ln < 2:
            return 0
        gain = n * ln
        self.score += gain
        for t in range(ln):
            cells[self._chain[t]] = 0
        cells[k] = n + 1
        if n + 1 == 4:
            self.max_gen = 4
        self.nmoves += 1
        self.refill()
        self.game_over = not self.has_legal_move()
        return gain


def from_cells(cells, seed=1):
    g = Game.__new__(Game)
    g.seed = seed
    g.rng_state = seed % M
    g.score = 0
    g.cells = np.asarray(cells, np.uint8).copy()
    g.nmoves = 0
    g._stamp = np.zeros(BOARD, np.int32)
    g._stack = np.zeros(BOARD, np.int32)
    g._chain = np.zeros(BOARD, np.int32)
    g._sid = 0
    mx = int(g.cells.max())
    g.max_gen = 4 if mx > 3 else 3
    g.game_over = not g.has_legal_move()
    return g


# ---- training hot path: FILL_NONE afterstates ------------------------------

_estamp = np.zeros(BOARD, np.int32)
_estack = np.zeros(BOARD, np.int32)
_echain = np.zeros(BOARD, np.int32)
_esid = [0]


def expand(cells, max_gen):
    """Every canonical legal move's FILL_NONE afterstate.

    Returns a list of (after_cells (uint8[25]), gain, next_gen, click_k). The
    afterstate is collapse + gravity with holes (zeros) compacted to the column
    tops -- exactly what the net is trained and evaluated on.
    """
    out = []
    for i in range(W):
        for j in range(H):
            k = i * H + j
            n = int(cells[k])
            if n < 1 or n > 5:
                continue
            if not (j == 0 or cells[k - 1] != cells[k]):
                continue
            _esid[0] += 1
            ln = _chain_at(cells, k, _estamp, _estack, _echain, _esid[0])
            if ln < 2:
                continue
            after = cells.copy()
            for t in range(ln):
                after[_echain[t]] = 0
            after[k] = n + 1
            # gravity: compact each column down, zeros to the top
            for ci in range(W):
                base = ci * H
                write = base
                for jj in range(H):
                    v = after[base + jj]
                    if v != 0:
                        after[write] = v
                        write += 1
                for w in range(write, base + H):
                    after[w] = 0
            next_gen = 4 if n + 1 == 4 else max_gen
            out.append((after, n * ln, next_gen, k))
    return out
