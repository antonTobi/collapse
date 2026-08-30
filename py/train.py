#!/usr/bin/env python3
"""Parallel TD(0) trainer for the n-tuple value net -- Python port of the
minimal bot/ptrain.js recipe (Hogwild self-play, --freeze-prefix, --freeze-root,
--starts pool, alpha anneal, checkpoint/resume).

One command, e.g. (reproduces the current Node run on a 56-core box):

  python3 py/train.py --resume bot/weights/all7h-seed.bin --sym \
      --freeze-prefix mini5_all7gr --freeze-root \
      --starts bot/data/mut-starts.bin --start-frac 0.5 \
      --jobs 56 --episodes 3000000 --alpha 0.004 --alpha-end 0.001 \
      --checkpoint-every 200000 --checkpoint-dir bot/weights/all7h-py-ckpts \
      --out bot/weights/all7h-py.bin

Hogwild: every worker thread updates one shared float32 weight array with no
locks; the jitted episode runner releases the GIL so the threads run in
parallel. Writes are extremely sparse, so lost updates just look like a little
gradient noise (the standard Hogwild argument, same as ptrain.js).

Weight files are byte-compatible with Node's ntuple.js -- warm-start from a
Node-grown seed here, bring the trained .bin back to Node to evaluate/deploy.
"""

import argparse
import os
import struct
import sys
import threading
import time

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
import ntuple as nt

try:
    import fastcore as fc
except Exception as e:  # pragma: no cover
    print('FATAL: could not import the numba fastcore (%s).' % e, file=sys.stderr)
    print('Install numba into the venv:  pip install numba', file=sys.stderr)
    sys.exit(1)

CSTA = 0x41545343


def load_starts(path):
    with open(path, 'rb') as f:
        buf = f.read()
    magic, count = struct.unpack_from('<II', buf, 0)
    if magic != CSTA:
        raise ValueError('%s is not a CSTA start pool' % path)
    cells = np.frombuffer(buf, np.uint8, count * 25, 8).reshape(count, 25)
    return np.ascontiguousarray(cells)


def is_prefix(small, big):
    if small.n > big.n:
        return False
    if not np.array_equal(small.len, big.len[:small.n]):
        return False
    ncell = int(small.len.sum())
    return np.array_equal(small.cells[:ncell], big.cells[:ncell])


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument('--resume')
    p.add_argument('--set', default='mini5_all7hr')
    p.add_argument('--sym', action='store_true')
    p.add_argument('--freeze-prefix', dest='freeze_prefix')
    p.add_argument('--freeze-root', dest='freeze_root', action='store_true')
    p.add_argument('--starts')
    p.add_argument('--start-frac', dest='start_frac', type=float, default=0.5)
    p.add_argument('--start-moves', dest='start_moves', type=int, default=0)
    p.add_argument('--jobs', type=int, default=8)
    p.add_argument('--episodes', type=int, default=1000000)
    p.add_argument('--alpha', type=float, default=0.004)
    p.add_argument('--alpha-end', dest='alpha_end', type=float, default=0.0)
    p.add_argument('--max-moves', dest='max_moves', type=int, default=20000)
    p.add_argument('--report', type=int, default=50000)
    p.add_argument('--checkpoint-every', dest='checkpoint_every', type=int, default=0)
    p.add_argument('--checkpoint-dir', dest='checkpoint_dir')
    p.add_argument('--out', default='bot/weights/ptd-py.bin')
    p.add_argument('--seed-base', dest='seed_base', type=int, default=2000000)
    return p.parse_args()


