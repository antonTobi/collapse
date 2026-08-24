# Bots

Headless implementation of the game plus a place to develop and benchmark agents.

| file | what it is |
| --- | --- |
| `engine.js` | The rules, headless. Verified move-for-move identical to `game.js` (board, score, PRNG, splits, move encoding, game-over) — no rendering, achievements or storage. |
| `agents.js` | Agent registry. An agent is `{ name, chooseMove(game) -> [i, j] }`. |
| `eval.js` | Position features and the linear evaluation the heuristic agents share. |
| `ntuple.js` | The learned value network: tuple sets, symmetry, stage banks, weight file format. |
| `run.js` | CLI benchmark: runs every agent on the same seeds and compares. |
| `harness.js` | Worker pool used by the tuning and fitting scripts. |
| `search.js` | Expectimax over the value network: max nodes on full boards, chance nodes over the tiles that drop into the holes. |
| `grow.js` | Copy a trained network into a bigger architecture (more tuples, more stage banks) without changing what it computes. |
| `starts.js` | Sample positions from search play, for training episodes to start from. |
| `hstarts.js` | Start positions drawn from human games, optionally mutated, for training a network that has to evaluate positions it would never reach. Holds out 1 game in 10. |
| `reduce.js` | Drop the mirror-duplicated half of a network's tuples. Same function, 40% fewer table reads. |
| `compact.js` | Fold every subset-redundant tuple into a tuple containing it. Same function, 64% fewer lookups, 1.6-1.9x faster. |
| `record.js` | Save a game as a replay (seed + move list) for the spectator, or `--scan` a seed range and keep the best. |
| `quantize.js` | Store the weights as int16 with a per-table scale. Half the memory traffic, 1.12x end to end, -14 +- 67. |
| `shrink.js` | Drop the 91% of weights nobody reads: one bank-independent table plus a per-bank correction where it earns its place. Writes a sparse `.bins` file 8.8x smaller than the int16 one, for -0 +- 90. |
| `corpus.js` | Freeze a set of real-game decisions to a file, so a value function can be judged without playing anything. |
| `agree.js` | Does a candidate value function make the same moves as a reference one? Agreement, regret and correlation over a corpus. |
| `tuples.html` | Every tuple shape the network reads, drawn on a board. Open it directly; it reads `ntuple.js`, so it cannot go stale. |
| `residual.js` | V's Bellman residual by move rank. Everything search buys over greedy is this number, and it costs seconds to read. |
| `timing.js` | How fast agents pick a move, on identical positions and one clock. Use this for speed, not `run.js`'s `ms/move`. |
| `calib.js` | Is the *number* right, not just the ranking? V against Monte Carlo rollouts, including the "this move loses X" delta. |
| `reveval.js` | Does the spectator's "biggest mistakes" list contain real mistakes? Rolls out the reviewer's move against the human's over held-out games. |
| `listagree.js` | Do two reviewers highlight the same mistakes? Top-N list overlap, suggested-move agreement, and recall of one ranking inside another's top K. No rollouts, seconds to run. |
| `probe.js` | Play one position out many times per candidate move, to settle an argument about a single move. |
| `tune.js` | Weight tuning by playing games: 1-D sweeps, coordinate ascent, random-direction climbing. |
| `train.js` | TD(0) self-play training of the value network, single process. |
| `ptrain.js` | The same training across all cores (Hogwild on a SharedArrayBuffer), and the only one that can train with a search behaviour policy. |
| `spectate.js` + `../spectate.html` | Play a game out headlessly, then scrub the replay with a slider, the arrow keys or Home/End. |

Everything that learns from human play goes through one loader:

| file | what it is |
| --- | --- |
| `fetch-replays.js` | Download finished games from Firestore to `data/replays.jsonl`. |
| `replays.js` | Load, filter and walk those games. The one place that knows the move encoding and the quality filter. |
| `fit.js` | Fit `eval.js` weights to the moves humans chose (softmax ranking loss). |
| `pretrain.js` | Fit the value network to human play, by MC return and/or ranking loss. |
| `disagree.js` | Where a given agent disagrees with strong humans, and which features move in those positions. |
| `human.js` | Play an agent on the exact seeds humans played, and compare the means. |

## Where this stands

The best agent is expectimax over an n-tuple value network:

```bash
node bot/run.js --agents "fx:weights=bot/weights/dom39q.bin,depth=3,cap=32,capDeep=4,topk=2,rootk=6" --seeds 200 --jobs 10
```

**10 813 ± 71** over seeds 1-200, median 11 000, best 12 675. The previous best
agent in this folder scored 6450 with a worst game of 272. A strong human
averages around 7400.

The ladder that got there, on seeds 1-100 except the last row:

| | mean | ms/move |
| --- | ---: | ------: |
| previous best (`blend`, linear + small net) | 6450 | 0.04 |
| the same idea with a network 36x bigger, trained 1.6M episodes | 7799 | 0.06 |
| + stage banks and cross tuples, grown into rather than trained cold | 8595 | 0.10 |
| + depth-2 expectimax | 10 116 | 3.3 |
| + depth-3 expectimax | 10 526 | 46 |
| + dominoes and a 5-group banking dimension, 6M episodes | 10 822 | 20 |
| + subset compaction (same function, fewer lookups) | 10 856 | 12.5 |
| + 6-count banks refined 7 -> 13 bins, +12.5M episodes (seeds 1-200) | **10 813** | 10.1 |

That last row does not look like progress and the ladder is the wrong instrument
to read it with. At 200 seeds a depth-3 benchmark carries ±71, so `dom39q`'s
10 813 against `dom21q`'s 10 741 on the same seeds is +72 ± 90 -- unresolvable.
Measured where it can be measured, the refinement is worth **+106 ± 33** at
depth 2 over 1500 seeds and **+54 ± 21** greedy over 6000, for **1.4% more time
per move at depth 2 and none at depth 3**. Every row above it carries the same
±80-100, which is worth remembering before reading small differences off this
table.

### What search costs, and what it buys

All paired against the same agent on seeds 1-200, on an idle machine, using
`dom21q.bin` unless noted. `ms/move` is only comparable within a single run, so
these all come from runs that included their own baseline.

