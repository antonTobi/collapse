# Bots

Headless implementation of the game plus a place to develop and benchmark agents.

| file | what it is |
| --- | --- |
| `engine.js` | The rules, headless. Verified move-for-move identical to `game.js` (board, score, PRNG, splits, move encoding, game-over) — no rendering, achievements or storage. |
| `agents.js` | Agent registry. An agent is `{ name, chooseMove(game) -> [i, j] }`. |
| `run.js` | CLI benchmark: runs every agent on the same seeds and compares. |
| `spectate.js` + `../spectate.html` | Watch one agent play one seed live, with a per-move delay. Open the html file directly. |

## Running

```bash
node bot/run.js                                  # random vs maxmoves, seeds 1–25
node bot/run.js --agents maxmoves --seeds 200    # bigger sample
node bot/run.js --agents random,maxmoves -v      # per-seed table
node bot/run.js --list                           # registered agents
```

Two agents are compared **paired** (same seeds), which removes most of the
seed-to-seed variance from the difference.

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
