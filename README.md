# Ledger

Eighth Iterative Intelligence instrument. Tagline: **the forecast that grades itself.**

Every cycle, a decile forecast (deciles 0.1–0.9, plus a naive and a random-walk-with-drift
baseline) for one economic series is committed to this repository as an immutable,
hash-stamped JSON file — *before* the data it forecasts exists. When the real value is
published, a separate step grades the forecast in public: pinball loss per decile, an
80%-interval hit/miss, and the model's absolute error at the median against both baselines.
The scoreboard launches **empty on purpose**. There are no backtests, ever — a foundation
time-series model may have seen the historical data during pretraining, which makes any
"backtest" of it retrodiction dressed up as forecasting, not forward skill. The only thing
this instrument claims is **precedence**: a public, timestamped commit that existed before
the outcome did. Verdicts are `SCORED` or `UNEVALUABLE` (late past a 30-day grace period,
discontinued, redefined, or a vintage conflict) — `UNEVALUABLE` is **terminal**; once written
it never becomes `SCORED`, even if better data shows up the next day. Corrections are
appended and dated; nothing already written is ever edited in place.

Four series, one quarter/month ahead (`h=1`): `ea-hicp` (euro-area HICP annual rate),
`lu-unemp` / `ea-unemp` (unemployment rate, SA), and `lu-debt` (Luxembourg quarterly
government gross debt — the "Luxembourg's Scissors" flagship). See `RUNBOOK.md` for the
exact dataset codes, release calendars, and the operator's monthly cycle.

Built 2026-09-01 across several build passes (site chassis + kernel, offline pipeline, this
reference check). **Not yet live**: `ledger/` is not inside any git repository yet, so
nothing registered so far has a public, independently-checkable timestamp — see `RUNBOOK.md`
§4 for what that requires before the precedence claim above means anything. **Synced to the site on 2026-09-02**: served at `/instruments/ledger/`, with a gallery card
under its own cluster and a computed miniature in the homepage preview cycler (the sync list
and card live in `site/scripts/sync-content.mjs` and `site/src/data/instruments.js`). See "Resolved 2026-09-01" below for the
canonical-JSON history.

## Registry layout

```
ledger/
  index.html                  built page (chassis.css + ledger.js + chassis.js + app.js,
                               via src/build.js) — a <head>-less, <body>-less fragment
  src/
    body.html, app.js         page markup/styles and controller
    ledger.js                 the scoring kernel: pinball loss, canonical-JSON + SHA-256,
                               registry-wide aggregates — runs in Node (tests, fixture
                               generation) AND inlined in the browser (live verification)
    ledger.test.js            `node ledger.test.js` — hand-computed checks for every
                               function in ledger.js, incl. NIST SHA-256 test vectors
    chassis.css, chassis.js   the shared chassis (copied verbatim from the sibling
                               instruments, e.g. phantom/src/)
    build.js                  concatenator; embeds data/registry/ledger.json (or, before
                               the first pipeline run, src/fixtures/ledger.fixture.json)
    fixtures/ledger.fixture.json   dev-time fixture: four real-shaped OPEN registrations,
                               zero outcomes — what index.html shows before any real
                               `compile` has run
  pipeline/
    ledger_pipeline.py         the offline engine: register / fetch / score / compile
                               (Python, TimesFM + naive/rw-drift baselines; venv at
                               pipeline/.venv, gitignored)
    reference_check.py         THIS TASK's deliverable — the independent reference check
                               (see below); stdlib-only, no venv needed
    fixtures/good/, fixtures/corrupted/   synthetic registry used by
                               `reference_check.py --fixtures` (see below)
    test_pipeline.py           ledger_pipeline.py's own unit tests
  data/
    registry/
      registrations/<id>.json  immutable once written (id = "<slug>--<period>--r<n>")
      outcomes/<id>.json       written once per registration by `score`; references the
                               registration id; never edited after
      corrections/<n>.json     append-only, numbered, dated notes — never rewrites
                               a past file
      cache/                   raw API fetch snapshots (debugging / audit trail, not
                               part of the fcreg schema)
      ledger.json              compiled bundle written by `ledger_pipeline.py compile`:
                               {generated_utc, registrations[], outcomes[], corrections[],
                               stats}. This is what build.js embeds into index.html.
RUNBOOK.md                     operator's day-to-day guide: exact commands, cadence
                               calendar, failure-mode table, precedence/git contract
```

Registration schema (`fcreg` v0.1) and outcome schema are the binding spec this checker
implements from; see the field-by-field comment at the top of `pipeline/reference_check.py`
rather than duplicating it here.

## The independent code paths

