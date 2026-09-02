#!/usr/bin/env python3
"""Plain-assert tests for ledger_pipeline.py. Run with:

    ./.venv/bin/python test_pipeline.py

No pytest dependency — every test is a `test_*` function collected and run
by `main()` below, which prints PASS/FAIL per test and exits nonzero on any
failure. None of these tests load TimesFM/torch: they exercise the pinball
math, hash canonicalisation, overwrite refusal, grace-window scoring logic,
and compile aggregation, all with injected fakes.
"""

from __future__ import annotations

import datetime as dt
import json
import tempfile
import traceback
from pathlib import Path

import ledger_pipeline as lp


# --------------------------------------------------------------------------
# Pinball loss — closed-form cases
# --------------------------------------------------------------------------


def test_pinball_zero_at_the_quantile():
  # y == f_q for every decile -> every loss, and the mean, is exactly 0.
  y = 42.0
  for q in [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]:
    assert lp.pinball_loss(y, y, q) == 0.0


def test_pinball_known_asymmetric_cases():
  # y >= f: loss = (y - f) * q
  assert lp.pinball_loss(10.0, 8.0, 0.1) == 0.2 - 0  # (10-8)*0.1 = 0.2
  assert abs(lp.pinball_loss(10.0, 8.0, 0.1) - 0.2) < 1e-12
  assert abs(lp.pinball_loss(10.0, 8.0, 0.9) - 1.8) < 1e-12
  # y < f: loss = (f - y) * (1 - q)
  assert abs(lp.pinball_loss(8.0, 10.0, 0.1) - 1.8) < 1e-12
  assert abs(lp.pinball_loss(8.0, 10.0, 0.9) - 0.2) < 1e-12
  # Symmetric quantile (median) is symmetric in over/under-shoot.
  assert abs(lp.pinball_loss(10.0, 8.0, 0.5) - lp.pinball_loss(8.0, 10.0, 0.5)) < 1e-12


def test_score_metrics_matches_hand_computation():
  deciles = {q: float(q) * 100 for q in lp.DECILES}  # f_0.1=10, f_0.2=20, ..., f_0.9=90
  y = 55.0
  m = lp.score_metrics(y, deciles, naive_point=50.0, rw_drift_point=60.0)
  expected_by_decile = {
    q: lp.pinball_loss(y, deciles[q], float(q)) for q in lp.DECILES
  }
  assert m["pinball_by_decile"] == expected_by_decile
  assert abs(m["pinball_mean"] - sum(expected_by_decile.values()) / 9) < 1e-12
  assert m["interval80_hit"] is True  # 10 <= 55 <= 90
  assert abs(m["abs_err_median"] - abs(55.0 - 50.0)) < 1e-12  # f_0.5 = 50
  assert abs(m["naive_abs_err"] - 5.0) < 1e-12
  assert abs(m["rw_drift_abs_err"] - 5.0) < 1e-12

  # Outside the 80% interval.
  m2 = lp.score_metrics(500.0, deciles, naive_point=50.0, rw_drift_point=60.0)
  assert m2["interval80_hit"] is False


# --------------------------------------------------------------------------
# sha256 canonicalisation stability
# --------------------------------------------------------------------------


def _sample_body(extra: dict | None = None) -> dict:
  body = {
    "fcreg": "0.1",
    "id": "lu-debt--2026-Q2--r1",
    "series": {"slug": "lu-debt", "dims": {"geo": "LU", "sector": "S13"}},
    "forecast": {"deciles": {"0.1": 1.0, "0.5": 2.0, "0.9": 3.0}},
    "created_utc": "2026-09-01T00:00:00Z",
  }
  if extra:
    body.update(extra)
  return body


def test_sha256_is_stable_across_key_order_and_reserialisation():
  body = _sample_body()
  h1 = lp.compute_sha256(body)

  # Re-derive the same object with keys inserted in a totally different
  # order (dict equality doesn't care, but a naive hash-of-repr would).
  reordered = {
    "created_utc": body["created_utc"],
    "forecast": {"deciles": {"0.9": 3.0, "0.1": 1.0, "0.5": 2.0}},
    "id": body["id"],
    "series": {"dims": {"sector": "S13", "geo": "LU"}, "slug": "lu-debt"},
    "fcreg": body["fcreg"],
  }
  h2 = lp.compute_sha256(reordered)
  assert h1 == h2, "hash must be invariant to dict/key insertion order"

  # Round-tripping through JSON (as happens when a file is written then
  # re-read) must not change the hash either.
  round_tripped = json.loads(json.dumps(body))
  h3 = lp.compute_sha256(round_tripped)
  assert h1 == h3


