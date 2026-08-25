# Scaling search with time

> The next evaluator experiment prompted by the ceiling documented here is in
> [NEXT_NETWORK.md](NEXT_NETWORK.md). It tests exact-grown far-field and global
> correction tuples, mined human-game blindspots, synthetic OOD support, and a
> frozen-prefix training phase before changing the already-strong evaluator.

A running record of the work on **how to spend more than a millisecond a move**.
Newest findings at the top of each section. The goals it is aimed at:

1. A single search that scales smoothly with the time available, interruptible at
   any point, replacing the current family of fixed `depth=2/3/4` settings.
2. A better gradient of score per unit of compute at long time controls — a
   strategy that starts worse but climbs faster is the interesting one.
3. 13 000 mean at 1 s/move.
4. Enough convergence that a minute of analysis on one position can be trusted,
   both for the move it picks and for the score it predicts.

---

## The headline problem, from data we already have

Score against compute for the current search family, all on `dom21c`/`dom21q`,
seeds 1–200. `ms/move` is only comparable within a run, so these come from runs
that each contained their own baseline:

| config | mean | ms/move |
| ------ | ---: | ------: |
| depth 1 (greedy) | 8727 | 0.036 |
| depth 2 `cap=4` | 9803 | 0.43 |
| depth 2 `cap=8` | 10128 | 0.52 |
| depth 2 `cap=16` | 10435 | 1.06 |
| depth 2 `cap=32` | 10526 | 2.25 |
| depth 2 `cap=96` | 10641 | 7.7 |
| depth 3 `cap=16 capDeep=2` | 10758 | 10.4 |
| depth 3 `cap=32 capDeep=4` | 10827 | 16.4 |
| depth 3 `cap=64 capDeep=4` | 10925 | 57.6 |

From 0.43 ms to 57.6 ms — **134× the compute** — the score moves 9803 → 10925,
i.e. **+1122**. The gradient decays sharply: roughly +160 per doubling early,
+50 per doubling by the right-hand end.

Extrapolating that gradient to 1 s/move (another ~4 doublings past 57.6 ms)
predicts about **11 100**, not 13 000. Reaching 13 000 at +50/doubling would need
some 40 further doublings, which is not a thing that happens.

**So the target is not reachable by scaling the current search, and the
interesting question is whether any search has a materially better gradient.**
The likely reason for the ceiling is that a fixed leaf evaluator bounds what
search can recover: past some depth the agent is optimising its own value
function's errors rather than the game. If that is the binding constraint, the
answer is a better evaluator, not a better search — which is a result worth
establishing early rather than late.

That guess turned out to be exactly right, and the first entry in the log below
turns it into an identity: a depth-*d* root value is the greedy score plus V's
own Bellman residual, so the whole search family is fixed-point iteration on one
operator and shares one ceiling with a perfectly repaired evaluator. Read the
gradient here as a property of `(T^d V - V)`, not of the tree.

---

## Infrastructure

### Subgames (`run.js --sub MODE`)

Measuring a search at a second a move is unaffordable on 1000-move games, so
`--sub` shortens them. Two kinds, shortening different halves:

| mode | what it is | moves | s/game | speedup |
| ---- | ---------- | ----: | -----: | ------: |
| `grid54` | bottom row walled with 6s | 448 | 0.36 | 3× |
| `grid45` | right column walled | 332 | 0.27 | 4× |
| `grid44` | both walled | 128 | 0.10 | 11× |
| `first6` | full board, stop at the first 6 | 160 | 0.22 | 4.7× |

The walls exploit a property of the game rather than changing it: a 6 is
permanent and can never be collapsed, so a row of them *is* a smaller board, and
the network already reads boards full of 6s without retraining. `first6` is
different in kind — it is the opening only, and the agent is still playing for
full-game value, so it measures "how well is the opening played", not a game.

**Validated.** Four agents whose full-game ranking is known (9803 / 10435 /
10758 / 10925) were run through all three modes, 200 seeds each. All three
preserve the ordering, and all three respond to search effort by a similar
*relative* amount (+10% to +14% from `cap=4` to `depth 3 cap=64`, against +11.4%
in the full game). So all three are honest proxies for relative scaling.

They differ enormously in how well they *discriminate*, though, and not in the
direction the speedups suggest. On the hard comparison — `depth 3 cap=16` versus
`depth 3 cap=64`:

| mode | difference | t | efficiency (t² per cpu-second) |
| ---- | ---------: | -: | -----------------------------: |
| `grid44` | +9 ± 25 | 0.36 | 1× |
| `grid54` | +95 ± 50 | 1.9 | 5× |
| `first6` | **+52 ± 16** | **3.25** | **22×** |