| config | mean | ms/move |
| ------ | ---: | ------: |
| depth 1 (greedy, no search) | 8727 | 0.04 |
| depth 2 `cap=4` | 9803 | 0.43 |
| depth 2 `cap=8` | **10128** | **0.52** |
| depth 2 `cap=16` | 10421 | 0.88 |
| depth 2 `cap=16 esc=6` | 10449 | 1.01 |
| depth 2 `cap=96 rootk=16` | 10641 | 7.7 |
| depth 3 `cap=16 capDeep=2` | 10758 | 10.7 |
| depth 3 `cap=32 capDeep=4` | 10827 | 16.4 |
| depth 3 `cap=64 capDeep=4 topk=3 rootk=8` | 10925 | 57.6 |
| depth 4 `cap=32 capDeep=2` (10 seeds) | ~+438 +- 405 vs depth 3 | 120 |

Three things worth knowing before spending compute on search.

**Benchmark at depth 2, play at depth 3.** Depth 3 is worth +390 to +560, so it
is the right thing to play at. It is the wrong thing to *measure* with: the same
weight change comes out +351 +- 84 at depth 2 and +281 +- 115 at depth 3, and
the five-group ablation costs -175 +- 77 at depth 2 and -238 +- 104 at depth 3.
Both agree within noise, and a game costs 1.1 s at depth 2 against 15.8 s at
depth 3 -- so for the same wall clock depth 2 buys 14x the seeds and an error
bar 3.7x tighter. A 100-seed depth-3 benchmark costs what a 1400-seed depth-2
one does, and tells you less.

**Lookahead pays on the turns that commit a 6, and almost nowhere else.**
`esc=N` searches one ply deeper when the move that comes out makes a tile of at
least N. `esc=6` fires on about 1.6% of moves and recovers 28% of what full
depth 3 buys, for 1.6% of the extra cost -- +90 +- 68 for +0.15 ms/move, an
exchange rate 18x better than paying for depth everywhere. `esc=5` fires on
about 20% of moves for +145 +- 85. Escalating *deeper* than one ply does not
help: on 6-makers, going to depth 4 or 5 instead of 3 measures +4 +- 81 and
+61 +- 77, i.e. nothing.

**The chance node is load-bearing; do not remove it.** `norefill=1` skips it and
hands the afterstate to the next max node with its holes still empty. That is
much cheaper and much worse than no search at all: 8307 against greedy's 8727,
and it degrades monotonically with depth (7016 at depth 3, 5707 at depth 4).
The reason is structural rather than a matter of leaf calibration -- without the
chance node the agent picks the next position instead of nature picking it, so
it plans combinations on an emptying board that the refill then breaks. Training
a network on hole-heavy positions would fix the leaf estimates and sharpen the
wishful thinking rather than remove it.

### Search ideas that did not work

All measured paired on seeds 1-200 at depth 2 unless noted, all against a
cheaper plain configuration rather than against nothing -- which is the
comparison that matters, and the one that killed most of these.

| idea | result |
| ---- | ------ |
| `norefill=1` -- drop the chance node, evaluate holes directly | 8307 against greedy's 8727; worse with depth |
| `cvk` -- control variates at chance nodes | -419 +- 83 at half the cost; a plain depth 2 at the same price scores ~200 more |
| `grade` -- budget by rank instead of a `rootk` cliff | loses at every price point (-480, -140, -113) |
| incremental evaluation | 1.19x ceiling *before* overhead; not implemented |

Three of these fail for one reason, and it is worth stating as a rule: **at a
max node, unequal estimation noise across siblings is actively harmful, because
the max selects whichever candidate got the luckiest estimate.** Graded
allocation gives rank 6 a 2-sample estimate and rank 1 a 16-sample one, so a
mediocre move with a noisy estimate beats a good move with an accurate one.
Control variates inject variance into every chance node and the max above
converts it into optimism. `norefill` is the extreme case: zero samples, so the
agent plans against whichever future it likes best. The uniform budget and the
Latin-hypercube stratification are not naive defaults -- they are what keeps
siblings comparable, and every scheme tried here that broke that lost.

Incremental evaluation fails for an unrelated and slightly ironic reason:
`compact.js` made it unattractive. A collapse changes 8 of 25 cells (gravity
moves whole columns), and with 28 large tuples those 8 cells dirty 75% of them,
while the bank changes on 36% of transitions and forces a full recompute anyway.
With the old 78 small tuples the dirty fraction would have been much lower. The
two optimisations are in tension and compaction already won.

### Speed: measure it with `timing.js`, not with `run.js`

`run.js` prints `ms/move`, and it is the wrong number for comparing agents. It
benchmarks agents sequentially, so other load on the machine lands on whichever
agent was running rather than cancelling out; each agent plays its *own* games,
so a stronger agent's longer, 6-heavier positions cost a different amount and the
figure mixes speed with trajectory; and timings from separate invocations are not
comparable at all. Measured badly, `dom39q` looked 1.6x slower than `dom21c`;
measured properly it is 1.4% slower.

```bash
node bot/timing.js --agents "td:weights=bot/weights/dom21q.bin,td:weights=bot/weights/dom39q.bin"
```

One set of positions sampled from real play, replayed by every agent, agents
interleaved round-robin with the order rotated each round, and the **best** pass
reported rather than the mean -- the fastest observed pass is the one least
polluted by whatever else the machine was doing. Seconds to run, because timing
needs positions rather than whole games.

ms/move on an idle machine, 250 positions at depth 1 and 200 at depth 2:

| network | table | depth 1 | depth 2 `cap=16` | depth 3 `cap=32` |
| ------- | ----: | ------: | ---------------: | ---------------: |
| `dom21c` float32 | 151 MB | 0.0254 | 1.415 | — |
| `dom21q` int16 | 75 MB | 0.0260 | **1.286** | **10.11** |
| `dom39c` float32 | 280 MB | 0.0289 | 1.445 | — |
| `dom39q` int16 | 140 MB | 0.0262 | **1.305** | **10.07** |

**A network with 1.86x the weights costs 1.4% more per move at depth 2 and
nothing at depth 3.** After compaction a leaf evaluation is 28 lookups whatever
the table size, and those lookups were already missing cache, so doubling the
table barely changes them. That is worth knowing before rejecting a bigger
network on speed grounds. The int16 tables also come out 0.91-0.92x their
float32 twins, which reproduces the `quantize.js` result independently.

