# A value network for *analysing* positions

> **Retired-architecture note.** This document describes the 21/39-bank `dom*`
> networks and their weight-bank / sparse-`.bins` machinery, all now retired. The
> current deployed net is the single-bank `all7g-Rcq.bin` (virtual-cell globals);
> see bot/README.md. This is kept as a research record.

`SCALING.md` and `LEADERBOARD.md` chase playing strength. This is a different
target: a network that evaluates **any** position accurately, including ones it
would never reach itself, so that a human game can be annotated move by move —
"the bot thinks this move loses X points".

Two things follow from that goal and neither is obvious.

**The magnitude matters, not just the ranking.** Every measurement in the other
two logs is ultimately a score in a game. A network can rank moves perfectly and
still print nonsense for X.

**Playing strength is explicitly not the objective.** If accuracy on strange
positions costs a few points of self-play score, that is a trade worth making.
It changes which of the previously rejected ideas are back on the table — and,
as it turns out, which are still rejected.

---

## The baseline: what the current network actually reports

`dom21q`, held-out human positions (`bot/data/human-test.bin`, 910 games never
trained on), 500 positions x 24 rollouts x 3 moves, continuations played by a
fixed reference (`--rollout-weights dom39q`):

| rank | predicted loss | true loss | overstatement | corr with truth |
| ---: | ---: | ---: | ---: | ---: |
| 2 | 113.4 | 72.2 | **+41.2** | 0.27 |
| 3 | 188.2 | 109.6 | **+78.6** | 0.25 |

The tool overstates what a move cost by about 60%, and the number it prints
correlates only ~0.25 with the truth. Ranking moves well and pricing them well
are different skills, and nothing in the training ever asked for the second.

> **Two corrections to earlier versions of this file.** Both mattered enough to
> change what the numbers said, and neither was caught by the code running.
>
> **The rollout harness had a bug.** `rollout()` started from an afterstate —
> the move applied, the collapsed cells still holes — and picked its first move
> *before* the random refill. That penalises exactly the moves that collapsed
> the most tiles, which are the strong ones, so it understated the true value of
> every good move. It reported the true cost of `dom21q`'s second choice as
> **-1.9 points**, i.e. that its top-two discrimination carried no information;
> the real figure is **+72.2**. Every `calib.js` number in this file predates
> the fix by one revision and has been re-measured. The tell was `reveval.js`
> reporting a *negative* mean true loss for the bot's own preferred move against
> a human's, which cannot be true and was worth stopping for.
>
> **250 positions was not enough.** A rank-3 correlation of 0.559 measured at
> 250 positions read 0.316 at 500. Nothing below is quoted at 250.

### Why: the residual on positions the bot never visits

`residual.js --by-sixes`, `dom21q`, bucketed by 6-count so a stage difference
cannot masquerade as a distribution difference:

| 6s on board | bot gap2 | human gap2 | bot gap4 | human gap4 |
| --- | ---: | ---: | ---: | ---: |
| 0-2 | 7.6 | **37.1** | 21.8 | **127.2** |
| 3-5 | 5.8 | **28.8** | 24.0 | **72.6** |
| 6-8 | 7.3 | **28.1** | 29.3 | **83.6** |
| 9-11 | 5.7 | **30.6** | 24.7 | **59.6** |

Human positions carry 4-5x the Bellman residual at matched stage, and they have
*fewer* legal moves (9.2 against 11.0), so branching is not doing it either. The
residual is positive and grows with rank — V under-values moves and under-values
bad moves most — which is exactly the sign that makes a depth-1 analysis
**overstate** what a move costs.

The stage control matters. Human games run to 8.1 sixes on average against the
bot's 13.8, so an uncontrolled comparison would have found the same gap for the
wrong reason. The bot's own gap2 is flat at 6-8 across every bucket, so the
difference is distribution, not stage.

### The distinction that makes this fixable

`SCALING.md` records six mechanisms for repairing the residual, all of which
failed. It would be easy to read this as the seventh.

