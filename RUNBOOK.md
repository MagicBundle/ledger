# Ledger — Operator Runbook

Instrument #8, Iterative Intelligence. "The forecast that grades itself." One Mac,
one operator, no servers, no cron. Every step below is a command you type by hand.

This runbook was written 2026-09-01. Every dataset code, dimension filter, and release
lag below was checked against the **live** Eurostat API and Eurostat/ECB calendar
sources on that date (commands used are in §2.5 so you can re-verify at any time).
Two corrections to the series set as originally briefed were found doing that and are
called out where they matter — read §0 before you run anything.

---

## 0. Read this first — corrections found while verifying (2026-09-01)

1. **`ea-hicp` dataset code is stale.** `prc_hicp_manr` (the code in the original
   series brief) is frozen: live query returns data only through **2025-12**, last
   updated 2026-02-06 — it stopped receiving new observations when Eurostat cut over
   to ECOICOP ver.2 in January 2026. The live dataset is **`prc_hicp_minr`**, and its
   "all items" filter is `coicop18=TOTAL` (not `coicop=CP00` — that dimension name and
   code no longer exist in the new table). Verified live through 2026-08.
2. **Euro-area geo code changed.** `une_rt_m` (unemployment) with `geo=EA20` now
   returns **zero series** — empty. The current euro-area aggregate code is
   **`EA21`** ("Euro area – 21 countries (from 2026)"), confirmed live with data
   through 2026-07. This is a real composition change (a 21st country entered the
   euro area in 2026), not a typo. `prc_hicp_minr` still happens to serve data under
   both `EA20` and `EA21` right now — use `EA21` there too, for consistency and
   because `EA20` is documented as the fixed 2023–2025 vintage and could freeze at
   any time the way `prc_hicp_manr` just did.
   `LU` is a country code, unaffected by this — `une_rt_m`/`gov_10q_ggdebt` with
   `geo=LU` are untouched.
3. **TimesFM checkpoint — a live compliance trap, not just a docs note.** The
   `pipeline/.venv` on this Mac has the `timesfm` pip package at **3.0.0** (that is
   fine — the *library code* is Apache-2.0 at every version) and its Hugging Face
   cache **already contains a full copy of `google/timesfm-3.0-pytorch`** — pulled by
   the separate, private TimesFM-exploration project (see `TimesFM exploration.md` in
   memory: 3.0 is that project's private lane). That checkpoint sits in the same
   cache the Ledger pipeline will read from. Confirmed via the Hugging Face API,
   2026-09-01:

   | checkpoint | license tag |
   |---|---|
   | `google/timesfm-2.0-500m-pytorch` | `apache-2.0` |
   | `google/timesfm-2.5-200m-pytorch` | `apache-2.0` (already cached locally) |
   | `google/timesfm-3.0-pytorch` | `other` (non-commercial — **banned for Ledger**) |

   **Use `google/timesfm-2.5-200m-pytorch`** as the registered `engine.checkpoint`
   (it is a "2.x" checkpoint per the binding spec, Apache-2.0, and the installed
   `timesfm==3.0.0` package has a native `timesfm_2p5` module for it — there is no
   equivalent 2.0-era module in that package, so 2.5 is also the path of least
   resistance). Every `register` run must assert the checkpoint string in code
   equals exactly `google/timesfm-2.5-200m-pytorch` before calling the model, and
   the assertion must fail loudly (not warn) if it doesn't. Never load a bare model
   name that lets the library pick a default.

None of this changes the schema, the layout, or the math — only the exact dataset
filters below and one hard-coded string in the pipeline.

---

## 1. QUICK CARD — one screen

**Since 2026-09-02 this whole card runs unattended every day — see §7.** By hand, it is
these five commands, in this order. `register` derives each series' target itself (the
period after the latest published observation) and refuses to re-register a target that
already has an `r1`; `--allow-rerun` is the deliberate exception.

```
cd "/Users/jeromeverony/Documents/Claude Code projects/Exploration/ledger/pipeline"
source .venv/bin/activate

python ledger_pipeline.py score                             # grade anything whose data has landed
python ledger_pipeline.py register --series all              # next period per series; SKIPs what is already registered
python ledger_pipeline.py compile                            # rebuild data/registry/ledger.json
cd .. && node src/build.js                                   # rebuild index.html
open index.html                                              # REVIEW LOCALLY, run the on-page self-test
```

