#!/usr/bin/env python3
"""Ledger — the offline registration/scoring pipeline.

Iterative Intelligence instrument #8. Pre-registers h=1 decile forecasts for a
fixed set of Eurostat macro series as immutable, hash-stamped JSON files
*before* the target-period data exists, then grades them in public once the
data arrives. No backtests: pretraining contamination makes a backtest of a
foundation-model forecaster inadmissible as forward-skill evidence, so the
scoreboard launches empty on purpose.

Subcommands
-----------
    fetch <slug>            pull one series from Eurostat, cache it
    register [--series ...] compute h=1 decile forecasts + baselines, write
                             immutable registration JSON(s)
    score [--now ISO]       grade any open, due registrations
    compile                 rebuild the compiled data/registry/ledger.json

Everything here is CPU-only, hand-run, no servers/cron. Networking is plain
`requests` against the public Eurostat dissemination API (curl is broken at
the socket level on this Mac — do not shell out to it).
"""

from __future__ import annotations

import argparse
import calendar
import datetime as dt
import hashlib
import importlib.metadata
import json
import sys
import urllib.parse
from pathlib import Path
from typing import Any, Callable, Optional

import requests

# --------------------------------------------------------------------------
# Paths
# --------------------------------------------------------------------------

PIPELINE_DIR = Path(__file__).resolve().parent
LEDGER_ROOT = PIPELINE_DIR.parent
REGISTRY_DIR = LEDGER_ROOT / "data" / "registry"
CACHE_DIR = REGISTRY_DIR / "cache"
REGISTRATIONS_DIR = REGISTRY_DIR / "registrations"
OUTCOMES_DIR = REGISTRY_DIR / "outcomes"
CORRECTIONS_DIR = REGISTRY_DIR / "corrections"
COMPILED_PATH = REGISTRY_DIR / "ledger.json"

EUROSTAT_BASE = "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data"

# TimesFM 2.x engine constants. NEVER swap this for a 3.0 checkpoint: 3.0
# pretrained weights ship under timesfm-non-commercial-license-v1.0, which
# forbids the commercial/production use this public page makes of them.
# 2.x checkpoints, up to and including 2.5, remain Apache-2.0.
TIMESFM_CHECKPOINT = "google/timesfm-2.5-200m-pytorch"
DECILES = ["0.1", "0.2", "0.3", "0.4", "0.5", "0.6", "0.7", "0.8", "0.9"]


class RegistrationExistsError(Exception):
  """Raised when a write would clobber an existing, immutable registration."""


class DatasetNotFoundError(Exception):
  """Raised when Eurostat 404s a dataflow — signals a possible discontinuation."""

  def __init__(self, url: str, body: str):
    super().__init__(f"404 for {url}: {body[:300]}")
    self.url = url
    self.body = body


# --------------------------------------------------------------------------
# Series registry (v1)
# --------------------------------------------------------------------------
#
# Every dataset code + dimension filter below was verified against the live
# Eurostat API on 2026-09-01. Two adaptations from the brief, both forced by
# what the live API actually returns (see notes):
#
#   - ea-hicp's brief candidate, `prc_hicp_manr` (coicop=CP00, unit=RCH_A), is
#     frozen: live query returns data only through 2025-12 (dataset "updated"
#     stamp 2026-02-06) — Eurostat cut this table over to the ECOICOP ver.2
#     classification in 2026 and stopped feeding it. Its direct, currently-fed
#     successor is `prc_hicp_minr` (same concept — all-items annual rate of
#     change — under the new classification, all-items code `coicop18=TOTAL`
#     instead of `coicop=CP00`), live through 2026-08 on the same fetch. No
#     standalone Eurostat "flash HICP" dataflow exists in the current
#     catalogue at all (checked via the TOC on 2026-09-01: zero dataflows
#     match 'flash'+'hicp'); prc_hicp_minr is Eurostat's fastest-updating
#     all-items HICP rate release and stands in for the flash role — its
#     2026-08 reading was already present on the 2026-09-01 fetch.
#   - The euro-area aggregate geo code for `une_rt_m` (unemployment) returns
#     ZERO observations under `EA20` as of verification — a new member
#     state's 2026-01-01 euro adoption moved Eurostat's current live
#     euro-area labour-force aggregate to `EA21` ("Euro area – 21 countries,
#     from 2026"). `EA20` still carries data for HICP/debt tables, but for
#     consistency (and because it is the code that is actually live and
#     correct going forward) EA21 is used for both ea-hicp and ea-unemp.
#
# lu-debt matches the brief's dataset/dims exactly and needed no adaptation.

