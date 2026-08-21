# Leaderboard

All numbers are **100 games on seeds 1-100** (`node bot/run.js --agents <spec> --seeds 100 --jobs 4`).
Seeds 1-100 are held out from everything: tuning uses 10001+, network training
100001+ / 300000+ / 500000+ / 800000+ for the `base` nets and 2000000+ for the
`big` one, and development benchmarking 20001+, 30001+ and 60001+. The human-fitted weights never see a seed at all — they are fitted to
replays. Mean score is the metric; the paired W/D/L the runner prints is
secondary, because most of the variance comes from luck late in a run when the
two agents' boards have long since diverged.
`ms/move` is measured in the same run, so a heuristic that buys little for a lot
of compute shows up immediately.

| # | agent spec | n | mean | ±se | median | min | max | moves | 6s | ms/move |
| - | ---------- | -: | ---: | --: | -----: | --: | --: | ----: | -: | ------: |
| 17 | `fx:weights=bot/weights/bigx-s7.bin,depth=3,cap=32,capDeep=4,topk=2,rootk=6` | 100 | **10526** | 74 | 10627 | 8477 | 12152 | 1063 | 14.9 | 46.3 |
| 16 | `fx:weights=bot/weights/bigx-s7.bin,depth=2,cap=16,rootk=6` | 100 | 10116 | 85 | 10269 | 6330 | 12112 | 1025 | 15.1 | 3.3 |
| 15 | `td:weights=bot/weights/bigx-s7.bin` (greedy) | 100 | 8595 | 115 | 8821 | 1388 | 10495 | 852 | 13.8 | 0.10 |
| 14 | `fx:weights=bot/weights/big-s3-final.bin,depth=3,cap=32,capDeep=4,topk=2,rootk=6` | 100 | 10435 | 82 | 10529 | 5703 | 11826 | 1052 | 14.9 | 38.3 |
| 13 | `fx:weights=bot/weights/big-s3-final.bin,depth=2,cap=32,rootk=8` | 200 | 9966 | 55 | 10045 | 4666 | 11281 | 1010 | 14.8 | 5.6 |
| 12 | `fx:weights=bot/weights/big-s3-final.bin,depth=2,cap=16,rootk=6` | 200 | 9873 | 59 | 9975 | 5239 | 11137 | 999 | 14.7 | 2.8 |
| 11 | `fx:weights=bot/weights/big-td.bin,depth=3,cap=32,capDeep=4,topk=2,rootk=6` | 100 | 9781 | 60 | 9901 | 7703 | 11158 | 989 | 14.6 | 37.4 |
| 10 | `fx:weights=bot/weights/big-td.bin,depth=2,cap=16,rootk=6` | 100 | 9315 | 65 | 9377 | 7309 | 10943 | 941 | 14.3 | 2.5 |
| 9 | `fx:weights=bot/weights/big-s3-final.bin,depth=2,cap=4,rootk=3` | 200 | 9282 | 76 | 9405 | 1394 | 11090 | 928 | 14.3 | 0.51 |
| 9 | `fx:weights=bot/weights/big-td.bin,depth=2,cap=4,rootk=3` | 100 | 8746 | 86 | 8777 | 4681 | 10555 | 874 | 13.7 | 0.40 |
| 8 | `td:weights=bot/weights/big-s3-final.bin` (greedy, no search) | 200 | 8198 | 76 | 8405 | 3609 | 10178 | 812 | 13.3 | 0.057 |
| 8 | `td:weights=bot/weights/big-td.bin` | 100 | 7799 | 92 | 7982 | 3922 | 9289 | 773 | 12.9 | 0.057 |
| 7 | `blend:preset=h1,weights=bot/weights/tdsym3.bin,beta=1` | 100 | 6450 | 158 | 6593 | 272 | 9760 | 628 | 10.4 | 0.041 |
| 6 | `td:weights=bot/weights/tdsym3.bin` | 100 | 5902 | 107 | 6070 | 1093 | 7825 | 578 | 11.7 | 0.017 |
| 5 | `linear:preset=h1` | 100 | 5351 | 131 | 5556 | 1708 | 8166 | 543 | 9.5 | 0.049 |
| 4 | `linear:preset=v4` | 100 | 5160 | 137 | 5271 | 1381 | 7639 | 531 | 9.7 | 0.18 |
| 3 | `linear:preset=v3` | 100 | 4265 | 124 | 4298 | 1703 | 7625 | 442 | 8.7 | 0.10 |
| 2 | `linear:preset=v2` | 100 | 3759 | 111 | 3824 | 536 | 6300 | 393 | 8.1 | 0.06 |
| 1 | `linear:preset=v1` | 100 | 2619 | 75 | 2548 | 1167 | 4756 | 283 | 7.6 | 0.07 |
| 0 | `maxmoves` | 100 | 855 | 19 | 855 | 390 | 1309 | 104 | 8.2 | 0.07 |
| — | `random` | 100 | 469 | 12 | 459 | 101 | 1000 | 54 | 3.6 | 0.01 |

`n` is how many seeds the row was measured over — always starting at seed 1, so
every row covers seeds 1-100 and some cover 1-200.

Confirmed on a fresh set the agents had never been measured on (500 games,
seeds 40001+): `blend` **6555 ± 72** against `v4`'s **5147 ± 66**, +1408 ± 95.

The top entries are confirmed the same way. Entry 14 — the same agent on the
previous network — scores **10238 ± 85** on seeds 60001-60100, which nothing has
ever been tuned or trained on, against **10435 ± 82** on seeds 1-100: a
difference of 197 ± 118, i.e. nothing. Both halves of the agent
are independent of the benchmark seeds by construction: the network is trained
on seeds 2000000+, and the search has no learned parameters at all.

Human reference, measured rather than remembered (`bot/human.js` plays the agent
on the exact seeds people played): over an even sample of 300 real games, humans
average **4130 ± 133** and `h1` scores **5332 ± 85** on the same seeds — 1.29x
the average human game. The ~10 000 figure is a good game by a good player, and
the best players' *averages* (7422 over 720 games for the top account) are still
well clear of every bot here.

## What the score distribution looks like

10 000 games with the best agent (seeds 1000001-1010000):

| | |
| --- | ---: |
| mean | 6463 ± 16 |
| sd | 1567 |
| min / p10 / median / p90 / max | 194 / 4496 / 6729 / 8144 / **10255** |
| games ≥ 8000 | 12.65% |
| games ≥ 9000 | 1.39% |
| games ≥ 10000 | **0.02%** (2 of 10 000) |

So a five-figure game is currently a 1-in-5000 event for the bot, while it is
roughly what a strong human manages on a good day. The median is healthy —
6729 — but the right tail is thin: the agent is reliable and rarely spectacular,
and the distribution is left-skewed (mean 6463 well below median 6729) because
of a small number of games that die early. The worst seeds still score under
250, so the checkerboard-deadlock death mode has not been engineered away, only
made rarer.

That shape is the argument for where to look next: raising the mean has come
from making the bad games less bad, but reaching human-best territory needs the
top end to move, and nothing measured so far moves it.