### What capacity buys, and what it does not

Every trained network in the folder, greedy and depth 2 `cap=16`, seeds 1-200:

| net | weights | banks | greedy | depth 2 | search gain |
| --- | ---: | ---: | ---: | ---: | ---: |
| `c_base` | 0.09M | 1 | 5527 | 7028 | +1501 ± 101 |
| `big-td` | 3.08M | 1 | 7834 | 9269 | +1435 ± 80 |
| `big-s3` | 9.23M | 3 | 8150 | 9857 | +1706 ± 90 |
| `bigx-s7` | 22.82M | 7 | 8639 | 10090 | +1451 ± 104 |
| `dom21c` | 39.53M | 21 | 8727 | 10381 | +1655 ± 114 |

Capacity still pays — about **+240 per doubling of weights** at depth 1 and
**+370** at depth 2 over the top four rows, with no clean sign of saturation.

**And it does not close the gap search fills.** Over a 460x capacity range the
depth-2 gain is 1501 / 1435 / 1706 / 1451 / 1655: flat, and flat in percentage
terms (17-21% once past the smallest net). A better evaluator lifts greedy and
search together rather than making search redundant, so the two are complementary
programs and neither reaches 13 000 alone. See SCALING.md, where six separate
attempts to move that +1500 into the weights all failed and the reason is
measured.

Which axis to grow matters for more than memory: `value()` loops over the tuples
and the bank is only an offset, so **refining `--edges` costs no extra lookups
per evaluation** while adding tuple shapes costs one each, on every leaf of every
search.

### There is no smaller n-tuple network to distil into

Zeroing a shape family and benchmarking what is left ranks what the tuples
carry:

| family | tuples | share of table | cost when zeroed |
| ------ | -----: | -------------: | ---------------: |
| 2x3 blocks | 6 | 43% | -2865 +- 80 |
| 3x2 blocks | 8 | 42% | -2624 +- 77 |
| both block families | 14 | 85% | -3818 +- 67 |
| plus shapes | 6 | 1% | -371 +- 74 |

The expensive tuples are the ones carrying the function, so trimming the
architecture to make evaluation cheaper has nothing cheap to trim. (The two
block families sum to far more than they cost together, which is coarse coding
working as intended: each partly covers for the other.) Distillation would have
to be into a different function class entirely, not a smaller tuple set.

### ...but 91% of the weights are never read

The architecture cannot be trimmed. The *table* can, by a lot, and the reason is
not that the weights are redundant in any structural sense -- it is that almost
none of them are ever looked at.

Counting reads per (bank, entry) slot over 178M afterstates of real play
(`shrink.js`, or `--save-counts` and reuse):

| | |
| --- | ---: |
| slots in `dom39c` | 73.4M |
| exactly zero (never touched in training) | 16.7% |
| ever read in 178M afterstates of play | 12.1M (16.5%) |
| slots holding half of all reads | 203k (0.28%) |
| slots holding 80% of all reads | 1.14M (1.6%) |
| distinct entries read, ignoring the bank | 544k of 1.88M |
| banks a read entry appears in, on average | 12.5 of 39 |

And the 39 banks are near-copies of each other: correlation 0.91-1.00 over the
entries they share, 0.99-1.00 between any two of banks 18-38. So write each
weight as a bank-independent `base[e]` -- the read-weighted mean across banks --
plus a correction `corr[s][e]`. The base carries an rms of 217, the correction
26. Keep the corrections that earn their place, ranked by `reads x correction^2`,
and let everything else read the base:

| kept corrections | file | vs f32 / int16 | regret | greedy, 300 seeds | depth 2, 400 seeds |
| ---------------: | ---: | -------------: | -----: | ----------------: | -----------------: |
| all 73.4M (`dom39c`) | 294 MB f32, 147 MB int16 | 1x | 0 | 8949 | 10251 |
| 12.1M (everything read) | 20.3 MB | 14.4x / 7.2x | 0.14 | | |
| **8.0M** (`dom39s.bins`) | **16.8 MB** | **17.5x / 8.8x** | **0.14** | **-0 +- 90** | **-57 +- 62** |
| 4.0M | 11.1 MB | 26.4x / 13.2x | 0.36 | -107 +- 99 | -91 +- 66 |
| 2.0M | 8.0 MB | 36.8x / 18.4x | 1.62 | | |
| 1.0M | 6.3 MB | 46.6x / 23.3x | 4.13 | | |

`regret` is `bot/agree.js`: the mean shortfall, measured by the *reference* value
function, of the move the candidate picks over 85k real decisions. It is the
number to watch, not the agreement percentage -- the median gap between a
position's best and second-best move is 11 points of V, so a perturbation of a
few points flips a great many decisions that were worth nothing. For scale,
`dom21q` scores 0.44 and plays -85 +- 123; `bigxr-s7` scores 1.90 and plays
-200 +- 101; `big-td` scores 15.1 and plays -1040.

Those are real files: `shrink.js` writes a `CNTS` sparse network, and every
agent reads it through the same `net.value(cells)` -- `td:weights=...bins` just
works. The 16.8 MB splits as 3.8 MB of base, 8.2 MB of corrections and 4.8 MB of
index; recording *which* 8M of the 73.4M slots carry a correction costs more
than half what the corrections themselves do, which is why the index is where
the format's design went. It is a bitmap over entries with a rank word per 32 of
them (one popcount to locate an entry), two words per carrying entry saying
which of the 39 banks it carries and where its values start, and then that
entry's base value with its correction bytes immediately after it, so one cache
line serves both. The entries that carry nothing are stored at `e - rank(e)`,
which the same popcount already produced, and cost no index at all.

The evaluation is 1.5-1.8x slower than the dense int16 table, depending on how
wide the working set is. That is not a cache effect and cannot be tuned away: a
dense read is one load and an indexed one is at least two, and the dense table's
hot set is small enough to cache anyway -- 0.3% of its slots carry half the
reads. Putting base and corrections in the same line was worth 1.25 us per
board and got it from 1.8x to 1.5x on the narrow benchmark; there is no similar
trick left. What the format buys is the 8.8x, which is the whole point if the
network has to be downloaded or held in memory rather than merely read fast.