It is not the same problem. On the bot's own distribution gap2 ~ 7 is a
**representational floor** — the data is there, the architecture cannot express
the rest, and every repair mechanism tested just moved error from one rank to
another. On human positions gap2 ~ 30 is a **data deficit**: TD only ever
updated the afterstate it walked into, and it never walked here.

Coverage is the one thing that fixes a data deficit, and it is the one thing
none of those six mechanisms supplied.

**Prediction, recorded before the run:** human gap2 falls from ~40 toward the
7-10 floor and gap4 from ~104 toward ~25, and it stops there. If pushing further
starts to need sibling updates or frozen-target distillation, that is the signal
to stop rather than repeat the failures in `SCALING.md`.

**How it turned out: the prediction was wrong.** gap2 went 40.2 -> 31.2 and
stopped, nowhere near 7-10, and the corrected `calib.js` figures improved by far
less than the first measurement suggested. The residual is a good *diagnostic*
of where a network is untrained and a poor *proxy* for how well it prices a
move, because it measures one Bellman backup rather than the whole continuation.
Neither turned out to be the metric the application needed — see the negative
result below.

---

## Two metrics, and why one is not enough

| tool | measures | blind to |
| --- | --- | --- |
| `residual.js` | self-consistency: what one Bellman backup would change | being consistently wrong — the residual is zero at *any* fixed point |
| `calib.js` | ground truth: V against Monte Carlo rollouts | nothing, but it costs thousands of games |

`residual.js --positions POOL --by-sixes` is cheap enough to run between
training stages. `calib.js --moves 3` is the one that answers the actual
question, and 24 000 rollout games take about two minutes.

`calib.js` reports the delta metric with common random numbers across the moves
of a position, and subtracts the Monte Carlo variance from the reported rms
rather than letting it inflate every network equally.

### What is *not* a problem

**Quantization.** Measured over 3 825 move evaluations, `dom21q` against the
float `dom21c`: bias 0.003, rms 0.036, and on the pairwise gaps an analysis tool
would display, rms 0.045 with a max of 0.20 over 17 964 pairs, and one top-move
flip in 400 positions. Use the quantized file; it is half the size.

---

## The training scheme

Start from `dom21` and mix human positions into the start pool:

```
node bot/hstarts.js --part train --every 5 --out bot/data/human-train.bin
node bot/ptrain.js --resume bot/weights/dom21.bin --starts bot/data/human-train.bin \
    --start-frac 0.9 --start-moves 24 --alpha 0.02 --alpha-end 0.005 ...
```

Half the pool is mutated: 1-3 tiles replaced with a random value 1-6. Measured,
one mutation of a *bot* position gets about halfway to the human residual (gap2
6.8 -> ~15), so mutation is a real diversifier rather than noise — but the human
corpus is the bigger half, which is why it is half the pool and not all of it.

### `--start-moves`, and why it is the whole trick

The obvious version of this plan changes only the **first state** of each
episode. After three to five moves the bot is back in its own distribution, and
with 415-move human games the human-and-mutated states are under 1% of updates
even at `--start-frac 1.0`. The run would have measured as noise.

TD(0) bootstraps, so there is no reason to play a seeded episode out: after 24
moves the last target is V's own estimate, which is what the rest of the episode
would have converged to anyway. Truncating buys ~17x the density of updates
around the pool for the same compute, and lifts throughput from ~170 episodes/s
to 1730.

Only seeded episodes are capped. Something has to stay anchored to the true
terminal 0 — a diet of nothing but truncated episodes is a bootstrap with no
ground under it, and a uniform inflation of V is consistent with every
constraint except the terminal one. The 10% of full-length episodes are that
anchor, and their self-play mean doubles as a damage gauge: it reads ~8800 at
the start, and if interference from the new distribution is wrecking the old
one, it shows up there first.

### Deliberately not in the first run

`--explore` broadens coverage around the seeded positions and is sound (the TD
target is `qmax`, so it does not care what the behaviour policy did). It was held
back so that the first run had one mechanism to attribute its result to, with
gap2 plateauing above the floor as the trigger to add it.

