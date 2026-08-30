"""Pure-Python (numpy-only, no numba) parity check against Node ground truth.

Confirms the tuple-set layout, feature extraction and value() match Node exactly
-- run this on the server after cloning to be sure the port lines up with the
weight file before committing a long run. Ground truth lives in _testvec.json
and _selfplay_ref.json (regenerate from Node with py/dump_testvec.js if the
architecture changes).
"""
import json, os, sys, time
import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
import ntuple as nt
import engine as E

HERE = os.path.dirname(__file__)
SEED = 'bot/weights/all7h-seed.bin'

net = nt.load(SEED)
print('set %s  tuples=%d  weights=%d  need_chain=%s need_surf=%s'
      % (net.set_name, net.t.n, net.t.size, net.need_chain, net.need_surf))

# 1. value() parity
d = json.load(open(os.path.join(HERE, '_testvec.json')))
assert net.t.size == d['wlen'], 'weight-count mismatch: port does not line up!'
maxd = 0.0
for b, vexp in zip(d['boards'], d['vals']):
    maxd = max(maxd, abs(net.value(np.array(b, np.uint8)) - vexp))
print('value: max |py - node| over %d boards = %.3g  %s'
      % (len(d['boards']), maxd, 'OK' if maxd < 1e-2 else 'FAIL'))

# 2. greedy self-play parity (engine + value + tie-break)
ref = {r[0]: (r[1], r[2]) for r in json.load(open(os.path.join(HERE, '_selfplay_ref.json')))}
ok = True
t0 = time.time()
for seed in sorted(ref)[:3]:            # 3 games: enough, and pure-Python is slow
    g = E.Game(seed)
    while not g.game_over:
        moves = E.expand(g.cells, g.max_gen)
        if not moves:
            break
        bv, bk = -1e30, -1
        for after, gain, ng, k in moves:
            v = gain + net.value(after)
            if v > bv:
                bv, bk = v, k
        g.apply(bk // 5, bk % 5)
    exp = ref[seed]
    m = (g.score == exp[0] and g.nmoves == exp[1])
    ok = ok and m
    print('  seed %d: py=(%d,%d) node=%s %s' % (seed, g.score, g.nmoves, exp, 'OK' if m else 'DIFF'))
print('self-play parity %s (%.0fs)' % ('OK' if ok else 'FAIL', time.time() - t0))