**Coverage is the whole result.** The same 4M-correction budget selected from a
10M-board read count plays **-440 +- 93**; selected from a 178M-board count,
**-107 +- 99**. Nothing about which slots were kept changed -- only how many
slots the counting pass had ever seen. At 10M boards, 9.4% of afterstates in
fresh play contain a slot the count table never saw, which then falls back to
`base` and takes an error of ~26 into a decision whose median margin is 11. At
178M boards, 0.24% do. This is the entire difference between "8x smaller and
unusable" and "8x smaller and unmeasurably different", so count far more play
than seems necessary; it is cheap.

### Five ways of shrinking it that did not work

Each of these was fitted by least-squares distillation against the full network
(an n-tuple net is linear in its weights, so matching one is a convex regression
over afterstates, not a search) and measured the same way.

| idea | size | regret | why not |
| ---- | ---: | -----: | ------- |
| merge the 39 banks by rank-R SVD | 4.9x at R=8 | 4.01 | 97.4% of the energy is in the first component, but what decides moves is the per-entry idiosyncratic part, which is not low-rank |
| merge the banks 39 -> 13 (drop the 5-group split), refit | 3.0x | 1.67 | fine on its own, strictly worse than pruning at equal size |
| hash (bank, entry) into 4M slots + a dense base, refit | 12x | 4.80 | trains to the same rmse as the 13-bank merge and plays far worse: collision noise is independent across the moves in a position, so all of it lands on decisions |
| tie tuples that are translates of each other | 2.0x | 14.3 | see below |
| drop the 3x2 blocks and plus shapes, refit | 2.2x | 8.19 | confirms the table above: the block families really are carrying the function |

The tying result is worth its own line, because "the same pattern in different
places of the board should mean the same thing" is the natural guess and it is
false. Horizontal translates do correlate (0.83-0.97) and vertical ones mostly
do not (0.12-0.98, and 0.03 between the floor row and the top row) -- gravity and
the floor make height a real coordinate, not a symmetry. Even where the
correlation is high the residual is not small: forcing the two 2x3 blocks at
`i=0,1` and `i=1,2` to share a table costs an rms of 59 against a decision margin
of 11. Only the tuples that carry almost nothing anyway (the plus shapes, most of
the 3x2 blocks) are cheap to tie.

Sub-byte quantisation by round-to-nearest is also a dead end -- int16 is free
(regret 0.00), int8 costs 1.18, int6 costs 8.48 -- but int8 *on the correction*,
with the base kept at int16, costs about 0.1, because the correction is 8x smaller
than what it corrects.

### Chasing a record, and whether the PRNG can be trusted

With unlimited attempts and a target to clear, the figure of merit is not mean
score but *expected compute per success*: seconds per game divided by the
probability of clearing the bar. Measured over 6550 games on fresh seeds
(300000+):

| config | n | mean | sd | max | cpu-s/game | P(>12k) | cpu-s per 12k game |
| ------ | -: | ---: | -: | --: | ---------: | ------: | -----------------: |
| depth 2 `cap=8` | 4000 | 10166 | 918 | 12104 | 0.71 | 0.10% | 710 |
| depth 2 `cap=16` | 2000 | 10368 | 893 | 12430 | 1.24 | 0.30% | **415** |
| depth 3 `cap=16 capDeep=2` | 400 | 10642 | 860 | 12696 | 11.62 | 1.00% | 1162 |
| depth 3 `cap=64 capDeep=4` | 150 | 10837 | 692 | 12319 | 64.16 | 3.33% | 1925 |

The curve is U-shaped and the optimum is in the middle. Depth 3 triples the hit
rate and costs 9 to 50 times more per game, so it loses badly; the cheapest
config wins games fast but too rarely. With 4 to 6 successes per row the Poisson
error is 40-50%, so the top two rows are within noise of each other -- but depth
2 beating depth 3 is not.

Two things are worth knowing before optimising for a record.

**Variance is an asset here, and mean score is the wrong target.** The strongest
agent by mean (`cap=64`, 10837) has the *smallest* spread (sd 692) and produced
no game over 12500 in 150 tries, while a weaker, noisier agent set the study's
high score of 12696. Training and tuning push toward consistency, which is
exactly backwards for the tail.

**The right tail is much thinner than a normal.** A normal fitted to the
`cap=8` row predicts P(>12k) = 1.15%; the measured value is 0.10%, eleven times
lower. Do not extrapolate this distribution with a Gaussian -- the left tail is
heavy (games collapse early) and the right tail is compressed, as if there were
a ceiling on how well a game can go. Nothing in 4550 games cleared 12700, and
extrapolating the observed decay (a factor of 4 to 14 per 500 points) puts a
13000 game at several cpu-hours to a cpu-day of attempts.

**The generator is not being exploited.** The engine uses the Numerical Recipes
LCG and takes the *high* bits, which is the right half to take -- an LCG's low
bits have period 2^(k+1). The residual worry is that a refill of h holes draws h
consecutive values and consecutive LCG outputs lie on lattice hyperplanes, and
the network was trained on LCG games. Running the same agent over the same 4000
seeds with `COLLAPSE_RNG=hash`, a counter-based murmur3 stream with no
recurrence at all, moves the score by **+11 +- 20**: nothing. The mechanism was
never plausible -- the network's input is 25 cell values, so it has no channel
to the generator -- but it is now measured rather than argued.

One real artefact did turn up, and it is about benchmark design rather than the
agents. Seeds s and s+1 start the LCG at states differing by A = 1664525, which
is 0.04% of the range, so **adjacent seeds share their first tile 99.9% of the
time** (and their fifth tile *never*, which is the lattice showing plainly).
Games on consecutive seeds are therefore slightly less independent than they
look, so quoted standard errors are a little optimistic. It affects every agent
equally, so paired comparisons are unharmed.

### Watching a game

`bot/record.js` saves a game as a seed plus a move list -- the refills come from
a seeded PRNG consumed in move order, so those two things reproduce every board
exactly, and a 1268-move game is 12 KB rather than megabytes of positions. The
spectator's **Replay** dropdown loads them instantly and needs no weights file,
which is the only practical way to watch the depth-3 agents: playing one out in
the page takes the better part of a minute at 37 ms a move. Saved replays carry
no per-move evaluations; pick the agent and seed directly if those are wanted.