`grid44` is 11x faster per game and cannot separate the two strong agents at
all: its noise swamps the effect. `first6` has smaller effects but far smaller
variance — an opening is much more reproducible than a whole game — and wins by
22x on t² per cpu-second, which is the metric that matters because t² grows with
sample size.

**Primary probe: `first6`. Cross-check: `grid54`. Anything that survives both
gets a full-game run.** The limitation to keep in mind is that `first6` sees only
the opening, so a technique that helps only the endgame would be invisible to
it — `grid54` exists to catch that.

---

## Log

### Finding — everything search buys is V's own Bellman residual, and the residual is a training-coverage artefact

This one reframes the rest of the file, so it is worth stating as algebra first.
`search.js` scores a root move `a` at depth `d` as

```
value(a) = gain_a + chanceValue(after_a, d-1)
         = gain_a + E_refill[ max_a' (gain' + V) ]
         = (gain_a + V(after_a))  +  (TV - V)(after_a)
```

The first bracket is exactly what greedy uses. The second is V's **Bellman
residual** `R(s) = E_refill[max_a (gain+V)] - V(s)`, which is zero at the TD(0)
fixed point. So **a depth-2 search ranks moves by `greedy score + R`, and by
nothing else** — and if `R` were zero everywhere, every search depth would
collapse to greedy. Depth 2 is worth +1400. That +1400 *is* `R`.

`bot/residual.js` measures `R` directly. On `dom21c`, greedy trajectories:

| | move greedy plays | rank 2 | rank 3 | rank 4 | rank 5 | rank 6 | rank 7 | rank 8+ |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| residual | **0.7** | 7.0 | 13.8 | 24.0 | 35.3 | 54.0 | 71.6 | 162.1 |

**V is at its fixed point to within a point on the states TD visits, and
systematically too low everywhere else.** Two measurements pin that down.

**It is coverage, not regression to the mean.** Ranking on `gain + V` selects for
positive V error, so a monotone rank column could in principle be pure selection.
Take the *rank-1* residual instead — identical statistic, identical selection —
at positions reached by k random deviations from the greedy trajectory:

| deviations k | 0 | 1 | 2 | 3 | 5 | 10 | 20 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| rank-1 residual | **1.1** | 13.4 | 20.1 | 29.7 | 50.3 | 46.8 | 45.5 |

One move off the trajectory and V is 13 points inconsistent with itself,
saturating around 47 (about 1% of V) a few moves out. Selection cannot produce
that gradient; a narrow training distribution is the only thing that can.

**Where V was trained it is excellent, and the -1268 calibration bias is not a
defect of V.** Over greedy self-play the residual is -0.09 (mean absolute 19.8),
and mean V is 4334 against a mean actual remaining score of 4342 — an **8-point**
error on a 4334-point prediction. Under search play the per-step residual is
+1.2 (depth 2) and +1.5 (depth 3), and over ~800 moves that is precisely the
+874 / +648 calibration gap the earlier section measured as -1268 at move 200. V
predicts the greedy continuation faithfully; it is the continuation that is wrong.

**Deeper search is the same correction applied more times.** Correction
`(T^{d-1}V - V)` at depth 2 / 3 / 4, with `crn=1` so the comparison is
deterministic: mean 20.8 / 27.3 / 31.6, spread across the moves of a position
39.1 / 44.9 / 49.0, and **corr(depth-2 correction, depth-4 correction) = 0.950**.
Extra depth is more iterations of one fixed-point operator converging to the same
limit, not new information — which is the mechanism behind the +50/doubling
gradient, and it confirms the headline extrapolation from underneath.

**Sizing the fix.** Depth 2 overrules greedy on 42.5% of decisions, and plays
shallow rank 1/2/3/4 on 57.5% / 19.2% / 10.3% / 6.5% of them — **93.5% cumulative
by rank 4.** Three siblings is the number.

**A shortcut that does not work, tested so nobody tries it.** The rank column
above is a systematic offset, so adding it back as a constant at play time looks
free. It is not: `greedy + rank offset` scores **-1097** at half strength and
**-3043** at full, on seeds 1-150. `R`'s mean-by-rank carries no move-choice
signal; only its per-position value does. Any repair has to be per-state.

### What this says about the three search-training arms below

Re-reading the A/B in the next section with `bot/residual.js` explains all of it,
and the metric costs seconds rather than a 500-seed benchmark:

| net | grid44 greedy score | rank 1 | rank 2 | rank 6+ | **spread** |
| --- | ---: | ---: | ---: | ---: | ---: |
| `ab44-greedy` (greedy behaviour, static target) | 1527 | 0.3 | 7.2 | 77.0 | **76.7** |
| `ab44-tree` (greedy → search target) | 1516 | -9.7 | 0.2 | 68.7 | **78.4** |
| `ab44c-tree32` (search cap32 + search target) | 1430 | -8.3 | 0.4 | 78.8 | **87.1** |
| `ab44-beh` (search behaviour, static target) | 1255 | -1.7 | 9.4 | 88.6 | **90.3** |
| `dom21c` (unadapted) | 1229 | 0.4 | 13.0 | 94.7 | **94.3** |

- **`--search-target` shifts the level and leaves the shape alone.** The whole
  curve drops ~10 points; the spread moves 76.7 → 78.4, i.e. not at all. Move
  choice depends only on differences between candidates, so a constant shift is a
  no-op by construction — which is the entire content of the "+68". It is visible
  in the weight files too: the tree arms carry 1.6x the RMS weight change of the
  greedy arms and 2.5x the mean *upward* shift. A re-levelling, not a re-shaping.
- **Search behaviour widens the spread** (76.7 → 90.3) and undoes almost all of
  the 4x4 adaptation. The diagnosis in the next section was right; this is it
  measured.
- Spread orders all five nets exactly as score does. n=5 and confounded with how
  much grid44 training each net got, so treat it as screening rather than proof —
  but the mechanism is direct, and screening is what it is for.

### Three things in the code that were failing silently

- **`--search-target` could not be used without `--search-depth > 1`.** The
  searcher is only built when `searchDepth > 1`; at depth 1 `best()` returns
  `value = gain + V(after)`, so the "search target" branch selected between two
  character-for-character identical expressions. **The combination the next
  section recommends — greedy behaviour, search target — had never been run and
  could not be run.** (Per the table above it would have been near-neutral
  anyway, so the recommendation survives; but the 2x2 design has an empty cell
  that the write-up treats as filled.) It is now an error.
- **`--starts` was ignored whenever `--sub` was set**, so the start-pool idea
  could not be A/B'd in the fast 4x4 arena at all. Also now an error.
- **The grid subgames run with `maxGen = 4` from move one.** `Collapse.fromCells`
  infers the generator from the board, and the wall 6s trip it. It is consistent
  between `ptrain --sub` and `run --sub`, so the A/Bs are internally valid — but
  grid44 is a *midgame* proxy, not a scaled-down game. It also exercises only
  ~7% of the 40.9M weights and 3 of the 21 banks, which is worth knowing before
  a grid44 result is generalised.

### Residual repair — the two mechanisms, and what they cost

The lever is **off-policy coverage of V**. Search is a way to pay for it, not the
point of it. `ptrain.js` now has both cheap ways to buy it.

**`--siblings K` — sibling Bellman updates.** At every training step the expander
has already produced every legal afterstate and V has already been evaluated on
all of them; the only thing missing is a target for the ones not played. Take the
top K rejected moves by shallow value and update each toward its own one-step
backup from a single sampled refill — the same unbiased estimator the trajectory
update already uses. Measured cost 2.7x (1360 → 490 ep/s on grid44), against 25x
for a search behaviour policy. The one-sample target is *not* the noisy part:
its spread over refills is 18-32 points against a V of ~900.

**`--explore EPS --explore-rank R` — exploration that this game can afford.**
Uniform-random deviation is ruinous here, which is probably why exploration was
never tried: it wastes structure that cannot be rebuilt. Stepping down one rank
is nearly free. On `dom21c`, 120 seeds:

| eps | uniform random | second-best |
| ---: | ---: | ---: |
| 0 | 8830 | — |
| 0.005 | 7957 | **8967** |
| 0.02 | 6379 | **8710** |
| 0.05 | 4762 | 8256 |

Safe because the TD target at `ptrain.js` is now `next.qmax` — the max over
moves, not the value of what was played. The backup is Q-learning-shaped, so the
behaviour policy can wander without changing what is learned. Without `--explore`
`qmax` is character-for-character the old expression, and the trainer is verified
bit-identical to the previous version with the new options off.

The two differ in kind and it matters: exploration puts off-policy states on a
trajectory that runs to a real terminal, so those updates are **grounded in
rewards**. Sibling updates are **bootstrapped** — they propagate V through a
region nothing anchors. Off-policy bootstrapping with a shared linear
approximator is the deadly triad, so `--sib-alpha` exists to damp it.