def main():
    a = parse_args()
    try:
        sys.stdout.reconfigure(line_buffering=True)   # live progress when redirected
    except Exception:
        pass

    if a.resume:
        net = nt.load(a.resume)
        if a.sym and not net.sym:
            net.sym = True
    else:
        net = nt.Network(None, {'set': a.set, 'sym': a.sym})
    meta_set = net.set_name

    train_from = 0
    if a.freeze_prefix:
        if not a.resume:
            print('--freeze-prefix needs a grown --resume network', file=sys.stderr); sys.exit(1)
        small, big = nt.tuple_set(a.freeze_prefix), nt.tuple_set(meta_set)
        if small.n >= big.n or not is_prefix(small, big):
            print('set "%s" is not a strict prefix of "%s"' % (a.freeze_prefix, meta_set), file=sys.stderr)
            sys.exit(1)
        train_from = small.n

    t = net.t
    off = np.ascontiguousarray(t.off, np.int64)
    ln = np.ascontiguousarray(t.len, np.int64)
    wbase = np.ascontiguousarray(t.wbase, np.int64)
    tcells = np.ascontiguousarray(t.cells, np.int64)
    tmcells = np.ascontiguousarray(t.mcells, np.int64)
    n, sym = t.n, net.sym
    nc, ns = net.need_chain, net.need_surf
    w = np.ascontiguousarray(net.w, np.float32)   # THE shared table
    net.w = w

    pool = load_starts(a.starts) if a.starts else None
    pool_n = len(pool) if pool is not None else 0

    print('set=%s sym=%s weights=%d jobs=%d%s%s%s' % (
        meta_set, sym, len(w), a.jobs,
        ('  freeze-prefix=%s (%d tuples)' % (a.freeze_prefix, train_from)) if train_from else '',
        '  freeze-root' if a.freeze_root else '',
        ('  starts=%d (%.0f%%)' % (pool_n, 100 * a.start_frac)) if pool_n else ''))

    def alpha_at(frac):
        if a.alpha_end > 0:
            return a.alpha * (a.alpha_end / a.alpha) ** frac
        return a.alpha

    # Warm up the JIT once (single thread) so workers don't all compile at once.
    fc.run_episode(False, np.zeros(25, np.uint8), 1, w.copy(), off, ln, wbase, tcells, tmcells,
                   n, sym, nc, ns, a.freeze_root, train_from, 0.0, 50, 0)

    lock = threading.Lock()
    state = {'next': 0, 'done': 0, 'seeded': 0, 'recent': [], 'sum': 0.0}
    dummy = np.zeros(25, np.uint8)
    t0 = time.time()

    def worker(tid):
        rng = np.random.default_rng(1234567 + tid)
        while True:
            with lock:
                ep = state['next']
                if ep >= a.episodes:
                    return
                state['next'] += 1
            seeded = pool_n > 0 and rng.random() < a.start_frac
            if seeded:
                start = np.ascontiguousarray(pool[rng.integers(pool_n)], np.uint8)
            else:
                start = dummy
            alpha = alpha_at(ep / a.episodes)
            score, _ = fc.run_episode(seeded, start, a.seed_base + ep, w, off, ln, wbase,
                                      tcells, tmcells, n, sym, nc, ns, a.freeze_root,
                                      train_from, alpha, a.max_moves, a.start_moves)
            with lock:
                state['done'] += 1
                if seeded:
                    state['seeded'] += 1
                else:
                    state['recent'].append(score)
                    state['sum'] += score
                    if len(state['recent']) > 4000:
                        state['sum'] -= state['recent'].pop(0)

    threads = [threading.Thread(target=worker, args=(k,), daemon=True) for k in range(a.jobs)]
    for th in threads:
        th.start()

    next_report = a.report
    next_ckpt = a.checkpoint_every if a.checkpoint_every else a.episodes + 1
    while any(th.is_alive() for th in threads):
        time.sleep(0.5)
        with lock:
            done = state['done']
            mean = state['sum'] / len(state['recent']) if state['recent'] else 0.0
            seeded = state['seeded']
        if done >= next_report:
            el = time.time() - t0
            print('ep %d (%d seeded)  mean(last %d) %.0f  alpha %.4f  %ds  %.0f ep/s'
                  % (done, seeded, min(4000, done - seeded), mean, alpha_at(done / a.episodes),
                     el, done / el))
            next_report += a.report
        if done >= next_ckpt and a.checkpoint_dir:
            os.makedirs(a.checkpoint_dir, exist_ok=True)
            ck = os.path.join(a.checkpoint_dir, 'ck-ep%d.bin' % done)
            nt.save(ck, net)
            print('checkpoint %s' % ck)
            next_ckpt += a.checkpoint_every

    for th in threads:
        th.join()
    nt.save(a.out, net)
    print('saved %s (%d tuples, %d weights)' % (a.out, n, len(w)))


if __name__ == '__main__':
    main()
