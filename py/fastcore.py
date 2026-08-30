"""Numba-jitted hot core for training: value, update, features, freeze, and a
whole-episode TD(0) runner that releases the GIL so many threads can Hogwild on
one shared weight array.

Everything here operates on flat numpy arrays and compile-time-constant tuple
tables, mirroring bot/ntuple.js + bot/engine.js + bot/freeze.js. The pure-Python
ntuple.py/engine.py stay as the readable reference and the parity oracle; this
module must produce identical numbers (py/verify_parity.py checks it).

If numba is unavailable, importing this module raises; train.py falls back to a
numpy path with a warning.
"""

import numpy as np
from numba import njit

V = 7
BOARD = 25
INPUT = 47
M = 4294967296
LCG_A = 1664525
LCG_C = 1013904223
W = H = 5

# Global virtual-cell indices (must match ntuple.js / ntuple.py).
ZEROES, FIVES, SIXES, FIVE_COMP, EXPOSED, LEGAL, LEGAL_NO6 = 25, 26, 27, 28, 29, 30, 31
HEIGHT0 = 32
MAXCHAIN0 = 37   # MAXCHAIN1 lives here (value 1); value v -> MAXCHAIN0 + (v-1)
SURF0 = 42


@njit(cache=True, nogil=True)
def _chain_at(cells, start, stamp, stack, chain, sid):
    n = cells[start]
    sp = 0
    ln = 0
    stack[0] = start
    sp = 1
    stamp[start] = sid
    while sp > 0:
        sp -= 1
        k = stack[sp]
        chain[ln] = k
        ln += 1
        i = k // H
        j = k - i * H
        if j < H - 1 and cells[k + 1] == n and stamp[k + 1] != sid:
            stamp[k + 1] = sid; stack[sp] = k + 1; sp += 1
        if j > 0 and cells[k - 1] == n and stamp[k - 1] != sid:
            stamp[k - 1] = sid; stack[sp] = k - 1; sp += 1
        if i > 0 and cells[k - H] == n and stamp[k - H] != sid:
            stamp[k - H] = sid; stack[sp] = k - H; sp += 1
        if i < W - 1 and cells[k + H] == n and stamp[k + H] != sid:
            stamp[k + H] = sid; stack[sp] = k + H; sp += 1
    return ln