**`--distil K` — the same idea with a frozen target.** Greedy is
`argmax(gain + V)` and depth 2 is `argmax(gain + TV)`, so a network that has
learned `TV` plays depth-2's moves at depth-1's price. `TV` is computable from
one sampled refill, which makes this a supervised regression against a frozen
copy of the network rather than a bootstrap — no drift, and an exactly stated
ceiling. ~5x per episode. Feed the result back with `--frozen` to iterate.

#### The arena: grid44 has real headroom

Before reading any of the screening below, the thing that makes it meaningful:
on grid44, over the converged 4x4 net `ab44-greedy`, greedy scores **1570 ± 32**
and depth 2 `cap=16` scores **1904 ± 24**, a paired **+334 ± 40** over 200 seeds.
That is +21% against +20% for the full game (8727 → 10435), so the subgame has
the same proportional gap to close, at 1/9th the cost per episode and with an
error bar tight enough to see it.

#### Screening: the level moves, the shape does not

All arms resume from `ab44-greedy`, 200k grid44 episodes, alpha 0.01 flat.

| arm | grid44 greedy | rank 1 | rank 2 | rank 6+ | gap2 | tail |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| start (`ab44-greedy`) | 1570 | 0.3 | 7.0 | 77.2 | 6.6 | 77.2 |
| +200k plain TD | 1559 | -0.7 | 6.8 | 78.8 | 7.5 | 79.5 |
| `--siblings 1` | 1577 | -4.2 | 3.6 | 74.7 | 7.9 | 79.0 |
| `--siblings 3` | 1401 | -12.5 | -2.9 | 39.8 | 9.5 | 52.3 |

**`--siblings` moves the level, not the shape, which is the same failure as the
search target.** `sib1` pushed rank 2's residual from 6.8 down to 3.6 — and
pushed rank 1's from -0.7 to -4.2 at the same time, leaving `gap2` exactly where
it was. `sib3` is the extreme version: it nearly halved the rank-6+ residual and
*lost 158 points*, because it raised `gap2` from 7.5 to 9.5 while doing it. The
mechanism is weight sharing — a sibling's afterstate and the trajectory's differ
by which chain collapsed, but they share most of their tuple patterns, so an
update with a positive mean lands on both. `--sib-center` exists to subtract that
common part; it is the thing to test rather than raw `--siblings`.

**And it corrects the summary statistic in the table above this one.** "Spread"
(rank 6+ minus rank 1) is the wrong number: depth 2 plays shallow rank 1/2/3/4 on
57/19/10/7% of decisions and rank 7+ essentially never, so a residual at rank 8
has no decision to change. `sib3` improved the tail by 27 points and lost. What
tracks score is `gap2` and `gap4`, and `bot/residual.js` now reports those.

#### Distilling TV: the regression succeeds and the policy does not

`--distil 3` on grid44 from `ab44-greedy`, alpha 0.01. The self-play mean goes
**1570 → 1460 → 1482 → 1480** over 300k episodes and stays there; the 100k
checkpoint scores **1488 ± 27** against the start's 1570 ± 32.

It is not failing to fit. Measured on the states the fitted network itself plays,
against `TV0` computed exactly:

| distance to TV0 | rms | within position | position mean |
| --- | ---: | ---: | ---: |
| `V0` (the start) | 94.2 | 77.0 | 53.6 |
| `V1` (100k of distil) | 65.7 | **57.3** | 31.7 |

The regression closed a quarter of the gap, *including* the within-position part
that is the only part that ranks moves. And yet agreement with depth-2's move
choice went **57.0% → 55.2%**, and the score fell.

**The control that makes this readable.** Rank moves by `gain + V + t*R` with `R`
computed exactly rather than fitted — t=0 is greedy, t=1 is depth 2. Over 200
grid44 seeds:

| t | 0 | 0.15 | 0.30 | 0.50 | 0.75 | 1.00 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| score | 1570 | 1610 | 1721 | 1842 | 1886 | 1940 |
| paired | — | +40 | +151 | +272 | +316 | +370 |

Monotone. **A partial step toward TV is not harmful in itself**, so an
incomplete regression is not the problem and more episodes are not the answer.

**What the fit actually did.** Within a position, with the position mean removed,
regress the fit's movement `delta = V1 - V0` on the correction it was aiming at
`R = TV0 - V0`:

```
rms R      77.2          corr(delta, R)  0.761
rms delta  31.1          delta = 0.307 * R + noise
                         rms of delta ORTHOGONAL to R:  20.2
```

So the fit moved **0.31 of the way up the right axis** — worth +151 by the table
above — **and carried 20.2 rms of movement off that axis**, which costs more than
the +151 is worth. The reason is the oldest lesson in this folder: a max node
over siblings selects whichever candidate the stray movement happened to favour,
so off-axis error at a max node is not neutral, it is negative. `norefill`,
control variates and graded allocation all died of this, and so does value
distillation.