That trigger fired after stage 2, and it should have fired sooner: exploration
turned out to be both the cheapest and the most effective of the three stages.
The lesson for next time is that a start *pool* only fixes where an episode
begins, and the thing that was actually missing was coverage of the moves not
taken — a different axis, and the one the residual table pointed at from the
beginning.

### The train/test split is by game

Positions from one game share a board lineage, so splitting by position would
leak. `hstarts.js --part test` holds out 1 game in 10; every measurement in this
file uses it.

---

## Free win, independent of any training

**Report the search value, not the raw V.** A depth-2 score *is* V plus the
residual — it removes precisely the error measured above, by construction.
Analysis is not real-time, so `depth 2, cap 64, topk 0, rootk 0` costs about a
second per position and needs no retraining at all.

Measured, on the **untrained** `dom21q` (`calib.js --depth 2`, corrected
harness, 500 positions):

| scoring | over (r2) | over (r3) | corr* (r2) | corr* (r3) | rms (r3) |
| --- | ---: | ---: | ---: | ---: | ---: |
| depth 1 (raw V) | +41.2 | +78.6 | 0.272 | 0.247 | 406 |
| depth 2 | **+28.3** | **+55.9** | **0.341** | **0.378** | **244** |

Depth 2 alone nearly halves the rank-3 rms and buys more than any single
training stage did, at no training cost whatever. It should be in the analysis
path regardless of which network is used — and it is the one recommendation in
this file that survived everything else being revised.

---

## Two ways to measure this wrong, both paid for

**The rollout policy must be pinned, or the ground truth moves with the
candidate.** `calib.js` rolls out to get the true cost of a move, and the
obvious choice of rollout policy — the candidate's own — makes two networks
incomparable, because a network that plays differently squanders an advantage
differently. The same 250 positions gave a true rank-2 loss of **18.2** under
one candidate's rollouts and **75.0** under another's. That is larger than the
effect being measured. Every comparison here uses
`--rollout-weights bot/weights/dom39q.bin`, a fixed third network that is not
either candidate. It also asks the better question: a user wants to know what a
move costs under *good* play, not under the analysis network's own play.

**The self-play mean in the training log is a damage gauge, not a benchmark.**
It reads ~430 points low mid-anneal and recovers as alpha falls — during stage 1
it went 8800 -> 8106 -> 8368 while nothing was getting worse after the first
third. Read the direction, never the level.

**And under `--explore` it stops being even that.** The mean is the score of the
*epsilon-greedy* behaviour policy, not of the greedy one: turning on
`--explore 0.06` dropped it from 8120 to 6556 instantly, while the greedy
strength it was standing in for fell by only 94. Anything measuring strength
during an exploring run has to come from `run.js`.

## The part training cannot fix, and the part it can

The overstatement (`over`) and the per-position correlation (`corr`) fail
independently, and only one of them is a training problem.

`calib.js` reports `slope`, the least-squares slope of truth on prediction. For
`dom21q` it is 0.82 at rank 2 and **0.37** at rank 3: the network exaggerates
differences, and worse the further down the ranking it looks. Rescaling the
displayed number by a fitted affine map is the best possible display-time fix —
a positive scalar is monotone, so it cannot change which move is recommended,
and it removes the systematic overstatement entirely.

What it does not do is make the number *informative*. `rms@fit` barely moves
(635 -> 627 at rank 2, 623 -> 582 at rank 3), because most of the error is not
scale but noise. A recalibration map is worth applying and is nearly free, but
the correlation is the real target and only training moves it.

Note that shrinkage appears in `LEADERBOARD.md` under "tried and rejected". It
was rejected for *playing strength*, where a monotone transform provably changes
nothing. For reporting magnitudes it is a different proposition, and it was
never tested for that.

## Results

Per-stage progress. `gap2`/`gap4` come from `residual.js`, which does no
rollouts and so was never touched by the harness bug; `greedy` is `run.js` over
seeds 1-200. The per-stage `calib.js` columns that used to be here were measured
with the buggy rollout and are not reproduced — the corrected figures for the
baseline and the finished network are in the table below, and re-measuring the
two intermediate checkpoints was not worth the compute once the negative result
below landed.

