"""N-tuple value network -- Python port of bot/ntuple.js (evaluation + training).

Only what the trainer needs: build a tuple set by name, read/write the CNTP
weight-file format, extract the global virtual-cell features (prepare), and
evaluate value(). The tuple ORDER and feature bucketing must match ntuple.js
byte-for-byte or the weight tables will not line up with a Node-trained file --
py/verify_parity.py checks exactly that against ground truth dumped from Node.

Kept deliberately close to the JS structure (same helper names, same iteration
order) so the two can be diffed by eye. Deployment tricks that only matter for
serving on a phone (int16 q16, selfOnce folding) are rejected here: training is
always float32 / sym / non-selfOnce.
"""

import json
import struct
import numpy as np

W, H, V = 5, 5, 7
BOARD = W * H


def idx(i, j):
    return i * H + j


# Global virtual-cell feature indices (must match ntuple.js GLOBAL).
G = {
    'ZEROES': BOARD + 0, 'FIVES': BOARD + 1, 'SIXES': BOARD + 2,
    'FIVE_COMP': BOARD + 3, 'EXPOSED': BOARD + 4, 'LEGAL': BOARD + 5,
    'LEGAL_NO6': BOARD + 6,
    'HEIGHT0': BOARD + 7, 'HEIGHT1': BOARD + 8, 'HEIGHT2': BOARD + 9,
    'HEIGHT3': BOARD + 10, 'HEIGHT4': BOARD + 11,
    'MAXCHAIN1': BOARD + 12, 'MAXCHAIN2': BOARD + 13, 'MAXCHAIN3': BOARD + 14,
    'MAXCHAIN4': BOARD + 15, 'MAXCHAIN5': BOARD + 16,
    'SURF0': BOARD + 17, 'SURF1': BOARD + 18, 'SURF2': BOARD + 19,
    'SURF3': BOARD + 20, 'SURF4': BOARD + 21,
}
INPUT_CELLS = BOARD + 22
HEIGHT0, SURF0 = G['HEIGHT0'], G['SURF0']

# ---- tuple sets ------------------------------------------------------------


def squares():
    t = []
    for i in range(W - 1):
        for j in range(H - 1):
            t.append([idx(i, j), idx(i + 1, j), idx(i, j + 1), idx(i + 1, j + 1)])
    return t


def runs(length):
    t = []
    for j in range(H):
        for i in range(W - length + 1):
            t.append([idx(i + k, j) for k in range(length)])
    for i in range(W):
        for j in range(H - length + 1):
            t.append([idx(i, j + k) for k in range(length)])
    return t


GVEC = [G['ZEROES'], G['FIVES'], G['SIXES'], G['FIVE_COMP'], G['EXPOSED']]
GVEC7 = [G['ZEROES'], G['FIVES'], G['SIXES'], G['FIVE_COMP'], G['EXPOSED'],
         G['LEGAL'], G['LEGAL_NO6']]
HEIGHTVEC = [G['HEIGHT0'], G['HEIGHT1'], G['HEIGHT2'], G['HEIGHT3'], G['HEIGHT4']]
CHAINVEC = [G['MAXCHAIN1'], G['MAXCHAIN2'], G['MAXCHAIN3'], G['MAXCHAIN4'], G['MAXCHAIN5']]
SURFVEC = [G['SURF0'], G['SURF1'], G['SURF2'], G['SURF3'], G['SURF4']]


def mini_hybrids():
    t = []
    for sq in squares() + runs(4):
        for g in GVEC:
            t.append(sq + [g])
    return t


def hybrids_of(shapes, gv):
    t = []
    for s in shapes:
        for g in gv:
            t.append(s + [g])
    return t


def height_dom_hybrids():
    t = []
    for i in range(W):
        for j in range(H - 1):
            t.append([i * H + j, i * H + j + 1, HEIGHT0 + i])
    for j in range(H):
        for i in range(W - 1):
            t.append([i * H + j, (i + 1) * H + j, HEIGHT0 + i, HEIGHT0 + i + 1])
    return t


def new_extras():
    t = []
    for i in range(W - 1):
        t.append([HEIGHT0 + i, HEIGHT0 + i + 1])
    for i in range(W - 1):
        t.append([SURF0 + i, SURF0 + i + 1])
    t.append(list(SURFVEC))
    t.append(list(CHAINVEC))
    t.append([G['MAXCHAIN5'], G['SIXES'], G['EXPOSED'], G['LEGAL'], G['ZEROES']])
    t.append([G['MAXCHAIN4'], G['MAXCHAIN5'], G['LEGAL'], G['LEGAL_NO6'], G['FIVE_COMP']])
    t.append([G['EXPOSED'], G['HEIGHT1'], G['HEIGHT2'], G['HEIGHT3'], G['SIXES']])
    t.append([G['SURF2'], G['EXPOSED'], G['SIXES'], G['LEGAL'], G['ZEROES']])
    return t