The 20.2 is not sampling noise from the one-refill target — that works out to
about 1.8 points of steady-state noise in V. It is approximation error: the tuple
class cannot represent `TV0`'s within-position structure, and what it fits
instead is 31% signal and the rest sideways.

**The exchange rate, which is the number to design against.** Two more episodes
counts give the trend, and the `t` table converts an on-axis slope into points:

| episodes | slope | corr | orthogonal rms | on-axis worth | measured | so off-axis cost |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100k | 0.307 | 0.761 | 20.2 | +155 | -82 | 237 (11.7 per unit) |
| 300k | 0.418 | 0.812 | 23.3 | +222 | -90 | 312 (13.4 per unit) |

An on-axis unit is worth **+7.0** points (544 per unit of `t`, over an `rms R` of
77.5); an off-axis unit costs **-12.5**. **Off-axis error at a max node is about
1.8x as expensive as on-axis movement is valuable**, which is the quantitative
form of the rule this file already had. Break-even needs
`orth / slope < 43`; the fit is at 66 after 100k and 56 after 300k.

So the fit *is* improving with episodes — slope, correlation and the ratio all
move the right way — and extrapolating the ratio reaches break-even somewhere
around 1.5-2M grid44 episodes, which is not a promising place to start. That
extrapolation is worth testing rather than trusting, because everything about
this depends on whether the ratio keeps falling.

**And it says the objective is wrong, not the mechanism.** Regressing values asks
the network to reproduce a function; the policy only needs the *order* of a
position's candidates, which is a far weaker thing to represent. That is what
`--rank` does.

#### Ranking instead of regressing

`--rank W` fires only when the backup prefers a different move than V does, and
then pushes exactly those two afterstates apart by `W` — equal and opposite, so
no level drifts, and self-limiting, so it stops when they agree. With the TD
trajectory update still running underneath as the anchor, the equilibrium
displacement is about `W`.

How far does V have to move? On grid44, over the 40.1% of decisions where depth 2
overrules greedy, the gap that has to be closed has median **15** and mean **36**
— deciles 2 / 6 / 15 / 41 / 93 / 255 at 10/25/50/75/90/99%. A displacement of
10 / 20 / 60 / 200 reaches 36 / 56 / 83 / 99% of them.

#### Verdict on train-time search: six mechanisms, none of them work

Everything above, on one scale. grid44, 200 seeds, all resumed from the same
converged 4x4 net, all scored by plain greedy play:

| arm | grid44 greedy | vs start |
| --- | ---: | ---: |
| **ceiling** — depth 2 `cap=16` over the start net | **1904 ± 24** | +334 |
| start (`ab44-greedy`) | 1570 ± 32 | — |
| `--rank 60` | 1585 ± 34 | +15 |
| `--rank 20` | 1578 ± 30 | +8 |
| `--siblings 1` | 1577 | +7 |
| +200k plain TD (the do-nothing control) | 1559 | -11 |
| `--distil 3` | 1488 ± 27 | -82 |
| `--explore 0.02 --explore-rank 2` | 1480 ± 36 | -90 |
| `--siblings 3` | 1401 | -169 |

Six mechanisms — search behaviour, search target, sibling backups, centred
sibling backups, value distillation against a frozen target, grounded
exploration, and pairwise ranking — and **nothing clears the do-nothing control
by more than noise**, while three are clearly negative. The +334 sitting at the
top of the table is real and reachable by *computing* the correction at play
time; it is not reachable by putting the correction into these weights.

The mechanism is measured rather than guessed, and it is the same one in every
row: the correction is 77 rms of per-position information, the tuple class can
absorb about 40% of it, and it pays for that with 23 rms of off-axis movement at
roughly twice the price. Which is a statement about the *function class*, and
points at the next section rather than at a seventh mechanism.

### Finding — capacity does not close the gap search fills

Every trained network in the repo, greedy and depth 2 `cap=16`, seeds 1-200:

| net | weights | banks | greedy | depth 2 | search gain | greedy/doubling | depth2/doubling |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `c_base` | 0.09M | 1 | 5527 | 7028 | +1501 ± 101 | — | — |
| `big-td` | 3.08M | 1 | 7834 | 9269 | +1435 ± 80 | 448 | 435 |
| `big-s3` | 9.23M | 3 | 8150 | 9857 | +1706 ± 90 | 199 | 371 |
| `bigx-s7` | 22.82M | 7 | 8639 | 10090 | +1451 ± 104 | 375 | 179 |
| `dom21c` | 39.53M | 21 | 8727 | 10381 | +1655 ± 114 | 111 | 367 |