SERIES = {
  "ea-hicp": {
    "title": "Euro area HICP, all-items, annual rate of change",
    "dataset": "prc_hicp_minr",
    "dims": {"coicop18": "TOTAL", "unit": "RCH_A", "geo": "EA21"},
    "unit": "% (annual rate of change)",
    "freq": "M",
    "grace_days": 30,
    "flash_note": (
      "The brief's candidate prc_hicp_manr (coicop=CP00, unit=RCH_A) is "
      "frozen at 2025-12 as of verification (2026-09-01; dataset 'updated' "
      "stamp 2026-02-06) — Eurostat cut this table over to the ECOICOP "
      "ver.2 classification during 2026 and stopped feeding it. "
      "prc_hicp_minr (coicop18=TOTAL, unit=RCH_A) is its direct, "
      "currently-fed successor under the new classification and carries "
      "identical published figures for every overlapping month checked; "
      "it is used here as 'the regular monthly rate' per the brief's own "
      "fallback wording. No standalone Eurostat 'flash HICP' dataflow "
      "exists in the current catalogue (verified via the TOC, zero "
      "dataflows match 'flash'+'hicp'); prc_hicp_minr is Eurostat's "
      "fastest-updating all-items HICP rate release and functionally "
      "serves the flash role — its 2026-08 reading was already present "
      "on the 2026-09-01 fetch."
    ),
  },
  "lu-unemp": {
    "title": "Luxembourg unemployment rate, seasonally adjusted",
    "dataset": "une_rt_m",
    "dims": {"geo": "LU", "s_adj": "SA", "age": "TOTAL", "sex": "T", "unit": "PC_ACT"},
    "unit": "% of active population",
    "freq": "M",
    "grace_days": 30,
  },
  "ea-unemp": {
    "title": "Euro area unemployment rate, seasonally adjusted",
    "dataset": "une_rt_m",
    "dims": {"geo": "EA21", "s_adj": "SA", "age": "TOTAL", "sex": "T", "unit": "PC_ACT"},
    "unit": "% of active population",
    "freq": "M",
    "grace_days": 30,
    "flash_note": (
      "geo=EA20 returns zero observations for une_rt_m as of verification "
      "(2026-09-01) even though the dataset itself is populated. Eurostat's "
      "live euro-area labour-force aggregate now sits under EA21 ('Euro "
      "area – 21 countries, from 2026'), reflecting a member state's "
      "2026-01-01 euro adoption. EA21 used for the same reason as ea-hicp."
    ),
  },
  "lu-debt": {
    "title": "Luxembourg general government gross debt",
    "dataset": "gov_10q_ggdebt",
    "dims": {"geo": "LU", "sector": "S13", "na_item": "GD", "unit": "MIO_EUR"},
    "unit": "million EUR",
    "freq": "Q",
    "grace_days": 30,
  },
}


# --------------------------------------------------------------------------
# Small utilities
# --------------------------------------------------------------------------


def iso_now() -> str:
  return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def canonical_json_bytes(obj: Any) -> bytes:
  """Canonical form used for hashing: sorted keys, no whitespace.

  ensure_ascii=True is deliberate, not the incidental Python default: this is
  the byte string an in-browser verifier has to reproduce from the same JSON
  to get the same sha256, and JS's JSON.stringify does NOT \\uXXXX-escape
  non-ASCII text on its own — a browser-side canonicalizer has to add that
  escaping itself to match this. Every calendar_source note here may contain
  an em dash or similar, so this is a real, live cross-runtime contract, not
  a hypothetical: don't flip this to ensure_ascii=False without also fixing
  every non-Python verifier that re-derives these hashes.
  """
  return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


def compute_sha256(obj_without_hash: dict) -> str:
  return hashlib.sha256(canonical_json_bytes(obj_without_hash)).hexdigest()


def last_day_of_month(year: int, month: int) -> dt.date:
  return dt.date(year, month, calendar.monthrange(year, month)[1])