| stage | episodes | human gap2 | human gap4 | greedy |
| --- | ---: | ---: | ---: | ---: |
| `dom21q` baseline | — | 40.2 | 103.5 | 8754 |
| stage 1: `--start-frac 0.9`, 0.02 -> 0.005 | 3M | 35.9 | 87.3 | — |
| stage 2: `--start-frac 0.97`, 0.012 -> 0.003 | +12M | 30.8 | 85.4 | 8115 |
| stage 3: `--explore 0.06 --explore-rank 4` | +12M | 31.2 | **77.6** | 8021 |

Stage 1 did not come close to the predicted floor — gap2 was 35.9 against a
predicted 7-10 — so something was rate-limiting. The candidate was the update
budget: at `--start-frac 0.9` the 10% of full-length episodes are 850 moves each
and still supply **80%** of all updates, so the on-policy solution is actively
pulling the shared weights back. Stage 2 raised `--start-frac` to 0.97, lifting
the human share of updates from 20% to ~48% while still leaving the full-length
anchors half the updates, and doubling throughput to 4100 episodes/s as a side
effect.

**gap2 flattened well above the predicted floor**: 40.2 -> 35.9 -> 30.8 -> 31.2,
with the per-episode rate dropping 4x between stages and then stopping. More
episodes of the same thing was poor value, which is what triggered `--explore`
in stage 3. Stage 3 cost only **-94 +- 96** greedy points — not distinguishable
from free — and moved gap4 more than stage 2 did with the same episode budget.

### Where it ended up

All four configurations, held-out human positions, 500 positions x 24 rollouts,
corrected harness:

| config | over (r2) | over (r3) | corr* (r2) | corr* (r3) | rms (r3) |
| --- | ---: | ---: | ---: | ---: | ---: |
| `dom21q` depth 1 (baseline) | +41.2 | +78.6 | 0.272 | 0.247 | 406 |
| `dom21q` depth 2 | +28.3 | +55.9 | 0.341 | 0.378 | 244 |
| `dom21hq` depth 1 | **+9.1** | +64.9 | 0.376 | 0.230 | 337 |
| **`dom21hq` depth 2** | +30.1 | **+17.3** | **0.386** | **0.412** | **244** |

The training did what it was asked to do, and by less than the first (buggy)
measurement claimed. Depth 2 is the larger of the two effects — it nearly halves
the rank-3 rms on its own — and the retrained network adds a further correction
to the rank-3 bias (+55.9 -> +17.3) and to both correlations.

### The price

**-733 greedy points** (8754 -> 8021 over seeds 1-200), almost all of it from
stages 1 and 2. `dom21hq` is an evaluator, not a player.

---

## The result that matters, and it is negative

Everything above measures how well a network prices **its own second and third
choices**. The application — the review button in `spectate.html` — asks
something else: it prices the move a **human** played, which is usually much
further down the order, and then lists the five positions with the largest
predicted loss.

`bot/reveval.js` measures that directly: roll out the reviewer's preferred move
and the human's actual move, over held-out human games, and ask what the five
positions the UI would list are really worth.

| reviewer | corr(pred, true) | mean TRUE loss of a listed position |
| --- | ---: | ---: |
| `dom39q` depth 2 cap 16 | 0.123 | +76.4 +- 26 |
| `dom39q` depth 2 cap 64 | 0.148 | +82.3 +- 26 |
| `dom39q` depth 2 cap 256 | 0.148 | +82.3 +- 26 |
| **`dom21hq` depth 2 cap 16** | **-0.028** | **-53.1 +- 25** |

**The analysis network is worse at the job the analysis network was built for**,
and not marginally: its list is anti-informative. The positions it calls the
biggest mistakes are ones where, on average, the human's move was *better* than
its own preferred move.

The reason is visible once stated. This feature's accuracy is dominated by
**picking the best move**, not by pricing the gap to it — the reported loss is
measured against the reviewer's own choice, so a reviewer that picks a worse
reference move reports nonsense no matter how well calibrated it is about its
own alternatives. `dom21hq` is 733 points weaker as a player. The calibration it
gained is about its own near-ties; it does not transfer to judging a move a
human played from several ranks down.

