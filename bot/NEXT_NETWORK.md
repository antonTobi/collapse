# Next network: OOD robustness without giving up strength

## Decision summary

Start with a **hierarchical n-tuple correction network**, not a wholesale neural
rewrite. Keep the current local evaluator as an exact prefix, then test two
small missing kinds of information independently and together:

1. **far-field tuples** connect distant corners, edges and diagonals;
2. **global categorical tuples** expose fragmentation, playable structure and
   six placement, including a few interactions between those facts and local
   corner/edge patterns.

This is the safest first experiment because all three candidates initially
compute *exactly* the current value function. Training can freeze the inherited
tables, so human and synthetic positions cannot erase playing strength while
the new correction tables learn. The same code still supports mirror reduction,
subset compaction, quantization and sparse phone deployment.

The hypothesis is not merely “a larger net is better.” It is:

> The current failures persist because the evaluator cannot condition a local
> pattern on distant/global board structure, and because its training support is
> narrow. A small correction layer with the missing inputs, trained on mined
> failures and deliberately broad support, should reduce those failures without
> moving the already-good in-distribution function unnecessarily.

## What is implemented

### Architecture arms

Global facts are represented as **virtual base-7 cells** after physical cell 24.
A tuple can mix ordinary cells and virtual cells and still use the existing
table format. The first eight features are:

- six count / 2, capped at 12+;
- Euler-estimated number of five-components, capped at 6+;
- equal-value playable adjacencies / 3 and cells belonging to legal groups / 3,
  both capped at 18+;
- exposed six count, capped at 6+;
- singleton component count / 2, capped at 12+;
- hole count, capped at 6+;
- count of 4/5 tiles / 2, capped at 12+.

`ntuple.js` defines both dense-training arms based on `doms` and directly
runnable arms based on the checked-in `domsrc` network:

| arm | direct set | tuples before deploy | weights/bank | mirrored cell reads | final `rc` reads |
| --- | --- | ---: | ---: | ---: | ---: |
| current | `domsrc` | 28 | 1,882,384 | 308 | 308 |
| far | `domsrcfar` | 37 | 1,932,805 | 384 | 350 |
| global | `domsrcglobal` | 38 | 1,906,394 | 388 | 364 |
| hybrid | `domsrchybrid` | 47 | 1,956,815 | 464 | 406 |

The hybrid adds 4.0% weights per bank before deployment and 32% final tuple-cell
reads. Global extraction is a single allocation-free pass over 25 cells plus a
25-bit component fill. Whether that stays inside the phone target is a measured
gate, not an assumption.

The corresponding dense-source sets are `domsfar`, `domsglobal` and
`domshybrid`. Prefer these when the last dense pre-deployment `doms` checkpoint
is available. The `domsrc*` arms make the experiment reproducible from
`dom39h.bins`; `grow.js` now expands a sparse source when necessary.

### Failure mining and broad support

`blindspots.js` scans human games for an upward depth-2 evaluation jump and then
requires the post-jump position to have a large depth-2 versus depth-1 Bellman
lift. The second condition matters: a refill can be lucky, but luck alone does
not make an extra search ply systematically repair the shallow evaluator. Save
pre-jump positions to train move selection, post-jump positions to train the
mis-evaluated state, or both.

`oodstarts.js` builds a deterministic mixture of:

- source positions (human and/or mined blindspots);
- locally mutated source positions;
- completely independent random legal boards;
- spatially correlated random boards with unusual six barriers.

Multiple comma-separated source pools are sampled uniformly by pool first, so a
small blindspot pool is not drowned by the much larger human corpus.

`ptrain.js --freeze-prefix SET` sends every value, sibling, ranking and TD update
only to tuples appended after `SET`. The update is renormalized over trainable
lookups, so the correction receives the requested value change rather than a
diluted fraction of it.

## First experiment

### 1. Build train/test blindspot pools

Partition by whole games. Do not select thresholds on the held-out pool.

```sh
node bot/blindspots.js --weights bot/weights/dom39h.bins \
  --partition train --jump 300 --lift 200 \
  --out bot/data/blindspots-train.bin

node bot/blindspots.js --weights bot/weights/dom39h.bins \
  --partition test --jump 300 --lift 200 \
  --out bot/data/blindspots-test.bin
```