House doctrine (site-wide ground rule, restated for this instrument): every displayed
number carries a **kind** tag — `stored` (a registered/committed value), `measured` (a
fetched outturn), or `live` (computed in the browser, from embedded data, at render time)
— and **an independent code path recomputes every published metric**. Ledger actually has
**three** code paths, and it matters which one is which:

| path | role | independence |
|---|---|---|
| `pipeline/ledger_pipeline.py` | **writes** the registry: fetches context from Eurostat, runs TimesFM 2.x + the two baselines, computes and stamps each registration's `sha256`, scores outcomes, compiles `data/registry/ledger.json` | none — it is the thing being checked |
| `src/ledger.js` (`canonicalize`/`sha256Hex`/`verifyRegistrationHash`/`aggregate`) | recomputes hashes and aggregates **live, in the browser**, from the exact data embedded in `index.html` — the `kind: live` guarantee the visitor actually sees | independent of the pipeline's *runtime*, but hand-written in parallel to the same spec, not derived from the pipeline's code |
| `pipeline/reference_check.py` (**this task**) | offline, stdlib-only, second opinion: re-derives every sha256, every outcome's metrics, and every `ledger.json` aggregate from the raw registry files, from the spec text alone | written without importing or reading `ledger_pipeline.py` — see its module docstring |

`ledger_pipeline.py` does **not** have its own `verify`/`correct` subcommand (an earlier
planning draft in `RUNBOOK.md` §3.2 describes one; the pipeline actually shipped only
`register` / `fetch` / `score` / `compile` — see "Resolved 2026-09-01" below). Even if it did, a
`verify` subcommand living inside `ledger_pipeline.py` would **not** be house-doctrine
independent — it would be the same code checking its own output, which cannot catch a bug
shared between writing and re-reading (exactly what happened here; see below).
`pipeline/reference_check.py` is the actual independent reference check this instrument's
doctrine requires, and it is the one to run before every commit.

## Running the reference check

```
cd "/Users/jeromeverony/Documents/Claude Code projects/Exploration/ledger/pipeline"
python3 reference_check.py                # check the live registry (data/registry/)
python3 reference_check.py --fixtures     # self-test the checker itself
```

No venv, no pip install — stdlib only (`json`, `hashlib`, `argparse`, `datetime`, `math`,
`pathlib`). Exit code is `0` iff nothing was found wrong (including the empty-registry
state, which is a deliberate PASS, not a warning) and non-zero the moment any single
mismatch is found; on failure every mismatch prints as a precise diff line, e.g.:

```
FAIL — 2 mismatch(es):
  - [registrations/ea-hicp--2026-09--r1.json] sha256 expected(recomputed)=1c65...5bca stored=757c...c09cb
  - [registrations/lu-debt--2026-Q2--r1.json] sha256 expected(recomputed)=0ec2...9b48 stored=7e00...189c
```

