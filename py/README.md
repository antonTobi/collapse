# Python trainer (compute-server port)

A dependency-light port of the n-tuple TD(0) trainer (`bot/ptrain.js`, minimal
recipe) for running long training runs where only Python 3 is available. Weight
files are byte-compatible with the Node code: warm-start from a Node-produced
`.bin`, train here, then copy the result back to a machine with Node to evaluate
and deploy (`bot/run.js`, `reduce.js` → `compact.js` → `quantize.js`).

## Setup (one time)

```bash
python3 -m venv ~/collapse-venv
source ~/collapse-venv/bin/activate
pip install -r py/requirements.txt        # numpy + numba
python3 -c "import numba; print('numba', numba.__version__)"   # sanity check
```

`numba` pulls a prebuilt LLVM (`llvmlite`) wheel — no compiler needed on x86-64
Linux with internet. Air-gapped box: download the wheels elsewhere and
`pip install --no-index --find-links=./wheels numpy numba llvmlite`.

## Train (one command)

Reproduces the current correction-module recipe (only the appended tuples train,
on the frozen evaluator), sized for the 56-core box:

```bash
source ~/collapse-venv/bin/activate
python3 py/train.py \
    --resume bot/weights/all7h-seed.bin --sym \
    --freeze-prefix mini5_all7gr --freeze-root \
    --starts bot/data/mut-starts.bin --start-frac 0.5 \
    --jobs 56 --episodes 3000000 --alpha 0.004 --alpha-end 0.001 \
    --checkpoint-every 200000 --checkpoint-dir /LocalData/all7h-ckpts \
    --out /LocalData/all7h-py.bin
```

For a full fine-tune instead (all weights co-adapt), drop `--freeze-prefix` and
raise the rate, e.g. `--alpha 0.03 --alpha-end 0.005`.

Put checkpoints and the output on `/LocalData` (the big local disk). `--jobs`
should match physical cores; Hogwild scales near-linearly. The run resumes from
any checkpoint with `--resume <checkpoint.bin>` (architecture is read from the
file; `--freeze-prefix` still needs naming).

## Key flags

| flag | meaning |
|------|---------|
| `--resume FILE` | warm-start from a `.bin` (architecture taken from the file) |
| `--set NAME` | build a fresh net on a tuple set (when not resuming) |
| `--sym` | mirror-symmetric reads (matches the trained nets) |
| `--freeze-prefix SET` | train only tuples appended after SET (correction module) |
| `--freeze-root` | show provably-dead tiles to the net as 6s at each root |
| `--starts FILE --start-frac F` | begin fraction F of episodes from a position pool |
| `--alpha A --alpha-end B` | geometric anneal from A to B over the run |
| `--jobs N` | Hogwild worker threads |
| `--checkpoint-every N --checkpoint-dir D` | periodic checkpoints |

## Layout

- `train.py` — CLI + Hogwild orchestration (threads on one shared weight array).
- `fastcore.py` — numba-jitted hot loop: value, update, features, freeze, and
  the whole-episode TD(0) runner (nogil, so threads run in parallel).
- `ntuple.py` / `engine.py` — readable pure-Python reference + the tuple-set
  builder and CNTP weight-file I/O; also the parity oracle.
- `verify_parity.py` / `verify_fast.py` — check Python matches Node exactly.

Only supported tuple sets are wired in `ntuple._BASE_SETS` (currently
`mini5_all7g`, `mini5_all7h`, plus their `r` reduced variants). Add a new set by
porting its builder from `bot/ntuple.js` — keep the tuple ORDER identical or the
weights won't line up with Node.