@njit(cache=True, nogil=True)
def prepare(cells, out, need_chain, need_surf, seen):
    for k in range(BOARD):
        out[k] = cells[k]
    holes = 0; sixes = 0; exposed = 0; fiveN = 0; fiveAdj = 0; fiveSq = 0
    legal = 0; legalNo6 = 0
    for i in range(W):
        for j in range(H):
            k = i * H + j
            v = cells[k]
            if v == 0:
                holes += 1
                continue
            if v == 6:
                sixes += 1
                non6 = 0
                if i > 0 and cells[k - H] != 6:
                    non6 += 1
                if i + 1 < W and cells[k + H] != 6:
                    non6 += 1
                if j > 0 and cells[k - 1] != 6:
                    non6 += 1
                if j + 1 < H and cells[k + 1] != 6:
                    non6 += 1
                if non6 >= 3:
                    exposed += 1
                continue
            if v == 5:
                fiveN += 1
                up = j + 1 < H and cells[k + 1] == 5
                right = i + 1 < W and cells[k + H] == 5
                if up:
                    fiveAdj += 1
                if right:
                    fiveAdj += 1
                if up and right and cells[k + H + 1] == 5:
                    fiveSq += 1
            if j == 0 or cells[k - 1] != v:
                if ((j + 1 < H and cells[k + 1] == v) or
                        (i > 0 and cells[k - H] == v) or
                        (i + 1 < W and cells[k + H] == v)):
                    legal += 1
                    if v <= 4:
                        legalNo6 += 1
    for i in range(W):
        hi = 0
        for j in range(H):
            if cells[i * H + j] == 6:
                hi = j + 1
        out[HEIGHT0 + i] = hi
    if need_surf:
        for i in range(W):
            hi = 0
            for j in range(H):
                if cells[i * H + j] != 0:
                    hi = j + 1
            out[SURF0 + i] = hi
    if need_chain:
        for s in range(BOARD):
            seen[s] = 0
        mc0 = 0; mc1 = 0; mc2 = 0; mc3 = 0; mc4 = 0
        for s in range(BOARD):
            v = cells[s]
            if seen[s] or v < 1 or v > 5:
                continue
            # iterative flood fill reusing `seen`; a tiny explicit stack
            top = 0
            stack0 = s
            seen[s] = 1
            size = 0
            # emulate a stack with array positions in `out`? use locals via list
            # numba: use a fixed local array
            st = np.empty(BOARD, np.int64)
            st[0] = s
            top = 1
            while top > 0:
                top -= 1
                kk = st[top]
                size += 1
                i = kk // H
                j = kk - i * H
                if j + 1 < H and seen[kk + 1] == 0 and cells[kk + 1] == v:
                    seen[kk + 1] = 1; st[top] = kk + 1; top += 1
                if j > 0 and seen[kk - 1] == 0 and cells[kk - 1] == v:
                    seen[kk - 1] = 1; st[top] = kk - 1; top += 1
                if i + 1 < W and seen[kk + H] == 0 and cells[kk + H] == v:
                    seen[kk + H] = 1; st[top] = kk + H; top += 1
                if i > 0 and seen[kk - H] == 0 and cells[kk - H] == v:
                    seen[kk - H] = 1; st[top] = kk - H; top += 1
            if size >= 2:
                if v == 1 and size > mc0: mc0 = size
                elif v == 2 and size > mc1: mc1 = size
                elif v == 3 and size > mc2: mc2 = size
                elif v == 4 and size > mc3: mc3 = size
                elif v == 5 and size > mc4: mc4 = size
        out[MAXCHAIN0 + 0] = min(6, mc0 >> 1)
        out[MAXCHAIN0 + 1] = min(6, mc1 >> 1)
        out[MAXCHAIN0 + 2] = min(6, mc2 >> 1)
        out[MAXCHAIN0 + 3] = min(6, mc3 >> 1)
        out[MAXCHAIN0 + 4] = min(6, mc4 >> 1)
    fiveGroups = fiveN - fiveAdj + fiveSq
    out[ZEROES] = min(6, (holes - 1) // 2 if holes > 0 else 0)
    out[FIVES] = min(6, fiveN // 2)
    out[SIXES] = min(6, sixes // 2)
    out[FIVE_COMP] = min(3, max(0, fiveGroups))
    out[EXPOSED] = min(6, exposed)
    out[LEGAL] = min(6, legal)
    out[LEGAL_NO6] = min(6, legalNo6)


@njit(cache=True, nogil=True)
def value(feat, w, off, ln, wbase, tcells, tmcells, n, sym):
    total = 0.0
    for k in range(n):
        o = off[k]; L = ln[k]; b = wbase[k]
        a = 0; m = 0
        for cc in range(L):
            a = a * V + feat[tcells[o + cc]]
            if sym:
                m = m * V + feat[tmcells[o + cc]]
        if sym:
            total += w[b + a] + w[b + m]
        else:
            total += w[b + a]
    return total


@njit(cache=True, nogil=True)
def update(feat, w, off, ln, wbase, tcells, tmcells, n, sym, delta, train_from):
    if sym:
        d = delta / (2.0 * (n - train_from))
    else:
        d = delta / (n - train_from)
    for k in range(train_from, n):
        o = off[k]; L = ln[k]; b = wbase[k]
        a = 0; m = 0
        for cc in range(L):
            a = a * V + feat[tcells[o + cc]]
            if sym:
                m = m * V + feat[tmcells[o + cc]]
        if sym:
            w[b + a] += d
            w[b + m] += d
        else:
            w[b + a] += d


@njit(cache=True, nogil=True)
def freeze_board(cells, work, frozen):
    """Write frozen-1x1-pocket board of `cells` into `work` (both uint8[25])."""
    for k in range(BOARD):
        work[k] = cells[k]
    changed = True
    while changed:
        changed = False
        for k in range(BOARD):
            frozen[k] = 0
        for i in range(W):
            below_frozen = True
            for j in range(H):
                k = i * H + j
                if work[k] == 6:
                    frozen[k] = 1 if below_frozen else 0
                    below_frozen = frozen[k] == 1
                else:
                    below_frozen = False
        for i in range(W):
            for j in range(H):
                k = i * H + j
                v = work[k]
                if v < 1 or v > 5:
                    continue
                up = work[k + 1] if j + 1 < H else 6
                down = work[k - 1] if j > 0 else 6
                left = work[k - H] if i > 0 else 6
                right = work[k + H] if i + 1 < W else 6
                if up != 6 or down != 6 or left != 6 or right != 6:
                    continue
                if j > 0 and frozen[k - 1] == 0:
                    continue
                if i > 0 and frozen[k - H] == 0:
                    continue
                if i + 1 < W and frozen[k + H] == 0:
                    continue
                work[k] = 6
                changed = True


@njit(cache=True, nogil=True)
def _next_tile(rng, max_gen):
    rng = (rng * LCG_A + LCG_C) % M
    return rng, (max_gen * rng) // M + 1


@njit(cache=True, nogil=True)
def _refill_cols(cells, rng, max_gen):
    for i in range(W):
        base = i * H
        write = base
        for j in range(H):
            v = cells[base + j]
            if v != 0:
                cells[write] = v
                write += 1
        for t in range(base + H - write):
            rng, tile = _next_tile(rng, max_gen)
            cells[write + t] = tile
    return rng


@njit(cache=True, nogil=True)
def _apply_live(cells, k, rng, max_gen, stamp, stack, chain):
    n = cells[k]
    for x in range(BOARD):
        stamp[x] = 0
    lnc = _chain_at(cells, k, stamp, stack, chain, 1)
    gain = n * lnc
    for t in range(lnc):
        cells[chain[t]] = 0
    cells[k] = n + 1
    if n + 1 == 4:
        max_gen = 4
    rng = _refill_cols(cells, rng, max_gen)
    return rng, max_gen, gain


@njit(cache=True, nogil=True)
def _best_move(work, w, off, ln, wbase, tcells, tmcells, n, sym, need_chain, need_surf,
               feat, seen, stamp, stack, chain, after_buf, best_after):
    """Argmax (gain + value) over canonical moves of `work`; write the winning
    afterstate to best_after. Returns (best_k, best_gain). best_k = -1 if none."""
    for x in range(BOARD):
        stamp[x] = 0
    sid = 0
    best_v = -1e30
    best_k = -1
    best_gain = 0
    for i in range(W):
        for j in range(H):
            k = i * H + j
            nn = work[k]
            if nn < 1 or nn > 5:
                continue
            if not (j == 0 or work[k - 1] != work[k]):
                continue
            sid += 1
            lnc = _chain_at(work, k, stamp, stack, chain, sid)
            if lnc < 2:
                continue
            for x in range(BOARD):
                after_buf[x] = work[x]
            for t in range(lnc):
                after_buf[chain[t]] = 0
            after_buf[k] = nn + 1
            for ci in range(W):
                base = ci * H
                wr = base
                for jj in range(H):
                    vv = after_buf[base + jj]
                    if vv != 0:
                        after_buf[wr] = vv
                        wr += 1
                for wp in range(wr, base + H):
                    after_buf[wp] = 0
            prepare(after_buf, feat, need_chain, need_surf, seen)
            val = value(feat, w, off, ln, wbase, tcells, tmcells, n, sym) + nn * lnc
            if val > best_v:
                best_v = val
                best_k = k
                best_gain = nn * lnc
                for x in range(BOARD):
                    best_after[x] = after_buf[x]
    return best_k, best_gain


@njit(cache=True, nogil=True)
def run_episode(seeded, start_cells, seed, w, off, ln, wbase, tcells, tmcells, n, sym,
                need_chain, need_surf, freeze_root, train_from, alpha, max_moves, start_moves):
    """One TD(0) self-play episode, Hogwild-updating w in place. Returns
    (score, nmoves). Root-freeze applied to the board the net sees when
    freeze_root; the live game advances on the unfrozen board."""
    live = np.zeros(BOARD, np.uint8)
    work = np.empty(BOARD, np.uint8)
    frozen_buf = np.empty(BOARD, np.uint8)
    feat = np.zeros(INPUT, np.uint8)
    cfeat = np.zeros(INPUT, np.uint8)
    seen = np.empty(BOARD, np.uint8)
    stamp = np.zeros(BOARD, np.int64)
    stack = np.empty(BOARD, np.int64)
    chain = np.empty(BOARD, np.int64)
    after_buf = np.empty(BOARD, np.uint8)
    best_after = np.empty(BOARD, np.uint8)
    cur_after = np.empty(BOARD, np.uint8)

    rng = seed % M
    if seeded:
        for x in range(BOARD):
            live[x] = start_cells[x]
        mx = 0
        for x in range(BOARD):
            if live[x] > mx:
                mx = live[x]
        max_gen = 4 if mx > 3 else 3
        cap = start_moves if start_moves > 0 else max_moves
    else:
        max_gen = 3
        rng = _refill_cols(live, rng, max_gen)
        cap = max_moves

    if freeze_root:
        freeze_board(live, work, frozen_buf)
    else:
        for x in range(BOARD):
            work[x] = live[x]
    ck, cgain = _best_move(work, w, off, ln, wbase, tcells, tmcells, n, sym,
                           need_chain, need_surf, feat, seen, stamp, stack, chain,
                           after_buf, best_after)
    if ck < 0:
        return 0, 0
    for x in range(BOARD):
        cur_after[x] = best_after[x]

    score = 0
    nmoves = 0
    while nmoves < cap:
        rng, max_gen, gain = _apply_live(live, ck, rng, max_gen, stamp, stack, chain)
        score += gain
        nmoves += 1

        if freeze_root:
            freeze_board(live, work, frozen_buf)
        else:
            for x in range(BOARD):
                work[x] = live[x]
        nk, ngain = _best_move(work, w, off, ln, wbase, tcells, tmcells, n, sym,
                               need_chain, need_surf, feat, seen, stamp, stack, chain,
                               after_buf, best_after)
        if nk < 0:
            target = 0.0
        else:
            prepare(best_after, feat, need_chain, need_surf, seen)
            target = value(feat, w, off, ln, wbase, tcells, tmcells, n, sym) + ngain

        prepare(cur_after, cfeat, need_chain, need_surf, seen)
        val = value(cfeat, w, off, ln, wbase, tcells, tmcells, n, sym)
        update(cfeat, w, off, ln, wbase, tcells, tmcells, n, sym,
               alpha * (target - val), train_from)

        if nk < 0:
            break
        for x in range(BOARD):
            cur_after[x] = best_after[x]
        ck = nk
        cgain = ngain
    return score, nmoves
