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
    p.add_argument('--freeze-first', dest='freeze_first', type=int, default=0,
                   help='train only tuples after the first N; for embedded/discovered tuple sets')
    p.add_argument('--freeze-root', dest='freeze_root', action='store_true')
    p.add_argument('--starts')
    p.add_argument('--start-frac', dest='start_frac', type=float, default=0.5)
    p.add_argument('--start-moves', dest='start_moves', type=int, default=0)
    p.add_argument('--jobs', type=int, default=8)
    p.add_argument('--episodes', type=int, default=1000000)
    p.add_argument('--alpha', type=float, default=0.004)
    p.add_argument('--alpha-end', dest='alpha_end', type=float, default=0.0)
    p.add_argument('--temp', type=float, default=0.0,
                   help='Boltzmann exploration temperature in points (0 = greedy). '
                        'Plays a value-weighted random move while keeping the TD target '
                        'greedy, broadening the trained state distribution.')
    p.add_argument('--temp-end', dest='temp_end', type=float, default=-1.0,
                   help='anneal --temp geometrically to this by end of run (default: '
                        'hold --temp constant). Set 0 to decay toward greedy.')
    p.add_argument('--max-moves', dest='max_moves', type=int, default=20000)
    p.add_argument('--report', type=int, default=50000)
    p.add_argument('--checkpoint-every', dest='checkpoint_every', type=int, default=0,
                   help='checkpoint every N episodes (games)')
    p.add_argument('--checkpoint-boards', dest='checkpoint_boards', type=int, default=0,
                   help='checkpoint every N boards (moves/TD-updates) instead of episodes. '
                        'Fairer unit when episode length varies (e.g. --temp shortens games), '
                        'so two runs are compared on equal training signal, not game count.')
    p.add_argument('--checkpoint-dir', dest='checkpoint_dir')
    p.add_argument('--out', default='bot/weights/ptd-py.bin')
    p.add_argument('--seed-base', dest='seed_base', type=int, default=2000000)
    p.add_argument('--interleave', dest='interleave', action='store_true', default=True,
                   help='spread the shared weight table across NUMA nodes (default on; '
                        'in-process equivalent of `numactl --interleave=all`)')
    p.add_argument('--no-interleave', dest='interleave', action='store_false')
    p.add_argument('--bench', nargs='?', const='auto', default=None,
                   help='benchmark throughput at several --jobs values and exit, instead '
                        'of training. Optional comma list, e.g. --bench 7,14,28 (default: '
                        'auto = quarter/half/all of os.cpu_count()).')
    p.add_argument('--bench-secs', dest='bench_secs', type=float, default=15.0,
                   help='measurement window per --jobs value in --bench mode')
    return p.parse_args()


_MPOL_DEFAULT = 0
_MPOL_INTERLEAVE = 3


def _numa_nodes():
    import glob
    return sorted(int(os.path.basename(p)[4:])
                  for p in glob.glob('/sys/devices/system/node/node[0-9]*'))