def last_day_of_quarter(year: int, quarter: int) -> dt.date:
  return last_day_of_month(year, quarter * 3)


def next_period_month(period: str) -> str:
  y, m = (int(x) for x in period.split("-"))
  m += 1
  if m == 13:
    m = 1
    y += 1
  return f"{y:04d}-{m:02d}"


def next_period_quarter(period: str) -> str:
  y, q = period.split("-Q")
  y, q = int(y), int(q)
  q += 1
  if q == 5:
    q = 1
    y += 1
  return f"{y:04d}-Q{q}"


def next_period(period: str, freq: str) -> str:
  if freq == "M":
    return next_period_month(period)
  if freq == "Q":
    return next_period_quarter(period)
  raise ValueError(f"unknown freq {freq!r}")


def expected_release_for_series(slug: str, target_period: str) -> tuple[str, str]:
  """Returns (expected_release_date_iso, calendar_source_note).

  These are stated assumptions grounded in what was actually observed on the
  live API at verification time (2026-09-01), not invented figures. The
  30-day grace window on every series absorbs the residual calendar
  uncertainty.
  """
  freq = SERIES[slug]["freq"]
  if slug == "ea-hicp":
    y, m = (int(x) for x in target_period.split("-"))
    release = last_day_of_month(y, m) + dt.timedelta(days=1)
    note = (
      "assumption: Eurostat's prc_hicp_minr HICP table posts a reference "
      "month's all-items annual rate on/around the first calendar day of "
      "the following month — empirically verified on 2026-09-01, when the "
      "2026-08 value was already present in a fresh fetch. grace_days=30 "
      "absorbs calendar drift (weekends, holidays, revisions to the "
      "release calendar)."
    )
    return release.isoformat(), note
  if freq == "M":  # lu-unemp, ea-unemp
    y, m = (int(x) for x in target_period.split("-"))
    release = last_day_of_month(y, m) + dt.timedelta(days=30)
    note = (
      "assumption: Eurostat publishes the euro-area/member-state "
      "unemployment rate approximately 30 calendar days after the "
      "reference month ends (Eurostat's own background-note convention "
      "for the une_rt_m release). grace_days=30 absorbs calendar drift."
    )
    return release.isoformat(), note
  if slug == "lu-debt":
    y, q = target_period.split("-Q")
    y, q = int(y), int(q)
    release = last_day_of_quarter(y, q) + dt.timedelta(days=112)
    note = (
      "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/gov_10q_ggdebt "
      "— empirically verified release lag: the 2026-Q1 observation carried "
      "a dataset 'updated' stamp of 2026-07-21, exactly 112 calendar days "
      "after the 2026-Q1 quarter-end (2026-03-31), matching Eurostat's "
      "documented T+112-day release convention for quarterly government "
      "debt. grace_days=30 absorbs calendar drift."
    )
    return release.isoformat(), note
  raise ValueError(f"no release-calendar rule for slug {slug!r}")


# --------------------------------------------------------------------------
# Eurostat fetch
# --------------------------------------------------------------------------


def eurostat_url(dataset: str, dims: dict) -> str:
  params = {"format": "JSON", "lang": "EN"}
  params.update(dims)
  qs = urllib.parse.urlencode(sorted(params.items()))
  return f"{EUROSTAT_BASE}/{dataset}?{qs}"


def fetch_eurostat(dataset: str, dims: dict, timeout: int = 30) -> tuple[list[tuple[str, float]], dict]:
  """Fetches one filtered Eurostat series.

  Returns (history, meta) where history is a chronologically sorted list of
  (period, value) with only the present (non-null) observations, and meta
  carries the exact URL used, the dataset's own 'label'/'updated' fields,
  and the fetch timestamp.
  """
  url = eurostat_url(dataset, dims)
  resp = requests.get(url, timeout=timeout)
  if resp.status_code == 404:
    raise DatasetNotFoundError(url, resp.text)
  resp.raise_for_status()
  payload = resp.json()

  time_index = payload["dimension"]["time"]["category"]["index"]
  index_to_period = {v: k for k, v in time_index.items()}
  values = payload.get("value", {})

  pairs = []
  for idx_str, v in values.items():
    idx = int(idx_str)
    pairs.append((idx, index_to_period[idx], float(v)))
  pairs.sort(key=lambda t: t[0])
  history = [(period, value) for _, period, value in pairs]

  dim_labels = {}
  for dim_name, dim_val in dims.items():
    try:
      dim_labels[dim_name] = payload["dimension"][dim_name]["category"]["label"].get(dim_val)
    except KeyError:
      dim_labels[dim_name] = None

  meta = {
    "source_url": url,
    "label": payload.get("label"),
    "updated": payload.get("updated"),
    "dim_labels": dim_labels,
    "fetched_utc": iso_now(),
  }
  return history, meta