So `spectate.html` keeps `dom39q`, at cap 64 rather than 16.

**The lesson is about the metric, not the network.** `calib.js` was built to
measure the stated goal — "the difference in evaluations matters, not just the
ranking" — and it does. It is simply not the quantity this application consumes,
and three training stages were spent optimising it before anything measured the
application end to end. The first thing to build is the metric the feature is
judged by.

### What the review is actually worth

`dom39q` depth 2 cap 64, 1 604 held-out human positions, 102 656 rollout games:

| predicted loss | n | mean TRUE loss |
| --- | ---: | ---: |
| 0-25 | 1027 | -0.8 +- 5 |
| 25-50 | 197 | 30.7 +- 14 |
| 50-100 | 191 | 24.6 +- 14 |
| 100-200 | 115 | 38.5 +- 18 |
| 200-400 | 50 | 42.6 +- 28 |
| **400+** | 24 | **229.7 +- 46** |

Three bands, and only the ends of it carry information. Below 25 there is
nothing. Between 25 and 400 there is a real but flat ~30 points, and the number
inside that band says almost nothing about where in it a position sits. Above
400 the losses are large and real.

A listed position (top 5 of a game) is worth **91.2 +- 22** against **13.7 +- 4**
for a position drawn at random, so the ranking works — 6.7x the base rate, four
standard errors from zero.

### Compressing the reviewer: `dom39s`

`dom39s` is `dom39c` sparsely compressed by `shrink.js` -- 16.8 MB against 147,
with 91% of the weights dropped and replaced by one bank-independent base value
plus a per-bank correction where it earns its place. Swapped into the review:

| | `dom39q` | `dom39s` |
| --- | ---: | ---: |
| same positions in the top 5 | — | **94%** (66/70) |
| same suggested move, listed positions | — | **94%** (66/70) |
| same preferred move, all positions | — | 88% |
| playing strength at this config, 100 seeds | — | **+36 +- 98** (equal) |
| corr(pred, true) over all positions | 0.168 | 0.098 |
| mean true loss of a listed position | 91.2 +- 22 | 55.4 +- 23 |
| speed (`timing.js`) | 1.00x | **1.91x slower** |
| size | 147 MB | **16.8 MB** |

On a real game the two are nearly interchangeable at the top: reviewing the
same 791-position human replay, `dom39q` lists 984/727/466/426/424 and `dom39s`
lists 985/728/465/421/403 -- the same five positions -- and the whole-game total
differs by 0.8% (23 538 against 23 357).

**Where it lost was the middle of the range, and the reason is the same one this
whole file is about.** `shrink.js` chooses which weights to keep by counting
reads over *bot self-play*, and its own header says coverage is the whole game.
Human positions are exactly the distribution that counting pass never saw:

| positions | V error rms | move-gap error rms | top-move disagreement |
| --- | ---: | ---: | ---: |
| bot self-play | 3.02 | 3.74 | 7.1% |
| **held-out human** | **177.4** | **98.3** | **19.6%** |

A 26x worse move-gap error off-distribution. The top of the list survives it
because the biggest mistakes are big enough to clear the noise; nothing below
about 400 does.

Note also that the drop in "mean true loss of a listed position" is **not**
resolvable from this data. 94% of the listed entries are the *same positions
with the same rollouts*, so the whole 91.2 -> 55.4 difference is carried by four
or five entries out of eighty, and a single extreme one moves that mean by ~37.
The correlation over all 1 604 positions (0.168 -> 0.098) is the reliable
statement, and it is a statement about the mid-range, not about the list.

### Fixing it: count over the distribution you will use it on

`shrink.js` gained a `--starts` option that begins a fraction of its counting
games from stored positions and cuts them off after a few plies -- the same
truncation trick, and needed for the same reason, as `--start-moves` in
`ptrain.js`. A full self-play game contributes ~10 000 boards and a 10-ply
seeded one about 90, so getting the two distributions to comparable read counts
takes 512 000 games of which 97.7% are seeded.