def test_sha256_changes_when_a_field_changes():
  base = lp.compute_sha256(_sample_body())
  changed = lp.compute_sha256(_sample_body({"created_utc": "2026-09-02T00:00:00Z"}))
  assert base != changed


def test_canonical_json_bytes_has_no_whitespace_and_sorted_keys():
  raw = lp.canonical_json_bytes({"b": 1, "a": 2})
  assert raw == b'{"a":2,"b":1}'
  assert b" " not in raw


# --------------------------------------------------------------------------
# Refusal to overwrite an existing registration
# --------------------------------------------------------------------------


def test_write_registration_refuses_to_overwrite():
  with tempfile.TemporaryDirectory() as tmp:
    reg_dir = Path(tmp)
    reg = {"id": "ea-hicp--2026-09--r1", "forecast": {"deciles": {"0.5": 2.0}}}
    path = lp.write_registration(reg, reg_dir=reg_dir)
    original_bytes = path.read_bytes()

    mutated = {"id": "ea-hicp--2026-09--r1", "forecast": {"deciles": {"0.5": 999.0}}}
    threw = False
    try:
      lp.write_registration(mutated, reg_dir=reg_dir)
    except lp.RegistrationExistsError:
      threw = True
    assert threw, "writing an existing id must raise RegistrationExistsError"
    assert path.read_bytes() == original_bytes, "the original file must be untouched"


def test_next_registration_id_increments_per_target_period():
  with tempfile.TemporaryDirectory() as tmp:
    reg_dir = Path(tmp)
    assert lp.next_registration_id("lu-debt", "2026-Q2", reg_dir=reg_dir) == "lu-debt--2026-Q2--r1"
    (reg_dir / "lu-debt--2026-Q2--r1.json").write_text("{}")
    assert lp.next_registration_id("lu-debt", "2026-Q2", reg_dir=reg_dir) == "lu-debt--2026-Q2--r2"
    # A different target period starts back at r1.
    assert lp.next_registration_id("lu-debt", "2026-Q3", reg_dir=reg_dir) == "lu-debt--2026-Q3--r1"


def test_write_outcome_refuses_to_overwrite_a_terminal_verdict():
  with tempfile.TemporaryDirectory() as tmp:
    out_dir = Path(tmp)
    outcome = {"id": "lu-unemp--2026-08--r1", "verdict": "SCORED"}
    lp.write_outcome(outcome, out_dir=out_dir)
    threw = False
    try:
      lp.write_outcome({"id": "lu-unemp--2026-08--r1", "verdict": "UNEVALUABLE"}, out_dir=out_dir)
    except lp.RegistrationExistsError:
      threw = True
    assert threw, "an UNEVALUABLE/SCORED verdict is terminal — it must never be rewritten"


# --------------------------------------------------------------------------
# Period / calendar helpers
# --------------------------------------------------------------------------


def test_next_period_month_and_quarter():
  assert lp.next_period_month("2026-01") == "2026-02"
  assert lp.next_period_month("2026-12") == "2027-01"
  assert lp.next_period_quarter("2026-Q1") == "2026-Q2"
  assert lp.next_period_quarter("2026-Q4") == "2027-Q1"


def test_last_day_of_month_and_quarter():
  assert lp.last_day_of_month(2026, 2) == dt.date(2026, 2, 28)  # not a leap year
  assert lp.last_day_of_month(2024, 2) == dt.date(2024, 2, 29)  # leap year
  assert lp.last_day_of_quarter(2026, 1) == dt.date(2026, 3, 31)
  assert lp.last_day_of_quarter(2026, 2) == dt.date(2026, 6, 30)


# --------------------------------------------------------------------------
# UNEVALUABLE grace logic, with an injected clock and a fake fetcher
# --------------------------------------------------------------------------


def _fake_registration(**overrides) -> dict:
  reg = {
    "id": "lu-unemp--2026-08--r1",
    "series": {"dataset": "une_rt_m", "dims": {"geo": "LU"}, "slug": "lu-unemp"},
    "target": {
      "period": "2026-08",
      "release": {"expected": "2026-09-30", "calendar_source": "test", "grace_days": 30},
    },
    "forecast": {"deciles": {q: 7.0 + float(q) for q in lp.DECILES}},
    "baselines": {"naive": {"point": 7.1}, "rw_drift": {"point": 7.05}},
  }
  reg.update(overrides)
  return reg


def test_score_one_stays_open_before_the_expected_release_date():
  reg = _fake_registration()

  def fetch_fn(dataset, dims):
    return [], {"fetched_utc": "x", "dim_labels": {}}

  out = lp.score_one(reg, now=dt.datetime(2026, 9, 1, tzinfo=dt.timezone.utc), fetch_fn=fetch_fn)
  assert out is None