Best seeds found, for spectating: **1009240** (10255), **1004921** (10144),
**1005862** (9931).

## The two things that got past 6500

Everything above entry 7 came from a better *evaluation of one position*. The
jump from 6450 to 9781 came from two changes that are both about scale rather
than about the game:

**A network with room in it.** `base` is 36 tuples and 86 436 weights, and by
`tdsym3` it was saturated — 460 000 episodes is roughly 3 000 updates per
weight, and more episodes stopped paying. `big` is the same architecture with
70 tuples and 3 078 082 weights. It had been tried before and dismissed at
200 000 episodes (5503, behind `base`'s 5685), which was the right measurement
and the wrong conclusion: it was still paying off its parameters. Given the
episodes it actually needs, it is not close:

| `big` + sym, episodes | greedy `td`, seeds 1-100 |
| --------------------: | -----------------------: |
| 200 000 | 6476 ± 115 |
| 800 000 | 7442 ± 125 |
| 1 650 000 | **7799 ± 92** |

Plain greedy on that network beats the old best agent by 1349 at a *quarter* of
its cost per move. The self-play mean during training was still creeping up when
the run was stopped (7688 at 1.0M, 7739 at 1.45M), so this is a floor, not a
ceiling — but the last 400 000 episodes were worth about 40 points, so it is a
fairly flat floor.

Getting there needed `ptrain.js`. The single-process trainer does ~130
episodes/s at this strength; Hogwild over 8-10 workers on a shared weight table
does ~220 with a much bigger network, which is what makes 1.6M episodes a
morning rather than a week.

**Search that models the actual randomness.** See below.

**Stage banks, warm-started.** `--stages 3` splits the weights into independent
banks by how many 6s are on the board. It was tried before and lost 224 ± 93,
and the diagnosis in this file was that "its cost is purely statistical" — three
banks each see a third of the data, so a cold-started staged net is three times
undertrained. That diagnosis suggests its own fix: **copy the trained
single-bank weights into all three banks** and carry on training. At
initialization the staged net is bit-for-bit the same function (verified: max
|V3 - V1| = 0 over sampled boards), so there is no cold start to pay for, and
every episode after that specialises the banks. 300 000 episodes of that:

| net | greedy | depth 2 (`cap=16,rootk=6`) |
| --- | -----: | -------------------------: |
| `big-td` (1 bank) | 7799 ± 92 | 9315 ± 65 |
| `big-s3` (3 banks, warm-started) | 8018 ± 120 | **9713 ± 70** |

Note the gain is bigger *with* search (+398) than without (+219). The opening
and the endgame really are different games — a single bank has to average a
board with two 6s on it against a board with fifteen — and the search compounds
a better evaluation rather than merely following it.

## Expectimax (`fx`)

`search:depth=2/3` is recorded under "tried and rejected" at −716 to −1163, and
that verdict stands *for what it does*: it searches the linear evaluation with
`fill=six`, i.e. down a line of play in which every incoming tile is a blocker.
That line will never happen, and summing hand-tuned move terms along it
optimizes a fiction.

`fx` searches the same tree the game actually generates:

* **max node** — a full board; take the best legal move.
* **chance node** — an afterstate, holes and all; average over the tiles that
  can drop into the holes, from the real uniform 1..maxGen distribution.

Since the network is trained on afterstates, a leaf is a single `net.value`
call and `depth=1` reproduces `td` exactly (verified: 0W 100D 0L). What depth
buys, on the final network over seeds 1-100:

| depth | mean | vs greedy | ms/move |
| ----- | ---: | --------: | ------: |
| 1 (`td`) | 7799 | — | 0.06 |
| 2 (`cap=16,rootk=6`) | 9315 | +1516 | 2.5 |
| 3 (`cap=32,capDeep=4,topk=2,rootk=6`) | **9781** | +1982 | 37 |

Depth 2 is where nearly all of it is, and it costs 2.5 ms/move. Depth 3 adds
466 for 15x the compute. Depth 4 was not tried; on this curve it would cost
another order of magnitude for a few hundred points.

### Chance nodes are much wider than they look

A chain of length *L* leaves *L-1* holes, and chains are not mostly pairs. Over
36 000 move expansions:

| holes | 1 | 2 | 3 | 4 | 5 | 6 | 7+ |
| ----- | -: | -: | -: | -: | -: | -: | -: |
| share | 36% | 20% | 12% | 7.5% | 5.4% | 4.5% | 14% |

With `maxGen=4` that is 4 outcomes for a third of moves and 4^16 for the widest.
Exhaustive enumeration is only possible for the narrow ones, so the rest have to
be sampled — and **how** they are sampled matters more than how many samples are
taken. A max node over noisy estimates is biased upwards in proportion to the
noise, and the noise is largest exactly for the widest chains, so independent
sampling makes the search systematically over-rate collapsing a big group —
which is the opposite of what STRATEGY.md says to do.

Latin-hypercube sampling fixes it: each hole takes each of its values exactly
`budget/maxGen` times across the sample, so every hole's marginal is exact.
After that the sample size stops mattering:

| `cap` at depth 2 | mean (60 seeds) | ms/move |
| ---------------: | --------------: | ------: |
| 16 | 7994 ± 112 | 4.1 |
| 64 | 7987 ± 116 | 12.5 |
| 256 | 8074 ± 84 | 36.5 |

`cap=16` is as good as `cap=256` at a ninth of the cost. Before stratification
the same knob was worth several hundred points.

### Where the budget goes

Measured on the depth-3 agent, one knob at a time:

| change | vs baseline |
| ------ | ----------: |
| `cap` 16 -> 32 at the first chance node | +270 ± 187 |
| `cap` 32 -> 64 | +96 ± 119 (2x cost) |
| `capDeep` 4 -> 8 at deeper chance nodes | −93 ± 170 |
| `topk` 2 -> 3 at internal max nodes | +26 ± 143 |
| `rootk` 6 -> 12 (search every root move) | +31 ± 196 (1.7x cost) |

The pattern is consistent and useful: **accuracy near the root is worth paying
for; width and accuracy deeper down are not.** Two candidate moves at an
internal node and four refill samples below them are enough, because those
values are only being used to rank moves one level up. Setting `rootk=6` at
depth 2 is actually free — +29 ± 86 and 1.7x faster than searching all of them.

### The death mode is gone

The old best agent's worst game over seeds 1-100 was 272, and the 10 000-game
distribution had a p10 of 4496: the checkerboard deadlock was rare but alive.
The depth-3 agent's worst game over the same 100 seeds is **7703**, and over a
fresh 100 (seeds 60001+) it is 7562. Nothing dies early any more. That is most
of where the mean came from — the median only moved from 6593 to 9901 while the
minimum moved by 7400.

## TD(lambda): the same score for a third of the episodes

`train.js` and the default in `ptrain.js` are TD(0): the value of an afterstate
is moved towards the very next afterstate's value. In a 1000-move game that
propagates what happened at the end backwards one step per pass, which is a slow
way to learn that a decision two hundred moves ago is what ran the board out of
material.

`--lambda` uses the lambda-return instead. An eligibility trace the size of a
three-million-weight table is out of the question, so the episode is stored and
walked backwards at the end, accumulating `carry = error + lambda * carry`.

Measured cleanly on a small network (`base` + sym, from zeros, identical seeds,
80 000 episodes each), benchmarked over 200 games:

| lambda | seeds 1-200 mean | vs TD(0) |
| -----: | ---------------: | -------: |
| 0 | 4588 ± 77 | — |
| **0.5** | **5398 ± 73** | **+811 ± 102** |
| 0.85 | 4166 ± 59 | −421 ± 96 |

For scale: `tdsym3` is the same architecture at roughly 460 000 episodes of
TD(0) and scores 5902. Lambda = 0.5 gets to 5398 in 80 000. Call it a **3x
saving in episodes** for a 10% cost in episodes per second.

Lambda = 0.85 is unstable rather than merely worse — its self-play mean
oscillates between 1822 and 3774 from one report to the next. The lambda-return
trades bias for variance, and past about 0.5 the variance wins.

One caveat on the comparison: with lambda > 0 the updates are applied in one
backward pass at the end of the episode, while TD(0) applies them online, so
part of the difference could be batching rather than the lambda-return itself.

**And it reverses.** Switching the main `bigx` run to lambda = 0.5 after 1.2M
episodes, with the value function already close to right, cost **345 ± 104**
over 200 000 episodes and the self-play mean stopped climbing. The lambda-return
buys speed by accepting variance, and that is a good trade only while the bias
in the TD(0) target is the thing holding you back. Once the table is fitted,
the variance is all that is left.

So lambda wants a schedule, and `ptrain.js --lambda 0.6 --lambda-end 0` anneals
it linearly over the run. Read together with the two other reversals in this
file — a bigger tuple set and stage banks both losing from a cold start and
winning when grown into — the pattern is that **most of these knobs are not good
or bad, they are good at one point in training and bad at another.**

## What an evaluation costs, and what is actually in it

Everything below was measured on the 87 MB network over real afterstates.

| network | weights | size | lookups/eval | ns/eval | ns/lookup |
| ------- | ------: | ---: | -----------: | ------: | --------: |
| `base`, 1 bank | 86 k | 0.3 MB | 288 | 692 | 2.4 |
| `big`, 1 bank | 3.1 M | 12 MB | 676 | 2439 | 3.6 |
| `bigx`, 1 bank | 3.3 M | 12 MB | 886 | 2946 | 3.3 |
| `bigx`, 3 banks | 9.8 M | 37 MB | 886 | 3115 | 3.5 |
| `bigx`, 7 banks | 22.8 M | 87 MB | 886 | 3628 | 4.1 |
| `bigx`, 14 banks | 45.6 M | 174 MB | 886 | 4542 | 5.1 |

**Cost tracks lookups, not weights.** A 6-cell tuple and a 4-cell tuple are the
same runtime cost and the 6-cell one holds 49x more weights; banks add no
lookups at all and cost only cache pressure, 7x the memory for 16% more time.
So halving the weight count is only worth doing if you halve the *tuples*.

A training step, per move: **36.6 us**, of which under 9 us is everything except
table lookups — move generation, collapse, gravity, bookkeeping. That is the
answer to "would another language be faster": a rewrite could address a fifth of
the time, and the other four fifths is waiting on random reads into an 87 MB
array, which C does at the same speed. What *was* available was 1.5x from the
trainer still going through `Game.preview` — `apply` recomputes `gameOver` with
a full legal-move scan, 25 flood fills per candidate that a training step throws
away. Routing it through `search.js`'s expander took 53-70 us/move down to 36.6
with bit-identical play (verified at alpha 0, where both play the same games).

### What each tuple group contributes

Over 7029 real decisions, the spread of each group's contribution across the
sibling moves in one decision — i.e. how much it can move the ranking:

| group | tuples | weights | share of table | spread | removing it flips the choice |
| ----- | -----: | ------: | -------------: | -----: | ---------------------------: |
| 2x2 squares | 16 | 38 k | 1% | 165 | 80% |
| runs of 4 | 20 | 48 k | 1% | 184 | 79% |
| runs of 5 | 10 | 168 k | 5% | 66 | 58% |
| 2x3 blocks | 12 | 1.41 M | 43% | 49 | 51% |
| 3x2 blocks | 12 | 1.41 M | 43% | 58 | 52% |
| crosses | 25 | 181 k | 6% | 25 | 28% |

(spread of the full value across siblings: 276)

The 6-cell blocks are 86% of the table and the smallest influence per weight.
The tempting conclusion is wrong, though: the crosses have the *lowest* spread
of anything here and measurably added +311 when they were introduced. Spread
measures how loudly a group speaks, not whether it is needed. The 6-cell blocks
are most likely undertrained, which is the same story as `big` looking worse than
`base` at 200 000 episodes.

### The banks are nearly duplicates

Pairwise correlation between the seven banks: **0.986 to 1.000**. As RMS
difference over a bank's own RMS spread, banks split from the same parent differ
by **0.01-0.02** and banks from different parents by **0.17-0.20**. After 400 000
episodes the 7-bank network is still a 3-bank network stored seven times. That is
not an argument against the split — it is what "recently grown" looks like — but
it does mean the memory is currently mostly redundancy.

## Redundant tuples are not redundant

A 4-run sits inside a 5-run, a 2x2 inside a 2x3, a corner L inside a 2x2. In
representational terms the smaller one adds nothing: anything it can express,
the larger table can express too. So the obvious cleanup is to delete it.

The obvious cleanup is wrong, for a reason worth keeping. A 4-cell table has
2401 entries against a 5-cell table's 16 807, so every entry is visited seven
times as often and generalises over the cell it does not look at. The small
tuple is not redundant information, it is the same information at a coarser
resolution, learned seven times faster. Which effect wins is a question about
how much data there is.

Five tuple sets, all trained from zeros on identical seeds, 150 000 episodes,
alpha 0.1 -> 0.03, lambda 0.5 -> 0, benchmarked greedy over 300 games:

| set | tuples | weights | reads/eval | mean | vs `bigx` | ms/move |
| --- | -----: | ------: | ---------: | ---: | --------: | ------: |
| **`doms`** = `bigx` + all 40 dominoes | 135 | 3.26 M | 1046 | **6426** | **+984 +- 73** | 0.083 |
| `bigx` | 95 | 3.26 M | 886 | 5442 | — | 0.071 |
| `coarse` = squares + 4-runs + crosses | 61 | 268 k | 498 | 5147 | -295 +- 78 | 0.043 |
| `lean` = squares + 5-runs + crosses | 51 | 388 k | 438 | 4961 | -481 +- 82 | 0.041 |
| `bigx5` = `bigx` without the 2x3 blocks | 71 | 436 k | 598 | 4904 | -537 +- 81 | 0.050 |

Three things fall out of that table.

**Deleting the contained tuples costs score.** `lean` keeps the 5-runs and drops
the 4-runs that sit inside them, and loses 481.

**When forced to choose, keep the smaller one.** `coarse` and `lean` differ only
in which run length they keep, and the one that keeps the *coarse* 4-runs beats
the one that keeps the *fine* 5-runs by about 190, while also being cheaper. The
subset-removal instinct points exactly the wrong way.

**Adding tuples coarser than anything already there is worth a lot.** Every
domino already sits inside a 2x2 or a run, so the 40 of them add no
representational power whatsoever -- 1960 weights, 0.06% of the table, 18% more
reads. They are worth **+984**, by far the largest single architecture result
here. At 49 entries each they are effectively fully trained after a few thousand
episodes, and they carry the model while the six-cell tables are still empty.

The caveat is that this is measured at 150 000 episodes, where a 3M-weight table
is very far from filled. The advantage should shrink as the fine tuples catch
up -- but every network in this file has been episode-limited, so the regime the
measurement is taken in is the regime that matters. `bigx` is a prefix of
`doms`, so `grow.js` transplants a trained network into it for free.

## Half the tuples are mirror duplicates

With `sym` on, each tuple is read twice -- once on the board, once on the mirror
-- both into the same table. But these tuple sets are *closed under mirroring*:
for all but the 17 self-mirrored shapes, the mirror of tuple k is another tuple
already in the list. Tuple k's mirror-read is exactly its partner's board-read,
so the two receive identical updates at identical indices, converge to the same
table, and the sum counts every distinct contribution twice.

Measured on the trained 95-tuple network, the two tables of a mirror pair differ
by an RMS of **0.10** against an RMS magnitude of **32** -- 0.3%, and that
residual is Hogwild write races, not anything learned.

Folding each pair into one representative is exact rather than approximate:

```
pair = w_k[a] + w_k[m] + w_p[a_p] + w_p[m_p]
     = w_k[a] + w_k[m] + w_p[s(m)] + w_p[s(a)]
     = W[a] + W[m]                    with  W[x] = w_k[x] + w_p[s(x)]
```

where `s` permutes the digits of an index, because the two tuples list the same
cells in a different order. `bot/reduce.js` does it and checks the result:

| | tuples | reads/eval | weights | greedy ms/move | depth-2 ms/move |
| --- | -----: | ---------: | ------: | -------------: | --------------: |
| `bigx-s7` | 95 | 886 | 22.8 M | 0.223 | 3.00 |
| `bigxr-s7` | 56 | 528 | 13.6 M | **0.091** | **1.80** |

**Identical play: 0W 100D 0L at depth 2, mean difference +0 +- 0**, and the two
networks agree to 1.5e-4 on 50 045 real afterstates (float32 rounding). 40% of
the reads and 40% of the memory were doing nothing at all.

## Choosing what to bank on

Two candidate replacements for the 6-count, measured over 13 844 real positions.

**Playable area — redundant.** The idea: a 1-5 tile sealed on all sides by walls
and 6s is effectively a 6 too, so what matters is not how many 6s there are but
how much *connected playable area* is left, counted as adjacent pairs of non-6
tiles. It is a better description of the position, and it carries no extra
information at all:

| 6s | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
| -- | -: | -: | -: | -: | -: | -: | -: | -: | -: |
| mean playable pairs | 40.0 | 38.0 | 36.0 | 33.8 | 32.0 | 31.0 | 29.0 | 27.0 | 25.0 |
| sd within that 6-count | 0.00 | 0.00 | 0.00 | 0.41 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |

Correlation with the 6-count: **-0.9989**, and the conditional spread is exactly
zero at nearly every 6-count. The reason is the agent itself: it already tucks
every 6 against a wall or another 6, so each new 6 removes the same number of
pairs every time. The metric would separate a well-played board from a badly
played one, and the agent does not produce badly played boards.

**Groups of 5s — orthogonal.** Correlation with the 6-count **-0.06**, and a
useful split: 12% of positions have no 5, 50% have one group, 38% have two or
more, and those proportions hold across the whole game. That is what a second
banking dimension has to look like.

`--five` on `grow.js` adds it, multiplying the bank count by three. The cost is
not zero: the group count has to be computed on every evaluation, and doing it
by flood fill cost 34%. Counting it by Euler characteristic instead (cells minus
adjacencies plus filled 2x2 squares, one straight pass) brings that to **16%**.
That count is not exact — a ring of 5s around a hole comes out one low, on 12
boards in 200 000 — and it does not need to be. A bank is a partition, not an
answer; all that matters is that the same board always lands in the same bank.

**A dedicated opening bank is cheap but nearly pointless.** Before any 4 exists
the rules genuinely differ (the generator draws 1-3, not 1-4), and the condition
is exactly detectable from the board — no tile above 3 means no 4 was ever made,
because a 4 can only leave the board by becoming a 5 and a 5 by becoming a 6
(verified: 0 mismatches in 13 844 positions, and `Collapse.fromCells` relies on
it). But that phase is **0.49% of positions**, about the first five moves. Its
own table would train fine, since with no tile above 3 only a small corner of
each tuple's state space is reachable — it just has very little to decide.

The arithmetic that constrains all of this: banks **multiply** the weight table
and **divide** the training data. Seven 6-count bins times three 5-group buckets
is 21 banks, 261 MB, and a smallest bank holding 0.8% of positions. Three bins
times three buckets is 9 banks, 112 MB, smallest bank 3.4% — the same order of
dilution as today's 7 banks (smallest 5.3%) but partitioned along an axis the
6-count knows nothing about. That is the version worth testing.

## The stage banks were splitting the wrong thing

`stageOf` originally split the 0..16 range of 6-counts into equal-width bands.
That sounds fair and is not, because positions are not spread evenly over
6-count. Counting the boards the depth-2 agent actually visits over 10 games:

| 6s on board | 0-5 | 6-11 | 12+ |
| ----------- | --: | ---: | --: |
| share of positions | **66.9%** | 27.3% | **5.8%** |

Two thirds of the training data lands in one bank, and the endgame bank — the
one that decides how a game finishes — gets a twentieth of it. So `ntuple.js`
now takes explicit `edges`: `[2,4,6,8,10,12]` means bank 0 is 0-1 sixes, bank 1
is 2-3, and so on.

Choosing edges that **refine** the existing ones (any superset of the old
boundaries) keeps `grow.js`'s copy exact, so a 3-bank network becomes a 7-bank
one for free. And once the growth is free, extra banks are close to a free
option in general: a bank that inherits correct weights and then sees very
little data simply stays where it started, which is exactly the behaviour the
original 3-bank network had anyway.

## Mean, consistency and best-of-100 are the same problem

Three plausible objectives, and the natural instinct is that they trade off:
play safe for consistency, play loose when only your best game counts. Measured
on the depth-2 agent over 200-400 seeds, they do not trade off at all.

**Consistency.** `risk` subtracts a multiple of the spread over refills at each
chance node, so a move whose value swings on which tile falls is penalised:

| `risk` | mean | sd | ≥9000 |
| -----: | ---: | -: | ----: |
| 0 | **9873** | **838** | **91%** |
| 0.25 | 9779 | 935 | 86% |
| 0.6 | 9436 | 843 | 76% |
| −0.4 (seeking) | 9389 | 885 | 74% |

Risk aversion makes the agent both worse *and less consistent*. The same shows
up along the whole speed curve below: sd falls monotonically as the mean rises.
At this level the bad games are not unlucky, they are misplayed, so there is no
safety to buy.

**Best of 100.** `temp` replaces the argmax with a softmax over move values,
which is the standard way to trade mean for spread. Bootstrapped E[max of 100]
over 400 games:

| config | mean | sd | E[max of 100] |
| ------ | ---: | -: | ------------: |
| depth 2, `cap=16,rootk=6` | 9857 | 809 | **11153** |
| depth 2, `cap=8,rootk=4` | 9578 | 969 | 11106 |
| depth 2 + `temp=3` | 9550 | 799 | 11008 |

A 20% wider distribution still loses on the maximum, because the extra spread
costs more mean than it adds tail. Full-strength softmax is a catastrophe:
`temp=15` costs **2165 ± 95** and lowers the best game from 11137 to 9264.

The unifying reason is game length. A game is ~1000 moves, so any policy that
deviates from the argmax with probability *p* per move deviates ~1000*p* times
per game, and the deviations do not cancel — they compound into a worse board.
The measured cost of *one* deliberate deviation is around 100-150 points (see
the 6-placement rule below), which at 1000 moves leaves no room at all for
deliberate noise. **Optimise the mean; the tails follow.**

## What a point of score costs

The whole speed/strength curve, one network (`big-s3`, 9.2M weights), 200 seeds:

| config | ms/move | mean | ≥9000 | sd |
| ------ | ------: | ---: | ----: | -: |
| greedy (`depth=1`) | 0.057 | 8198 | 22% | 1082 |
| `depth=2,cap=4,rootk=3` | 0.51 | 9282 | 66% | 1076 |
| `depth=2,cap=8,rootk=4` | 1.05 | 9553 | 84% | 1106 |
| `depth=2,cap=12,rootk=5` | 1.76 | 9702 | 84% | 851 |
| `depth=2,cap=16,rootk=6` | 2.84 | 9873 | 91% | 838 |
| `depth=2,cap=32,rootk=8` | 5.56 | 9966 | 93% | 777 |
| `depth=3,cap=32,capDeep=4,topk=2,rootk=6` | 38.3 | 10435 (100 seeds) | 97% | 825 |

Roughly 200 points per doubling of search compute, tailing off. The cheap end is
the interesting part: `cap=4,rootk=3` keeps 94% of the best depth-2 score for
18% of its cost.

The obvious further saving — skip the search when the 1-ply ranking already has
a clear winner — does not exist, and measuring why is the most direct evidence
of what search is doing. Over six games, bucketed by the 1-ply value gap between
the best and second-best move:

| 1-ply gap | share of decisions | depth 2 picks a different move |
| --------- | -----------------: | -----------------------------: |
| 0-5 | 25.2% | 63.6% |
| 5-10 | 18.1% | 53.2% |
| 10-25 | 29.8% | 42.2% |
| 25-50 | 16.5% | 30.8% |
| 50-100 | 7.4% | 23.0% |
| 100-250 | 2.5% | 15.2% |
| 250+ | 0.6% | 8.8% |

**Search overrules the greedy choice in 45.5% of all decisions**, and still in
9% of the decisions the greedy agent is most confident about. There is no gap
threshold that is both common and safe: skipping every decision with a gap over
25 would save a quarter of the work and change 7% of all moves, which at ~1000
moves a game is 70 deviations — far past the ~130 points a single deliberate
deviation costs. The shallow ordering simply is not a good predictor of the deep
one, which is the same fact as "depth 2 is worth 1500 points".

**The important comparison is across networks, not across search settings:**

| | weights | ms/move | mean |
| --- | ------: | ------: | ---: |
| `base` net + depth 2 | 86 436 | 1.07 | 7563 |
| `big-s3` net, greedy | 9 234 246 | **0.057** | **8198** |

A hundred times more weights and a twentieth of the time, for 600 more points.
An n-tuple network is a lookup table: its size costs memory and training
episodes, not evaluation time, while search costs time on every move of every
game forever. **Capacity is the cheap axis and search is the expensive one** —
which is the opposite of the usual intuition, and it is why the two things that
moved this project most were a bigger network and more episodes rather than
anything clever at move time.

## A hand-written rule about 6-placement

Prompted by watching the bot make a 6 in the middle of an open board when it
could have tucked one into a corner. The proposed rule:

> Do not make a 6 with three or four sides open if some other legal move makes a
> 6 with at least two sides against a wall or another 6.

It is a good rule, and the network already follows it. Over 8 games the depth-2
agent placed 126 sixes, of which **13 (10%)** were exposed placements with a
sealed alternative available. Applied as a hard override — disallow the move,
take the agent's next choice — it costs score at both search depths:

| agent | without | with the rule | difference |
| ----- | ------: | ------------: | ---------: |
| greedy, 300 seeds | 7760 | 7535 | **−226 ± 73** |
| depth 2, 200 seeds | 9626 | 9430 | **−196 ± 73** |

Roughly 1.6 overrides per game at ~130 points each, which is the same exchange
rate the `temp` experiment found.

The instructive part is the position that prompted it. `bot/probe.js` plays one
position out repeatedly per candidate move, with the same tile futures for each,
which is the only way to settle a single move:

```
1 3 2 3 5
5 1 3 2 5
5 5 4 5 5
5 5 5 5 5
5 5 5 5 6      400 playouts per move
```

| move | 6 lands | open sides | mean from here | vs best |
| ---- | ------- | ---------: | -------------: | ------: |
| A1 | A1 | 2 | **6909 ± 38** | (best) |
| C1 | C1 | 3 | 6877 ± 41 | −31 ± 49 |
| D1 | D1 | 2 | 6670 ± 36 | −238 ± 51 |
| B1 | B1 | 3 | 6491 ± 47 | −418 ± 57 |
| E2 | E2 | 2 | 6211 ± 38 | −698 ± 50 |

The bot played C1, the exposed one. A sealed placement *is* nominally best — A1,
by 31 ± 49, which is not a difference — but the rule's category does not
discriminate: the three sealed placements span **700 points**, and two of them
are much worse than the exposed move the bot chose. "At least two sides blocked"
is a real signal and much too coarse to override a value function with.

What the rule points at is nonetheless a gap in the *architecture*, and that
part is actionable. The tuple set contains 2x2 squares, 4- and 5-runs and 2x3
blocks — and no shape that holds a cell together with all four of its
neighbours, because a plus does not fit inside a 2x3. "How exposed is this 6"
is exactly a plus-shaped question, so the network could only ever infer it
indirectly, from several overlapping rectangles. The `bigx` set adds the 25
cross shapes (a plus in the middle, a T on an edge, an L in a corner) for
181 000 extra weights, and `grow.js` transplants a trained `big` network into it
for free.

## The entries

**`maxmoves`** — 1-ply greedy on the number of legal moves after the collapse.

**`v1` = `moves:0.71, made:-17.2`** — prefer creating the *smallest possible*
tile; break ties on legal move count. The `made` weight is large enough to be
effectively lexicographic, and re-sweeping it against every later weight set
keeps confirming that: softening it below about -12 costs score. Delaying every
promotion is worth 3x more than local mobility.

**`v2`** — v1 plus positional features (coordinate ascent, seeds 10001-10300):
`pairs:0.87, made4:1, made5:1.43, gain:0.14, sixopen:-1.79, heightsum:-0.033, lowtiles:0.38`.
The big addition is `pairs` (adjacent same-value tiles): it measures *how much*
material is still matchable rather than merely whether a move exists.
`sixopen` is STRATEGY.md's "put 6s in the corner" — summed open sides of all
6-tiles — and it is the second strongest positional term.

**`v3`** — longer ascent from v2 (seeds 10001-10400): `pairs` down to 0.62,
`sixopen` up to -2.82, plus `heightsum:-0.065, lowtiles:-0.38, cnt1:-0.5, cnt3:-0.45`.
Worth noting the minimum over 100 seeds went 536 -> 1703: most of the gain is in
not throwing away the bad games.

**`v4`** — adds **5-placement**, from watching v3 play. A 5 is nearly inert: it
can only ever be consumed by merging with another 5, so it behaves like a
semi-blocker and wants to be tucked against walls and 6s rather than left in
open board. Two features carry this, `new5blocked` (walls/6s orthogonally
adjacent to the 5 the move just created) and `fiveblocked` (the same summed over
every 5 on the board); individually they are worth +578 and +554 on the tune set.
Held out: **+895 ± 177 over v3, 69W-31L.**

Note the asymmetry with 6s. For a 6, `sixopen` says sealing it away is purely
good. For a 5 it is a trade-off — a 5 walled in on three sides by 6s can only
ever connect on the one remaining side — which is why the two values need
separate features rather than one shared "openness" term.

Two things only showed up in the joint ascent, not in single-feature sweeps:
`comp5` (number of connected 5-groups, weight -1.20) and `fournear5` (4s
adjacent to or sharing a column with a 5, +0.23). Both had swept to exactly zero
against v2/v3. Keeping the 5s together only pays once they are being placed
against walls in the first place — the two heuristics are complements, and
testing either alone hides it.

**`h1`** — the first agent not tuned by playing at all. `bot/fit.js` fits the
same 45 features to *which move a strong human chose*, by a softmax ranking loss
over the legal moves in 100k real positions (see below). Two hours of coordinate
ascent worth of weights, from a few minutes of gradient descent: **+191 ± 187
over v4**. Its real value is as a starting point — it puts the whole vector in a
good basin at once, where `tune.js` only ever moves one axis at a time against a
noisy game mean.

**`td`** — the learned value network, greedy on `points now + V(afterstate)`.
The `tdsym` weights that already existed were simply **undertrained**, and that
was the single biggest finding here. Same architecture, same code, more
episodes:

| net | episodes | seeds 20001+ mean |
| --- | -------: | ----------------: |
| `tdsym.bin` (as found) | ? | 5082 ± 62 |
| `tdsym2.bin` | +60 000 | 5480 ± 74 |
| `tdsym3.bin` | +400 000 more | **5844 ± 62** |

It costs 0.017 ms/move, *half* the linear evaluation, and it was still improving
when the run stopped. The n-tuple net was the most underexploited thing in the
folder and the cheapest gain available.

**`blend`** — `h1` plus `beta` times the network's estimate. Previously recorded
as a failure (−650); it was being run at `beta=1` with the undertrained network
and `v4`. With both components healthy it is the best agent here: **6450, +1290
over v4**, a 25% improvement, and it reaches 9760 on its best seed.

`beta` was swept over 0.02 → 6. Everything from 0.6 to 1.6 is the same within
noise (a first sweep put `beta=1.6` 300 ahead of `beta=1`; re-run on a different
400 seeds the gap was −6 ± 109, so that was selection noise, not a signal).
`beta=1` is kept as the simplest point on the plateau — worth noting in itself,
since it means the two evaluations want roughly equal weight even though one is
in points and the other in arbitrary units. Swapping `h1` back to `v4` inside
the blend costs 480, so both halves compound.

The two evaluations are trained on completely different principles and make
different mistakes, which is exactly when averaging pays.

## Learning from human replays

`data/replays.jsonl` holds 9109 clean finished games, 3.78M moves. Until now
nothing read it. What it is and is not good for turned out to be sharply
divided.

### Which games to learn from

The obvious question is whether to filter to strong games. Measured properly by
holding the *sample size* fixed at 100k decisions and varying only the quality
threshold, then benchmarking each fit over 300 games:

| min score | games in pool | fit's mean score |
| --------: | ------------: | ---------------: |
| 0 | 9093 | 5126 ± 80 |
| 4000 | 4428 | 5206 ± 82 |
| **6000** | **1831** | **5383 ± 84** |
| 7000 | 1138 | 5273 ± 82 |
| 8000 | 558 | 5266 ± 93 |
| 9000 | 227 | 5339 ± 89 |

So yes, filter — unfiltered play costs about 250 points — but the benefit is
flat from 6000 up, and every threshold above it is within noise of every other.
6000 is the default because it is the cheapest place on the plateau: 1831 games
and 1.39M moves, versus 227 games at 9000. Raising the bar further buys move
quality that the 45-feature model cannot use anyway.

Note the agreement metrics (`val nll`, `val top1`) that `fit.js` prints are
**not** comparable across thresholds — each is measured against different
reference play, and agreeing with 9000+ games is a harder target than agreeing
with all games. Only the mean score ranks them.

### What worked

**Fitting the linear weights (`fit.js`).** A whole 45-weight vector in minutes,
`h1` above.

The obvious follow-up — hand `h1` to the tuner and let it polish — **did not
work**, and the way it failed is worth recording. Coordinate ascent from `h1`
(400 games, seeds 10001-10400) reported a clean gain, 5443 → 5640. On 300
held-out seeds the result (`h2`) scored **169 ± 109 worse than `h1`**. It had
gained on the seeds it was tuned on and lost everywhere else.

That is not surprising in hindsight: a round of ascent takes the best of 45
features x 2 directions against an estimate with a standard error of ±69, three
times over. Selecting the maximum of ~270 noisy draws finds noise. It is a
caution about the tuning protocol generally, not about `h1` — `v4`'s gain over
`v3` was confirmed on held-out seeds and is real, but any ascent result that has
only been measured on its own tune set should be treated as unverified until it
is re-run somewhere else.

**Finding the disagreements (`disagree.js`).** Ranks every legal move in a
strong human's position by an agent's evaluation and reports where the human's
choice lands, plus which features systematically move in the positions where the
agent is most wrong.

### What did not work: pretraining the value network

This looked like the best idea available and it is a clean negative result.

For every human move, the afterstate's Monte-Carlo return (`finalScore - score`)
is exactly the quantity `train.js` bootstraps towards, and it comes from a policy
scoring ~7500 rather than the bot's ~5000. Regressing the network on 1.39M of
them fits beautifully — **val RMSE 911 against a 2346 baseline** — and the
resulting greedy agent scores **1056**.

The reason is worth keeping: *a replay only ever shows the branch the human
took*. Every alternative a greedy agent has to rank against it is off
distribution, and the network's opinion there is untrained. A value function can
be accurate everywhere it was fitted and still be useless for choosing, because
choosing happens precisely where it was not fitted.

Adding a ranking loss over all the candidate moves (`--rank-weight`, which does
score the losers) addresses exactly that and helps a lot — greedy play goes
**1056 → 3045**. It still is not competitive, and worse, as a TD *initializer*
it is actively harmful:

| TD(0), 40 000 episodes, identical seeds | self-play mean at the end |
| --- | ---: |
| from zeros | **3616** |
| from MC-regression pretraining | 1099 |
| from MC + ranking pretraining | 1051 (peaks at 2054 early, then decays) |

Both pretrained runs get *worse* as TD proceeds. A confidently-wrong value
function is harder to escape than a blank one: the greedy policy chases whatever
the pretrained net over-estimates, and TD only corrects states the policy
actually visits. Starting from zeros, nothing is over-estimated in the first
place.

`pretrain.js` is kept because the machinery is right and the diagnosis is
specific — the missing ingredient is coverage of the losing branches, which
replays structurally cannot provide. Self-play generates exactly that coverage,
which is why TD from zeros wins.

### Imitation is a ceiling, not a target

Top-1 agreement with strong human play, over 43 000 decisions:

| agent | seeds 1-100 mean | agrees with humans |
| ----- | ---------------: | -----------------: |
| random choice | 469 | 15.1% |
| `maxmoves` | 855 | 32.9% |
| `v1` | 2619 | 50.3% |
| `v2` | 3759 | 56.0% |
| `v3` | 4265 | 55.3% |
| `v4` | 5160 | 56.4% |
| `h1` | 5351 | 59.1% |
| **`blend`** | **6450** | **28.0%** |

Agreement tracks strength up to v2 and then stops: v2, v3 and v4 are
indistinguishable on it while gaining 1400 points. And the strongest agent by a
wide margin agrees with people *barely more than `maxmoves` does*, while scoring
seven times as much.

Where `blend` and strong humans differ, the pattern is consistent: the bot takes
more `gain`, a higher `made`, longer chains and more 6s — it cashes tiles in
considerably earlier than STRATEGY.md advises and than people actually play, and
it scores more for it. Human data is therefore very good for finding a decent
region of weight space quickly, and misleading as an objective to converge to.

## Value network architecture

Five nets, all trained from zeros for 200 000 episodes on the same seeds, one
variable each, benchmarked over 300 games on seeds 20001+:

| net | weights | mean | ±se | vs base | ms/move |
| --- | ------: | ---: | --: | ------: | ------: |
| **`base` + sym** (36 tuples: 2x2 squares, runs of 4) | 86 436 | **5685** | 67 | — | 0.025 |
| `stages=3` (separate banks by 6-count) | 259 308 | 5462 | 67 | −224 ± 93 | 0.016 |
| `rows` (adds full rows and columns of 5) | 254 506 | 5014 | 66 | −672 ± 93 | 0.018 |
| `big` (adds 5-runs and 2x3 / 3x2 blocks) | 3 078 082 | 5503 | 58 | −182 ± 89 | 0.040 |
| `base` + temporal coherence | 86 436 | 4085 | 61 | −1601 ± 88 | 0.015 |

**Nothing beat the original tuple set.** At this budget every larger model is
still paying off its extra parameters: `big` has 36x the weights and is 182
behind, and it was climbing fastest at the end (self-play mean 4576 → 5460 over
its last 110k episodes), so it may well pass `base` given several million
episodes. It is not where the next point comes from cheaply.

`stages=3` is the closest and the most interesting failure. Splitting the
weights by 6-count is the same instinct as eval.js's `s_*` interaction features,
which were also within noise. It makes each bank see a third of the data, and it
notably plays for more 6s (13.1 per game against 11.4). Worth retrying at a much
larger episode count, since it is the one variant whose cost is purely
statistical.

**Temporal coherence is a disaster here** (−1601), which is the surprise, since
it is the standard step-size rule for n-tuple TD in 2048. The per-weight
multiplier is |sum of errors| / sum of |errors|, so a weight pulled both ways
damps itself towards zero. With rewards on a 0-10 000 scale and a value function
that has to move a long way before it is even roughly right, weights appear
"incoherent" early and get frozen before they reach a sensible magnitude. The
plausible fix is to warm up on a plain alpha and only switch TC on later, but
that is untested — for now, do not use `--tc`.

The one thing that did work was more episodes, on the architecture that was
already there. `tdsym3` (the resumed lineage, ~460k episodes) reaches 5844 ± 62
where `c_base` at 200k reaches 5685 ± 67, and the curve had not flattened.

## Getting the new tile's real position

Features about *where* a move puts a tile need the post-gravity index, not the
click position: `apply` writes the upgraded tile at the clicked cell and then
compacts the column, so it falls by however many cells below it were collapsed.
`game.lastCreated` records where it actually ends up.

## Why games end

Two distinct death modes, which is what makes the score variance so large:

* **Checkerboard deadlock with only 3-5 sixes on the board** — no two adjacent
  equal tiles anywhere. These are the disaster games (score < 2000).
* **6-clog with 11-15 sixes** — the good games (score > 5000).

## A useful invariant

**Score = the total value of every tile ever created, minus the value of the
tiles left on the board at the end** (verified in code: each tile is consumed at
most once, and contributes its own value when it is). Consequences: collapsing
*k* tiles of value *n* always scores *n·k* regardless of how the chain is split,
but yields only one tile of *n+1* — so small chains are better below 5 (same
points, more product) while big 5-chains are strictly better (same points, fewer
permanent 6s).

## Tried and rejected

Kept here so they don't get re-tried. Each was measured against the then-best
agent on the same seeds.

| idea | result |
| ---- | ------ |
| n-ply search, `depth=2/3`, all three fill modes, death penalty 20-1000 | −716 to −1163, 5-15x slower. Summing move terms along a line optimizes a line that will never be played. |
| MC policy rollouts, `obj=score`, full or truncated horizon | −2600 to −2800, 100-500x slower |
| MC rollouts, `obj=steps` (survival), common random numbers | −471 to −2588 |
| MC rollouts restricted to moves the base policy rates equal (`eps=8`) | −165 ± 321, i.e. **parity at ~100x the cost** — the best search result, and still not worth it |
| Evaluating features on sampled refills instead of an empty top (`samples=1..6`) | −361 to −1324; more samples converge back to parity at 6x cost |
| Tile-count potential features `cnt1..cnt5` | within noise |
| Anti-deadlock features `iso, pairlo, pairhi, distinct, gen4` | within noise |
| Chain-size split `chain5` / `chainlow` (from the invariant above) | within noise — already captured by `gain` |
| Phase interactions `s_moves, s_pairs, s_made, s_sixopen, s_gain, s_heightsum` (weights bending as 6s accumulate) | within noise |
| Random-direction hill climbing from v3 (140 iterations, 400 seeds) | no improvement found |
| 5-connectivity features `new5bond`, `new5colgap`, `fivebond`, `fivemax`, `fivecols`, `fivespan` | weight 0 against **both** v3 and v4. Explicitly measuring "put the new 5 next to the old one" adds nothing beyond `comp5`; the corner placement is what carries the gain |
| Pretraining the value network on human MC returns | fits well (val RMSE 911 vs 2346), plays at 1056, and makes TD **worse** than starting from zeros. See "What did not work" above |
| Adding a ranking loss to that pretraining | greedy play 1056 → 3045, still not competitive, still a bad TD initializer |
| Optimizing agreement with human play as an objective | saturates: v2/v3/v4 all sit at ~56% while gaining 1400 points, and the best agent scores 25.7% |
| Coordinate ascent from `h1` (`h2`) | +197 on the 400 tune seeds, **−169 ± 109 on 300 held-out seeds**. Tune-set overfitting; see above |
| Independent (non-stratified) sampling of chance nodes | worth several hundred points to fix, and it is a *bias*, not just noise: the max node over-rates whichever move has the widest chain |
| Deeper chance nodes (`capDeep` 8) and wider internal max nodes (`topk` 3) | −93 ± 170 and +26 ± 143 at 1.4x cost. Spend the budget at the root instead |
| Fine-tuning the network on the search policy's own trajectories | **−705 ± 93**. See below |
| `risk` — penalising the spread over refills at chance nodes | −94 to −484, and it makes the agent *less* consistent, not more |
| `temp` — softmax move selection instead of argmax | −2165 at temp 15, and it lowers the best game too |
| Ensembling the 1-stage and 3-stage networks | −299 ± 98 at 2.5x the cost. They share a lineage, so their mistakes are the same mistakes |
| The exposed-6 rule as a hard override | −196 to −226. As a soft override (`sixeps=10`) it is exactly neutral: +11 ± 29 |
| `--lambda 0.85` | unstable; oscillates by 2000 points between reports |
| Banking on playable area instead of the 6-count | correlates -0.999 with the 6-count in real play; the same information |
| Skipping the search when the 1-ply gap is large | no safe threshold exists; see the table above |

**A bug worth the embarrassment.** `search.js` capped a position's move list at
16 with a comment claiming canonical moves never approach that. Real positions
reach 19, and 1.6% of them have more than 16, so `expand` was silently dropping
the last moves it found. Fixing it is worth +14 +- 47 — nothing — but the way it
was found is the lesson: a single 100-seed run of the fixed version looked 141
points *worse*, and only a paired comparison showed the truth. Changing anything
that alters 1.6% of decisions makes 85% of games diverge completely, so
comparing two separate runs measures divergence, not the change.

### Fine-tuning on the search policy's trajectories

This one looked obviously right and is not. The depth-3 agent plays 989-move
games reaching 14.6 sixes; greedy self-play, which is all the network was ever
trained on, reaches 773 moves and 12.9 sixes. So the network has never seen the
positions the deployed agent spends its endgame in. `ptrain.js --search-depth 2`
runs TD with the expectimax agent as the behaviour policy to cover exactly that
gap.

8 000 such episodes at alpha 0.03 cost **705 points**. The self-play mean *rose*
during the run (8308 -> 8390), which is what makes it a trap: the policy was
improving on the distribution it was being trained on while the network as a
whole got worse.

The diagnosis is the same catastrophic-interference story as the human-replay
pretraining above, in a different costume. An n-tuple weight is shared by every
board containing that pattern, so 8 000 episodes concentrated on one slice of the
state space drag weights that 1.6M episodes of broad coverage had already
fitted. Search-based behaviour is 35x slower per episode, so the coverage needed
to make it safe is 35x more expensive than the coverage that made the network
good in the first place. If it is retried, it wants a far smaller alpha and a
budget measured in hundreds of thousands of episodes, not thousands.

The pattern that used to be here — "lookahead does not pay, because the
uncertainty about incoming tiles swamps the depth" — was wrong, and it is worth
being precise about why, because the measurement behind it was sound. Search on
a *hand-tuned linear evaluation down a pessimistic fixed line* does not pay.
Search on a *learned afterstate value function over the real tile distribution*
is worth +1982, more than every hand-written feature in this file put together.
The two differ in both halves: what is at the leaves, and what the chance nodes
model.

The newer pattern, from the entries above: the things that moved the number most
were **more training**, **more capacity**, and **search** — none of them a new
idea about the game, all of them ideas that had already been tried once at a
tenth of the scale needed and written off. Before designing a feature, it is
worth checking whether something already in the folder is simply undertrained,
under-sized or under-searched.

A caution the v4 result illustrates: a single-feature sweep against the current
best can report exactly zero for a feature that is worth several hundred points
once its complement is present. Before discarding an idea, it is worth one joint
ascent with the whole group enabled.

## A bug worth remembering

The flood fill marks visited cells with a counter stamped into an `Int32Array`
while counting in a JS number. Past 2^31 stamps the stored value wraps negative,
never compares equal again, and the fill spins forever — which silently stalled
two long training runs after ~25 minutes each. Both `engine.js` and `eval.js`
now recycle the counter. Long-lived processes (training, tuning pools) reach
2^31 flood fills in well under an hour.

## Reproducing

```bash
node bot/run.js --agents "linear:preset=v4" --seeds 100 --jobs 4
node bot/tune.js sweep  --seeds 300 --jobs 4 --start h1        # 1-D scan per feature
node bot/tune.js ascent --seeds 400 --jobs 3 --start h1        # coordinate ascent
node bot/tune.js climb  --seeds 400 --jobs 3 --start h1        # random-direction
```

Learning from the replays:

```bash
node bot/fit.js --min-score 6000 --decisions 100000 --out bot/weights/fit.json
node bot/fit.js --sweep 0,4000,6000,8000 --bench 300           # the threshold table above
node bot/disagree.js --agent "linear:preset=h1" --show 6       # with example boards
node bot/human.js --agent "linear:preset=h1" --games 300 -v    # per-player comparison
```

Training the value network:

```bash
node bot/train.js --sym --alpha 0.05 --episodes 200000 --out bot/weights/mine.bin
node bot/train.js --resume bot/weights/mine.bin --sym --episodes 400000   # keeps going
```

Weight files record their own architecture, so `td:weights=PATH` needs no other
options. The four original `.bin` files predate the header and are read as
`base`, one stage; `tdsym.bin` also needs `sym=true` in the spec.