# --------------------------------------------------------------------------
# TimesFM 2.x engine (lazy import — nothing above this needs torch)
# --------------------------------------------------------------------------

_MODEL_SINGLETON = None


def _get_timesfm_model():
  global _MODEL_SINGLETON
  if _MODEL_SINGLETON is None:
    import timesfm  # local import: keeps `fetch`/`score`/`compile` cheap

    _MODEL_SINGLETON = timesfm.TimesFM_2p5_200M_torch.from_pretrained(
      TIMESFM_CHECKPOINT, torch_compile=False
    )
  return _MODEL_SINGLETON


def timesfm_forecast_deciles(values: list[float]) -> dict[str, float]:
  """h=1 decile forecast for one series via TimesFM 2.5 (200M, CPU)."""
  import numpy as np
  import timesfm

  model = _get_timesfm_model()
  model.compile(
    timesfm.ForecastConfig(
      max_context=max(32, len(values)),
      max_horizon=128,
      normalize_inputs=True,
      use_continuous_quantile_head=True,
      force_flip_invariance=True,
      infer_is_positive=True,
      fix_quantile_crossing=True,
    )
  )
  _point, quantiles = model.forecast(horizon=1, inputs=[np.asarray(values, dtype=np.float32)])
  # quantiles: (1, 1, 10) — channel 0 is the mean, channels 1..9 are the
  # 0.1..0.9 deciles (per the model card's documented output layout).
  row = quantiles[0, 0]
  return {q: float(row[i + 1]) for i, q in enumerate(DECILES)}


def baseline_forecasts(values: list[float]) -> dict[str, dict[str, float]]:
  last = values[-1]
  diffs = [values[i] - values[i - 1] for i in range(1, len(values))]
  drift = sum(diffs) / len(diffs) if diffs else 0.0
  return {
    "naive": {"point": float(last)},
    "rw_drift": {"point": float(last + drift)},
  }


# --------------------------------------------------------------------------
# Registration
# --------------------------------------------------------------------------


def next_registration_id(slug: str, target_period: str, reg_dir: Path = REGISTRATIONS_DIR) -> str:
  n = 1
  while (reg_dir / f"{slug}--{target_period}--r{n}.json").exists():
    n += 1
  return f"{slug}--{target_period}--r{n}"


def write_registration(reg: dict, reg_dir: Path = REGISTRATIONS_DIR) -> Path:
  """Writes an immutable registration. Refuses to clobber an existing id."""
  reg_dir.mkdir(parents=True, exist_ok=True)
  path = reg_dir / f"{reg['id']}.json"
  if path.exists():
    raise RegistrationExistsError(f"registration {reg['id']} already exists at {path}")
  path.write_text(json.dumps(reg, indent=2, sort_keys=False) + "\n", encoding="utf-8")
  return path


