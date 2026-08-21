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
| `reduce.js` | Drop the mirror-duplicated half of a network's tuples. Same function, 40% fewer table reads. |
| `tuples.html` | Every tuple shape the network reads, drawn on a board. Open it directly; it reads `ntuple.js`, so it cannot go stale. |
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
node bot/run.js --agents "fx:weights=bot/weights/bigx-s7.bin,depth=3,cap=32,capDeep=4,topk=2,rootk=6" --seeds 100 --jobs 10
```

**10 526 ± 74** over seeds 1-100, median 10 627, worst game 8477, best 12 152,
96% of games above 9000. The previous best agent in this folder scored 6450 with
a worst game of 272. A strong human averages around 7400.

The ladder that got there, all on seeds 1-100:

| | mean | ms/move |
| --- | ---: | ------: |
| previous best (`blend`, linear + small net) | 6450 | 0.04 |
| the same idea with a network 36x bigger, trained 1.6M episodes | 7799 | 0.06 |
| + stage banks and cross tuples, grown into rather than trained cold | 8595 | 0.10 |
| + depth-2 expectimax | 10 116 | 3.3 |
| + depth-3 expectimax | **10 526** | 46 |

### Which weight files are in the repository

Only `bot/weights/big-td.bin` (12 MB) and the small original `base` networks.
The two large ones are gitignored, because a 35 MB and an 87 MB blob in git
history are permanent:

| file | size | what it is | how to get it |
| ---- | ---: | ---------- | ------------- |
| `big-td.bin` | 12 MB | `big`, 1 bank, 1.65M episodes | committed |
| `big-s3-final.bin` | 35 MB | the above grown to 3 banks, +1.2M episodes | `grow.js --stages 3`, then `ptrain.js` |
| `bigx-s7.bin` | 87 MB | the above grown to the `bigx` set and 7 banks, +1.6M episodes | `grow.js --set bigx`, `grow.js --edges 2,4,6,8,10,12`, then `ptrain.js` |

Everything in the leaderboard below `big-td.bin` therefore runs from a clone;
the top three rows need their network trained first. The spectator opens on an
agent whose weights are committed, and lists the stronger ones after it.

`bot/LEADERBOARD.md` has every measurement, including the negative ones. The
three findings that carried the most weight:

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

**Finish the training run.** `bigx-s7.bin` is a 7-bank, 22.8M-weight network
that has had only ~400k episodes since it was grown from a 3-bank one, and its
self-play mean was still climbing (8486 -> 8557) when it was stopped. Every
previous network in this folder kept improving well past the point it looked
flat, and this is the cheapest gain available:

```bash
node bot/ptrain.js --jobs 10 --resume bot/weights/bigx-s7.bin --episodes 3000000 \
    --alpha 0.011 --alpha-end 0.003 --report 50000 --seed-base 15000000 \
    --out bot/weights/bigx-s7.bin
```

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
expressive power — see LEADERBOARD.md. Train `Xr` from zeros, or convert a
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
