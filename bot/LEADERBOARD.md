# Leaderboard

All numbers are **100 games on seeds 1-100** (`node bot/run.js --agents <spec> --seeds 100 --jobs 4`).
Weights are tuned/trained on seeds 10001+ / 100001+ only, so seeds 1-100 stay held out.
`ms/move` is measured in the same run, so a heuristic that buys little for a lot
of compute shows up immediately.

| # | agent spec | mean | ±se | median | min | max | moves | 6s | ms/move |
| - | ---------- | ---: | --: | -----: | --: | --: | ----: | -: | ------: |
| 4 | `linear:preset=v4` | **5160** | 137 | 5271 | 1381 | 7639 | 531 | 9.7 | 0.18 |
| 3 | `linear:preset=v3` | 4265 | 124 | 4298 | 1703 | 7625 | 442 | 8.7 | 0.10 |
| 2 | `linear:preset=v2` | 3759 | 111 | 3824 | 536 | 6300 | 393 | 8.1 | 0.06 |
| 1 | `linear:preset=v1` | 2619 | 75 | 2548 | 1167 | 4756 | 283 | 7.6 | 0.07 |
| 0 | `maxmoves` | 855 | 19 | 855 | 390 | 1309 | 104 | 8.2 | 0.07 |
| — | `random` | 469 | 12 | 459 | 101 | 1000 | 54 | 3.6 | 0.01 |

Human reference: ~10 000 in a good game.

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

The pattern: lookahead does not pay, because the uncertainty about incoming
tiles swamps the depth. Every gain so far has come from a better *evaluation* of
the immediate position — and the two biggest ones (v1's "make the smallest tile"
and v4's 5-placement) came from strategy, not from search.

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
node bot/run.js --agents "linear:preset=v3" --seeds 100 --jobs 4
node bot/tune.js sweep  --seeds 300 --jobs 4 --start v3        # 1-D scan per feature
node bot/tune.js ascent --seeds 400 --jobs 3 --start v3        # coordinate ascent
node bot/tune.js climb  --seeds 400 --jobs 3 --start v3        # random-direction
```