def test_score_one_stays_open_within_grace_when_data_still_missing():
  reg = _fake_registration()

  def fetch_fn(dataset, dims):
    return [("2026-07", 7.1)], {"fetched_utc": "x", "dim_labels": {}}  # target 2026-08 absent

  # expected=2026-09-30, grace=30d -> terminal boundary is 2026-10-30.
  out = lp.score_one(reg, now=dt.datetime(2026, 10, 15, tzinfo=dt.timezone.utc), fetch_fn=fetch_fn)
  assert out is None


def test_score_one_marks_late_once_grace_is_exhausted_with_no_data():
  reg = _fake_registration()

  def fetch_fn(dataset, dims):
    return [("2026-07", 7.1)], {"fetched_utc": "x", "dim_labels": {}}  # still no 2026-08

  out = lp.score_one(reg, now=dt.datetime(2026, 10, 30, tzinfo=dt.timezone.utc), fetch_fn=fetch_fn)
  assert out is not None
  assert out["verdict"] == "UNEVALUABLE"
  assert out["reason"] == "late"
  assert out["outturn"] is None
  assert out["metrics"] is None


def test_score_one_scores_as_soon_as_data_lands_on_or_after_expected():
  reg = _fake_registration()

  def fetch_fn(dataset, dims):
    return [("2026-07", 7.1), ("2026-08", 7.2)], {"fetched_utc": "2026-09-30T12:00:00Z", "dim_labels": {}}

  out = lp.score_one(reg, now=dt.datetime(2026, 9, 30, tzinfo=dt.timezone.utc), fetch_fn=fetch_fn)
  assert out is not None
  assert out["verdict"] == "SCORED"
  assert out["reason"] is None
  assert out["outturn"]["value"] == 7.2
  expected_metrics = lp.score_metrics(7.2, reg["forecast"]["deciles"], 7.1, 7.05)
  assert out["metrics"] == expected_metrics


def test_score_one_marks_discontinued_on_404():
  reg = _fake_registration()

  def fetch_fn(dataset, dims):
    raise lp.DatasetNotFoundError("http://example", "gone")

  out = lp.score_one(reg, now=dt.datetime(2026, 9, 30, tzinfo=dt.timezone.utc), fetch_fn=fetch_fn)
  assert out["verdict"] == "UNEVALUABLE"
  assert out["reason"] == "discontinued"


def test_score_one_detects_vintage_conflict_against_the_registration_snapshot():
  reg = _fake_registration(id="lu-unemp--2026-08--r1")
  with tempfile.TemporaryDirectory() as tmp:
    snap_dir = Path(tmp)
    (snap_dir / f"{reg['id']}.snapshot.json").write_text(
      json.dumps(
        {
          "id": reg["id"],
          "history": [{"period": "2026-07", "value": 7.1}, {"period": "2026-08", "value": 6.6}],
          "meta": {"dim_labels": {"geo": "Luxembourg"}},
        }
      )
    )

    def fetch_fn(dataset, dims):
      return [("2026-07", 7.1), ("2026-08", 7.2)], {"fetched_utc": "x", "dim_labels": {"geo": "Luxembourg"}}

    out = lp.score_one(
      reg, now=dt.datetime(2026, 9, 30, tzinfo=dt.timezone.utc), fetch_fn=fetch_fn, snapshot_dir=snap_dir
    )
    assert out["verdict"] == "UNEVALUABLE"
    assert out["reason"] == "vintage_conflict"


def test_score_one_detects_definition_changed_via_dim_label_drift():
  reg = _fake_registration(id="lu-unemp--2026-08--r2")
  with tempfile.TemporaryDirectory() as tmp:
    snap_dir = Path(tmp)
    (snap_dir / f"{reg['id']}.snapshot.json").write_text(
      json.dumps(
        {
          "id": reg["id"],
          "history": [{"period": "2026-07", "value": 7.1}],
          "meta": {"dim_labels": {"unit": "Percentage of active population in the same age class"}},
        }
      )
    )

    def fetch_fn(dataset, dims):
      return [("2026-07", 7.1), ("2026-08", 7.2)], {
        "fetched_utc": "x",
        "dim_labels": {"unit": "Percentage of labour force (redefined series)"},
      }

    out = lp.score_one(
      reg, now=dt.datetime(2026, 9, 30, tzinfo=dt.timezone.utc), fetch_fn=fetch_fn, snapshot_dir=snap_dir
    )
    assert out["verdict"] == "UNEVALUABLE"
    assert out["reason"] == "definition_changed"


# --------------------------------------------------------------------------
# Compile aggregation on a synthetic fixture
# --------------------------------------------------------------------------