Build one fixed training pool and reuse its bytes for every arm:

```sh
node bot/oodstarts.js \
  --source bot/data/human-train.bin,bot/data/blindspots-train.bin \
  --positions 200000 --source-frac .25 --mutate-frac .25 --iid-frac .25 \
  --out bot/data/nextnet-ood-train.bin
```

This makes the intended distribution explicit: 12.5% ordinary human, 12.5%
mined blindspots, 25% mutations split equally by source pool, 25% IID random and
25% structured random. Ordinary fresh self-play is still supplied by the half
of training episodes that do not start from the pool.

### 2. Exact-grow four initial networks

These commands are runnable from the repository alone. They use substantial
RAM because the sparse deployment file is expanded into a trainable Float32
table; use a dense `doms` checkpoint and the `doms*` names when available.

```sh
node bot/grow.js --in bot/weights/dom39h.bins --out /tmp/next-control.bin --set domsrc
node bot/grow.js --in bot/weights/dom39h.bins --out /tmp/next-far-0.bin --set domsrcfar
node bot/grow.js --in bot/weights/dom39h.bins --out /tmp/next-global-0.bin --set domsrcglobal
node bot/grow.js --in bot/weights/dom39h.bins --out /tmp/next-hybrid-0.bin --set domsrchybrid
```

`grow.js` checks equality on played and constructed boards before writing. Far,
global and hybrid must all report a maximum difference near zero.

### 3. Short correction-only screen

Use identical episode counts, seeds and pool bytes. Keep an untouched
`dom39h.bins` baseline as well as the full-fine-tuned control: the pair separates
“new training data helped” from “new inputs helped without forgetting.”

```sh
# Full fine-tune control: deliberately measures the old failure mode.
node bot/ptrain.js --resume /tmp/next-control.bin --out /tmp/next-control-t.bin \
  --jobs 8 --episodes 200000 --alpha .02 --alpha-end .005 \
  --starts bot/data/nextnet-ood-train.bin --start-frac .5 --start-moves 32

# Repeat for far/global/hybrid, changing the two filenames.
node bot/ptrain.js --resume /tmp/next-hybrid-0.bin --out /tmp/next-hybrid-t.bin \
  --freeze-prefix domsrc --jobs 8 --episodes 200000 \
  --alpha .02 --alpha-end .005 \
  --starts bot/data/nextnet-ood-train.bin --start-frac .5 --start-moves 32 \
  --rank .1 --rank-k 3 --frozen /tmp/next-hybrid-0.bin
```

Run the correction-only comparison first without `--rank`, then with it if the
value metrics improve but move ordering does not. Ranking is a second factor,
not something to silently confound with architecture. A useful short-screen
matrix is therefore:

| factor | levels |
| --- | --- |
| added inputs | far / global / hybrid |
| target | TD only / TD plus frozen depth-2 ranking |
| seed | at least 3 training seeds |

Two hundred thousand episodes is a screen, not a final training budget. Advance
an arm only on a consistent effect across seeds.

### 4. Measurements and gates

Use three disjoint evaluation domains: bot self-play afterstates, held-out human
games/blindspots, and fresh synthetic boards generated from a different seed.
For each report:

- **value accuracy:** centered depth-2 Bellman residual by move rank and RMS;
- **move accuracy:** shallow top-move agreement and regret against a deeper,
  higher-cap reference, not just absolute-value RMSE;
- **hallucinations:** upward-jump count, post-jump lift and worst-1% regret on
  held-out human games;
- **playing strength:** greedy and the deployed search setting on common seeds;
- **search scaling:** the complete score-versus-time curve, especially the
  slope after 10 ms/move rather than only one endpoint;
- **deployment:** final sparse file size and evaluations/second on a phone-class
  browser/device.

Initial gates:

1. no statistically meaningful loss from the untouched bot at its deployed
   search setting; target mean remains at least 10,000;
2. at least 25% reduction in held-out human/synthetic move regret and a clear
   reduction in the worst tail;
3. improved late search-scaling slope, not merely a vertical offset at depth 1;
4. final sparse file under 20 MB and evaluator time at most 1.5x `dom39h.bins`.

### Local smoke results (not a strength result)

The implementation was screened locally before commit:

```sh
node bot/nextnet-test.js
node bot/nextnet-test.js --timing
```

| check | result |
| --- | --- |
| dense exact growth, each arm | max difference 0 on 2,468 boards |
| sparse `dom39h` → direct hybrid | max difference 0.000164 on 2,468 boards; 0.000020 on 100 synthetic boards |
| frozen-prefix update | inherited Float32 prefix byte-for-byte unchanged |
| feature-aware codec | encode/decode values unchanged |
| reduce then compact after smoke training | max differences 0.000131 and 0.000436 on ~47k real afterstates |
| OOD corpus, same seed | byte-for-byte identical output |

An interleaved Node timing microbenchmark used identical 4,096 boards, nonzero
weights, staged/five-banked networks, eight rotated rounds and 200,000
evaluations per pass. Relative median evaluator times after reduction/compaction
were **1.12x far, 1.35x global and 1.43x hybrid** versus `domsrc`. This is an
encouraging architecture-level screen and the reason the original exact global
component flood was replaced, but it is not the deployment measurement: sparse
indexing, browser JITs and phone memory caches can change the result.

After a correction-only winner is selected, unfreeze all tables at 5–10x lower
learning rate with at least half ordinary self-play. This is integration, not
architecture selection; if it gives back the robustness gain, keep the prefix
frozen for the final model.

### 5. Build the phone candidate

Do this only for finalists. Count sparse coverage over the same broad support;
counting only self-play would recreate the current off-distribution compression
error even if training fixed the dense network.

```sh
node bot/reduce.js --in /tmp/next-hybrid-t.bin --out /tmp/next-hybrid-r.bin
node bot/compact.js --in /tmp/next-hybrid-r.bin --out /tmp/next-hybrid-rc.bin
node bot/shrink.js --in /tmp/next-hybrid-rc.bin --out /tmp/next-hybrid.bins \
  --keep 8000000 --games 512000 --jobs 8 \
  --starts bot/data/nextnet-ood-train.bin --start-frac .977 --start-moves 10
```

Re-run every accuracy and timing metric on the sparse file. The dense result is
not deployable evidence.

## Evaluating after refill instead of before refill

This is a credible second experiment, but it should not be mixed into the first
architecture screen.

The current afterstate value is cheap: each root move gets one lookup and the
network learns the expectation over its unknown refill. A full-state evaluator
would see the actual tiles and score a move as

\[
Q(s,a)=r(s,a)+\mathbb{E}_{z\sim refill}\,W(s'_{a,z}).
\]

That provides strictly more information to each sampled branch and may reduce
model bias. It also turns depth-1 move selection from one evaluation per move
into `cap` evaluations per move, adds max-selection noise when siblings receive
different random samples, and makes phone latency scale directly with the
chance cap. Common random numbers across moves are essential.

Test three variants after selecting an architecture:

1. current afterstate network (control);
2. full-state network with 4/8/16 refill samples and common random numbers;
3. train the full-state target, then distil its refill average back into the
   same afterstate architecture for one-evaluation deployment.

Variant 3 is the most promising way to gain the information without paying the
runtime cost. A phase virtual feature could let one file represent both full
states and afterstates, but that is logically two value functions sharing
weights and should earn its complexity empirically.

## Longer-range alternatives after the first screen

If far tuples help, expand them gradually; their tables are interpretable and
cheap. If they do not, the next compact options are:

- a tiny 2-layer convolution over the 5x5 board followed by global pooling and
  a residual added to the n-tuple value;
- axial row/column mixing or two attention heads with a 16–24 dimensional cell
  embedding;
- a low-rank factorization of `(local pattern, global context)` instead of full
  conditioned tuple tables.

All can fit in a few hundred kilobytes, but they require a new optimized phone
kernel and new serialization. The virtual-cell experiment answers whether the
missing information is valuable before paying that engineering cost.

## Environment and long runs

The local work environment is suitable for correctness checks, corpus samples,
short training screens and evaluation timing. It is not a durable experiment
runner: scratch storage and processes should not be assumed to survive a long
session, and its CPU is not representative of phones. Multi-hour/multi-seed
training should run on a persistent machine, with commands, git SHA, corpus
hash, seeds and periodic checkpoints recorded. The checked-in code makes those
runs reproducible; it does not substitute a short local proxy for them.