### Which weight files are in the repository

Only `bot/weights/big-td.bin` (12 MB) and the small original `base` networks.
The larger ones are gitignored, because a 156 MB blob in git history is
permanent:

| file | size | what it is | how to get it |
| ---- | ---: | ---------- | ------------- |
| `big-td.bin` | 12 MB | `big`, 1 bank, 1.65M episodes | committed |
| `big-s3-final.bin` | 35 MB | the above grown to 3 banks, +1.2M episodes | `grow.js --stages 3`, then `ptrain.js` |
| `bigx-s7.bin` | 87 MB | the above grown to the `bigx` set and 7 banks, +1.6M episodes | `grow.js --set bigx`, `grow.js --edges 2,4,6,8,10,12`, then `ptrain.js` |
| `dom21.bin` | 156 MB | the above mirror-reduced, grown to `domsr` and 21 banks, +6M episodes | the pipeline below |
| `dom21c.bin` | 151 MB | `dom21.bin` compacted -- same function, 1.6-1.9x faster | `compact.js` |
| `dom21q.bin` | 75 MB | `dom21c.bin` quantised to int16 | `quantize.js` |
| `dom39.bin` | 290 MB | `dom21.bin` with the 6-count banks refined to 13 bins (39 banks), +12.5M episodes | `grow.js --edges 1,...,12`, then `ptrain.js` |
| `dom39c.bin` | 280 MB | `dom39.bin` compacted -- 78 tuples down to 28 lookups | `compact.js` |
| `dom39q.bin` | 140 MB | `dom39c.bin` quantised to int16 -- **the file to play with** | `quantize.js` |
| `dom39s.bins` | 15 MB | `dom39c.bin` with 8M of its 73.4M weights kept and the rest read from one bank-independent table, stored sparsely. Equal strength, 1.9x slower. Superseded: its read counts came from self-play only | `shrink.js` |
| `dom39h.bins` | **17 MB** | the same, counted over human positions as well -- **the file the spectator reviews with**. 5x more accurate than `dom39s` off-distribution, same strength, same speed | `shrink.js --starts` |
| `dom21h3.bin` | 156 MB | `dom21.bin` retrained on human start positions with exploration, +27M episodes. An *evaluator*, 733 points weaker at playing | `hstarts.js`, then `ptrain.js --starts` |
| `dom21hc.bin` | 151 MB | `dom21h3.bin` compacted | `compact.js` |
| `dom21hq.bin` | 75 MB | `dom21hc.bin` quantised -- **the file to analyse with, at depth 2**. See ANALYSIS.md | `quantize.js` |

The whole pipeline from the committed network, every step exact and checked:

```bash
node bot/reduce.js  --in bot/weights/bigx-s7.bin   --out bot/weights/bigxr-s7.bin
node bot/grow.js    --in bot/weights/bigxr-s7.bin  --out bot/weights/domsr-s7.bin  --set domsr
node bot/grow.js    --in bot/weights/domsr-s7.bin  --out bot/weights/domsr-s21.bin --five
node bot/ptrain.js  --jobs 10 --resume bot/weights/domsr-s21.bin --out bot/weights/dom21.bin     --episodes 6000000 --alpha 0.02 --alpha-end 0.002 --report 250000 --seed-base 200000000
node bot/grow.js    --in bot/weights/dom21.bin     --out bot/weights/dom39-seed.bin --edges 1,2,3,4,5,6,7,8,9,10,11,12
node bot/ptrain.js  --jobs 10 --resume bot/weights/dom39-seed.bin --out bot/weights/dom39.bin    --episodes 12000000 --alpha 0.02 --alpha-end 0.002 --report 250000 --seed-base 500000000
node bot/compact.js  --in bot/weights/dom39.bin  --out bot/weights/dom39c.bin
node bot/quantize.js --in bot/weights/dom39c.bin --out bot/weights/dom39q.bin
```

And, optionally, the compression pass. The counting run is the expensive part
and the part that decides the result, so save its output and reuse it while
sweeping `--keep`:

```bash
node bot/shrink.js --in bot/weights/dom39c.bin --out bot/weights/dom39s.bins \
                   --keep 8000000 --games 24000 --jobs 4 --save-counts /tmp/reads.bin
node bot/corpus.js --agent "fx:weights=bot/weights/dom39q.bin,depth=2,cap=8,capDeep=2,topk=2,rootk=6" \
                   --games 250 --stride 3 --out /tmp/corpus.bin
node bot/agree.js  --corpus /tmp/corpus.bin --ref bot/weights/dom39c.bin --cand bot/weights/dom39s.bins
```

The alpha schedule on that last training step is not a detail. The same growth
trained at `--alpha 0.005` moved the network by nothing in 2.65M episodes;
0.02 -> 0.002 moved it +45 in a tenth of that. Bank differentiation rate scales
with alpha, and the weight noise that comes with a high alpha is temporary --
it anneals away and costs ~100 points until it does, which is why a mid-run
benchmark of this run reads about 100 low. See LEADERBOARD.md.

Everything in the leaderboard below `big-td.bin` therefore runs from a clone;
the top rows need their network trained first. The spectator opens on an
agent whose weights are committed, and lists the stronger ones after it.

Three logs sit beside this one, and they answer different questions.
`bot/LEADERBOARD.md` has every measurement of playing strength, including the
negative ones. `bot/SCALING.md` is the investigation into whether search can be
used to *train* a better network. `bot/ANALYSIS.md` is a separate line of work:
a network that has to price moves accurately in positions it would never reach
itself, so that human games can be annotated — where the objective is the
*magnitude* of an evaluation and not the score it wins.

Of the strength measurements, the three findings that carried the most weight:

1. **The evaluation was undersized, not badly designed.** The `base` tuple set
   (86k weights) was saturated. `big` had been tried and dismissed at 200k
   episodes; given the episodes it needs it is not close.
2. **Search pays, but only if it models the real randomness.** The old
   `search` agent searched a hand-tuned evaluation down a line where every
   incoming tile was a blocker, and lost 700-1100 points. Expectimax over the
   actual tile distribution, with a learned afterstate value at the leaves, is
   worth +1900.