def build_registration(
  slug: str,
  fetch_fn: Callable[[str, dict], tuple[list[tuple[str, float]], dict]] = fetch_eurostat,
  forecast_fn: Callable[[list[float]], dict[str, float]] = timesfm_forecast_deciles,
  reg_dir: Path = REGISTRATIONS_DIR,
  now: Optional[dt.datetime] = None,
  allow_rerun: bool = False,
) -> tuple[dict, list[tuple[str, float]], dict]:
  """Fetches the live history, forecasts h=1, and assembles a registration.

  Refuses — before any model call — if this (slug, target) is already
  registered, unless allow_rerun=True. Without this guard a repeated
  `register` (an unattended daily run, a retried shell command) would mint
  r2, r3, ... for the same target: duplicate forecasts, each a real hash-
  stamped commitment. Re-registration is a deliberate act (after a
  correction, say) and must be asked for explicitly with --allow-rerun.

  Returns (registration_dict, history, fetch_meta) — the caller is
  responsible for writing the registration and, if desired, a snapshot of
  the history for later vintage/definition-change checks at score time.
  """
  cfg = SERIES[slug]
  history, meta = fetch_fn(cfg["dataset"], cfg["dims"])
  if not history:
    raise ValueError(f"{slug}: fetch returned no observations")

  last_period, _ = history[-1]
  target_period = next_period(last_period, cfg["freq"])
  expected_iso, calendar_note = expected_release_for_series(slug, target_period)

  first = reg_dir / f"{slug}--{target_period}--r1.json"
  if first.exists() and not allow_rerun:
    raise RegistrationExistsError(
      f"{slug}: target {target_period} is already registered ({first.name}); "
      "nothing new to forecast until the next observation is published "
      "(pass --allow-rerun to deliberately mint another revision)"
    )
  reg_id = next_registration_id(slug, target_period, reg_dir=reg_dir)
  values = [v for _, v in history]

  deciles = forecast_fn(values)
  baselines = baseline_forecasts(values)

  engine_version = importlib.metadata.version("timesfm")

  body = {
    "fcreg": "0.1",
    "id": reg_id,
    "series": {
      "slug": slug,
      "title": cfg["title"],
      "dataset": cfg["dataset"],
      "dims": cfg["dims"],
      "unit": cfg["unit"],
      "source_url": meta["source_url"],
    },
    "target": {
      "period": target_period,
      "release": {
        "expected": expected_iso,
        "calendar_source": calendar_note,
        "grace_days": cfg["grace_days"],
      },
    },
    "vintage_policy": (
      "first-published value at first successful fetch on/after release "
      "date scores; later revisions never re-open a verdict"
    ),
    "engine": {
      "name": "timesfm",
      "version": engine_version,
      "checkpoint": TIMESFM_CHECKPOINT,
      "context_span": f"{history[0][0]}..{history[-1][0]}",
      "data_cutoff": last_period,
    },
    "forecast": {"deciles": deciles},
    "baselines": baselines,
    "created_utc": (now or dt.datetime.now(dt.timezone.utc)).isoformat(timespec="seconds").replace("+00:00", "Z"),
  }
  body["sha256"] = compute_sha256(body)
  return body, history, meta


def cmd_register(args: argparse.Namespace) -> int:
  if args.series == "all":
    slugs = list(SERIES.keys())
  else:
    slugs = [s.strip() for s in args.series.split(",") if s.strip()]

  ok = 0
  for slug in slugs:
    if slug not in SERIES:
      print(f"[register] SKIP {slug}: unknown series slug", file=sys.stderr)
      continue
    try:
      reg, history, meta = build_registration(slug, allow_rerun=bool(getattr(args, 'allow_rerun', False)))
      path = write_registration(reg)
      # Internal (non-schema) snapshot used later by `score` for
      # vintage-conflict / definition-change checks. Not part of fcreg.
      snap_path = CACHE_DIR / f"{reg['id']}.snapshot.json"
      CACHE_DIR.mkdir(parents=True, exist_ok=True)
      snap_path.write_text(
        json.dumps(
          {
            "id": reg["id"],
            "history": [{"period": p, "value": v} for p, v in history],
            "meta": meta,
          },
          indent=2,
        )
        + "\n",
        encoding="utf-8",
      )
      # Also refresh the plain fetch cache for this slug.
      write_fetch_cache(slug, history, meta)

      deciles = reg["forecast"]["deciles"]
      print(f"[register] {reg['id']}")
      print(f"           target period   : {reg['target']['period']}")
      print(f"           expected release: {reg['target']['release']['expected']} (grace {reg['target']['release']['grace_days']}d)")
      print(f"           data cutoff     : {reg['engine']['data_cutoff']}  (context {reg['engine']['context_span']})")
      print(
        "           deciles         : "
        + ", ".join(f"{q}={deciles[q]:.3f}" for q in DECILES)
      )
      print(
        f"           baselines       : naive={reg['baselines']['naive']['point']:.3f}"
        f"  rw_drift={reg['baselines']['rw_drift']['point']:.3f}"
      )
      print(f"           written         : {path}")
      ok += 1
    except RegistrationExistsError as e:
      print(f"[register] SKIP {slug}: {e}", file=sys.stderr)
    except (DatasetNotFoundError, requests.RequestException, ValueError) as e:
      print(f"[register] FAIL {slug}: {e}", file=sys.stderr)
  print(f"[register] {ok}/{len(slugs)} series registered")
  return 0 if ok == len(slugs) else 1