Two readings, and the second is the surprise.

**Capacity still pays and is not obviously saturating.** From 3M to 39.5M
weights greedy gains ~240 per doubling and depth 2 ~370, and neither per-step
column trends to zero. Set against six train-time-search mechanisms returning
nothing, this is the only lever here with a measured non-zero return.

**But capacity has not closed the greedy-to-search gap at all.** Over a 460x
capacity range the gain from depth 2 is 1501, 1435, 1706, 1451, 1655 — flat, and
flat in percentage terms too (17-21% once past the smallest net). A bigger
evaluator lifts greedy and search *together*; it does not make search redundant.
That is good for goal 3 — the +1500 stays available on top of a better net — but
it means "grow the evaluator" and "improve the search" are complementary
programs, and neither extrapolates to 13 000 alone: at +300 per doubling the
target is nine more doublings away, which is a 16 GB table.

Two caveats. Capacity and episodes are confounded in that ladder — every later
net got more of both. And `dom21` may be undertrained *for its size*: about 229
weight-updates per weight against `big-td`'s 418, i.e. half the training density
of the network below it. Which is why the follow-up is two matched arms rather
than one.

### Finding — search as the BEHAVIOUR policy is what breaks training, not the target

The plan was a 5x5 run using search, since V is trained under a greedy policy
scoring ~8700 while the agent plays with search scoring ~10400 -- so V predicts
a continuation nobody plays. A 4x4 pipeline (`ptrain --sub grid44`, 1560 ep/s
against 179 for 5x5) made the A/Bs affordable: 30 minutes an arm, not 5 hours.

A pipeline bug first: **`--search-depth` alone would not have fixed anything.**
The TD target was `next.reward + net.value(next.cells)`, a one-ply static
estimate, so search changed only which positions were visited, not what was
learned about them. `--search-target` bootstraps off the searcher's own value
instead.

**The decomposition.** All arms resume from a *converged* 4x4 net and are
benchmarked afterwards under identical search, 500 seeds:

| arm | behaviour | target | score | vs start |
| --- | --------- | ------ | ----: | -------: |
| start | — | — | 1894 | — |
| greedy +2.4M episodes | greedy | static | 1920 | +26 +- 23 |
| B2 | search cap4 | static | 1682 | **-212 +- 23** |
| C2 | search cap4 | search | 1751 | -144 +- 25 |
| C3 | search cap32 | search | 1643 | **-251 +- 25** |

Three readings, and the first one reverses what an earlier writeup of this
section claimed:

1. **The search target HELPS.** Holding behaviour at cap4: -144 with the search
   target against -212 with the static one, i.e. +68 for tree-strapping. An
   earlier A/B during adaptation had it at +191. Bootstrapping off the search is
   the good part.
2. **The search BEHAVIOUR hurts, and badly.** Holding the target static: +26 for
   greedy against -212 for search, a -238 swing.
3. **The damage grows with how strong the behaviour is**: greedy +26, cap4 -212,
   cap32 -251. This also disposes of the sampling-noise explanation -- more
   refill samples per chance node made things *worse*, which is the opposite of
   what a max-over-noise bias predicts.

**Why.** V's consumer is not the trajectory, it is the search. A depth-2 search
evaluates many hypothetical positions in order to *reject* them, and those are
exactly the bad positions that greedy play blunders into and that strong play
avoids. Train on-policy with a strong behaviour and the data narrows onto good
positions; V gets more accurate where the agent goes and less accurate where the
search looks, and since the search is what turns V into a policy, the agent gets
worse. The monotone relationship between behaviour strength and damage is the
signature.

**The fix, and it is not the existing tool.** `bot/starts.js` samples positions
from search *play* -- trajectory points, the good positions. That reinforces the
narrowing rather than repairing it. What is needed is seeding from search
*leaves*, including the branches the search rejected, with full games played out
from them so the targets stay grounded in real rewards rather than in the
search's own values. Same machinery, different distribution, opposite effect.

**Until that exists: do not train with a search behaviour policy.** Greedy
behaviour with a search-derived target is the combination the evidence supports,
and `--search-target` is worth keeping for it.

