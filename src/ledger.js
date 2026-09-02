/*
 * ledger.js -- the scoring kernel for Ledger, Iterative Intelligence
 * instrument #8: "the forecast that grades itself."
 *
 * Self-contained, dependency-free, plain script (no modules / no imports,
 * matching the suite convention set by phantom.js / twdist.js). Attaches
 * `window.Ledger` in a browser and `module.exports` in Node so the same
 * code path runs the live page and `node ledger.test.js`.
 *
 * WHAT LIVES HERE (all of it EXACT arithmetic -- closed forms, not fits):
 *
 *  1. Pinball (quantile) loss and the aggregates built from it, per the
 *     binding spec:
 *       L_q(y, f_q) = (y - f_q) * q         if y >= f_q
 *                   = (f_q - y) * (1 - q)   otherwise
 *     pinball_mean = mean of L_q over the 9 registered deciles q in
 *       {0.1, 0.2, ..., 0.9}. interval80_hit = (f_0.1 <= y <= f_0.9).
 *     abs_err_median = |y - f_0.5|, compared against the registered naive
 *     and random-walk-with-drift baseline POINT forecasts (their absolute
 *     errors, NOT run through pinball -- a point forecast has no quantile
 *     spread to score against).
 *
 *  2. Canonicalisation + SHA-256, used two ways: (a) the offline pipeline
 *     hashes a registration's fields (every field above "sha256", sorted
 *     keys, no whitespace) to produce the value stored in the registry
 *     file; (b) this SAME code, inlined into the page, recomputes that
 *     hash live, in the browser, for every registration on screen, so the
 *     "stored" hash is never taken on faith -- it is the house doctrine's
 *     "independent reference check recomputes every published metric by a
 *     separate code path" applied to the registry's own integrity, not
 *     just to the scoring math.
 *
 *  3. Registry-wide aggregates for the Scoreboard: verdict counts (OPEN /
 *     SCORED / UNEVALUABLE), empirical 80% interval coverage across SCORED
 *     verdicts vs the nominal 0.80, and per-series means of pinball_mean
 *     and abs_err_median (model vs naive vs rw_drift). The empty-registry
 *     case (zero outcomes) returns null aggregates rather than 0/0 -- the
 *     page renders that as the deliberate empty state, not as a zero.
 *
 * Nothing here fetches anything or reads the DOM; app.js does that.
 */