What it checks (full detail in the script's module docstring):

1. Structural sanity of every registration/outcome (id matches filename, required fields
   present, exactly the nine deciles, non-decreasing decile values).
2. **sha256 re-derivation** for every registration, from the raw fields via the exact
   canonical-JSON rule in the fcreg spec, cross-referencing the same math `src/ledger.js`
   runs in the browser (see "Resolved 2026-09-01").
3. **Metric recomputation** for every `SCORED` outcome — pinball loss per decile, pinball
   mean, interval-80 hit, and the three absolute errors — from the raw registration +
   outturn, compared against what was stored.
4. **Append-only invariants**: every outcome references a real registration; no
   registration's `created_utc` is in the future; `UNEVALUABLE` outcomes carry a reason
   and no metrics, `SCORED` outcomes the reverse; an outcome is never `scored_utc`-stamped
   before its own registration's `created_utc`, nor in the future; every correction names
   an existing registration.
5. **`data/registry/ledger.json`**, if present: its embedded `registrations`/`outcomes`/
   `corrections` arrays must be byte-identical to the per-file registry (catches a stale
   `compile`), and its `stats` object (`n_open`, `n_scored`, `n_unevaluable`, `coverage80`,
   `mean_pinball_by_series`) is recomputed independently from the raw registry — never from
   the stored per-outcome metrics — and compared field-for-field. A published field this
   script doesn't know how to recompute is itself reported as a mismatch.

### `--fixtures`: self-testing the checker

`pipeline/fixtures/good/` is a tiny synthetic registry (one series, `demo-cpi`): one
`SCORED` registration+outcome and one `UNEVALUABLE` one, plus a compiled `ledger.json` and
one correction note. Every expected number is hand-computed in a comment at the top of
`run_fixtures_selftest()` in `reference_check.py` (the pinball arithmetic, the aggregate
stats, all worked by hand from the raw deciles and outturn). `pipeline/fixtures/corrupted/`
is a byte-for-byte copy with exactly three planted defects — a tampered `pinball_mean`, a
flipped hex digit in a `sha256`, and a wrong `stats.n_scored` — and `--fixtures` asserts
the good copy PASSes, the corrupted copy FAILs, and each of the three specific defects is
among the reported mismatches (not just "it failed for *some* reason"). It also prints an
informational (non-gating) cross-check of `src/fixtures/ledger.fixture.json`, a file this
script does not own.

```
$ python3 reference_check.py --fixtures
=== fixture self-test: GOOD registry (must PASS) ===
PASS — total=2 OPEN=0 SCORED=1 UNEVALUABLE=1
      interval80 coverage: 1.000 empirical over 1 SCORED verdict(s) (nominal 0.800)

=== fixture self-test: CORRUPTED registry (must FAIL) ===
FAIL — 3 mismatch(es): ...

FIXTURE SELF-TEST: PASS
```

## Resolved 2026-09-01: canonical JSON now agrees across Python and JavaScript

An earlier build pass found that `pipeline/ledger_pipeline.py`'s `canonical_json_bytes()`
(`json.dumps(..., ensure_ascii=True)`) and `src/ledger.js`'s `canonicalize()` disagreed on
any registration containing a non-ASCII character (an em dash in a `calendar_source` note
was enough): Python emitted `\u2014`, JavaScript's `JSON.stringify` emitted the literal
character, and the two SHA-256 digests differed — so the live page would have flagged two
correctly written forecasts as tampered.

**This is fixed, and the fix is on the JavaScript side.** `src/ledger.js` now
`\uXXXX`-escapes every non-ASCII code unit (surrogate pairs escaped unit by unit) so its
canonical bytes reproduce Python's `ensure_ascii=True` output byte for byte; the reasoning
is in the comment above `jsonStringEscape()`. `ensure_ascii=True` in the pipeline is
therefore **deliberate** and documented in place — do not flip it to `False`, and do not
"simplify" the escaping in `ledger.js`: either change reintroduces the mismatch. Checked
2026-09-01 evening: `pipeline/reference_check.py` passes on the real registry (4 of 4
hashes match), the page's self-test re-verifies all four registrations live in the
browser, and `node src/ledger.test.js` covers the escaping.

A related trap the checker still guards: Python's `json.dumps` and JavaScript's
`JSON.stringify` agree on integers but disagree on a whole-number float literal (`90.0`
round-trips as `"90.0"` in Python, `"90"` in JS). `reference_check.py` scans every
registration file's raw JSON text for this pattern (distinguishing numeric literals from
digits inside quoted strings such as a checkpoint id) and reports it as a mismatch if
found. None of the current registrations trigger it.

## License lane

The public engine lane is **Apache-2.0 TimesFM 2.x only**. The registered
`engine.checkpoint` must be an exact Hugging Face id for a 2.x-era Apache-2.0 checkpoint —
currently `google/timesfm-2.5-200m-pytorch` (confirmed `apache-2.0` via the Hugging Face
API, per `RUNBOOK.md` §0.3) — and **never** a `3.0` checkpoint (`google/timesfm-3.0-pytorch`
is licensed `other`/non-commercial, and is a separate, private-lane project already using
the same local Hugging Face cache — see the user's own `TimesFM exploration` notes). Two
axes not to confuse: `engine.checkpoint` (the model weights; license-gated, must stay 2.x)
and `engine.version` (the `timesfm` **pip package** version, currently `3.0.0` — the
library code itself is Apache-2.0 at every version; this field records tooling, not the
weights). `RUNBOOK.md` §0.3 says every `register` run must assert the checkpoint string
equals `google/timesfm-2.5-200m-pytorch` before calling the model, loudly, not as a
warning — `reference_check.py` does not currently re-verify that assertion (it has no way
to know what the pipeline *would have* loaded, only what got written), so this remains an
operator/pipeline responsibility, not something the reference check can catch after the
fact.

## What "SCORED" / "UNEVALUABLE" mean here

- `SCORED`: the outturn arrived on time (or within the 30-day grace period) and the
  forecast was graded — pinball loss per decile, `interval80_hit`, and absolute error at
  the median vs. both baselines. This verdict, once written, is final: a later data
  revision never reopens it (`vintage_policy`).
- `UNEVALUABLE`: terminal, with a reason (`late`, `discontinued`, `definition_changed`, or
  `vintage_conflict`). It can never later become `SCORED`, even if better data shows up the
  next day — a forecast made after the outcome is knowable is not a forecast, so there is
  no backfill path, ever.

The scoreboard currently shows four `OPEN` registrations and zero of either verdict. That
is the intended launch state, not a placeholder waiting to be filled in a hurry —
precedence before performance.