> **Superseded in part — see the first entry in this log.** The behaviour half
> stands and is now measured rather than argued (search behaviour widens the
> residual spread 76.7 → 90.3). The target half does not: that combination could
> not be run at all (the searcher only exists at `--search-depth > 1`, so at
> depth 1 the "search target" *is* the static target), and measuring what
> `--search-target` did to the arms that could run shows it moves the residual's
> level and not its shape — a no-op for move choice. The +68 is that no-op.
>
> The diagnosis in this section — V gets accurate where the agent goes and
> inaccurate where the search looks — is right, and is the thing to fix. The
> proposed fix is not the cheapest one. Seeding from search *leaves* buys
> off-policy coverage at 25x the cost per episode; `--siblings` buys the same
> coverage at 2.7x by updating the afterstates the expander has already built,
> and `--explore` buys a grounded version of it for free.

### Finding — the ceiling is the evaluator, and here is the evidence

The chain, in the order it was measured:

**1. The ladder works but is not the answer.** `ms=N` climbs the measured Pareto
frontier and answers with the last completed rung. On `first6`, 150 seeds:

| | mean | ms/move |
| --- | ---: | ------: |
| fixed d2 `cap=8` | 1616 | 1.14 |
| ladder `ms=1` | 1599 | 1.13 |
| fixed d2 `cap=16` | 1641 | 1.81 |
| ladder `ms=5` | 1634 | 2.38 |
| fixed d3 `cap=16` | 1656 | 16.2 |
| ladder `ms=30` | **1680** | 18.5 |

It costs 1-2% at the cheap end (the work on lower rungs) and slightly beats the
fixed configuration at the expensive end. That is a fair price for one time knob
replacing depth 2/3/4, and goal 1 is met — but it does not change the gradient,
which was the point.

**2. The search disagrees with itself far more than it disagrees with depth.**
`analyse.js` runs one position up the ladder; the control that matters is
re-running each rung on a *fresh sample*, since chance nodes are stochastic:

| rung | ms | changed vs rung below | changed vs ITSELF |
| ---- | -: | --------------------: | ----------------: |
| d2c16 | 0.9 | 18% | 12% |
| d2c32 | 2.0 | 12% | 8% |
| d3c32 | 12.7 | 25% | **25%** |
| d3c64 | 44.0 | 30% | **25%** |
| d4c32 | 97.6 | 32% | **28%** |

Past depth 3 the two columns coincide: extra depth appeared to be buying nothing
but different dice. Without the self-comparison this would have read as "deeper
search keeps finding things", which is the opposite conclusion.

**3. Common random numbers (`crn=1`) remove the dice entirely.** Driving every
root move from one stream, seeded from the position, makes the comparison paired
and the search deterministic: self-disagreement goes to **0% at every rung**.
And that inverts finding 2 — with the noise gone, depth 3 → depth 4 still
changes **25%** of decisions, and now that is *entirely* a depth effect. Depth
was doing real work all along; sampling noise was hiding it.

**4. But removing the noise does not change the score.** `crn=1` measures
-9 ± 16 at depth 2 and +8 ± 15 at depth 3, at identical cost. Both facts
together have one explanation: **the decisions that flip are near-ties.** A
quarter of decisions change and it costs nothing, because either choice is worth
about the same.

**5. So spend effort only on decisions that are close but not tied — except
that does not work either.** `gap=N` re-searches deeper when the top two moves
are within N points:

| config | vs base | ms/move | points per ms |
| ------ | ------: | ------: | ------------: |
| `gap=10` | +35 ± 16 | 13.1 | 2.7 |
| `gap=30` | +49 ± 16 | 15.3 | 3.2 |
| `gap=80` | +41 ± 16 | 16.4 | 2.5 |
| uniform depth 3 | +48 ± 17 | 17.6 | 2.7 |

`gap=30` matches uniform depth 3 at 87% of its cost: a 13% gain, not a
step change. The cost column says why — base is 1.7 ms and gap-triggering runs
at 13-16 ms, so it fires on most moves. Near-ties are the common case, not the
rare one, which is exactly why this is not the `esc=6` result again (that won by
selecting a genuinely rare event, 1.6% of moves).

**Conclusion.** Search precision is not what is limiting the score. The
lookahead already changes a quarter of its decisions when given more depth, the
decisions it changes are ones where being wrong is nearly free, and eliminating
decision noise altogether buys nothing. What is left is the *ranking accuracy of
the evaluator on close decisions* — and no search strategy fixes that.

This is consistent with the headline extrapolation and makes it more credible:
**13 000 at 1 s/move is an evaluator problem, not a search problem.** The most
valuable next work is a better value function, not MCTS.

What that means for the four goals:

- **Goal 1 (one smooth time knob)** — done, `ms=N`.
- **Goal 4 (trustworthy analysis)** — `crn=1` gets most of the way: the bot's
  opinion is now a deterministic, reproducible function of the position rather
  than 25% dice. What it cannot yet do is tell you *how sure* it is; the value
  is not a calibrated score forecast.