# --------------------------------------------------------------------------
# fetch (standalone cache refresh)
# --------------------------------------------------------------------------


def write_fetch_cache(slug: str, history: list[tuple[str, float]], meta: dict, cache_dir: Path = CACHE_DIR) -> Path:
  cache_dir.mkdir(parents=True, exist_ok=True)
  cfg = SERIES[slug]
  path = cache_dir / f"{slug}.json"
  payload = {
    "slug": slug,
    "dataset": cfg["dataset"],
    "dims": cfg["dims"],
    **meta,
    "series": [{"period": p, "value": v} for p, v in history],
  }
  path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
  return path


def cmd_fetch(args: argparse.Namespace) -> int:
  slug = args.slug
  if slug not in SERIES:
    print(f"[fetch] unknown series slug {slug!r}; known: {', '.join(SERIES)}", file=sys.stderr)
    return 1
  cfg = SERIES[slug]
  try:
    history, meta = fetch_eurostat(cfg["dataset"], cfg["dims"])
  except (DatasetNotFoundError, requests.RequestException) as e:
    print(f"[fetch] FAIL {slug}: {e}", file=sys.stderr)
    return 1
  path = write_fetch_cache(slug, history, meta)
  last_period, last_value = history[-1]
  print(f"[fetch] {slug}: {len(history)} observations, last={last_period}={last_value}")
  print(f"        source: {meta['source_url']}")
  print(f"        cached: {path}")
  return 0


# --------------------------------------------------------------------------
# Scoring
# --------------------------------------------------------------------------


def pinball_loss(y: float, f: float, q: float) -> float:
  if y >= f:
    return (y - f) * q
  return (f - y) * (1 - q)


def score_metrics(y: float, deciles: dict[str, float], naive_point: float, rw_drift_point: float) -> dict:
  pinball_by_decile = {q: pinball_loss(y, deciles[q], float(q)) for q in DECILES}
  pinball_mean = sum(pinball_by_decile.values()) / len(pinball_by_decile)
  return {
    "pinball_mean": pinball_mean,
    "pinball_by_decile": pinball_by_decile,
    "interval80_hit": deciles["0.1"] <= y <= deciles["0.9"],
    "abs_err_median": abs(y - deciles["0.5"]),
    "naive_abs_err": abs(y - naive_point),
    "rw_drift_abs_err": abs(y - rw_drift_point),
  }


def _load_snapshot(reg_id: str, snapshot_dir: Path = CACHE_DIR) -> Optional[dict]:
  path = snapshot_dir / f"{reg_id}.snapshot.json"
  if not path.exists():
    return None
  return json.loads(path.read_text(encoding="utf-8"))


