#!/usr/bin/env python3
"""Residual-guided discovery of missing two-cell n-tuples.

The corpus comes from bot/residual-corpus.js. Candidate tables are fitted only
to the within-position Bellman residual, cross-validated by complete game seed,
and ranked by held-out depth-2 teacher regret rather than raw value RMSE.

This first implementation deliberately searches all missing PAIRS only. The
selected pairs form the beam/seeds for a later size-3..5 expansion, but pairs
are cheap enough (at most C(47,2)=1081) to establish whether the signal exists
before building the larger search.
"""

import argparse
import itertools
import json
import os
import struct
import sys

import numpy as np

import ntuple as nt

MAGIC = 0x43545252
VERSION = 1


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument('--corpus', nargs='+', required=True,
                   help='one or more residual-corpus.bin files')
    p.add_argument('--out', required=True, help='selected tuple manifest JSON')
    p.add_argument('--exclude-set', default=None,
                   help='training tuple set whose existing pairs must be excluded; '
                        'default strips deployment compaction suffix c from corpus set')
    p.add_argument('--select', type=int, default=8,
                   help='maximum boosting rounds / selected pairs')
    p.add_argument('--beam', type=int, default=128,
                   help='pairs retained after the exhaustive first screen')
    p.add_argument('--folds', type=int, default=5)
    p.add_argument('--ridge', type=float, default=8.0,
                   help='pseudo-count shrinkage per table entry')
    p.add_argument('--epochs', type=int, default=5,
                   help='Jacobi/backfitting passes for a symmetric table')
    p.add_argument('--learning-rate', type=float, default=0.25)
    p.add_argument('--self-once', action='store_true',
                   help='fit self-mirrored tuples with compacted selfOnce semantics; '
                        'default matches ordinary float training nets')
    p.add_argument('--min-gain', type=float, default=0.01,
                   help='minimum held-out teacher-regret reduction per round')
    p.add_argument('--name', default='residual-pairs-v1')
    return p.parse_args()


def read_corpus(path):
    with open(path, 'rb') as f:
        data = f.read()
    if len(data) < 32:
        raise ValueError('%s is too short' % path)
    magic, version, nf, npos, ncand, topk, jlen, _ = struct.unpack_from('<8I', data, 0)
    if magic != MAGIC or version != VERSION:
        raise ValueError('%s is not residual corpus version %d' % (path, VERSION))
    meta = json.loads(data[32:32 + jlen].rstrip(b'\0').decode())
    at = 32 + jlen
    features, shallow, deep, pos_ids = [], [], [], []
    seeds, plies, offsets = [], [], [0]
    for p in range(npos):
        seed, ply, n = struct.unpack_from('<III', data, at)
        at += 12
        seeds.append(seed); plies.append(ply)
        for _ in range(n):
            at += 1  # canonical move cell; retained in the file for diagnostics
            features.append(np.frombuffer(data, np.uint8, nf, at).copy())
            at += nf
            q, qs = struct.unpack_from('<ff', data, at)
            at += 8
            shallow.append(q); deep.append(qs); pos_ids.append(p)
        offsets.append(len(features))
    if at != len(data):
        raise ValueError('%s has %d trailing bytes' % (path, len(data) - at))
    if len(features) != ncand:
        raise ValueError('%s header says %d candidates, decoded %d' %
                         (path, ncand, len(features)))
    return {
        'features': np.asarray(features, np.uint8),
        'shallow': np.asarray(shallow, np.float64),
        'deep': np.asarray(deep, np.float64),
        'pos': np.asarray(pos_ids, np.int32),
        'seeds': np.asarray(seeds, np.uint32),
        'plies': np.asarray(plies, np.uint32),
        'offsets': np.asarray(offsets, np.int64),
        'feature_count': nf, 'meta': meta, 'path': path
    }


def combine(parts):
    nf = parts[0]['feature_count']
    if any(p['feature_count'] != nf for p in parts):
        raise ValueError('all corpora must have the same feature count')
    feats, shallow, deep, pos, seeds, plies = [], [], [], [], [], []
    offsets = [0]
    poff = 0
    for p in parts:
        feats.append(p['features']); shallow.append(p['shallow']); deep.append(p['deep'])
        pos.append(p['pos'] + poff); seeds.append(p['seeds']); plies.append(p['plies'])
        for n in np.diff(p['offsets']): offsets.append(offsets[-1] + int(n))
        poff += len(p['seeds'])
    return {
        'features': np.concatenate(feats), 'shallow': np.concatenate(shallow),
        'deep': np.concatenate(deep), 'pos': np.concatenate(pos),
        'seeds': np.concatenate(seeds), 'plies': np.concatenate(plies),
        'offsets': np.asarray(offsets, np.int64), 'feature_count': nf,
        'metas': [p['meta'] for p in parts], 'paths': [p['path'] for p in parts]
    }


