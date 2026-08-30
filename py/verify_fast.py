"""Verify the numba fastcore against the pure-Python/Node oracles."""
import json, sys, time
import numpy as np
sys.path.insert(0, 'py')
import ntuple as nt
import fastcore as fc

net = nt.load('bot/weights/all7h-seed.bin')
t = net.t
off = t.off.astype(np.int64); ln = t.len.astype(np.int64); wbase = t.wbase.astype(np.int64)
tcells = t.cells.astype(np.int64); tmcells = t.mcells.astype(np.int64)
n = t.n; sym = net.sym; w = net.w.astype(np.float32)
nc, ns = net.need_chain, net.need_surf

# 1. value parity vs Node testvec
d = json.load(open('py/_testvec.json'))
feat = np.zeros(fc.INPUT, np.uint8); seen = np.empty(fc.BOARD, np.uint8)
maxd = 0.0
for b, vexp in zip(d['boards'], d['vals']):
    cells = np.array(b, np.uint8)
    fc.prepare(cells, feat, nc, ns, seen)
    v = fc.value(feat, w, off, ln, wbase, tcells, tmcells, n, sym)
    maxd = max(maxd, abs(v - vexp))
print('nb value: max |nb - node| over %d boards = %.6g  %s' % (len(d['boards']), maxd, 'OK' if maxd < 1e-2 else 'FAIL'))

# 2. greedy self-play (alpha=0 -> no weight change) vs Node reference
ref = {r[0]: (r[1], r[2]) for r in json.load(open('py/_selfplay_ref.json'))}
dummy = np.zeros(fc.BOARD, np.uint8)
t0 = time.time()
ok = True
for seed in range(1, 11):
    w2 = w.copy()  # alpha=0 won't change it, but keep runs independent
    score, nm = fc.run_episode(False, dummy, seed, w2, off, ln, wbase, tcells, tmcells, n, sym,
                               nc, ns, False, 0, 0.0, 100000, 0)
    exp = ref[seed]
    m = (score == exp[0] and nm == exp[1])
    ok = ok and m
    print('  seed %d: nb=(%d,%d) node=%s %s' % (seed, score, nm, exp, 'OK' if m else 'DIFF'))
print('self-play parity %s  (%.1fs incl compile)' % ('OK' if ok else 'FAIL', time.time() - t0))
