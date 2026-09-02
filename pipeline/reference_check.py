#!/usr/bin/env python3
"""
Ledger — independent reference check.

House doctrine (see ../README.md): every published number carries a "kind" tag, and an
INDEPENDENT code path recomputes every published metric. This script is that second path.

It does NOT import ledger_pipeline.py, and does not read a single line of it. Every formula
below is re-typed from the project spec text alone (registration/outcome schema, pinball loss,
interval-80 hit, sha256 canonicalisation). If this script and ledger_pipeline.py ever disagree,
that disagreement is the finding — do not "fix" this file to match the pipeline's output without
first checking which one has the bug.

What it checks, walking data/registry/{registrations,outcomes,corrections}/ and
data/registry/ledger.json (the compiled bundle `ledger_pipeline.py compile` writes):

  1. Structural sanity of every registration and outcome (matching id/filename, required fields,
     exactly the nine deciles 0.1..0.9, non-decreasing decile values).
  2. sha256 re-derivation: canonical JSON (sort_keys=True, separators=(",", ":"), ensure_ascii=
     True) of every registration field ABOVE "sha256" in the schema (fcreg, id, series, target,
     vintage_policy, engine, forecast, baselines, created_utc), hashed with sha256, compared
     byte-for-byte against the stored "sha256" field. ensure_ascii=True is not the incidental
     Python default here, it is the deliberate cross-runtime contract: it is what makes this
     match both pipeline/ledger_pipeline.py's own canonical_json_bytes() (ensure_ascii=True for
     the identical stated reason) and src/ledger.js's in-browser canonicalize()+sha256Hex(),
     whose jsonStringEscape() explicitly \\uXXXX-escapes non-ASCII text to reproduce Python's
     ensure_ascii=True output byte-for-byte — by that function's own code comment, and confirmed
     by src/ledger.test.js's 66/66-passing oracle-hash unit tests (hard-coded Python-computed
     hashes for em-dash/curly-quote/emoji strings). Raw JS JSON.stringify does not escape
     non-ASCII on its own, but ledger.js does not rely on it raw for this purpose — it is the
     browser-side code that actually re-verifies a registration's hash live, in front of a
     visitor, so it is the side this script must agree with, and ensure_ascii=True is that
     agreement, not a divergence from it. See README.md (this section previously, incorrectly,
     documented the opposite convention as a "known issue" — corrected as of this writing).
     A second, independent gotcha this script watches for: Python's json.dumps and JS's
     JSON.stringify agree on integers but DISAGREE on a whole-number float literal (e.g. a
     registration field written as `90.0`) — Python re-emits "90.0", JS's Number re-emits "90" —
     which would silently break this exact cross-runtime hash match. Every registrations/*.json is
     scanned for that pattern too.
  3. Per-outcome metric recomputation for every SCORED outcome: pinball_by_decile (all 9 deciles),
     pinball_mean, interval80_hit, abs_err_median, naive_abs_err, rw_drift_abs_err — all recomputed
     from the raw registration forecast + baselines and the raw outturn value, then compared
     against the stored metrics (numeric comparisons use a 1e-9 tolerance; everything else exact).
  4. Append-only invariants:
       - every outcome references an existing registration id
       - no registration's created_utc is in the future
       - UNEVALUABLE outcomes carry a non-null reason (one of the four defined reasons) and no
         metrics; SCORED outcomes carry null reason and non-null metrics
       - an outcome's scored_utc is not earlier than its registration's created_utc (you cannot
         grade a forecast before it was committed) and is not itself in the future
       - every corrections/*.json that names a registration_id must reference one that exists
  5. data/registry/ledger.json, if present: its embedded registrations/outcomes/corrections arrays
     must be byte-identical (by sha256, for registrations; by content, for outcomes/corrections) to
     the per-file registry (catches a stale or partial `compile` run), and its "stats" object
     (n_open, n_scored, n_unevaluable, coverage80.{empirical,nominal}, mean_pinball_by_series) is
     recomputed independently from the RAW registry — registration deciles/baselines + raw outturn
     values — never from the stored per-outcome metrics, and compared field-for-field. Any field
     published under "stats" that this script does not know how to recompute is itself reported as
     a mismatch — an unverifiable published number is a doctrine violation, not a pass. NOTE: this
     is deliberately NOT the same thing as `ledger_pipeline.py`'s own metrics — this check recomputes
     coverage80/mean_pinball_by_series from scratch rather than trusting the numbers the pipeline
     already wrote into each outcome file, so a bug shared between "write" and "compile" inside the
     pipeline (as in point 2 above) cannot hide from this script the way it could from a self-check
     that reused the pipeline's own metrics.

Exit code is 0 iff there is nothing to report (including the legitimate empty-registry state —
"precedence before performance" means a clean launch has zero registrations, and that is a PASS,
not a warning) and non-zero the moment any single mismatch is found. On failure, every mismatch is
printed as a precise diff line: [path] field expected=<recomputed> stored/published=<found>.

Usage:
    python3 reference_check.py                          # check the live registry (default paths)
    python3 reference_check.py --registry P --ledger P  # check an arbitrary registry/ledger.json
    python3 reference_check.py --fixtures               # self-test the checker itself (see below)

--fixtures runs this script against pipeline/fixtures/good (must PASS) and
pipeline/fixtures/corrupted (must FAIL, and must fail for each of the three planted reasons) — see
the comment block at the top of run_fixtures_selftest() below for the by-hand arithmetic and the
exact corruptions. It then prints an informational (non-gating) cross-check of the sha256 values
in src/fixtures/ledger.fixture.json, a file this script does not own.

Stdlib only. No network. No dependency on the pipeline/.venv.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

VALID_REASONS = {"late", "discontinued", "definition_changed", "vintage_conflict"}
EXPECTED_DECILE_KEYS = {f"0.{d}" for d in range(1, 10)}
REGISTRATION_HASH_FIELDS = (
    "fcreg", "id", "series", "target", "vintage_policy", "engine", "forecast", "baselines",
    "created_utc",
)
# Top-level ledger.json keys that are metadata, not recomputable aggregates.
ALLOWED_LEDGER_METADATA = {"ledger_version", "generated_utc"}
TOL_REL = 1e-9
TOL_ABS = 1e-9


# --------------------------------------------------------------------------------------
# canonicalisation + sha256 (schema: "sha256 of canonical JSON of every field above this
# one, sorted keys, no whitespace")
# --------------------------------------------------------------------------------------

def canonical_bytes(obj: Any) -> bytes:
    # ensure_ascii=True deliberately: matches both pipeline/ledger_pipeline.py's
    # canonical_json_bytes() and src/ledger.js's canonicalize(), whose own jsonStringEscape()
    # explicitly \uXXXX-escapes non-ASCII text to reproduce Python's ensure_ascii=True default
    # byte-for-byte (see that function's code comment, and its 66/66-passing oracle-hash unit
    # tests in src/ledger.test.js). JS's raw JSON.stringify does NOT escape non-ASCII on its
    # own -- but ledger.js does not use it raw for this purpose. See module docstring.
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


def recompute_registration_sha256(reg: dict) -> str:
    fields = {}
    for key in REGISTRATION_HASH_FIELDS:
        if key not in reg:
            raise KeyError(key)
        fields[key] = reg[key]
    return hashlib.sha256(canonical_bytes(fields)).hexdigest()


def find_dotzero_literals(raw_text: str) -> list[str]:
    """Return every numeric literal in raw_text written as a whole number with a decimal point
    (e.g. "90.0", "-4.00"). json.loads' parse_float hook sees the exact original token text for
    every JSON number containing a "." or exponent, so this only ever looks at real JSON number
    tokens -- never at digits that happen to appear inside a quoted string (e.g. a checkpoint id
    like "timesfm-2.0-500m"). Malformed JSON is ignored here; check_registry() reports that
    separately when it tries json.loads() itself."""
    hits: list[str] = []

    def catch_float(s: str) -> float:
        hits.append(s)
        return float(s)

    try:
        json.loads(raw_text, parse_float=catch_float)
    except Exception:
        return []

    out = []
    for s in hits:
        body = s[1:] if s.startswith("-") else s
        if "e" in body or "E" in body or "." not in body:
            continue
        _, frac = body.split(".", 1)
        if frac and set(frac) == {"0"}:
            out.append(s)
    return out


# --------------------------------------------------------------------------------------
# scoring math (schema, exact): pinball loss, interval-80 hit, abs errors
# --------------------------------------------------------------------------------------

def pinball_loss(y: float, f_q: float, q: float) -> float:
    if y >= f_q:
        return (y - f_q) * q
    return (f_q - y) * (1 - q)


def compute_outcome_metrics(reg: dict, y: float) -> dict:
    deciles = reg["forecast"]["deciles"]
    by_decile = {q: pinball_loss(y, fv, float(q)) for q, fv in deciles.items()}
    pinball_mean = sum(by_decile.values()) / len(by_decile)
    f_lo, f_hi, f_med = deciles["0.1"], deciles["0.9"], deciles["0.5"]
    interval80_hit = f_lo <= y <= f_hi
    abs_err_median = abs(y - f_med)
    naive_pt = reg["baselines"]["naive"]["point"]
    rw_pt = reg["baselines"]["rw_drift"]["point"]
    return {
        "pinball_by_decile": by_decile,
        "pinball_mean": pinball_mean,
        "interval80_hit": interval80_hit,
        "abs_err_median": abs_err_median,
        "naive_abs_err": abs(y - naive_pt),
        "rw_drift_abs_err": abs(y - rw_pt),
    }


# --------------------------------------------------------------------------------------
# small helpers
# --------------------------------------------------------------------------------------

def parse_iso(s: str) -> datetime:
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def num_close(a: float, b: float) -> bool:
    return math.isclose(float(a), float(b), rel_tol=TOL_REL, abs_tol=TOL_ABS)


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


# --------------------------------------------------------------------------------------
# aggregate comparison (recursive; any published key this schema can't recompute is itself
# a finding — "recomputes every aggregate" means every one, not the ones we happened to model)
# --------------------------------------------------------------------------------------

def compare_value(expected: Any, actual: Any, mismatches: list[str], label: str, path: str) -> None:
    if expected is None:
        if actual is not None:
            mismatches.append(f"[{label}] {path} expected=null published={actual!r}")
        return
    if isinstance(expected, dict):
        if not isinstance(actual, dict):
            mismatches.append(f"[{label}] {path} expected an object, published={actual!r}")
            return
        for k, v in expected.items():
            if k not in actual:
                mismatches.append(f"[{label}] {path}.{k} missing (expected={v!r})")
            else:
                compare_value(v, actual[k], mismatches, label, f"{path}.{k}")
        for k in actual:
            if k not in expected:
                mismatches.append(
                    f"[{label}] {path}.{k}={actual[k]!r} is not a field this reference schema can "
                    f"recompute — either it is a typo/extra field, or reference_check.py needs to be "
                    f"extended to cover it"
                )
        return
    if isinstance(expected, bool):
        if not isinstance(actual, bool) or actual != expected:
            mismatches.append(f"[{label}] {path} expected={expected!r} published={actual!r}")
        return
    if isinstance(expected, (int, float)):
        if isinstance(actual, bool) or not isinstance(actual, (int, float)):
            mismatches.append(f"[{label}] {path} expected numeric {expected!r}, published={actual!r}")
        elif not num_close(expected, actual):
            mismatches.append(f"[{label}] {path} expected={expected!r} published={actual!r}")
        return
    if expected != actual:
        mismatches.append(f"[{label}] {path} expected={expected!r} published={actual!r}")


def compare_aggregates(recomputed: dict, published: Any, mismatches: list[str], label: str, prefix: str) -> None:
    if not isinstance(published, dict):
        mismatches.append(f"[{label}] {prefix} expected a JSON object, got {type(published).__name__}")
        return
    for k, v in recomputed.items():
        if k not in published:
            mismatches.append(f"[{label}] {prefix}.{k} missing (expected={v!r})")
            continue
        compare_value(v, published[k], mismatches, label, f"{prefix}.{k}")
    for k in published:
        if k in recomputed or (prefix == "" and k in ALLOWED_LEDGER_METADATA):
            continue
        mismatches.append(
            f"[{label}] {prefix}.{k}={published[k]!r} is not a field this reference schema can "
            f"recompute — either it is a typo/extra field, or reference_check.py needs to be "
            f"extended to cover it"
        )


def check_bundle_consistency(
    ledger: dict, registrations: dict, outcomes: dict, corr_dir: Path, label: str, mismatches: list[str]
) -> None:
    """ledger.json embeds full copies of every registration/outcome/correction (so the live page
    can run ledger.js's aggregate()/verifyRegistrationHash() against them without a directory
    listing). Those embedded copies must be exactly the per-file registry -- not stale, not
    partial -- or the page would be showing something other than the append-only source of truth."""
    bundled_regs = {r.get("id"): r for r in (ledger.get("registrations") or []) if isinstance(r, dict)}
    for rid, (p, reg) in registrations.items():
        if rid not in bundled_regs:
            mismatches.append(f"[{label}] registrations[] is missing {rid!r} (present in registrations/{p.name})")
        elif bundled_regs[rid] != reg:
            mismatches.append(
                f"[{label}] registrations[] entry for {rid!r} does not match registrations/{p.name} "
                f"— bundle is stale"
            )
    for rid in bundled_regs:
        if rid not in registrations:
            mismatches.append(f"[{label}] registrations[] contains {rid!r}, which has no file under registrations/")

    bundled_outs = {o.get("id"): o for o in (ledger.get("outcomes") or []) if isinstance(o, dict)}
    for oid, (p, out) in outcomes.items():
        if oid not in bundled_outs:
            mismatches.append(f"[{label}] outcomes[] is missing {oid!r} (present in outcomes/{p.name})")
        elif bundled_outs[oid] != out:
            mismatches.append(f"[{label}] outcomes[] entry for {oid!r} does not match outcomes/{p.name} — bundle is stale")
    for oid in bundled_outs:
        if oid not in outcomes:
            mismatches.append(f"[{label}] outcomes[] contains {oid!r}, which has no file under outcomes/")

    file_corrections = []
    if corr_dir.is_dir():
        for p in sorted(corr_dir.glob("*.json")):
            try:
                file_corrections.append(load_json(p))
            except Exception:
                pass  # already reported when corrections/ was scanned directly
    bundled_corr = ledger.get("corrections") or []
    if len(bundled_corr) != len(file_corrections):
        mismatches.append(
            f"[{label}] corrections[] has {len(bundled_corr)} entries, corrections/ has "
            f"{len(file_corrections)} files — bundle is stale"
        )
    elif bundled_corr != file_corrections:
        mismatches.append(f"[{label}] corrections[] does not match the contents of corrections/ — bundle is stale")


# --------------------------------------------------------------------------------------
# the checker itself
# --------------------------------------------------------------------------------------

def check_registry(registry_dir: Path, ledger_path: Path | None) -> tuple[bool, list[str], list[str], dict]:
    mismatches: list[str] = []
    info: list[str] = []

    reg_dir = registry_dir / "registrations"
    out_dir = registry_dir / "outcomes"
    corr_dir = registry_dir / "corrections"

    registrations: dict[str, tuple[Path, dict]] = {}
    for p in sorted(reg_dir.glob("*.json")) if reg_dir.is_dir() else []:
        try:
            reg = load_json(p)
        except Exception as e:
            mismatches.append(f"[registrations/{p.name}] invalid JSON: {e}")
            continue
        rid = reg.get("id")
        if rid != p.stem:
            mismatches.append(f"[registrations/{p.name}] id={rid!r} does not match filename stem {p.stem!r}")
        key = rid if rid else p.stem
        if key in registrations:
            mismatches.append(f"[registrations/{p.name}] duplicate id {key!r} (already used by "
                               f"{registrations[key][0].name})")
            continue
        registrations[key] = (p, reg)

    outcomes: dict[str, tuple[Path, dict]] = {}
    for p in sorted(out_dir.glob("*.json")) if out_dir.is_dir() else []:
        try:
            out = load_json(p)
        except Exception as e:
            mismatches.append(f"[outcomes/{p.name}] invalid JSON: {e}")
            continue
        oid = out.get("id")
        if oid != p.stem:
            mismatches.append(f"[outcomes/{p.name}] id={oid!r} does not match filename stem {p.stem!r}")
        key = oid if oid else p.stem
        if key in outcomes:
            mismatches.append(f"[outcomes/{p.name}] duplicate id {key!r} (already used by "
                               f"{outcomes[key][0].name})")
            continue
        outcomes[key] = (p, out)

    now = datetime.now(timezone.utc)

    # --- per-registration structural checks + sha256 re-derivation + "no future created_utc" ---
    for rid, (p, reg) in registrations.items():
        for lit in find_dotzero_literals(p.read_text(encoding="utf-8")):
            mismatches.append(
                f"[registrations/{p.name}] numeric literal '{lit}' is written as a whole-number "
                f"float; Python's json.dumps and JavaScript's JSON.stringify diverge on this "
                f"(Python re-emits '{lit}', JS re-emits '{lit.split('.')[0]}'), which would "
                f"silently break the sha256 cross-check between the offline pipeline and the "
                f"in-browser live check — write it as a plain integer instead"
            )
        for field in REGISTRATION_HASH_FIELDS:
            if field not in reg:
                mismatches.append(f"[registrations/{p.name}] missing required field {field!r}")
        deciles = (reg.get("forecast") or {}).get("deciles")
        if not isinstance(deciles, dict) or set(deciles.keys()) != EXPECTED_DECILE_KEYS:
            mismatches.append(
                f"[registrations/{p.name}] forecast.deciles must have exactly the keys "
                f"{sorted(EXPECTED_DECILE_KEYS, key=float)}, found "
                f"{sorted(deciles.keys(), key=float) if isinstance(deciles, dict) else deciles!r}"
            )
        else:
            ordered = [deciles[q] for q in sorted(deciles.keys(), key=float)]
            if any(ordered[i] > ordered[i + 1] for i in range(len(ordered) - 1)):
                mismatches.append(f"[registrations/{p.name}] forecast.deciles is not non-decreasing: {ordered}")

        created = reg.get("created_utc")
        created_dt = None
        if created:
            try:
                created_dt = parse_iso(created)
                if created_dt > now:
                    mismatches.append(
                        f"[registrations/{p.name}] created_utc={created} is in the future "
                        f"(checked against {now.isoformat()})"
                    )
            except Exception as e:
                mismatches.append(f"[registrations/{p.name}] created_utc={created!r} unparsable: {e}")

        stored_sha = reg.get("sha256")
        if not stored_sha:
            mismatches.append(f"[registrations/{p.name}] missing sha256 field")
        else:
            try:
                recomputed_sha = recompute_registration_sha256(reg)
                if recomputed_sha != stored_sha:
                    mismatches.append(
                        f"[registrations/{p.name}] sha256 expected(recomputed)={recomputed_sha} "
                        f"stored={stored_sha}"
                    )
            except KeyError as missing:
                mismatches.append(f"[registrations/{p.name}] cannot recompute sha256, missing field {missing}")

    # --- append-only: every outcome references an existing registration ---
    for oid, (p, out) in outcomes.items():
        if oid not in registrations:
            mismatches.append(f"[outcomes/{p.name}] id={oid!r} does not reference any known registration")

    # --- corrections: light structural check ---
    if corr_dir.is_dir():
        for p in sorted(corr_dir.glob("*.json")):
            try:
                corr = load_json(p)
            except Exception as e:
                mismatches.append(f"[corrections/{p.name}] invalid JSON: {e}")
                continue
            ref = corr.get("registration_id")
            if ref is not None and ref not in registrations:
                mismatches.append(
                    f"[corrections/{p.name}] registration_id={ref!r} does not reference any known registration"
                )

    # --- per-outcome verdict + metric recomputation, accumulating independent aggregates.
    # The "stats" SHAPE below matches pipeline/ledger_pipeline.py's compile_ledger() field-for-
    # field (n_open, n_scored, n_unevaluable, coverage80.{empirical,nominal},
    # mean_pinball_by_series) -- confirmed by reading its output contract, not an invented shape --
    # so this is checking the real artifact at data/registry/ledger.json, not a guess. Unlike
    # compile_ledger() itself, every number below is rebuilt from the RAW registration + outturn
    # (never from a stored outcome's "metrics" block) -- see module docstring point 5. n_open counts
    # registrations with no outcome file at all; a verdict string that is neither SCORED nor
    # UNEVALUABLE is (like in compile_ledger()) counted in none of the three buckets -- it is
    # already reported as its own mismatch below, and matching the pipeline's silent-omission
    # behavior here means the stats comparison isn't itself the thing that catches that case.
    per_series: dict[str, dict] = {}
    scored_count = 0
    unevaluable_count = 0
    hits_total = 0

    for oid, (p, out) in outcomes.items():
        if oid not in registrations:
            continue  # already reported above
        reg_path, reg = registrations[oid]
        slug = ((reg.get("series") or {}).get("slug")) or "<unknown>"
        verdict = out.get("verdict")
        reason = out.get("reason")
        metrics = out.get("metrics")
        outturn = out.get("outturn")

        created = reg.get("created_utc")
        scored_utc = out.get("scored_utc")
        if created and scored_utc:
            try:
                if parse_iso(scored_utc) < parse_iso(created):
                    mismatches.append(
                        f"[outcomes/{p.name}] scored_utc={scored_utc} is before its own "
                        f"registration's created_utc={created} (append-only violation)"
                    )
                if parse_iso(scored_utc) > now:
                    mismatches.append(f"[outcomes/{p.name}] scored_utc={scored_utc} is in the future")
            except Exception as e:
                mismatches.append(f"[outcomes/{p.name}] scored_utc={scored_utc!r} unparsable: {e}")

        if verdict == "UNEVALUABLE":
            unevaluable_count += 1
            if not reason:
                mismatches.append(f"[outcomes/{p.name}] verdict=UNEVALUABLE but reason is null/empty")
            elif reason not in VALID_REASONS:
                mismatches.append(f"[outcomes/{p.name}] reason={reason!r} not one of {sorted(VALID_REASONS)}")
            if metrics is not None:
                mismatches.append(f"[outcomes/{p.name}] verdict=UNEVALUABLE but metrics is not null")

        elif verdict == "SCORED":
            scored_count += 1
            if reason is not None:
                mismatches.append(f"[outcomes/{p.name}] verdict=SCORED but reason is not null (reason={reason!r})")
            if metrics is None:
                mismatches.append(f"[outcomes/{p.name}] verdict=SCORED but metrics is null")
            if not outturn or "value" not in outturn:
                mismatches.append(f"[outcomes/{p.name}] verdict=SCORED but outturn.value is missing")
            elif metrics is not None:
                y = outturn["value"]
                try:
                    recomputed = compute_outcome_metrics(reg, y)
                except Exception as e:
                    mismatches.append(
                        f"[outcomes/{p.name}] could not recompute metrics from registration "
                        f"{reg_path.name}: {e}"
                    )
                    recomputed = None
                if recomputed is not None:
                    stored_by_decile = metrics.get("pinball_by_decile") or {}
                    for q, exp_l in recomputed["pinball_by_decile"].items():
                        got_l = stored_by_decile.get(q)
                        if got_l is None or not num_close(exp_l, got_l):
                            mismatches.append(
                                f"[outcomes/{p.name}] pinball_by_decile[{q}] expected={exp_l!r} stored={got_l!r}"
                            )
                    if not num_close(metrics.get("pinball_mean", math.nan), recomputed["pinball_mean"]):
                        mismatches.append(
                            f"[outcomes/{p.name}] pinball_mean expected={recomputed['pinball_mean']!r} "
                            f"stored={metrics.get('pinball_mean')!r}"
                        )
                    if bool(metrics.get("interval80_hit")) != recomputed["interval80_hit"]:
                        mismatches.append(
                            f"[outcomes/{p.name}] interval80_hit expected={recomputed['interval80_hit']!r} "
                            f"stored={metrics.get('interval80_hit')!r}"
                        )
                    for k in ("abs_err_median", "naive_abs_err", "rw_drift_abs_err"):
                        if not num_close(metrics.get(k, math.nan), recomputed[k]):
                            mismatches.append(
                                f"[outcomes/{p.name}] {k} expected={recomputed[k]!r} stored={metrics.get(k)!r}"
                            )

                    # accumulate aggregates from the INDEPENDENT recomputation, never from stored metrics
                    slot = per_series.setdefault(slug, {
                        "pinball": [], "abs_err": [], "naive_err": [], "rw_err": [], "n": 0, "hits": 0,
                    })
                    slot["pinball"].append(recomputed["pinball_mean"])
                    slot["abs_err"].append(recomputed["abs_err_median"])
                    slot["naive_err"].append(recomputed["naive_abs_err"])
                    slot["rw_err"].append(recomputed["rw_drift_abs_err"])
                    slot["n"] += 1
                    if recomputed["interval80_hit"]:
                        slot["hits"] += 1
                        hits_total += 1
        else:
            mismatches.append(f"[outcomes/{p.name}] verdict={verdict!r} is neither SCORED nor UNEVALUABLE")

    n_open = sum(1 for rid in registrations if rid not in outcomes)

    def mean_or_none(xs: list[float]):
        return sum(xs) / len(xs) if xs else None

    stats = {
        "n_open": n_open,
        "n_scored": scored_count,
        "n_unevaluable": unevaluable_count,
        "coverage80": {
            "empirical": (hits_total / scored_count) if scored_count else None,
            "nominal": 0.8,
        },
        "mean_pinball_by_series": {
            slug: mean_or_none(v["pinball"])
            for slug, v in sorted(per_series.items())
            if v["pinball"]
        },
    }
    # kept for anyone reading this dict from Python (e.g. a future caller): per-series detail
    # beyond pinball_mean, computed the same independent way, even though compile_ledger()'s own
    # "stats" only publishes mean_pinball_by_series today.
    agg = {"stats": stats, "bySeries": {
        slug: {
            "n": v["n"],
            "pinball_mean": mean_or_none(v["pinball"]),
            "abs_err_median_mean": mean_or_none(v["abs_err"]),
            "naive_abs_err_mean": mean_or_none(v["naive_err"]),
            "rw_drift_abs_err_mean": mean_or_none(v["rw_err"]),
        }
        for slug, v in sorted(per_series.items())
    }}

    if ledger_path is not None and ledger_path.is_file():
        try:
            ledger = load_json(ledger_path)
        except Exception as e:
            mismatches.append(f"[{ledger_path.name}] invalid JSON: {e}")
            ledger = None
        if ledger is not None:
            gen = ledger.get("generated_utc")
            if gen:
                try:
                    if parse_iso(gen) > now:
                        mismatches.append(f"[{ledger_path.name}] generated_utc={gen} is in the future")
                except Exception as e:
                    mismatches.append(f"[{ledger_path.name}] generated_utc={gen!r} unparsable: {e}")

            # bundle-consistency: ledger.json's embedded registrations/outcomes/corrections must
            # be exactly the per-file registry, not a stale or partial snapshot of it.
            check_bundle_consistency(ledger, registrations, outcomes, corr_dir, ledger_path.name, mismatches)

            published_stats = ledger.get("stats")
            if published_stats is None:
                mismatches.append(f"[{ledger_path.name}] missing top-level \"stats\" object")
            else:
                compare_aggregates(stats, published_stats, mismatches, ledger_path.name, prefix="stats")
    else:
        info.append(
            f"ledger.json not found at {ledger_path} — \"stats\" checks skipped "
            f"(expected before the first `ledger_pipeline.py compile` run)"
        )

    ok = len(mismatches) == 0
    return ok, info, mismatches, agg


def print_report(ok: bool, info: list[str], mismatches: list[str], agg: dict | None) -> None:
    for line in info:
        print(f"NOTE: {line}")
    if ok:
        if agg is not None:
            s = agg["stats"]
            total = s["n_open"] + s["n_scored"] + s["n_unevaluable"]
            print(
                f"PASS — total={total} OPEN={s['n_open']} SCORED={s['n_scored']} "
                f"UNEVALUABLE={s['n_unevaluable']}"
            )
            if total == 0:
                print("      registry is empty. That is the expected pre-launch state: "
                      "precedence before performance.")
            if s["n_scored"]:
                print(
                    f"      interval80 coverage: {s['coverage80']['empirical']:.3f} empirical "
                    f"over {s['n_scored']} SCORED verdict(s) (nominal "
                    f"{s['coverage80']['nominal']:.3f})"
                )
        else:
            print("PASS — nothing to verify.")
    else:
        print(f"FAIL — {len(mismatches)} mismatch(es):")
        for m in mismatches:
            print(f"  - {m}")


# --------------------------------------------------------------------------------------
# --fixtures self-test
# --------------------------------------------------------------------------------------

def run_fixtures_selftest(pipeline_dir: Path) -> bool:
    # ------------------------------------------------------------------------------
    # Hand-computed expected numbers for pipeline/fixtures/good, derived from the raw
    # registration + outturn ONLY (no code was used to pick these; the sha256 hashes
    # below were the one exception — those are 64 hex digits and were generated with
    # `hashlib.sha256`, they are not "hand computed", but everything numeric is):
    #
    #   demo-cpi--2026-01--r1 (SCORED): deciles 90,92,94,96,98,100,102,104,106 at
    #   q=0.1..0.9, outturn y=101, naive point=95, rw_drift point=97.
    #
    #   pinball L_q(y,f) = (y-f)*q if y>=f else (f-y)*(1-q):
    #     q=0.1 f=90  y>=f: (101-90)*0.1  = 11*0.1 = 1.1
    #     q=0.2 f=92  y>=f: (101-92)*0.2  =  9*0.2 = 1.8
    #     q=0.3 f=94  y>=f: (101-94)*0.3  =  7*0.3 = 2.1
    #     q=0.4 f=96  y>=f: (101-96)*0.4  =  5*0.4 = 2.0
    #     q=0.5 f=98  y>=f: (101-98)*0.5  =  3*0.5 = 1.5
    #     q=0.6 f=100 y>=f: (101-100)*0.6 =  1*0.6 = 0.6
    #     q=0.7 f=102 y<f:  (102-101)*0.3 =  1*0.3 = 0.3
    #     q=0.8 f=104 y<f:  (104-101)*0.2 =  3*0.2 = 0.6
    #     q=0.9 f=106 y<f:  (106-101)*0.1 =  5*0.1 = 0.5
    #     sum = 1.1+1.8+2.1+2.0+1.5+0.6+0.3+0.6+0.5 = 10.5  ->  pinball_mean = 10.5/9 = 1.16666...7
    #   interval80_hit: f_0.1=90 <= 101 <= f_0.9=106  -> True
    #   abs_err_median = |101-98| = 3
    #   naive_abs_err  = |101-95| = 6
    #   rw_drift_abs_err = |101-97| = 4
    #   (model beats both baselines: 3 < 6 and 3 < 4)
    #
    #   demo-cpi--2026-02--r1 (UNEVALUABLE, reason="late"): no outturn, no metrics.
    #
    #   ledger.json's "stats" over these two registrations (shape matches
    #   pipeline/ledger_pipeline.py's compile_ledger(), NOT an invented one): n_open=0, n_scored=1,
    #   n_unevaluable=1, coverage80={empirical:1.0, nominal:0.8} (1/1 SCORED hit),
    #   mean_pinball_by_series={"demo-cpi": 1.1666666666666667} (mean over a single SCORED entry
    #   equals that entry's own pinball_mean).
    #
    # pipeline/fixtures/corrupted/ is a byte-for-byte copy of good/ with exactly three
    # deliberate corruptions, each of which this checker must catch:
    #   1. outcomes/demo-cpi--2026-01--r1.json: metrics.pinball_mean changed 1.1666666666666667 -> 1.5
    #   2. registrations/demo-cpi--2026-02--r1.json: sha256 first hex digit changed 6 -> 1
    #   3. ledger.json: stats.n_scored changed 1 -> 2
    # ------------------------------------------------------------------------------

    good_dir = pipeline_dir / "fixtures" / "good"
    corrupted_dir = pipeline_dir / "fixtures" / "corrupted"

    print("=== fixture self-test: GOOD registry (must PASS) ===")
    ok_good, info_good, mism_good, agg_good = check_registry(good_dir, good_dir / "ledger.json")
    print_report(ok_good, info_good, mism_good, agg_good)
    print()

    print("=== fixture self-test: CORRUPTED registry (must FAIL) ===")
    ok_bad, info_bad, mism_bad, agg_bad = check_registry(corrupted_dir, corrupted_dir / "ledger.json")
    print_report(ok_bad, info_bad, mism_bad, agg_bad)
    print()

    selftest_ok = True

    if not ok_good:
        print("SELF-TEST FAILURE: the GOOD fixture was expected to PASS but did not.")
        selftest_ok = False
    elif agg_good is not None:
        expected_mean = 1.1666666666666667
        got_mean = agg_good["stats"]["mean_pinball_by_series"]["demo-cpi"]
        if not num_close(got_mean, expected_mean):
            print(
                f"SELF-TEST FAILURE: good fixture stats.mean_pinball_by_series.demo-cpi recomputed "
                f"as {got_mean!r}, expected {expected_mean!r} by hand."
            )
            selftest_ok = False

    if ok_bad:
        print("SELF-TEST FAILURE: the CORRUPTED fixture was expected to FAIL but PASSED.")
        selftest_ok = False
    else:
        expectations = [
            ("pinball_mean expected=1.1666666666666667 stored=1.5", "planted pinball_mean corruption"),
            ("sha256 expected(recomputed)=", "planted sha256 corruption"),
            ("stats.n_scored", "planted ledger.json stats.n_scored corruption"),
        ]
        for needle, desc in expectations:
            if not any(needle in m for m in mism_bad):
                print(f"SELF-TEST FAILURE: expected to catch the {desc} (looked for {needle!r} in the "
                      f"mismatch list) but did not find it.")
                selftest_ok = False

    # ------------------------------------------------------------------------------
    # Cross-check against the page's own dev fixture: src/fixtures/ledger.fixture.json holds
    # four REAL registrations (built independently by the app.js/build.js side of this project,
    # not by this script) with sha256 values already committed. Recomputing them here is a
    # genuine independent cross-check, not a synthetic one -- and it is the one that actually
    # exercises non-ASCII input: ea-hicp's calendar_source contains a literal U+2019 apostrophe.
    # ------------------------------------------------------------------------------
    print()
    # This is diagnostic, NOT part of the self-test's pass/fail verdict: it reads a file this
    # script does not own (src/fixtures/ledger.fixture.json, maintained by the app.js/build.js
    # side of the project) and reports what it finds. This script's canonical_bytes() uses
    # ensure_ascii=True, the same convention as pipeline/ledger_pipeline.py's
    # canonical_json_bytes() and src/ledger.js's canonicalize() -- see the module docstring --
    # so a MISMATCH here would mean that dev fixture's stored sha256 values were computed with a
    # different (incorrect) canonicalization, a real, worth-reporting fact about the wider
    # codebase, but not evidence that THIS script's own math is wrong: see the good/corrupted
    # fixtures above, which this script fully controls, for that.
    print("=== cross-check: src/fixtures/ledger.fixture.json (external file, informational only) ===")
    dev_fixture = pipeline_dir.parent / "src" / "fixtures" / "ledger.fixture.json"
    if not dev_fixture.is_file():
        print(f"NOTE: {dev_fixture} not found — skipping (not this script's fixture, may move).")
    else:
        try:
            bundle = load_json(dev_fixture)
            regs = bundle.get("registrations", [])
        except Exception as e:
            print(f"NOTE: could not read/parse {dev_fixture}: {e}")
            regs = []
        if not regs:
            print(f"NOTE: {dev_fixture} has no registrations to cross-check.")
        for reg in regs:
            rid = reg.get("id", "<no id>")
            stored = reg.get("sha256")
            try:
                recomputed = recompute_registration_sha256(reg)
            except KeyError as missing:
                print(f"  {rid}: cannot recompute, missing field {missing}")
                continue
            ok_one = recomputed == stored
            print(f"  {rid}: {'matches' if ok_one else 'MISMATCH'} (this script vs. the file's own stored sha256)")
            if not ok_one:
                print(f"      this script(ensure_ascii=True)={recomputed} stored={stored}")

    return selftest_ok


# --------------------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    script_dir = Path(__file__).resolve().parent
    default_registry = script_dir.parent / "data" / "registry"
    default_ledger = default_registry / "ledger.json"

    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--registry", type=Path, default=default_registry,
                         help=f"path to data/registry/ (default: {default_registry})")
    parser.add_argument("--ledger", type=Path, default=default_ledger,
                         help=f"path to ledger.json (default: {default_ledger})")
    parser.add_argument("--fixtures", action="store_true",
                         help="run the self-test against pipeline/fixtures/{good,corrupted} instead")
    args = parser.parse_args(argv)

    if args.fixtures:
        ok = run_fixtures_selftest(script_dir)
        print("FIXTURE SELF-TEST: PASS" if ok else "FIXTURE SELF-TEST: FAIL")
        return 0 if ok else 1

    if not args.registry.is_dir():
        print(f"PASS — no registry directory at {args.registry} (nothing to verify).")
        return 0

    ok, info, mismatches, agg = check_registry(args.registry, args.ledger)
    print_report(ok, info, mismatches, agg)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