def score_one(
  reg: dict,
  now: dt.datetime,
  fetch_fn: Callable[[str, dict], tuple[list[tuple[str, float]], dict]] = fetch_eurostat,
  snapshot_dir: Path = CACHE_DIR,
) -> Optional[dict]:
  """Grades one registration. Returns an outcome dict, or None if still open
  (not due, or due-but-within-grace with no data yet).
  """
  target_period = reg["target"]["period"]
  expected = dt.date.fromisoformat(reg["target"]["release"]["expected"])
  grace_days = reg["target"]["release"]["grace_days"]
  now_date = now.date() if isinstance(now, dt.datetime) else now

  if now_date < expected:
    return None  # not due yet — stays open

  try:
    history, meta = fetch_fn(reg["series"]["dataset"], reg["series"]["dims"])
  except DatasetNotFoundError:
    return {
      "id": reg["id"],
      "verdict": "UNEVALUABLE",
      "reason": "discontinued",
      "outturn": None,
      "metrics": None,
      "scored_utc": iso_now(),
    }

  by_period = dict(history)
  value = by_period.get(target_period)

  if value is None:
    if now_date >= expected + dt.timedelta(days=grace_days):
      return {
        "id": reg["id"],
        "verdict": "UNEVALUABLE",
        "reason": "late",
        "outturn": None,
        "metrics": None,
        "scored_utc": iso_now(),
      }
    return None  # due, but still inside the grace window — stays open

  # A value now exists for the target period. Check for a vintage conflict:
  # did the registration-time snapshot already carry a (necessarily
  # preliminary) reading for this same period that disagrees with the one
  # we see now? That would mean the "unpublished target period" premise was
  # already broken at registration time.
  snapshot = _load_snapshot(reg["id"], snapshot_dir=snapshot_dir)
  if snapshot is not None:
    snap_by_period = {row["period"]: row["value"] for row in snapshot["history"]}
    if target_period in snap_by_period and snap_by_period[target_period] != value:
      return {
        "id": reg["id"],
        "verdict": "UNEVALUABLE",
        "reason": "vintage_conflict",
        "outturn": {
          "value": value,
          "fetched_utc": meta["fetched_utc"],
          "vintage_note": (
            f"target period {target_period} already carried a value "
            f"({snap_by_period[target_period]}) in the registration-time "
            f"snapshot, which conflicts with the value seen now ({value})"
          ),
        },
        "metrics": None,
        "scored_utc": iso_now(),
      }
    # definition-change check: unit label on the pinned dims drifted.
    old_labels = snapshot.get("meta", {}).get("dim_labels", {})
    new_labels = meta.get("dim_labels", {})
    if old_labels and new_labels and old_labels != new_labels:
      return {
        "id": reg["id"],
        "verdict": "UNEVALUABLE",
        "reason": "definition_changed",
        "outturn": {
          "value": value,
          "fetched_utc": meta["fetched_utc"],
          "vintage_note": f"dimension labels changed since registration: {old_labels} -> {new_labels}",
        },
        "metrics": None,
        "scored_utc": iso_now(),
      }

  metrics = score_metrics(
    value,
    reg["forecast"]["deciles"],
    reg["baselines"]["naive"]["point"],
    reg["baselines"]["rw_drift"]["point"],
  )
  return {
    "id": reg["id"],
    "verdict": "SCORED",
    "reason": None,
    "outturn": {
      "value": value,
      "fetched_utc": meta["fetched_utc"],
      "vintage_note": "first-published value at first successful fetch on/after release date",
    },
    "metrics": metrics,
    "scored_utc": iso_now(),
  }


def write_outcome(outcome: dict, out_dir: Path = OUTCOMES_DIR) -> Path:
  out_dir.mkdir(parents=True, exist_ok=True)
  path = out_dir / f"{outcome['id']}.json"
  if path.exists():
    raise RegistrationExistsError(f"outcome for {outcome['id']} already exists at {path} (terminal, never re-scored)")
  path.write_text(json.dumps(outcome, indent=2, sort_keys=False) + "\n", encoding="utf-8")
  return path


def cmd_score(args: argparse.Namespace) -> int:
  now = dt.datetime.fromisoformat(args.now) if args.now else dt.datetime.now(dt.timezone.utc)
  n_scored = n_unevaluable = n_still_open = n_errors = 0
  for reg_path in sorted(REGISTRATIONS_DIR.glob("*.json")):
    reg = json.loads(reg_path.read_text(encoding="utf-8"))
    out_path = OUTCOMES_DIR / f"{reg['id']}.json"
    if out_path.exists():
      continue  # terminal verdict already recorded — never revisit
    try:
      outcome = score_one(reg, now=now)
    except requests.RequestException as e:
      print(f"[score] FAIL {reg['id']}: {e}", file=sys.stderr)
      n_errors += 1
      continue
    if outcome is None:
      n_still_open += 1
      continue
    write_outcome(outcome)
    if outcome["verdict"] == "SCORED":
      n_scored += 1
      m = outcome["metrics"]
      print(f"[score] {reg['id']}: SCORED  pinball_mean={m['pinball_mean']:.4f}  interval80_hit={m['interval80_hit']}")
    else:
      n_unevaluable += 1
      print(f"[score] {reg['id']}: UNEVALUABLE ({outcome['reason']})")
  print(f"[score] scored={n_scored} unevaluable={n_unevaluable} still_open={n_still_open} errors={n_errors}")
  return 0 if n_errors == 0 else 1