3. **Several rejected ideas were rejected at the wrong point in training.** A
   bigger tuple set, stage banks and TD(lambda) all lose from a cold start and
   win when introduced into a network that is already good — which is what
   `grow.js` and `--lambda-end` are for.

### Promising next steps

Roughly in order of expected value per hour of compute.

**Grow the evaluator; that is the only lever with a measured return.** The
capacity ladder above pays ~240 per doubling of weights at depth 1 and ~370 at
depth 2 with no visible saturation, and refining `--edges` buys it without
costing a single extra lookup at evaluation time. Two things to do properly:
run a matched-episode control at the old architecture, because capacity and
episodes are confounded in every comparison this folder has made so far; and
budget the episodes, because `dom21` already has only ~229 weight-updates per
weight against `big-td`'s ~418 and a bigger table dilutes that further.

**Do not spend more compute on train-time search.** Six mechanisms, all
measured, none of them clears a do-nothing control — see SCALING.md. The reason
is measured too, and it is about the function class rather than the recipe.

**Spend the speedup on search.** Compaction made the network 1.6-1.9x cheaper
without changing it, so depth 3 now costs about what depth 2 used to. Nothing
has re-tuned `depth`/`cap`/`rootk` against the new price list, and search has
been the single largest source of gains in this folder (+1900 when it was first
done properly). This is the cheapest gain available.

**Add more banks, do not remove them.** Measuring how far the 21 banks drifted
apart suggests the six-count dimension is carrying its weight at only two
boundaries -- 4-5 -> 6-7 (20.2% RMS divergence) and 10-11 -> 12+ (11.7%), with
the other four at 2.4-3.9%. That suggestion is wrong, and measuring it settled
the matter. Merging banks in the trained network and benchmarking the result:

| ablation | cost (depth 2, 200 seeds, paired) |
| -------- | --------------------------------: |
| five-groups 3 -> 1 | -175 +- 77 |
| six-bins 7 -> 3 (edges 6,12) | -663 +- 91 |
| six-bins 7 -> 1 | -1751 +- 77 |

The banking is the single most valuable structural feature in the network, the
four "weak" boundaries are worth 663 points between them, and the obvious move
is to refine `--edges` further rather than coarsen it. `grow.js` copies exactly
into any edge set that is a superset of the source's, so this is free to try.

The general lesson, which cost a wrong recommendation to learn: RMS divergence
between banks is a *bad* proxy for whether a bank matters. Move choice turns on
differences between candidate afterstates, which are tiny beside the absolute
value, so a bank that differs by 3% can still be worth hundreds of points.
Merge-and-benchmark is the only measurement that answers the question.

**Keep growing.** Growth is free and the two axes are independent, so the
obvious continuations are more stage banks (`--edges` refining `2,4,6,8,10,12`)
and more tuple shapes appended after the crosses. The rule for both: a
destination architecture whose tuple list starts with the source's, and whose
bank edges are a superset of the source's, copies exactly — `grow.js` checks
this and refuses to write otherwise. Diagonals and 3x3 blocks are the obvious
shapes not yet in the set.

**A lambda schedule from zeros.** TD(lambda=0.5) reached in 80 000 episodes what
TD(0) needs roughly 250 000 for, and then became harmful once the network was
converged. Nothing here has yet trained a network from scratch with
`--lambda 0.6 --lambda-end 0`, which is the setting that finding implies. If it
holds at scale it makes every future training run ~3x cheaper, which matters
more than any one network.

**An independently trained network to ensemble.** Averaging `big-s3` with
`big-td` lost 299, but those two share a lineage — one was grown from the other,
so they make the same mistakes. Two networks trained from zeros on different
seeds, ideally with different tuple sets, is the version of that experiment that
has not been run.

**Cheaper accuracy at the root.** The measurement in LEADERBOARD.md showing that
search overrules greedy in 45% of decisions also rules out skipping the search
on a confidence threshold. What has not been tried is spending the *chance* node
budget adaptively — a bandit-style allocation that samples more refills only
while the top two root moves are still within noise of each other. Depth 2 costs
3.3 ms/move and most of that is spent separating moves that are not close.

**A distributional value function.** Everything here optimises the mean, and the
measurements say that is also right for consistency and for best-of-100. The one
untested way to change that is a network that predicts the *distribution* of the
remaining score rather than its mean, which would let the search optimise a
quantile directly instead of faking it by penalising evaluation variance
(`risk`, which does not work).

## Running

```bash
node bot/run.js                                  # random vs maxmoves, seeds 1–25
node bot/run.js --agents maxmoves --seeds 200    # bigger sample
node bot/run.js --agents random,maxmoves -v      # per-seed table
node bot/run.js --list                           # registered agents
```

**Mean score is the metric.** The paired W/D/L line the runner prints is a
secondary read: most of the score variance in this game comes from luck late in
a run, long after two agents' boards have diverged completely, so sharing a seed
removes much less variance than the pairing suggests. Seeds are not meaningfully
easier or harder for a strong agent — a good policy absorbs a bad opening and
still finishes well — so a difference in mean over enough games is the signal,
and the win count is colour.

## Board representation

`game.cells` is a flat `Uint8Array(25)`, index `k = i * 5 + j`, where `i` is the
column (0 = left) and `j` is the row with **0 = bottom**. `0` = empty, `1..5` =
collapsible, `6` = finished. In normal play the board is always full.

`game.legalMoves()` returns canonical moves only: a move is skipped when the
tile directly below has the same value, because clicking either cell of a
vertically adjacent pair leads to the identical board.

## Lookahead and the PRNG

`game.preview(i, j, fill)` clones the game and plays the move without touching
the real tile generator. `fill` says what the bot may assume about incoming
tiles:

* `FILL_SIX` (default) — pessimistic: incoming tiles are unusable blockers.
  This is the model STRATEGY.md recommends for search.
* `FILL_NONE` — incoming tiles are ignored (cells stay empty).
* `FILL_RANDOM` — **peeks at the real future**; only for analysis, not for a
  bot whose score you intend to compare against a human's.

## Adding an agent

Most heuristic bots are a 1-ply greedy search over a position evaluation, so
`greedy()` does the plumbing (preview every legal move, take the best, break
ties randomly):