- **Goal 2 (better gradient)** — no search strategy tried has one. The gradient
  is a property of the evaluator.
- **Goal 3 (13 000)** — not reachable this way.

### Finding — the predicted score is usable, but biased low by a known amount

Goal 4 has two halves: does the bot pick the right move, and can its *number* be
believed. `crn=1` answers the first (the opinion is now deterministic). This is
the second. `analyse.js` with `CALIB=1` takes positions at move M, records the
search's root value as a prediction of the final score, then plays the same game
out and compares.

| at move | predicted | actual | bias | correlation (1 future) | correlation (8 futures) |
| ------: | --------: | -----: | ---: | ---------------------: | ----------------------: |
| 200 | 9088 (sd 219) | 10356 (sd 391) | **-1268** | -0.006 | **0.569** |
| 500 | 9529 (sd 284) | 10387 (sd 646) | -858 | 0.563 | — |
| 800 | 9987 (sd 371) | 10298 (sd 702) | -311 | 0.610 | — |

**The correlation column is a trap and both numbers are in the table for a
reason.** Measured against a single played-out future, the value at move 200
correlates -0.006 with the outcome, which reads as "the estimate is worthless
early". It is not: at move 200 the realised spread is 970 while V's spread across
positions is 219, i.e. almost all of the variance is future luck rather than
present position. Averaging each position over 8 independent futures -- same
board, different engine rng -- lifts the correlation to 0.569. The estimate was
fine; the measurement was noise-limited.

**The bias is real, systematic, and explainable.** V is trained by TD under the
behaviour policy, which is greedy and scores about 8700. The game is then played
out with search, which scores about 10400. So V predicts, faithfully, the value
of a continuation nobody plays -- and under-predicts by 1268 early, shrinking to
311 by move 800 as the remaining game gets shorter and the policies matter less.

Two consequences worth acting on:

- For an analysis interface, the number should be shown with the offset removed,
  or shown as a *difference between moves* rather than as a level. Move
  differences are unaffected by a common bias.
- The principled fix is to train V under the search policy rather than the greedy
  one. That would move the level and, more usefully, teach it what search play
  actually achieves from a position -- which is the same evaluator-quality
  problem the search findings point at.

### Finding — ensembling two networks does nothing

Averaging `dom21q` with `bigx-s7` (supported by `loadNetworks` via `a.bin+b.bin`)
scores **+2 +- 15** against `dom21q` alone at 3.6x the evaluation cost;
`bigx-s7` alone is -41. The weaker network's errors are not complementary
enough to be worth averaging, so the cheap route to a better evaluator is closed.

### Candidate 1 — anytime ladder (`ms=N`)

`search.js` now takes `ms=N` and climbs a ladder of the measured Pareto-optimal
configurations in cost order, answering with the last rung that completed. One
knob — milliseconds — replaces the depth 2/3/4 family, and it can be stopped
whenever the caller likes.

A rung is never returned half-finished. A partial pass would leave some root
moves scored deep and others shallow, and choosing the max over estimates of
unequal precision is exactly the mistake that has already cost this project
three separate ideas (`norefill`, control variates, graded allocation). Being
anytime at *rung* granularity is safe; being anytime at *move* granularity is
not, and that constrains how fine the time control can get.

The price is the work spent on every rung below the last one. Classical
iterative deepening gets away with this because successive plies cost a large
constant factor more, making the overhead a small fraction; here consecutive
rungs differ by only 2–5x, so the overhead should be 25–50%. Whether that is
worth paying is the measurement.

### Session start — plan

Ordered by information per minute of compute, cheapest first:

1. Validate the subgames against the known full-game ranking of four agents.
   Without this nothing downstream means anything.
2. Measure a clean score-vs-time curve in one run, so timings are comparable,
   using whichever subgame validated best.
3. Candidate anytime searches, compared on gradient rather than absolute score:
   - **iterative deepening** — the obvious unification of depth 2/3/4, anytime
     for free, and a fair baseline for anything cleverer.
   - **MCTS with chance nodes** — the canonical anytime algorithm. Prior caution:
     three separate results this project has already produced say that *unequal
     estimation noise across siblings at a max node is harmful*, because the max
     selects the luckiest estimate. MCTS is built on unequal sampling, so it may
     inherit that problem; the counter-argument is that its bias shrinks as
     visits grow, which is exactly the regime being targeted here.
   - **transposition/caching**, which helps whatever else wins.
4. Only then, long time controls.