def _set_mempolicy(mode, nodes=None):
    """Thin ctypes wrapper over the Linux set_mempolicy(2) syscall. Returns True on
    success. INTERLEAVE needs the node list; DEFAULT restores first-touch placement."""
    if not sys.platform.startswith('linux'):
        return False
    try:
        import ctypes
        libc = ctypes.CDLL('libc.so.6', use_errno=True)
        if mode == _MPOL_INTERLEAVE:
            ulbits = ctypes.sizeof(ctypes.c_ulong) * 8
            nwords = (max(nodes) + ulbits) // ulbits       # room for the highest node id
            mask = (ctypes.c_ulong * nwords)()
            for nd in nodes:
                mask[nd // ulbits] |= 1 << (nd % ulbits)
            rc = libc.set_mempolicy(mode, mask, ctypes.c_ulong(nwords * ulbits))
        else:
            rc = libc.set_mempolicy(mode, None, 0)
        return rc == 0
    except Exception:
        return False


def alloc_shared_weights(net, want_interleave):
    """Return the one float32 weight table every worker hammers, placed for NUMA.

    On a multi-socket box the table otherwise parks on whichever node first touched
    it, so half the workers pay remote-access latency AND all table bandwidth hits a
    single memory controller. We interleave *only this array* across nodes (both
    controllers, symmetric latency) via a fresh faulted-under-MPOL_INTERLEAVE copy,
    then immediately restore MPOL_DEFAULT so each worker's thread-private scratch
    stays node-local (first-touch). Returns (w, nodes-or-None)."""
    if want_interleave and sys.platform.startswith('linux'):
        nodes = _numa_nodes()
        if len(nodes) >= 2 and _set_mempolicy(_MPOL_INTERLEAVE, nodes):
            w = np.ascontiguousarray(net.w, np.float32).copy()  # faults every page interleaved
            _set_mempolicy(_MPOL_DEFAULT)                       # scratch → node-local again
            return w, nodes
    return np.ascontiguousarray(net.w, np.float32), None


def run_bench(a, w, off, ln, wbase, tcells, tmcells, n, sym, nc, ns, pool, pool_n):
    """Throughput probe: for each --jobs value, run real episodes for a fixed window
    and print steady-state ep/s, then exit. No checkpoint/save. Finds the NUMA/HT knee
    without a wasted long run. The JIT is already warmed by the caller."""
    ncpu = os.cpu_count() or a.jobs
    if a.bench == 'auto':
        jobs_list = sorted({max(1, ncpu // 4), max(1, ncpu // 2), ncpu})
    else:
        jobs_list = [int(x) for x in a.bench.split(',') if x.strip()]
    warmup = 4.0
    dummy = np.zeros(25, np.uint8)
    print('bench: %.0fs window per setting (after %.0fs warmup), jobs=%s'
          % (a.bench_secs, warmup, jobs_list))
    for J in jobs_list:
        stop = threading.Event()
        lock = threading.Lock()
        cnt = {'n': 0}

        def worker(tid):
            rng = np.random.default_rng(424242 + tid)
            k = 0
            while not stop.is_set():
                seeded = pool_n > 0 and rng.random() < a.start_frac
                start = np.ascontiguousarray(pool[rng.integers(pool_n)], np.uint8) if seeded else dummy
                fc.run_episode(seeded, start, a.seed_base + tid * 1000000 + k, w, off, ln,
                               wbase, tcells, tmcells, n, sym, nc, ns, a.freeze_root,
                               0, a.alpha, a.max_moves, a.start_moves, a.temp)
                k += 1
                with lock:
                    cnt['n'] += 1

        threads = [threading.Thread(target=worker, args=(k,), daemon=True) for k in range(J)]
        for th in threads:
            th.start()
        time.sleep(warmup)
        with lock:
            base = cnt['n']
        t0 = time.time()
        time.sleep(a.bench_secs)
        with lock:
            got = cnt['n'] - base
        el = time.time() - t0
        stop.set()
        for th in threads:
            th.join()
        print('  jobs %3d  %6.0f ep/s  (%5.1f ep/s/job)' % (J, got / el, got / el / J))


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
    if a.freeze_prefix and a.freeze_first:
        print('--freeze-prefix and --freeze-first are alternatives', file=sys.stderr); sys.exit(1)
    if a.freeze_prefix:
        if not a.resume:
            print('--freeze-prefix needs a grown --resume network', file=sys.stderr); sys.exit(1)
        small, big = nt.tuple_set(a.freeze_prefix), nt.tuple_set(meta_set)
        if small.n >= big.n or not is_prefix(small, big):
            print('set "%s" is not a strict prefix of "%s"' % (a.freeze_prefix, meta_set), file=sys.stderr)
            sys.exit(1)
        train_from = small.n
    elif a.freeze_first:
        if not a.resume:
            print('--freeze-first needs --resume', file=sys.stderr); sys.exit(1)
        if a.freeze_first < 1 or a.freeze_first >= net.t.n:
            print('--freeze-first must leave at least one of %d tuples trainable' % net.t.n,
                  file=sys.stderr); sys.exit(1)
        train_from = a.freeze_first

    t = net.t
    off = np.ascontiguousarray(t.off, np.int64)
    ln = np.ascontiguousarray(t.len, np.int64)
    wbase = np.ascontiguousarray(t.wbase, np.int64)
    tcells = np.ascontiguousarray(t.cells, np.int64)
    tmcells = np.ascontiguousarray(t.mcells, np.int64)
    n, sym = t.n, net.sym
    nc, ns = net.need_chain, net.need_surf
    w, il_nodes = alloc_shared_weights(net, a.interleave)   # THE shared table
    net.w = w

    pool = load_starts(a.starts) if a.starts else None
    pool_n = len(pool) if pool is not None else 0

    print('set=%s sym=%s weights=%d jobs=%d%s%s%s' % (
        meta_set, sym, len(w), a.jobs,
        (('  freeze-prefix=%s (%d tuples)' % (a.freeze_prefix, train_from)) if a.freeze_prefix
         else ('  freeze-first=%d tuples' % train_from) if train_from else ''),
        '  freeze-root' if a.freeze_root else '',
        ('  starts=%d (%.0f%%)' % (pool_n, 100 * a.start_frac)) if pool_n else ''))
    if il_nodes:
        print('NUMA: shared weight table interleaved across nodes %s, worker scratch node-local'
              % il_nodes)
    if a.temp > 0:
        print('softmax exploration: temp %.1f%s (greedy TD target preserved)'
              % (a.temp, '' if a.temp_end < 0 else ' -> %.1f' % a.temp_end))

    def alpha_at(frac):
        if a.alpha_end > 0:
            return a.alpha * (a.alpha_end / a.alpha) ** frac
        return a.alpha

    def temp_at(frac):
        if a.temp <= 0:
            return 0.0
        if a.temp_end < 0:
            return a.temp                                   # hold constant
        if a.temp_end == 0:
            return a.temp * (1.0 - frac)                    # linear decay to greedy
        return a.temp * (a.temp_end / a.temp) ** frac       # geometric anneal

    # Warm up the JIT once (single thread) so workers don't all compile at once.
    fc.run_episode(False, np.zeros(25, np.uint8), 1, w.copy(), off, ln, wbase, tcells, tmcells,
                   n, sym, nc, ns, a.freeze_root, train_from, 0.0, 50, 0, 0.0)

    if a.bench is not None:
        run_bench(a, w, off, ln, wbase, tcells, tmcells, n, sym, nc, ns, pool, pool_n)
        return

    lock = threading.Lock()
    state = {'next': 0, 'done': 0, 'seeded': 0, 'recent': [], 'sum': 0.0, 'boards': 0}
    dummy = np.zeros(25, np.uint8)
    t0 = time.time()

    def write_checkpoint(name, done, boards):
        os.makedirs(a.checkpoint_dir, exist_ok=True)
        ck = os.path.join(a.checkpoint_dir, name)
        nt.save(ck, net)
        with open(os.path.join(a.checkpoint_dir, 'manifest.tsv'), 'a') as mf:
            mf.write('%s\t%d\t%d\n' % (name, done, boards))   # align evals by boards, not games
        print('checkpoint %s  (ep %d, boards %d)' % (ck, done, boards))

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
            frac = ep / a.episodes
            alpha = alpha_at(frac)
            score, nmoves = fc.run_episode(seeded, start, a.seed_base + ep, w, off, ln, wbase,
                                           tcells, tmcells, n, sym, nc, ns, a.freeze_root,
                                           train_from, alpha, a.max_moves, a.start_moves,
                                           temp_at(frac))
            with lock:
                state['done'] += 1
                state['boards'] += nmoves
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
    by_boards = a.checkpoint_boards > 0
    next_ckpt = (a.checkpoint_boards if by_boards
                 else (a.checkpoint_every if a.checkpoint_every else a.episodes + 1))
    while any(th.is_alive() for th in threads):
        time.sleep(0.5)
        with lock:
            done = state['done']
            boards = state['boards']
            mean = state['sum'] / len(state['recent']) if state['recent'] else 0.0
            seeded = state['seeded']
        if done >= next_report:
            el = time.time() - t0
            print('ep %d (%d seeded)  boards %d (%.0f/ep)  mean(last %d) %.0f  alpha %.4f  %ds  %.0f ep/s'
                  % (done, seeded, boards, boards / max(1, done), min(4000, done - seeded), mean,
                     alpha_at(done / a.episodes), el, done / el))
            next_report += a.report
        if a.checkpoint_dir and (boards if by_boards else done) >= next_ckpt:
            name = ('ck-bd%d.bin' % boards) if by_boards else ('ck-ep%d.bin' % done)
            write_checkpoint(name, done, boards)
            next_ckpt += a.checkpoint_boards if by_boards else a.checkpoint_every

    for th in threads:
        th.join()
    with lock:
        boards = state['boards']
    nt.save(a.out, net)
    print('saved %s (%d tuples, %d weights, %d episodes, %d boards)'
          % (a.out, n, len(w), state['done'], boards))


if __name__ == '__main__':
    main()