```js
register('mynewbot', function (options) {
    const rng = makeRng(options.seed);
    return greedy('mynewbot', (next, move, game) => {
        return next.countLegalMoves() * 10 - game.at(move[0], move[1]);  // e.g. prefer low tiles
    }, { rng });
});
```

Agents exposing `scoreMoves(game)` (everything built with `greedy`) get their
per-move values displayed on the board in the spectator.

For anything deeper than 1 ply, write `chooseMove` directly and recurse with
`preview`. Cloning is cheap: the whole state is 25 bytes plus a few scalars.

Agents are seeded per game (`createAgent(name, { seed })`), so benchmark runs
are fully reproducible.

A weight vector fitted by `fit.js` is 45 numbers, which makes an unreadable spec
string and an unreadable benchmark table, so `linear:json=PATH` loads one from
disk instead:

```bash
node bot/fit.js --min-score 6000 --out bot/weights/mine.json
node bot/run.js --agents "linear:json=bot/weights/mine.json" --seeds 200
```

## The value network

`ntuple.js` sums one table lookup per tuple over the afterstate. Three knobs,
all recorded in the weight file's header so an agent never has to be told how a
file was trained:

* `--set` — which tuples. `base` (36 tuples, 86k weights) through `big`
  (70 tuples, 3.1M weights).
* `--sym` — also read the left-right mirrored board, sharing one table. Mirroring
  is an exact symmetry of the rules, so this doubles the data per weight for free.
* `--stages` / `--edges` — separate weight banks by how many 6s are on the
  board. `--edges 2,4,6,8,10,12` puts 0-1 sixes in the first bank, 2-3 in the
  next, and so on; without edges the 0..16 range is split evenly, which sounds
  fair and is not (see LEADERBOARD.md).
* `--five` on `grow.js` — a second, independent banking dimension: how many
  separate groups of 5s are on the board, capped at 2+. It multiplies the bank
  count by three.

Every set `X` has a mirror-reduced twin `Xr` with half the tuples and the same
expressive power, and `selfOnce` in the file header reads the self-mirrored
tuples once rather than twice — together about 1.95x on evaluation for bit-
identical play. See LEADERBOARD.md. Train `Xr` from zeros, or convert a
trained `X` with `bot/reduce.js`. The fastest path from the current network:

```bash
node bot/reduce.js --in bot/weights/bigx-s7.bin  --out bot/weights/bigxr-s7.bin
node bot/grow.js   --in bot/weights/bigxr-s7.bin --out bot/weights/domsr-s7.bin --set domsr
node bot/ptrain.js --jobs 10 --resume bot/weights/domsr-s7.bin --episodes 3000000
```

```bash
node bot/ptrain.js --jobs 10 --set big --sym --episodes 2000000 --out bot/weights/mine.bin
node bot/run.js --agents "td:weights=bot/weights/mine.bin" --seeds 100
```

**Do not benchmark a network in the middle of a run.** TD at step `alpha` carries
a stationary weight noise proportional to `sqrt(alpha)`, and an argmax over
siblings converts it straight into lost points: the same weights score 8722 ± 26
at alpha 0.02 and **8845 ± 28** after 300k episodes at 0.002, a 123-point swing
with nothing learned. Read the trend between consecutive reports at near-constant
alpha, or anneal a branch first — and size the anneal at ~`1/alpha` updates per
weight (about 280k episodes at 0.002) or it will read as a failure. See
LEADERBOARD.md.

`ptrain.js` is the one to use. It puts the weight table in a `SharedArrayBuffer`
and lets every worker read and write it without locking: an n-tuple update
touches 70 weights out of three million, so collisions are rare enough that the
lost updates behave like a little extra gradient noise. It is ~8x faster than
`train.js` on this machine, which matters because the single most reliable way
to improve this network has been more episodes.

## Search

`td` is greedy: it plays the move maximizing `points now + V(afterstate)`.
`fx` searches instead, alternating two kinds of node:

* **max node** — a full board. Take the best legal move.
* **chance node** — an afterstate, with holes where the chain collapsed and the
  columns fell. Average over the tiles that can drop into them.

`V` is trained on afterstates, so a leaf is one `net.value(cells)` and `depth=1`
reproduces `td` exactly.

```bash
node bot/run.js --agents "fx:weights=bot/weights/big-td.bin,depth=2,cap=16" --seeds 100
node bot/run.js --agents "fx:weights=bot/weights/big-td.bin,depth=3,cap=32,capDeep=4,topk=2,rootk=6" --seeds 100
```

| option | what it does |
| --- | --- |
| `depth` | max-levels searched. 1 = greedy. |
| `cap` | chance branches at the **first** chance node. Enumerated exactly when `maxGen^holes` fits inside it, sampled otherwise. |
| `capDeep` | the same at every deeper chance node. Cheap is fine here. |
| `topk` | at an internal max node, only this many moves (by their 1-ply value) are searched deeper. |
| `rootk` | the same at the root. |

Chance nodes are much wider than they look: a chain of length *L* leaves *L-1*
holes, and only 36% of moves collapse a pair, so a third of all moves leave four
or more holes and the widest leave sixteen. Sampling those is unavoidable, and
it must be **stratified** — each hole takes each of its values equally often
across the sample — because a max node over noisy estimates is biased upwards in
proportion to the noise, and the noise is worst exactly for the widest chains.
With plain independent sampling the search systematically over-rates collapsing
a big group; with stratification `cap=16` is as good as `cap=256`.

`weights=a.bin+b.bin` averages several networks.

Two more `fx` options exist and both are **negative results**, kept because the
question comes up: `risk` (subtract a multiple of the spread over refills at
chance nodes, to prefer positions whose value does not depend on luck) and
`temp` (softmax move selection instead of argmax). See LEADERBOARD.md — a
1000-move game punishes any systematic deviation from the argmax.

`sixrule` / `sixeps` implement a hand-written override on where 6s may be
placed; also a negative result, and also documented there.

## Growing a network

```bash
node bot/grow.js --in bot/weights/big-td.bin --out bot/weights/big-s3.bin --stages 3
node bot/grow.js --in bot/weights/big-s3.bin --out bot/weights/bigx-s3.bin --set bigx
```