Then, only after the local review looks right:

```
git add data/registry src/ index.html
git commit -m "ledger: <what changed this cycle>"
git push
```

**Deadline rule:** the `git push` above must land, timestamped, *before* the
release date-time of every target period being registered in that commit. If you
are not sure you'll get to a machine before a release, register early — there is no
penalty for registering months ahead, only for registering late. See §0 point 3 and
§3 before your very first run: the repo `git push` above targets **does not exist
yet** and the checkpoint safety assertion **must be in place** before the first
`register`.

---

## 2. Cadence calendar

Every series is registered one period ahead (`h=1`): you always register the
soonest period whose data does not exist yet, and score the one before it once its
data lands. Grace period for a late release, all series: **30 days** past the
`target.release.expected` date (matches the schema default; widen per-series later
only with a dated correction, never silently).

### 2.1 `ea-hicp` — euro-area HICP, all-items annual rate

- Dataset: `prc_hicp_minr`, dims `coicop18=TOTAL, unit=RCH_A, geo=EA21` (§0.1, §0.2)
- Release rhythm: **flash estimate**, released on the last working day of the
  reference month or the first 1–4 calendar days of the next month. Source: ECB
  statistical calendar (`ecb.europa.eu/press/calendars/statscal`), 2026 dates —
  Mar 31, Apr 30, May → Jun 2, Jun → Jul 1, Jul 31, Aug → Sep 1 (**verified live**:
  the Aug‑2026 value appeared in `prc_hicp_minr` at the Sep‑1‑2026 pull done for
  this runbook), Sep → Oct 2, Oct → Nov 4. Beyond Nov 2026: **[ASSUMED]** same
  pattern (last day of month, sliding to the next 1–4 business days for weekends) —
  reconfirm each cycle against the live ECB/Eurostat calendar, do not hard-code past
  Nov 2026.
  I could not confirm from Eurostat's own written docs (only from this live
  behavior) that `prc_hicp_minr`'s all-items row *is* the flash figure rather than a
  fast provisional update on the same schedule — functionally identical for our
  purposes (same date, first-published value), flagged as **[INFERRED]** rather than
  documented, per house doctrine on not inventing sourcing.
- Next open target as of 2026-09-01: **2026-09**, expected release **~2026-10-02**.

### 2.2 `lu-unemp` / `ea-unemp` — unemployment rate, monthly, SA

- Dataset: `une_rt_m`, dims `s_adj=SA, age=TOTAL, sex=T, unit=PC_ACT`,
  `geo=LU` / `geo=EA21` (§0.2)
- Release rhythm: Eurostat metadata for `une_rt_m` states seasonally-adjusted
  monthly rates publish "approximately 31 days after the end of the reference
  month." **Verified live** for this runbook: July‑2026 data appeared at the
  2026‑09‑01 pull — 32 days after month-end. LU and EA21 release the same day (same
  `updated` timestamp in the API response). Projected forward at the same ~31–32 day
  lag: Aug‑2026 data ≈ **2026-10-01/02**, Sep‑2026 data ≈ **2026-11-02/03** —
  **[pattern-based estimate]**, reconfirm against Eurostat's release calendar each
  cycle; exact day shifts around weekends and (per Eurostat's HICP metadata, which
  flags the same January irregularity) the January release can run later than usual
  in some years for unrelated reweighting reasons — watch the January cycle
  specifically.
- Next open target as of 2026-09-01, both series: **2026-08**, expected release
  **~2026-10-01/02**.

### 2.3 `lu-debt` — Luxembourg quarterly general-government gross debt

- Dataset: `gov_10q_ggdebt`, dims `sector=S13, na_item=GD, unit=MIO_EUR, geo=LU`
  (verified live, unchanged from the original brief)
- Release rhythm: Eurostat metadata / third-party mirrors of the release calendar
  put quarterly government debt at roughly **t+113 days** after quarter-end.
  **Verified live** for this runbook: Q1‑2026 (ends Mar 31) appeared in the API with
  `updated: 2026-07-21` — **112 days** after quarter-end, matching. This is the
  flagship "Luxembourg's Scissors" series and the slowest-cadence one — only four
  cycles a year.