def _mini5_all7():
    return (runs(2) + runs(3) + runs(4) + runs(5) + squares()
            + [list(GVEC)] + mini_hybrids()
            + hybrids_of(squares() + runs(4), [G['LEGAL'], G['LEGAL_NO6']])
            + hybrids_of(runs(2), GVEC7)
            + [[G['ZEROES'], G['SIXES'], G['EXPOSED'], G['LEGAL'], G['LEGAL_NO6']]]
            + [list(HEIGHTVEC)] + height_dom_hybrids())


def _mini5_all7g():
    return (_mini5_all7()
            + [[G['HEIGHT2'], G['SIXES'], G['EXPOSED'], G['LEGAL'], G['ZEROES']]]
            + [[G['SIXES'], G['EXPOSED'], G['LEGAL'], G['LEGAL_NO6'], G['FIVE_COMP']]])


def _mini5_all7h():
    return _mini5_all7g() + new_extras()


_BASE_SETS = {
    'mini5_all7g': _mini5_all7g,
    'mini5_all7h': _mini5_all7h,
}


def mirror_cell(k):
    if k >= BOARD:
        if HEIGHT0 <= k <= HEIGHT0 + (W - 1):
            return HEIGHT0 + (W - 1) - (k - HEIGHT0)
        if SURF0 <= k <= SURF0 + (W - 1):
            return SURF0 + (W - 1) - (k - SURF0)
        return k
    return (W - 1 - (k // H)) * H + (k % H)


def mirror_reduce(tuples):
    def key(a):
        return ','.join(str(x) for x in sorted(a))
    index = {key(t): i for i, t in enumerate(tuples)}
    out, taken = [], set()
    for i, t in enumerate(tuples):
        if i in taken:
            continue
        taken.add(i)
        partner = index.get(key([mirror_cell(c) for c in t]))
        if partner is not None:
            taken.add(partner)
        out.append(t)
    return out


def build_set(name):
    """Return the tuple list for a set name (supports the 'r' reduced suffix)."""
    if name in _BASE_SETS:
        return _BASE_SETS[name]()
    if name.endswith('r') and name[:-1] in _BASE_SETS:
        return mirror_reduce(_BASE_SETS[name[:-1]]())
    raise ValueError('unknown/unsupported tuple set "%s"' % name)


# ---- packed representation -------------------------------------------------


class Packed:
    def __init__(self, tuples):
        self.n = len(tuples)
        self.off = np.zeros(self.n, np.int64)
        self.len = np.zeros(self.n, np.int64)
        self.wbase = np.zeros(self.n, np.int64)
        cells, mcells = [], []
        total = 0
        c = 0
        for ti, t in enumerate(tuples):
            self.off[ti] = c
            self.len[ti] = len(t)
            self.wbase[ti] = total
            for k in t:
                cells.append(k)
                mcells.append(mirror_cell(k))
                c += 1
            total += V ** len(t)
        self.cells = np.asarray(cells, np.int64)
        self.mcells = np.asarray(mcells, np.int64)
        self.size = total
        self.has_global = bool((self.cells >= BOARD).any())


_packed_cache = {}


def tuple_set(name):
    if name not in _packed_cache:
        _packed_cache[name] = Packed(build_set(name))
    return _packed_cache[name]


# ---- network ---------------------------------------------------------------


class Network:
    def __init__(self, weights, meta):
        if meta.get('selfOnce'):
            raise NotImplementedError('selfOnce files are deploy-only; train on the unreduced float32 net')
        self.set_name = meta['set']
        self.sym = bool(meta.get('sym'))
        self.tuples = meta.get('tuples')
        self.base_tuple_count = meta.get('baseTupleCount')
        self.t = Packed(self.tuples) if self.tuples is not None else tuple_set(self.set_name)
        if self.base_tuple_count is not None:
            self.base_tuple_count = int(self.base_tuple_count)
            if self.base_tuple_count < 0 or self.base_tuple_count > self.t.n:
                raise ValueError('baseTupleCount must be between 0 and %d' % self.t.n)
        if weights is None:
            weights = np.zeros(self.t.size, np.float32)
        if len(weights) != self.t.size:
            raise ValueError('weight file has %d weights; set "%s" needs %d'
                             % (len(weights), self.set_name, self.t.size))
        self.w = weights
        self.need_chain = bool(((self.t.cells >= G['MAXCHAIN1']) & (self.t.cells <= G['MAXCHAIN5'])).any())
        self.need_surf = bool(((self.t.cells >= G['SURF0']) & (self.t.cells <= G['SURF4'])).any())
        self._feat = np.zeros(INPUT_CELLS, np.uint8) if self.t.has_global else None

    def prepare(self, cells):
        """Materialise the global virtual cells. Mirrors ntuple.js prepare()."""
        if self._feat is None:
            return cells
        out = self._feat
        out[:BOARD] = cells
        holes = sixes = exposed = fiveN = fiveAdj = fiveSq = 0
        legal = legalNo6 = 0
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

        if self.need_surf:
            for i in range(W):
                hi = 0
                for j in range(H):
                    if cells[i * H + j] != 0:
                        hi = j + 1
                out[SURF0 + i] = hi

        if self.need_chain:
            seen = np.zeros(BOARD, np.uint8)
            mc = [0, 0, 0, 0, 0]
            for s in range(BOARD):
                v = cells[s]
                if seen[s] or v < 1 or v > 5:
                    continue
                stack = [s]
                seen[s] = 1
                size = 0
                while stack:
                    kk = stack.pop()
                    size += 1
                    i, j = kk // H, kk % H
                    if j + 1 < H and not seen[kk + 1] and cells[kk + 1] == v:
                        seen[kk + 1] = 1
                        stack.append(kk + 1)
                    if j > 0 and not seen[kk - 1] and cells[kk - 1] == v:
                        seen[kk - 1] = 1
                        stack.append(kk - 1)
                    if i + 1 < W and not seen[kk + H] and cells[kk + H] == v:
                        seen[kk + H] = 1
                        stack.append(kk + H)
                    if i > 0 and not seen[kk - H] and cells[kk - H] == v:
                        seen[kk - H] = 1
                        stack.append(kk - H)
                if size >= 2 and size > mc[v - 1]:
                    mc[v - 1] = size
            for vi in range(5):
                out[G['MAXCHAIN1'] + vi] = min(6, mc[vi] >> 1)

        fiveGroups = fiveN - fiveAdj + fiveSq
        out[G['ZEROES']] = min(6, ((holes - 1) // 2) if holes > 0 else 0)
        out[G['FIVES']] = min(6, fiveN // 2)
        out[G['SIXES']] = min(6, sixes // 2)
        out[G['FIVE_COMP']] = min(3, max(0, fiveGroups))
        out[G['EXPOSED']] = min(6, exposed)
        out[G['LEGAL']] = min(6, legal)
        out[G['LEGAL_NO6']] = min(6, legalNo6)
        return out

    def value(self, cells):
        c = self.prepare(cells)
        t = self.t
        w = self.w
        cell_idx = t.cells
        mcell_idx = t.mcells
        total = 0.0
        for k in range(t.n):
            o = int(t.off[k])
            length = int(t.len[k])
            b = int(t.wbase[k])
            a = 0
            m = 0
            for cc in range(length):
                a = a * V + int(c[cell_idx[o + cc]])
                if self.sym:
                    m = m * V + int(c[mcell_idx[o + cc]])
            if not self.sym:
                total += w[b + a]
            else:
                total += w[b + a] + w[b + m]
        return float(total)


# ---- CNTP file format ------------------------------------------------------

MAGIC = 0x50544E43  # 'CNTP' little-endian


def decode(buf):
    u8 = np.frombuffer(buf, np.uint8)
    meta = {'set': 'base', 'sym': False}
    offset = 0
    if len(u8) >= 8 and struct.unpack_from('<I', u8, 0)[0] == MAGIC:
        jlen = struct.unpack_from('<I', u8, 4)[0]
        text = bytes(u8[8:8 + jlen]).rstrip(b'\x00').decode()
        meta = json.loads(text)
        offset = 8 + jlen
    if meta.get('q16'):
        raise NotImplementedError('q16 (quantised) files are deploy-only; train on float32')
    weights = np.frombuffer(bytes(u8[offset:]), np.float32).copy()
    return Network(weights, meta)


def encode(net):
    meta = {'set': net.set_name, 'sym': net.sym}
    if net.tuples is not None:
        meta['tuples'] = net.tuples
    if net.base_tuple_count is not None:
        meta['baseTupleCount'] = net.base_tuple_count
    jb = json.dumps(meta, separators=(',', ':')).encode()
    pad = (4 - (len(jb) % 4)) % 4
    head = struct.pack('<II', MAGIC, len(jb) + pad) + jb + b'\x00' * pad
    return head + net.w.astype(np.float32).tobytes()


def load(path):
    with open(path, 'rb') as f:
        return decode(f.read())


def save(path, net):
    import os
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    with open(path, 'wb') as f:
        f.write(encode(net))