```
node bot/shrink.js --in bot/weights/dom39c.bin --out bot/weights/dom39h.bins      --keep 8000000 --games 512000 --jobs 4      --starts bot/data/human-train.bin --start-frac 0.977 --start-moves 10
```

| | `dom39s` (self-play counts) | `dom39h` (+ human counts) |
| --- | ---: | ---: |
| move-gap error, human positions | 70.6 | **14.2** |
| top move differs, human | 11.4% | **6.3%** |
| move-gap error, bot positions | 3.74 | 3.73 |
| same positions in the top 5 | 94% | **97%** |
| same suggested move, listed | 94% | **98.6%** |
| playing strength at this config | +36 +- 98 | +24 +- 112 |
| size | 15 MB | 17 MB |

**5x the off-distribution accuracy for 2 MB, and nothing given up on the
distribution it already had.** The counting pass now sees 16.6M distinct slots
rather than 12.1M, so the same 8M budget covers a smaller share of them, and it
still costs the bot side nothing -- the slots it now shares with were the
rarely-read ones.

One reading trap in that table: the bot-side top-move disagreement goes *up*
(7.1% -> 10.9%) while the bot-side move-gap error is flat, and playing strength
is unchanged. Those extra disagreements are near-ties worth nothing. Counting
disagreements is the misleading statistic and magnitude is the real one, which
is the point `agree.js` was written to make.

### Greedy cannot find the mistakes, but a very cheap search can

The review's cost is dominated by `cap`, the number of sampled refills at a
chance node. Per position on `dom39h` (`bot/timing.js`):

| scoring | ms/position |
| --- | ---: |
| greedy (no search) | 0.04 |
| depth 2, cap 2 | 1.03 |
| depth 2, cap 16 | 2.94 |
| depth 2, cap 64 | 8.49 |
| depth 3, cap 32, full root width | 185 |

So the obvious economy is to scan the game with something cheap and search only
the candidates. **Greedy is the wrong cheap thing.** Ranked by greedy loss
against the same network searched at cap 16:

| scanner | recall of the searched top 5, @K=5 | @K=10 | @K=20 | @K=80 | same best move, all positions |
| --- | ---: | ---: | ---: | ---: | ---: |
| greedy | 27.1% | 41.4% | 57.1% | 84.3% | 50.9% |
| **depth 2, cap 2** | **92.9%** | **98.6%** | **100%** | 100% | 84.5% |

Greedy disagrees with the searched reviewer about the best move at **half** of
all positions, and its loss numbers are not merely noisy but wrong in a
structured way: 1650/1137/994/950/925 where the search says 645/184/76/0/35. Its
"loss" is `(gain + V)(best) - (gain + V)(played)`, and V's Bellman residual is
exactly the error in that expression — the thing this whole file is about.

Two sampled refills are enough to fix it. Almost all of what search adds is the
*existence* of the backup, not the precision of the expectation.

**The two-pass reviewer** that follows: scan every position at cap 2, re-score
the top 40 at cap 64, sort on the re-scored numbers, and apply `MISTAKE_MIN` to
those — which is what drops a position the cheap pass called a blunder and the
careful pass does not. Measured in the page on a 791-position human replay, it
produces a **bit-identical top five** (984/727/468/423/402) in **2 100 ms
against 3 922**.

The cheap pass agrees with the careful one about the best move at only 84.5% of
positions, which is fine for ranking a game and not fine for the arrow drawn on
the board. So the position on screen is re-scored on demand the first time it is
shown: 5.7 ms on arrival, 0.4 ms on a revisit, cached on the frame.

`depth 3` is not worth considering here — at full root width it is 185 ms per
position, 22x cap 64, and when it was tried it moved the measured total by 7%
without changing which positions came out on top.

### Was compression worth it at all?

Yes, and the alternative that looks obvious is not competitive:

| net | size | review speed | top-5 overlap | same suggested move | strength |
| --- | ---: | ---: | ---: | ---: | ---: |
| `dom39q` | 140 MB | 1.00x | — | — | reference |
| `dom21q` | 75 MB | 1.00x | 86% | 91.4% | weaker |
| **`dom39h`** | **17 MB** | 1.91x | **97%** | **98.6%** | +24 +- 112 |