- Next open target as of 2026-09-01: **2026-Q2** (ends 2026-06-30; the API's latest
  point is still 2026-Q1), expected release ≈ **2026-10-20**
  **[ASSUMED, ~112–113-day historical lag — Eurostat does not publish a long-range
  fixed calendar for this table the way it does for HICP/unemployment; reconfirm
  nearer the date]**.

### 2.4 What's due right now (bootstrap example, computed 2026-09-01)

| series | next target | context cutoff available today | expected release | register-by (this runbook's safety margin) |
|---|---|---|---|---|
| ea-hicp | 2026-09 | through 2026-08 (published today) | ~2026-10-02 | 2026-09-25 |
| lu-unemp | 2026-08 | through 2026-07 (published today) | ~2026-10-01/02 | 2026-09-25 |
| ea-unemp | 2026-08 | through 2026-07 (published today) | ~2026-10-01/02 | 2026-09-25 |
| lu-debt | 2026-Q2 | through 2026-Q1 (published Jul 21) | ~2026-10-20 | 2026-10-10 |

All four have context data available *today* — nothing blocks registering all four
in one sitting right now, well ahead of every deadline.

### 2.5 The monthly loop, steady state (~15 min once the backlog above is cleared)

Because you register one period ahead and score one period behind, in steady state
every monthly sitting does both halves at once for the monthly series, and the
quarterly series only has something to do one sitting in four:

1. `score` — grades every open registration whose release date has passed and whose
   data is now fetchable (writes `outcomes/<id>.json`, or marks `UNEVALUABLE` per §4).
2. `register --series all` — registers the following period for every series whose
   new observation has been published; SKIPs the rest. This is what keeps you always ~1 release-cycle ahead of every deadline.
3. `compile`, `node src/build.js`, review, commit, push — as in §1.

### 2.6 Re-verifying the live API yourself

The exact commands used to produce every fact in §2.1–2.3 (run from anywhere with
network access, no venv needed — plain `urllib`, since `curl` is broken at the
socket level on this Mac):

```
python3 - <<'EOF'
import urllib.request, json
def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "curl/8.0"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read())
base = "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/"
j = get(base + "prc_hicp_minr?format=JSON&lang=EN&coicop18=TOTAL&unit=RCH_A&geo=EA21&lastTimePeriod=3")
print("ea-hicp latest:", j["dimension"]["time"]["category"]["label"], j["updated"])
j = get(base + "une_rt_m?format=JSON&lang=EN&geo=LU&s_adj=SA&age=TOTAL&sex=T&unit=PC_ACT&lastTimePeriod=3")
print("lu-unemp latest:", j["dimension"]["time"]["category"]["label"], j["updated"])
j = get(base + "une_rt_m?format=JSON&lang=EN&geo=EA21&s_adj=SA&age=TOTAL&sex=T&unit=PC_ACT&lastTimePeriod=3")
print("ea-unemp latest:", j["dimension"]["time"]["category"]["label"], j["updated"])
j = get(base + "gov_10q_ggdebt?format=JSON&lang=EN&geo=LU&sector=S13&na_item=GD&unit=MIO_EUR&lastTimePeriod=3")
print("lu-debt latest:", j["dimension"]["time"]["category"]["label"], j["updated"])
EOF
```

Run this before every `register` — the "latest" period it prints tells you the
`target.period` to register (one after the latest shown) and the `data_cutoff` to
record in the registration's `engine` block.

---

## 3. Exact commands, every step

### 3.1 One-time setup (do this before the very first cycle)

The venv already exists on this Mac (`pipeline/.venv`, Python 3.12, `timesfm` 3.0.0
+ `torch` 2.13.0 + `huggingface_hub` + `numpy` installed). If it ever needs rebuilding:

```
cd "/Users/jeromeverony/Documents/Claude Code projects/Exploration/ledger/pipeline"
python3 -m venv .venv
source .venv/bin/activate
pip install timesfm torch huggingface_hub numpy
```

**Before the first `register` ever runs**, add the checkpoint assertion from §0
point 3 to the pipeline's forecast call, and confirm it with:

```
python -c "import timesfm; print(timesfm.__version__)"   # sanity: package importable
```

**Before the first `git push` ever happens**, §4 below is not optional — the ledger
directory is not in any git repository yet. Do that first.

### 3.2 Pipeline subcommands (`pipeline/ledger_pipeline.py`)

As of this writing `pipeline/` holds only the venv and a set of test fixtures
(`pipeline/fixtures/good/`, `pipeline/fixtures/corrupted/` — a compiled
`ledger.json`, sample `registrations/`, `outcomes/`, `corrections/` for a demo
`demo-cpi` series) — the CLI script itself has not been written yet by whichever
build step owns `pipeline/`. The five subcommands below are the operator-facing
contract that script must expose; the fixture layout already matches this contract
(`registrations/<id>.json`, `outcomes/<id>.json`, `corrections/<n>.json`, a compiled
top-level `ledger.json`), so treat this as settled, not provisional. If the actual
filename ends up different from `ledger_pipeline.py`, substitute it — the
subcommands and arguments are what matters.

```
# activate first, every session:
cd "/Users/jeromeverony/Documents/Claude Code projects/Exploration/ledger/pipeline"
source .venv/bin/activate

# 1. register — fetch context, run TimesFM 2.5 + naive + rw-drift baselines,
#    write an immutable, hash-stamped registrations/<id>.json. Refuses to run if
#    <id> already exists (fcreg immutability) or if data for <target> already
#    exists (you'd be registering with foresight — the whole point is you can't).
python ledger_pipeline.py register --series ea-hicp
python ledger_pipeline.py register --series lu-unemp
python ledger_pipeline.py register --series ea-unemp
python ledger_pipeline.py register --series lu-debt

# 2. score — for one id or --all: if today >= release.expected, try to fetch the
#    outturn; if found, compute the verdict + metrics (SCORING MATH in the main
#    spec) and write outcomes/<id>.json; if not yet released, do nothing and say
#    so; if release.expected + grace_days has passed with nothing fetchable, mark
#    UNEVALUABLE:late.
python ledger_pipeline.py score --id ea-hicp--2026-08--r1
python ledger_pipeline.py score

# 3. compile — read every registrations/*.json + outcomes/*.json + corrections/*.json,
#    write the single summary data/registry/ledger.json (counts, coverage, pinball,
#    accuracy, by_series) that src/build.js embeds into the page.
python ledger_pipeline.py compile

# 4. verify — the house-doctrine "independent reference check": recompute every
#    registration's sha256 and every outcome's metrics via a code path separate
#    from ledger.js (i.e. this python implementation, not a call into node), diff
#    against the stored files, exit non-zero on any mismatch. Run this before every
#    commit, not just when something looks wrong.
python ledger_pipeline.py verify

# 5. correct — append a new, numbered, dated correction. Never edit an existing
#    corrections/<n>.json file to fix it; append a new one that says what was wrong.
python ledger_pipeline.py correct --about ea-hicp--2026-08--r1 \
  --note "Eurostat revised the Aug-2026 EA21 HICP figure on 2026-11-03 from 2.4 to 2.5; \
verdict SCORED stands per vintage_policy, noted here for the record."
```

### 3.3 Rebuild the page

```
cd "/Users/jeromeverony/Documents/Claude Code projects/Exploration/ledger"
node src/build.js
```

Matches the phantom convention exactly (`phantom/src/build.js`): concatenates
`chassis.css` + page CSS from `src/body.html` + the DOM from `src/body.html` +
`ledger.js` (the kernel) + `chassis.js` + `app.js` into `index.html`, a
self-contained fragment (no `<html>/<head>/<body>` — the site's
`sync-content.mjs` wraps it, same as every other instrument). `app.js` is
responsible for embedding the compiled registry data (§3.2 step 3's
`data/registry/ledger.json` plus the raw `registrations/outcomes/corrections`) into
the page so `ledger.js`'s `aggregate()` and `verifyRegistrationHash()` can run
**live, in the browser** against the exact files just committed — this is why
`compile` must run before `node src/build.js`, and both must run before you commit.

### 3.4 Run the kernel's own tests

```
cd "/Users/jeromeverony/Documents/Claude Code projects/Exploration/ledger/src"
node ledger.test.js
```

### 3.5 The site sync step — documented here, DO NOT RUN IT as part of this runbook

```
cd "/Users/jeromeverony/Documents/Claude Code projects/Exploration/site"
node scripts/sync-content.mjs
```

This copies the built `ledger/index.html` fragment into
`site/public/instruments/ledger/index.html` (wrapped with the theme-sync snippet
and the "Iterative Intelligence" badge, same as the other seven). It is a **site**
repo operation with its own commit/push, on its own schedule (whenever the site
gets redeployed) — decoupled from the precedence-critical `ledger/` push in §4.
Running it is out of scope for this runbook per the standing instruction not to
touch anything under `Exploration/site`; §6 documents exactly what it needs once
`ledger` is ready to go live on the site.

---

## 4. The precedence contract

A pre-registered forecast only counts as pre-registered if there is a public,
independently-checkable timestamp proving it existed before the target data did.
That proof is `git commit` + `git push` to a public remote — **not** the file's
`created_utc` field (a JSON field is just a claim; a comment on a hosted git
provider's server, or an admittedly ignorable git-authorship spoof, are cheaper
to fake than a repository's own append-only commit graph on a server you don't
control).

**Current state: since 2026-09-02 `ledger/` IS a git repository with a public remote,
`github.com/MagicBundle/ledger` (first push 2026-09-02T05:37Z, ahead of every release
below). The one-time setup that follows is therefore done; it stays here as the record.**

**As originally found, 2026-09-01: `ledger/` was not inside any git repository.**
`Exploration/` (the parent) is not a repo either — only its `site/` subdirectory is
(pushing to `github.com/MagicBundle/iterativeintelligence`, and CLAUDE.md forbids
touching that directory). Before the precedence contract means anything, `ledger/`
needs its own repository with a public remote. This runbook documents that as a
required one-time setup step for you, the operator, to do by hand (this build agent
does not run git commands, per its own standing instructions):

1. `git init` inside `ledger/` (or fold `ledger/` into some other repo you already
   control — either way, it must be a real repo with real history from day one;
   don't back-date anything).
2. Add `pipeline/.venv/`, `pipeline/__pycache__/`, `*.pyc` to `.gitignore` at the
   repo root (the `pipeline/.gitignore` already covers this for that subdirectory;
   confirm it's honored, or add a root one — a venv should never enter the commit
   history).
3. Create a public remote (a public GitHub repo is the natural choice, matching how
   `site/` already works) and push an initial commit before registering anything
   for real. An empty scoreboard with a real, timestamped, public commit is exactly
   the deliberate "precedence before performance" state the house doctrine wants —
   don't wait for the first registration to do this.
4. Only after that remote exists and the first push has landed does the deadline
   rule in §1/§2.4 mean anything. Until then, nothing you register is provable
   pre-registration — it is a private file with a timestamp you could have edited.

**Deadline per series, each cycle:** `git push` must complete before the release
date-time in §2 — not "sometime that day." Releases land at a fixed clock time
(11:00 CEST for the Sep-1-2026 releases observed while writing this), so "the same
calendar day" is not early enough if you're not certain you'll push before 11:00.
Use the register-by dates in §2.4 (days of margin, not hours) as your actual
personal deadline, not the release date itself.

---

## 5. Failure modes — the honest response

| situation | what you do | what you do NOT do |
|---|---|---|
| You missed a monthly cycle entirely — a target period's release date has come and gone with no registration on file for it | Nothing. That period simply has no Ledger forecast. Move on to the next open target next cycle. | Never register it retroactively, even flagged somehow as "late" — a forecast made after the outcome is knowable is not a forecast. No backfill, ever. |
| A release comes in later than `expected + grace_days` (30 days) | Run `score`; it writes `outcomes/<id>.json` with `"verdict": "UNEVALUABLE", "reason": "late"`. This is terminal — that id can never later become SCORED even if the data shows up the next day. | Don't re-run `score` hoping for a different verdict once UNEVALUABLE is written; don't quietly drop the id from the compiled ledger — it counts in the UNEVALUABLE tally, publicly. |
| Eurostat changes a dataset's definition, discontinues a table, or swaps a code (as already happened once here — §0.1) mid-cycle, before a registered forecast's target period is scoreable | Mark it `UNEVALUABLE`, `reason: "definition_changed"` (or `"discontinued"` if the table is gone outright), then run `correct` to append a dated note explaining exactly what changed and citing the source (the way §0 does above). | Don't retarget the existing registration to the new dataset/definition — that registration was made against a specific, named source; it either scores against that source or goes UNEVALUABLE. A *new* registration against the new dataset is a separate id. |
| A value gets revised by Eurostat after it has already been scored | The verdict stands, unchanged, forever — `vintage_policy` exists exactly so a later revision can't retroactively flip a SCORED verdict. Run `correct` to append a dated note recording the revision (old value, new value, date), for the record. | Never edit `outcomes/<id>.json` in place. Never re-run `score` on an id that already has an outcome file. |
| The pipeline's `verify` step (§3.2) finds a hash or metric mismatch | Stop. Do not compile, build, or push. Figure out whether a file was hand-edited, a bug is in the scoring code, or the registry directory got corrupted, and fix the root cause before continuing. | Never "fix" a mismatch by changing the stored `sha256` or `metrics` to match what verify computed, or vice versa, without understanding which one is actually wrong — that's editing history, which the whole design exists to prevent. |

---

## 6. Site wiring — documented for the operator, not performed here

> **Done 2026-09-02.** Both edits below are in place; the card sits under a new
> `precedence` cluster ("Before the fact") with the gold `--mark` hue, and the homepage
> suite cycler gained a Ledger miniature. Kept for the record.

Two edits, in the `site` repo, done by hand when `ledger` is ready to go live (this
build agent does not touch anything under `Exploration/site`):

### 6.1 `site/scripts/sync-content.mjs`, line 103

```js
const instruments = ['repulsion', 'arctic', 'fever', 'sunflower', 'flash', 'branch', 'phantom'];
```
becomes
```js
const instruments = ['repulsion', 'arctic', 'fever', 'sunflower', 'flash', 'branch', 'phantom', 'ledger'];
```
This is purely mechanical — it makes `sync-content.mjs` copy
`Exploration/ledger/index.html` into `site/public/instruments/ledger/index.html`,
wrapped exactly like the other seven (viewport meta, theme-sync snippet, the
"Iterative Intelligence" badge — see the `wrapFragment`/`copyWithViewport` logic
already in that file). No other change to that script is needed; ledger's
`index.html` just needs to already be a valid artifact-body fragment (it will be,
built the way §3.3 describes).

### 6.2 `site/src/data/instruments.js` — the card

The gallery at `/instruments/` (`site/src/pages/instruments/index.astro`) reads
this array, grouped by `cluster`. Each of the current seven entries looks like:

```js
{
  slug: 'phantom',
  title: 'Phantom',
  domain: 'complex systems',
  cluster: 'universality',
  hue: 'var(--s1)',
  thesis: 'Traffic jams with no cause.',
  desc: 'A ring-road exclusion process whose jam edge fluctuates by the Tracy–Widom law — the primes’ symmetry class, met again at the edge.',
},
```

Ledger needs an entry in the same shape, e.g.:

```js
{
  slug: 'ledger',
  title: 'Ledger',
  domain: 'forecasting',
  cluster: '???',                 // see note below — operator decision
  hue: 'var(--exact)',            // or var(--numerical) — no card currently uses either; see note
  thesis: 'The forecast that grades itself.',
  desc: 'Decile forecasts pre-registered, hash-stamped, and committed before the data exists — then graded in public when it arrives. No backtests: the scoreboard starts empty on purpose.',
},
```

**Two things flagged for you to decide, not decided here:**

- **`cluster`.** The three existing clusters (`universality`, `order from
  randomness`, `criticality`) are each built around "one genuinely surprising, true
  fact," and `phantom`'s own README calls it out explicitly: "Completes the suite" —
  seven pieces, deliberately closed. Ledger isn't a closed-form fact demonstrated
  once; it's an open-ended, ongoing empirical record that changes every month. It
  doesn't obviously belong in any of the three existing clusters, and shoehorning it
  into one for the sake of not adding a fourth would misdescribe it. A fourth
  cluster (something like "evidence over time," or "precedence") is the more honest
  fit, but that's a copy/curation call for you, not a mechanical one — this runbook
  flags it rather than picks it.
- **`hue`.** Four accent variables exist (`--s1`..`--s4`, defined in
  `site/src/styles/site.css`); all four are already used at least once (`--s1` is
  deliberately reused for `repulsion`+`phantom` to signal the same symmetry class —
  see the `universalityNote` in `instruments/index.astro`). `--live` and `--play`
  are also already claimed. `--exact` and `--numerical` exist as tag-pill colors
  (used in the "every value is tagged" legend) but no card currently uses either as
  its `hue` — either is available, or add a fifth `--s5` to `site.css`'s three theme
  blocks (light default, dark, `[data-theme="dark"]` — see how `--s1`..`--s4` are
  each defined three times there) if a genuinely new color is wanted.

### 6.3 Review before push

Whatever the final edits, the same rule as every other cycle in this runbook
applies: build `ledger/index.html` and open it locally first (§1), and once synced,
open the site's local dev build of `/instruments/ledger/` and `/instruments/` (the
gallery) before committing anything in the `site` repo. Nothing here is pushed sight
unseen.

---

## 7. Automation — the cycle runs itself (installed 2026-09-02)

`pipeline/cycle.sh` is the whole monthly card as one idempotent script: `score`,
then `register --series all` (SKIP is normal — a new registration is minted only on
the first run after a series' next observation is published; the pipeline refuses
to re-register a target that already has an `r1` unless `--allow-rerun` is passed
deliberately), and if the registry changed: `compile`, `node src/build.js`,
`reference_check.py` (must PASS), `ledger.test.js` (must pass), commit + push this
repository, then sync ONLY the Ledger page into the site repository
(`SYNC_ONLY=ledger`) and push that. Nothing is pushed if verification fails. Every
run writes `pipeline/logs/status.json` and a dated `pipeline/logs/cycle-YYYY-MM-DD.log`;
a failure also writes `pipeline/logs/LAST-FAILURE` and posts a macOS notification.
`CYCLE_DRY=1` runs everything except commit/push. The model runs offline
(`HF_HUB_OFFLINE=1`) from the cached 2.5 checkpoint — an unattended run can never
pull different weights. Run it by hand at any time: `bash pipeline/cycle.sh`.

Two schedulers drive it, so that a single failure is visible rather than silent:

**Primary — the `ledger-daily` scheduled task in the Claude Code app, 07:45 every
day.** It runs `bash pipeline/cycle.sh` and reports in two or three lines. It runs
while the app is open; a slot missed while the app was closed runs at the next
launch. Because registering happens on the first day the data is available (about a
month before that target's own release), a missed day or two never threatens a
deadline — only the app staying closed for weeks would.

**Watchdog — the `ledger-watchdog` scheduled task, Mondays and Thursdays 09:00.**
Reads `status.json`, re-runs the cycle if it is stale (>3 days) or failed for a
transient reason, checks the invariant that every series has at least one OPEN
registration, checks both repositories are fully pushed (a plain `git push` if
not), and lists open registrations whose release is within 7 days. It never edits
the registry by hand and never force-pushes.

**Why not launchd/cron.** `pipeline/io.iterativeintelligence.ledger.plist` is a
working launchd definition for the same 07:45 run, and it was installed and tested
on 2026-09-02 — macOS refused it: a launchd-spawned `/bin/bash` may not read
`~/Documents` ("Operation not permitted", the Files-and-Folders privacy control)
unless `/bin/bash` is granted Full Disk Access in System Settings → Privacy &
Security. That is a system security setting and a broad grant, so it was not made.
If you ever want a scheduler independent of the Claude app, grant it yourself and
reinstall the job:

```
cp pipeline/io.iterativeintelligence.ledger.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/io.iterativeintelligence.ledger.plist
```

The scheduled tasks and the plist all run the same script, so nothing else changes.