def canonical_pair(a, b):
    t = tuple(sorted((int(a), int(b))))
    m = tuple(sorted((nt.mirror_cell(t[0]), nt.mirror_cell(t[1]))))
    return min(t, m)


def candidate_pairs(data, base_tuples):
    present = set()
    for t in base_tuples:
        if len(t) == 2:
            present.add(canonical_pair(t[0], t[1]))
    for meta in data['metas']:
        for t in meta.get('tuples', []):
            if len(t) == 2:
                present.add(canonical_pair(t[0], t[1]))
    out, seen = [], set()
    for a, b in itertools.combinations(range(data['feature_count']), 2):
        c = canonical_pair(a, b)
        if c in seen or c in present:
            continue
        seen.add(c); out.append(c)
    return out


def centered_residual(data):
    r = data['deep'] - data['shallow']
    y = r.copy()
    for a, b in zip(data['offsets'][:-1], data['offsets'][1:]):
        y[a:b] -= y[a:b].mean()
    return y


def tuple_indices(features, pair, self_once):
    a, b = pair
    ma, mb = nt.mirror_cell(a), nt.mirror_cell(b)
    idx = 7 * features[:, a].astype(np.int32) + features[:, b]
    midx = 7 * features[:, ma].astype(np.int32) + features[:, mb]
    self_mirror = set(pair) == {ma, mb}
    if self_once and self_mirror:
        return np.minimum(idx, midx), None
    return idx, midx


def fit_table(idx, midx, target, mask, ridge, epochs, baseline=None):
    w = np.zeros(49, np.float64)
    ii = idx[mask]
    yy = target[mask]
    if baseline is not None:
        yy = yy - baseline[mask]
    if midx is None:
        count = np.bincount(ii, minlength=49).astype(np.float64)
        for _ in range(epochs):
            err = yy - w[ii]
            grad = np.bincount(ii, weights=err, minlength=49)
            w += grad / (count + ridge)
        return w
    mm = midx[mask]
    count = (np.bincount(ii, minlength=49) +
             np.bincount(mm, minlength=49)).astype(np.float64)
    for _ in range(epochs):
        err = yy - w[ii] - w[mm]
        grad = (np.bincount(ii, weights=err, minlength=49) +
                np.bincount(mm, weights=err, minlength=49))
        # Half-step is exact when the two active entries coincide and stable
        # for the ordinary two-entry symmetric case.
        w += 0.5 * grad / (count + ridge)
    return w


def predict(w, idx, midx):
    return w[idx] if midx is None else w[idx] + w[midx]


def cv_fit(data, pair, target, row_fold, folds, self_once, ridge, epochs,
           fold_current=None):
    idx, midx = tuple_indices(data['features'], pair, self_once)
    out = np.zeros(len(target), np.float64)
    weights = []
    for fold in range(folds):
        test = row_fold == fold
        train = ~test
        baseline = None if fold_current is None else fold_current[fold]
        w = fit_table(idx, midx, target, train, ridge, epochs, baseline)
        weights.append(w)
        out[test] = predict(w, idx[test], None if midx is None else midx[test])
    return out, weights, idx, midx


def policy_metrics(data, correction, target):
    regrets, agree = [], 0
    for a, b in zip(data['offsets'][:-1], data['offsets'][1:]):
        teacher = a + int(np.argmax(data['deep'][a:b]))
        chosen = a + int(np.argmax(data['shallow'][a:b] + correction[a:b]))
        regrets.append(data['deep'][teacher] - data['deep'][chosen])
        agree += chosen == teacher
    return {
        'regret': float(np.mean(regrets)),
        'agreement': float(agree / (len(data['offsets']) - 1)),
        'residualRms': float(np.sqrt(np.mean((target - correction) ** 2)))
    }