`grow.js` copies a trained network into a bigger architecture — more stage banks
or more tuples — **without changing the function it computes**. More banks start
as copies of the bank they split from; more tuples are appended at the end of
the list, so the old weights are the new table's leading prefix and the new
tuples start at zero. It verifies the two networks agree on real boards across
the whole range of 6-counts before writing anything.

This matters because both of those architectures had been measured and rejected
from a cold start, where they have to pay for their extra parameters out of the
same training budget. Grown into, they cost nothing, and every episode
afterwards goes into the new capacity.

The exactness check at the end is not decoration — it caught a real bug in the
bank mapping the first time the 5-group dimension was added. Growth is only free
when the destination's tuple list starts with the source's *and* its bank edges
refine the source's; `grow.js` refuses to write when the copy does not reproduce
the original.

## Off-policy coverage, and why search is worth what it is worth

A depth-*d* search scores a root move as

```
gain + chanceValue(after, d-1)  =  (gain + V(after))  +  (TV - V)(after)
```

— the greedy score plus V's own **Bellman residual**. If the residual were zero
everywhere, every search depth would reproduce greedy exactly. So the +1400 that
depth 2 is worth is not lookahead finding something new; it is one Bellman backup
repairing V where training never applied one.

`bot/residual.js` reads that number off a network in seconds:

```bash
node bot/residual.js --weights bot/weights/dom21c.bin --sub grid44 --games 30
```

On a network trained by on-policy self-play it comes out ~0 on the move greedy
plays and +7, +14, +24, +35, +54, +72, +162 down the ranks. TD only ever updates
the afterstate it walks into, so V lands on its fixed point along the trajectory
and nowhere else — and one random move off the trajectory is enough to put the
*rank-1* residual at +13. The **spread** down the rank column is the number that
matters: a constant offset shifts every candidate equally and changes no move,
which is why a search-derived TD target measured as nothing.

Three knobs buy the missing coverage, all greedy-behaviour options:

| option | what it does | cost |
| --- | --- | ---: |
| `--explore EPS --explore-rank R` | deviate to a rank drawn from 2..R with probability EPS, so off-policy states land on a trajectory that runs to a real terminal | free |
| `--siblings K` | also update the top K *rejected* afterstates, each toward its own one-step backup from one sampled refill | 2.7x |
| `--sib-center` / `--sib-alpha F` / `--sib-every N` | subtract rank 1's residual from those targets (so the update goes into the shape, not the level), damp them, or apply them on 1 position in N | — |
| `--distil K` (+ `--frozen FILE`) | regress the top K+1 candidates onto a **frozen** copy's backup | ~5x |
| `--rank W` / `--rank-k K` | when the backup prefers a different move than V does, push those two afterstates apart by `W` and touch nothing else | ~5x |

`--distil` is the one with an exact statement of what it is aiming at. Greedy is
`argmax(gain + V)` and depth 2 is `argmax(gain + TV)`, so a network that has
learned `TV` plays depth-2's moves at depth-1's price — and `TV` is computable
from one sampled refill, which makes this a supervised regression rather than a
bootstrap. It defaults to freezing the weights being resumed; feed the result
back with `--frozen` to iterate toward `T²V`, i.e. depth 3.

`--rank` asks for less, and SCALING.md has the measurement saying why that
matters: the regression moves 0.31 of the way up the right axis and carries 20
rms of movement off it, and at a max node the off-axis part costs more than the
on-axis part gains. Reordering two afterstates is equal and opposite, so nothing
drifts, and it stops as soon as they agree.

```bash
node bot/ptrain.js --jobs 10 --resume bot/weights/dom21.bin --distil 3 \
     --out bot/weights/rr1.bin --episodes 1200000 --alpha 0.01 --alpha-end 0.003
```

`--explore` is safe because the TD target is `next.qmax`, the max over moves
rather than the value of what was played — the backup is Q-learning-shaped, so
the behaviour policy can wander without changing what is learned. Use
`--explore-rank 2`, not uniform randomness: a random move wastes structure that
cannot be rebuilt and `eps=0.02` costs 2450 points of episode quality, where
stepping down one rank costs 120.

The two are different in kind. Exploration is **grounded** — the episode
continues from the explored state to a terminal, so real rewards anchor it.
Sibling updates are **bootstrapped**, propagating V through a region nothing
anchors, which is the deadly triad with a shared linear approximator; that is
what `--sib-alpha` is for. See SCALING.md.

## Training from search-visited positions

```bash
node bot/starts.js --agent "fx:weights=bot/weights/bigx-s7.bin,depth=2,cap=8,rootk=4"     --games 300 --jobs 10 --out bot/data/starts.bin
node bot/ptrain.js --jobs 10 --resume W.bin --starts bot/data/starts.bin --start-frac 0.4 ...
```

The network is trained on the states 1-ply greedy self-play reaches and deployed
on the states depth-3 search reaches, which are ~200 moves longer and a six
deeper. Training *with* search fixes that and costs ~25x the episodes (measured:
6 ep/s against 170), which is the wrong trade when episodes are the scarce
resource. This buys the same coverage once: play a few hundred games with the
search agent, keep the positions, and start a fraction of episodes from them.

Seeded episodes score from their starting position rather than from zero, so
they are counted separately and kept out of the reported self-play mean.

Files written before the header existed are read as `base`, one stage, and need
`sym=true` in the spec if they were trained symmetric.

## Learning from human replays

`data/replays.jsonl` is every finished game people have played: 9109 clean
replays, 3.78M moves, freshly re-fetchable with `fetch-replays.js`. Load it
through `replays.js` rather than parsing it again:

```js
const Replays = require('./replays.js');
const rows = Replays.load({ minScore: 6000 });          // quality filter
Replays.walkAll(rows, d => {                            // every real decision
    d.game;         // position before the move
    d.move;         // the canonical move the human played
    d.legalMoves;   // what they chose from
    d.finalScore;   // what the game ended on
});
```

`minScore: 6000` is the tuned default — see LEADERBOARD.md for the measurement
behind it. `walk` canonicalizes the human's click (they may click any cell of a
vertical run; `legalMoves()` only returns the lowest) and stops at the first
move that does not replay, so a corrupt tail cannot silently poison a fit.