# --------------------------------------------------------------------------
# Compile
# --------------------------------------------------------------------------


def compile_ledger(
  reg_dir: Path = REGISTRATIONS_DIR,
  out_dir: Path = OUTCOMES_DIR,
  corr_dir: Path = CORRECTIONS_DIR,
  output_path: Path = COMPILED_PATH,
  now: Optional[dt.datetime] = None,
) -> dict:
  registrations = [json.loads(p.read_text(encoding="utf-8")) for p in sorted(reg_dir.glob("*.json"))]
  outcomes = [json.loads(p.read_text(encoding="utf-8")) for p in sorted(out_dir.glob("*.json"))]
  corrections = [json.loads(p.read_text(encoding="utf-8")) for p in sorted(corr_dir.glob("*.json"))] if corr_dir.exists() else []

  outcomes_by_id = {o["id"]: o for o in outcomes}
  scored = [o for o in outcomes if o["verdict"] == "SCORED"]
  unevaluable = [o for o in outcomes if o["verdict"] == "UNEVALUABLE"]
  n_open = sum(1 for r in registrations if r["id"] not in outcomes_by_id)

  if scored:
    hits = sum(1 for o in scored if o["metrics"]["interval80_hit"])
    coverage_empirical = hits / len(scored)
  else:
    coverage_empirical = None

  pinball_sums: dict[str, list[float]] = {}
  reg_by_id = {r["id"]: r for r in registrations}
  for o in scored:
    slug = reg_by_id[o["id"]]["series"]["slug"]
    pinball_sums.setdefault(slug, []).append(o["metrics"]["pinball_mean"])
  mean_pinball_by_series = {slug: sum(vals) / len(vals) for slug, vals in pinball_sums.items()}

  ledger = {
    "generated_utc": (now or dt.datetime.now(dt.timezone.utc)).isoformat(timespec="seconds").replace("+00:00", "Z"),
    "registrations": registrations,
    "outcomes": outcomes,
    "corrections": corrections,
    "stats": {
      "n_open": n_open,
      "n_scored": len(scored),
      "n_unevaluable": len(unevaluable),
      "coverage80": {"empirical": coverage_empirical, "nominal": 0.80},
      "mean_pinball_by_series": mean_pinball_by_series,
    },
  }
  output_path.parent.mkdir(parents=True, exist_ok=True)
  output_path.write_text(json.dumps(ledger, indent=2, sort_keys=False) + "\n", encoding="utf-8")
  return ledger


def cmd_compile(args: argparse.Namespace) -> int:
  ledger = compile_ledger()
  s = ledger["stats"]
  print(f"[compile] wrote {COMPILED_PATH}")
  print(f"          n_open={s['n_open']} n_scored={s['n_scored']} n_unevaluable={s['n_unevaluable']}")
  print(f"          coverage80 empirical={s['coverage80']['empirical']} nominal={s['coverage80']['nominal']}")
  print(f"          mean_pinball_by_series={s['mean_pinball_by_series']}")
  return 0


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------


def main(argv: Optional[list[str]] = None) -> int:
  parser = argparse.ArgumentParser(description="Ledger registration/scoring pipeline")
  sub = parser.add_subparsers(dest="command", required=True)

  p_fetch = sub.add_parser("fetch", help="pull one series from Eurostat and cache it")
  p_fetch.add_argument("slug", choices=sorted(SERIES.keys()))
  p_fetch.set_defaults(func=cmd_fetch)

  p_register = sub.add_parser("register", help="compute + write immutable registrations")
  p_register.add_argument("--series", default="all", help="'all' or a comma-separated list of slugs")
  p_register.add_argument("--allow-rerun", action="store_true",
                          help="mint r<n+1> for a target that is already registered (deliberate re-registration only)")
  p_register.set_defaults(func=cmd_register)

  p_score = sub.add_parser("score", help="grade open, due registrations")
  p_score.add_argument("--now", default=None, help="ISO datetime to use as 'now' (default: real now, UTC)")
  p_score.set_defaults(func=cmd_score)

  p_compile = sub.add_parser("compile", help="rebuild the compiled ledger.json")
  p_compile.set_defaults(func=cmd_compile)

  args = parser.parse_args(argv)
  return args.func(args)


if __name__ == "__main__":
  raise SystemExit(main())