def main():
    a = parse_args()
    if a.folds < 2 or a.select < 1 or a.beam < 1 or not (0 < a.learning_rate <= 1):
        print('--folds >=2, --select/--beam >=1 and 0 < --learning-rate <=1 required',
              file=sys.stderr)
        return 1
    data = combine([read_corpus(p) for p in a.corpus])
    npos = len(data['seeds'])
    # Multiplicative hash avoids contiguous seed blocks lining up with folds.
    pos_fold = ((data['seeds'].astype(np.uint64) * 2654435761) % a.folds).astype(np.int32)
    used_folds = np.unique(pos_fold)
    if len(used_folds) < 2:
        print('the corpus reaches fewer than two CV folds; collect more complete games or lower --folds',
              file=sys.stderr)
        return 1
    row_fold = pos_fold[data['pos']]
    target0 = centered_residual(data)
    self_once = a.self_once
    base_set = a.exclude_set or data['metas'][0].get('set')
    if base_set and base_set.endswith('c'):
        base_set = base_set[:-1]
    try:
        base_tuples = nt.build_set(base_set) if base_set else data['metas'][0].get('tuples', [])
    except ValueError as e:
        print(str(e) + '; pass --exclude-set explicitly', file=sys.stderr)
        return 1
    pairs = candidate_pairs(data, base_tuples)
    if not pairs:
        print('no missing mirror-distinct pairs remain', file=sys.stderr)
        return 1
    current = np.zeros(len(target0), np.float64)
    base = policy_metrics(data, current, target0)
    print('%d positions, %d afterstates, %d input cells, %d missing mirror-distinct pairs' %
          (npos, len(target0), data['feature_count'], len(pairs)))
    print('baseline: regret %.3f  agreement %.2f%%  residual rms %.3f' %
          (base['regret'], 100 * base['agreement'], base['residualRms']))

    # Exhaustive first screen. Later boosting rounds only revisit its strongest
    # candidates; this keeps the all-pairs test cheap enough to repeat often.
    screened = []
    for n, pair in enumerate(pairs):
        pred, _, _, _ = cv_fit(data, pair, target0, row_fold, a.folds, self_once,
                               a.ridge, a.epochs)
        m = policy_metrics(data, a.learning_rate * pred, target0)
        screened.append((base['regret'] - m['regret'], pair))
        if n and n % 100 == 0:
            print('\rscreened %d/%d' % (n, len(pairs)), end='', flush=True)
    print('\rscreened %d/%d' % (len(pairs), len(pairs)))
    screened.sort(reverse=True)
    beam = [pair for _, pair in screened[:min(a.beam, len(screened))]]
    print('top single pair: %s  held-out regret gain %.3f' %
          (beam[0], screened[0][0]))

    selected = []
    full_current = np.zeros(len(target0), np.float64)
    # One boosting model per held-out fold. Its residual predictions on every
    # row are retained so later rounds for fold f still depend only on data
    # outside fold f; using ordinary OOF predictions as training residuals here
    # would leak fold f back in on round two.
    fold_current = np.zeros((a.folds, len(target0)), np.float64)
    remaining = list(beam)
    cur_metrics = base
    for step in range(a.select):
        best = None
        for pair in remaining:
            pred, fold_weights, idx, midx = cv_fit(
                data, pair, target0, row_fold, a.folds, self_once,
                a.ridge, a.epochs, fold_current)
            trial = current + a.learning_rate * pred
            m = policy_metrics(data, trial, target0)
            gain = cur_metrics['regret'] - m['regret']
            if best is None or gain > best[0]:
                best = (gain, pair, pred, m, fold_weights, idx, midx)
        if best is None or best[0] < a.min_gain:
            print('stop: best remaining held-out regret gain %.3f < %.3f' %
                  ((best[0] if best else float('-inf')), a.min_gain))
            break
        gain, pair, pred, m, fold_weights, idx, midx = best
        for fold, wfold in enumerate(fold_weights):
            fold_current[fold] += a.learning_rate * predict(wfold, idx, midx)
        current = fold_current[row_fold, np.arange(len(target0))]

        # Fit optional diagnostic initialisation weights on the full corpus
        # against the corresponding full-fit boosting residual. Structure
        # selection above remains OOF; grow.js starts these tables at zero unless
        # --init-residual is explicitly requested.
        w = fit_table(idx, midx, target0 - full_current,
                      np.ones(len(target0), dtype=bool), a.ridge, a.epochs)
        w *= a.learning_rate
        full_current += predict(w, idx, midx)
        selected.append({
            'tuple': list(pair), 'weights': [float(x) for x in w],
            'cvRegretGain': float(gain), 'cvRegret': m['regret'],
            'cvAgreement': m['agreement'], 'cvResidualRms': m['residualRms']
        })
        remaining.remove(pair); cur_metrics = m
        print('round %d: %-10s regret gain %.3f -> %.3f, agreement %.2f%%, rms %.3f' %
              (step + 1, str(pair), gain, m['regret'], 100 * m['agreement'],
               m['residualRms']))

    manifest = {
        'version': 1, 'name': a.name,
        'method': 'pairwise-within-position residual boosting; game-fold CV regret selection',
        'corpora': data['paths'], 'positions': npos, 'afterstates': len(target0),
        'featureCount': data['feature_count'], 'baseSet': base_set,
        'baseTupleCount': len(base_tuples),
        'sym': True, 'selfOnce': self_once, 'folds': a.folds, 'ridge': a.ridge,
        'epochs': a.epochs, 'learningRate': a.learning_rate,
        'baseline': base, 'finalCrossValidated': cur_metrics,
        'selected': selected
    }
    os.makedirs(os.path.dirname(a.out) or '.', exist_ok=True)
    with open(a.out, 'w') as f:
        json.dump(manifest, f, indent=2)
        f.write('\n')
    print('wrote %s with %d selected tuples' % (a.out, len(selected)))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