def test_compile_ledger_aggregates_a_synthetic_fixture():
  with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    reg_dir, out_dir, corr_dir = root / "registrations", root / "outcomes", root / "corrections"
    reg_dir.mkdir()
    out_dir.mkdir()
    corr_dir.mkdir()

    def make_reg(reg_id, slug):
      return {
        "id": reg_id,
        "series": {"slug": slug},
        "forecast": {"deciles": {q: 1.0 for q in lp.DECILES}},
        "baselines": {"naive": {"point": 1.0}, "rw_drift": {"point": 1.0}},
      }

    regs = [
      make_reg("ea-hicp--2026-09--r1", "ea-hicp"),
      make_reg("lu-unemp--2026-08--r1", "lu-unemp"),
      make_reg("lu-unemp--2026-09--r1", "lu-unemp"),
      make_reg("lu-debt--2026-Q2--r1", "lu-debt"),
    ]
    for r in regs:
      (reg_dir / f"{r['id']}.json").write_text(json.dumps(r))

    def make_outcome(reg_id, verdict, reason=None, pinball_mean=None, hit=None):
      return {
        "id": reg_id,
        "verdict": verdict,
        "reason": reason,
        "outturn": None if verdict != "SCORED" else {"value": 1.0, "fetched_utc": "x", "vintage_note": "x"},
        "metrics": None
        if verdict != "SCORED"
        else {
          "pinball_mean": pinball_mean,
          "pinball_by_decile": {q: pinball_mean for q in lp.DECILES},
          "interval80_hit": hit,
          "abs_err_median": 0.0,
          "naive_abs_err": 0.0,
          "rw_drift_abs_err": 0.0,
        },
        "scored_utc": "x",
      }

    outcomes = [
      make_outcome("ea-hicp--2026-09--r1", "SCORED", pinball_mean=0.10, hit=True),
      make_outcome("lu-unemp--2026-08--r1", "SCORED", pinball_mean=0.20, hit=False),
      make_outcome("lu-unemp--2026-09--r1", "UNEVALUABLE", reason="late"),
      # lu-debt--2026-Q2--r1 has no outcome file -> stays open.
    ]
    for o in outcomes:
      (out_dir / f"{o['id']}.json").write_text(json.dumps(o))

    ledger = lp.compile_ledger(
      reg_dir=reg_dir,
      out_dir=out_dir,
      corr_dir=corr_dir,
      output_path=root / "ledger.json",
      now=dt.datetime(2026, 10, 1, tzinfo=dt.timezone.utc),
    )

    s = ledger["stats"]
    assert s["n_open"] == 1  # lu-debt--2026-Q2--r1
    assert s["n_scored"] == 2
    assert s["n_unevaluable"] == 1
    assert abs(s["coverage80"]["empirical"] - 0.5) < 1e-12  # 1 hit out of 2 scored
    assert s["coverage80"]["nominal"] == 0.80
    assert abs(s["mean_pinball_by_series"]["ea-hicp"] - 0.10) < 1e-12
    assert abs(s["mean_pinball_by_series"]["lu-unemp"] - 0.20) < 1e-12
    assert "lu-debt" not in s["mean_pinball_by_series"]  # never scored -> no entry

    assert (root / "ledger.json").exists()
    reloaded = json.loads((root / "ledger.json").read_text())
    assert reloaded == ledger


def test_compile_ledger_handles_the_empty_scoreboard():
  # "The scoreboard launches EMPTY on purpose" — compile must handle zero
  # registrations and zero outcomes cleanly, with null (not zero-division)
  # aggregate stats.
  with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    reg_dir, out_dir, corr_dir = root / "registrations", root / "outcomes", root / "corrections"
    reg_dir.mkdir()
    out_dir.mkdir()
    corr_dir.mkdir()
    ledger = lp.compile_ledger(reg_dir=reg_dir, out_dir=out_dir, corr_dir=corr_dir, output_path=root / "ledger.json")
    s = ledger["stats"]
    assert s == {
      "n_open": 0,
      "n_scored": 0,
      "n_unevaluable": 0,
      "coverage80": {"empirical": None, "nominal": 0.80},
      "mean_pinball_by_series": {},
    }


# --------------------------------------------------------------------------
# Runner
# --------------------------------------------------------------------------


def main() -> int:
  tests = [(name, fn) for name, fn in sorted(globals().items()) if name.startswith("test_") and callable(fn)]
  passed = failed = 0
  for name, fn in tests:
    try:
      fn()
    except Exception:
      failed += 1
      print(f"FAIL {name}")
      traceback.print_exc()
    else:
      passed += 1
      print(f"PASS {name}")
  print(f"\n{passed} passed, {failed} failed, {passed + failed} total")
  return 0 if failed == 0 else 1


if __name__ == "__main__":
  raise SystemExit(main())