;(function (global) {
  'use strict';

  /* ===================================================================== *
   * 1. Pinball loss and the per-registration score.
   * ===================================================================== */

  var DECILES = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];

  /* key a decile the same way the fcreg schema does: "0.1" .. "0.9" */
  function qkey(q) { return q.toFixed(1); }

  function pinballLoss(y, fq, q) {
    if (y >= fq) return (y - fq) * q;
    return (fq - y) * (1 - q);
  }

  /* deciles: { "0.1": x, ..., "0.9": x } -> { "0.1": loss, ... } */
  function pinballByDecile(y, deciles) {
    var out = {};
    for (var i = 0; i < DECILES.length; i++) {
      var k = qkey(DECILES[i]);
      out[k] = pinballLoss(y, deciles[k], DECILES[i]);
    }
    return out;
  }

  function pinballMean(y, deciles) {
    var byd = pinballByDecile(y, deciles);
    var sum = 0;
    for (var i = 0; i < DECILES.length; i++) sum += byd[qkey(DECILES[i])];
    return sum / DECILES.length;
  }

  function interval80Hit(y, deciles) {
    return y >= deciles['0.1'] && y <= deciles['0.9'];
  }

  function absErrMedian(y, deciles) {
    return Math.abs(y - deciles['0.5']);
  }

  /* Score one registration against its realised outturn value. Returns the
   * exact `metrics` object the fcreg outcomes/<id>.json schema expects.
   * Pure function: same registration + same y -> bit-identical metrics,
   * every time, in the pipeline or in the browser. */
  function scoreRegistration(registration, y) {
    var deciles = registration.forecast.deciles;
    var pinball_by_decile = pinballByDecile(y, deciles);
    var pinball_mean = pinballMean(y, deciles);
    var interval80_hit = interval80Hit(y, deciles);
    var abs_err_median = absErrMedian(y, deciles);
    var naive_abs_err = Math.abs(y - registration.baselines.naive.point);
    var rw_drift_abs_err = Math.abs(y - registration.baselines.rw_drift.point);
    return {
      pinball_mean: pinball_mean,
      pinball_by_decile: pinball_by_decile,
      interval80_hit: interval80_hit,
      abs_err_median: abs_err_median,
      naive_abs_err: naive_abs_err,
      rw_drift_abs_err: rw_drift_abs_err
    };
  }

  /* ===================================================================== *
   * 2. Canonical JSON + SHA-256 (FIPS 180-4), pure JS, no Web Crypto
   *    dependency -- so it runs identically in Node (fixture generation,
   *    node ledger.test.js) and in every browser, including file:// and
   *    non-secure-context embeds where crypto.subtle may be unavailable.
   * ===================================================================== */

  /* String literal, ASCII-only: JSON.stringify already escapes quotes,
   * backslashes and control characters correctly, so this only has to
   * additionally \uXXXX-escape anything left over that is not printable
   * ASCII (code unit > 0x7E) -- which is exactly Python's json.dumps
   * default ensure_ascii=True behaviour, INCLUDING how it renders a
   * character outside the Basic Multilingual Plane: JS strings are UTF-16
   * internally, so a non-BMP code point is already split into the same
   * two surrogate code units Python's ensure_ascii encodes as two \u
   * escapes -- escaping unit-by-unit reproduces that byte-for-byte with
   * no special-casing. This is NOT a stylistic choice: the offline
   * pipeline that fills data/registry/ledger.json hashes with Python's
   * `json.dumps(fields, sort_keys=True, separators=(',', ':'))`, which
   * defaults to ensure_ascii=True, so any registration whose text (a
   * calendar_source note, a title) contains a non-ASCII character (an
   * em dash, a curly apostrophe) would otherwise hash differently here
   * than it did at registration time -- a real cross-language mismatch
   * caught by exactly this: two of the first four real registrations
   * this instrument ever produced failed verification before this fix. */
  function jsonStringEscape(str) {
    var s = JSON.stringify(str);
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var code = s.charCodeAt(i);
      out += (code > 0x7E) ? ('\\u' + ('0000' + code.toString(16)).slice(-4)) : s[i];
    }
    return out;
  }

  /* Deterministic string form: object keys sorted (recursively), arrays
   * keep their given order, no inserted whitespace, non-ASCII text
   * \u-escaped. Matches the fcreg spec's "canonical JSON of every field
   * above this one, sorted keys, no whitespace" AND the offline pipeline's
   * actual Python json.dumps(sort_keys=True, separators=(',',':'))
   * (ensure_ascii=True by default) byte-for-byte -- verified in
   * ledger.test.js against real Python-computed oracle hashes. */
  function canonicalize(value) {
    if (typeof value === 'string') return jsonStringEscape(value);
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) {
      var items = new Array(value.length);
      for (var i = 0; i < value.length; i++) items[i] = canonicalize(value[i]);
      return '[' + items.join(',') + ']';
    }
    var keys = Object.keys(value).sort();
    var parts = new Array(keys.length);
    for (var k = 0; k < keys.length; k++) {
      parts[k] = jsonStringEscape(keys[k]) + ':' + canonicalize(value[keys[k]]);
    }
    return '{' + parts.join(',') + '}';
  }

  /* UTF-8 encode a JS string to an array of bytes (0..255). Handles the
   * full BMP + surrogate pairs via codePointAt, so non-ASCII title/unit
   * strings hash correctly. */
  function utf8Bytes(str) {
    var bytes = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.codePointAt(i);
      if (c > 0xFFFF) i++; /* consumed a surrogate pair */
      if (c < 0x80) {
        bytes.push(c);
      } else if (c < 0x800) {
        bytes.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
      } else if (c < 0x10000) {
        bytes.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
      } else {
        bytes.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 0x3F), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
      }
    }
    return bytes;
  }

  var K256 = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

  /* sha256Hex(str): the lower-case hex digest of the UTF-8 bytes of `str`.
   * Standard FIPS 180-4 message schedule/compression, unrolled to plain
   * 32-bit ops (Node and every browser back to ES5 has these). Verified
   * against the NIST test vectors ("", "abc", the 448-bit vector) in
   * ledger.test.js. */
  function sha256Hex(str) {
    var bytes = utf8Bytes(str);
    var bitLen = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    var hi = Math.floor(bitLen / 0x100000000);
    var lo = bitLen >>> 0;
    bytes.push((hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff,
               (lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff);

    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var W = new Uint32Array(64);

    for (var offset = 0; offset < bytes.length; offset += 64) {
      var t;
      for (t = 0; t < 16; t++) {
        var j = offset + t * 4;
        W[t] = ((bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3]) >>> 0;
      }
      for (t = 16; t < 64; t++) {
        var s0 = rotr(W[t - 15], 7) ^ rotr(W[t - 15], 18) ^ (W[t - 15] >>> 3);
        var s1 = rotr(W[t - 2], 17) ^ rotr(W[t - 2], 19) ^ (W[t - 2] >>> 10);
        W[t] = (W[t - 16] + s0 + W[t - 7] + s1) >>> 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (t = 0; t < 64; t++) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        var ch = (e & f) ^ (~e & g);
        var temp1 = (h + S1 + ch + K256[t] + W[t]) >>> 0;
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var temp2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + temp1) >>> 0;
        d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
    }
    var hex = '';
    for (var i = 0; i < 8; i++) hex += ('00000000' + H[i].toString(16)).slice(-8);
    return hex;
  }

  /* Recompute a registration's sha256 from its own fields (everything
   * except the "sha256" key itself) and report whether it matches the
   * stored value. Returns { ok, expected, computed }. `ok` is false (not
   * thrown) on a missing/malformed sha256 field, so a corrupt record shows
   * up on the Ledger table as a failed check rather than a page crash. */
  function verifyRegistrationHash(registration) {
    var copy = {}, k;
    for (k in registration) {
      if (Object.prototype.hasOwnProperty.call(registration, k) && k !== 'sha256') copy[k] = registration[k];
    }
    var computed = sha256Hex(canonicalize(copy));
    var expected = registration.sha256;
    return { ok: typeof expected === 'string' && expected.toLowerCase() === computed, expected: expected, computed: computed };
  }

  /* ===================================================================== *
   * 3. Registry-wide aggregates for the Scoreboard.
   * ===================================================================== */

  function mean(arr) {
    if (!arr.length) return null;
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += arr[i];
    return s / arr.length;
  }

  function median(arr) {
    if (!arr.length) return null;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var n = a.length, mid = Math.floor(n / 2);
    return (n % 2) ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  }

  /* aggregate(registrations, outcomes):
   *   registrations: array of fcreg registration objects
   *   outcomes:      array of fcreg outcome objects ({ id, verdict, reason,
   *                  outturn, metrics, scored_utc }), one per SCORED or
   *                  UNEVALUABLE registration (an id with no outcome entry
   *                  is OPEN by definition -- there is no separate "OPEN"
   *                  file, per the append-only registry design).
   *
   * Returns a plain object; every SCORED-only aggregate is null (not 0 or
   * NaN) when there are zero SCORED verdicts, so the page can render the
   * deliberate empty state instead of a misleading zero. */
  function aggregate(registrations, outcomes) {
    registrations = registrations || [];
    outcomes = outcomes || [];

    var outcomeById = {};
    for (var i = 0; i < outcomes.length; i++) outcomeById[outcomes[i].id] = outcomes[i];

    var counts = { OPEN: 0, SCORED: 0, UNEVALUABLE: 0 };
    var scored = [];
    for (i = 0; i < registrations.length; i++) {
      var reg = registrations[i];
      var oc = outcomeById[reg.id];
      if (!oc) { counts.OPEN++; continue; }
      if (oc.verdict === 'SCORED') { counts.SCORED++; scored.push({ reg: reg, oc: oc }); }
      else if (oc.verdict === 'UNEVALUABLE') { counts.UNEVALUABLE++; }
      else { counts.OPEN++; } /* defensive: unrecognised verdict treated as still-open */
    }

    var hits = 0;
    for (i = 0; i < scored.length; i++) if (scored[i].oc.metrics.interval80_hit) hits++;
    var empiricalCoverage80 = scored.length ? hits / scored.length : null;

    var bySeries = {};
    for (i = 0; i < scored.length; i++) {
      var slug = scored[i].reg.series.slug;
      var m = scored[i].oc.metrics;
      if (!bySeries[slug]) bySeries[slug] = { n: 0, pinball: [], absErr: [], naiveErr: [], rwErr: [] };
      var s = bySeries[slug];
      s.n++;
      s.pinball.push(m.pinball_mean);
      s.absErr.push(m.abs_err_median);
      s.naiveErr.push(m.naive_abs_err);
      s.rwErr.push(m.rw_drift_abs_err);
    }
    var seriesSummary = {};
    for (var slug2 in bySeries) {
      var b = bySeries[slug2];
      seriesSummary[slug2] = {
        n: b.n,
        pinball_mean: mean(b.pinball),
        abs_err_median_mean: mean(b.absErr),
        naive_abs_err_mean: mean(b.naiveErr),
        rw_drift_abs_err_mean: mean(b.rwErr)
      };
    }

    return {
      total: registrations.length,
      counts: counts,
      scoredCount: scored.length,
      empiricalCoverage80: empiricalCoverage80,
      nominalCoverage80: 0.80,
      bySeries: seriesSummary
    };
  }

  /* Next expected grading date per still-OPEN registration, soonest first
   * -- used by the empty-state scoreboard so "0 verdicts" still names
   * something concrete on the calendar rather than reading as inert. */
  function upcomingGradings(registrations, outcomes) {
    registrations = registrations || []; outcomes = outcomes || [];
    var scoredIds = {};
    for (var i = 0; i < outcomes.length; i++) scoredIds[outcomes[i].id] = true;
    var open = [];
    for (i = 0; i < registrations.length; i++) {
      var r = registrations[i];
      if (scoredIds[r.id]) continue;
      open.push({ id: r.id, series: r.series.slug, title: r.series.title, target: r.target.period, expected: r.target.release.expected });
    }
    open.sort(function (a, b) { return a.expected < b.expected ? -1 : a.expected > b.expected ? 1 : 0; });
    return open;
  }

  /* ---------- export ---------- */
  var api = {
    DECILES: DECILES,
    pinballLoss: pinballLoss,
    pinballByDecile: pinballByDecile,
    pinballMean: pinballMean,
    interval80Hit: interval80Hit,
    absErrMedian: absErrMedian,
    scoreRegistration: scoreRegistration,
    canonicalize: canonicalize,
    sha256Hex: sha256Hex,
    verifyRegistrationHash: verifyRegistrationHash,
    mean: mean,
    median: median,
    aggregate: aggregate,
    upcomingGradings: upcomingGradings
  };
  if (global) global.Ledger = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this)));