Dropping back to `dom21` is **dominated**: 4x the size of `dom39h` and a worse
match to the full network, because it is a different and weaker network rather
than the same one with weights removed. The only real cost of compression is
speed -- the sparse format's two-level index makes every weight read slower, and
that is 1.91x whichever counting distribution was used.

Two changes to `spectate.html` follow:

- **`MISTAKE_MIN = 200`.** The top five of a full game land in the 400+ band
  anyway; the bar matters for a *clean* game, where the list would otherwise pad
  itself out with five harmless moves and present them as mistakes. Measured on
  a 12 696-point depth-3 replay a bar of 100 already cut the list from five
  entries to one. 200 is a judgement call, not a measurement -- the evidence
  would support 400 for `dom39s`, but a 400 floor would only ever bite on weaker
  games, which are the ones the list is most useful for.
- **cap 16 -> 64**, worth a little (corr 0.123 -> 0.148) where cap 256 is worth
  nothing more. A 792-move review runs 4.1 s with `dom39s` at cap 64, against
  0.7 s for the original `dom39q` at cap 16.

### On the displayed number

Regressed through the origin, true loss ~ **0.32 x** the displayed one, so the
UI runs about 3x high. It is not rescaled, for two reasons. A monotone rescale
cannot change which positions are listed, which is what the number is for; and
the factor is confounded — the truth is measured with a *greedy* playout while
the reviewer searches to depth 2, so part of that 3x is advantage the greedy
continuation fails to cash in rather than error in the estimate. Separating the
two needs depth-2 rollouts, which cost about 100x more than the budget here.
The hint text says the number is a ranking rather than a price.

---

## How to use this for annotating a game

Use **`dom39q`**, not `dom21hq` — see the negative result above.

```
node bot/run.js --agents "fx:weights=bot/weights/dom39q.bin,depth=2,cap=64,topk=0,rootk=0"
```

or, in code, `Search.makeSearcher(net, { depth: 2, cap: 64, capDeep: 64, topk: 0, rootk: 0, rng })`
and read `scoreMoves(game)`. The reported cost of a move is
`value(best) - value(move)`.

`dom21hq` is the better choice only if what is being priced is the network's own
close alternatives rather than an arbitrary human move; nothing in this repo
currently needs that.

Three things it is worth telling the user alongside it:

- **`topk: 0, rootk: 0` matters.** A pruned root leaves most moves holding their
  shallow value, and their reported cost reverts to the depth-1 number, which is
  the badly calibrated one. Pruning is for playing fast, not for analysing.
- **The remaining error is per-position noise, not bias.** A single "this move
  cost 40 points" is worth much less than the same claim aggregated over a game.
- **Analysis costs about 3 seconds per position** at this width, against 0.03 for
  a greedy evaluation. That is fine for annotating a finished game and not fine
  for anything interactive.

## Open

- **The one thing that would make the review list better is a stronger player,**
  since its accuracy is dominated by picking the right reference move. That
  points back at `LEADERBOARD.md`, not at this file.
- **Per-position truth is barely measurable.** One move's real effect on a final
  score is small against the spread of a game (sd ~1500), and common random
  numbers stop helping once the two lines diverge, so resolving a single position
  to +-25 points needs ~1600 rollout pairs. Every conclusion here is a population
  statistic; none of them licenses a claim about one position.
- **No matched-episode control.** 27M episodes went in; some unknown part of the
  change is simply more training rather than the human distribution. Resuming
  `dom21` for 27M episodes on its *own* start distribution would settle it.
- **Depth-2 rollouts would separate the 3x.** The displayed loss runs 3x high
  against a greedy playout, and how much of that is real error versus advantage
  a greedy continuation cannot cash in is unresolved.
- **`dom39` was never tried as the base.** `dom21` was chosen because human
  positions sit at 0-8 sixes where `dom39`'s extra 6-count banks add nothing, but
  that reasoning was never tested.
- **The mutation rate was never swept.** Half the pool is mutated with 1-3 tiles
  because one mutation of a bot position closed about half the residual gap; no
  other setting was tried.
