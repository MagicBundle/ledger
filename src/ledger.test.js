/*
 * ledger.test.js -- node test for ledger.js.
 *
 * Prints a table of every verification and exits non-zero if any check
 * fails, matching the sibling instruments' test style (phantom.test.js).
 * Every case here is closed-form: hand-computed pinball sums, published
 * NIST SHA-256 test vectors, and small synthetic registries built and
 * checked by arithmetic done independently of ledger.js itself.
 *
 * Run:  node ledger.test.js
 */
'use strict';
var L = require('./ledger.js');

var rows = [];
var failures = 0;
function check(name, measured, expected, tol, note) {
  var ok;
  if (expected === undefined) {
    ok = (measured === undefined);
  } else if (typeof expected === 'boolean' || typeof measured === 'boolean') {
    ok = measured === expected;
  } else if (typeof measured === 'string') {
    ok = measured === expected;
  } else if (expected === null) {
    ok = (note && note.pass !== undefined) ? note.pass : (measured === null);
  } else {
    ok = Math.abs(measured - expected) <= tol;
  }
  if (note && note.pass !== undefined) ok = note.pass;
  if (!ok) failures++;
  rows.push({
    name: name,
    measured: fmt(measured),
    expected: fmt(expected),
    tol: (tol === undefined || tol === null) ? '-' : fmt(tol),
    status: ok ? 'PASS' : 'FAIL'
  });
  return ok;
}
function fmt(x) {
  if (typeof x === 'boolean') return String(x);
  if (x === null || x === undefined) return String(x);
  if (typeof x === 'string') return x.length > 40 ? x.slice(0, 40) + '…' : x;
  if (typeof x !== 'number') return String(x);
  if (x === 0) return '0';
  if (Math.abs(x) < 1e-4 || Math.abs(x) >= 1e6) return x.toExponential(4);
  return x.toFixed(6);
}
function section(t) { rows.push({ section: t }); }

var t0 = Date.now();

/* ===================================================================== *
 * A. Pinball loss -- point cases against the exact piecewise definition.
 * ===================================================================== */
section('A. Pinball loss L_q(y, f_q)');
check('y>f_q, q=0.5: (10-8)*0.5', L.pinballLoss(10, 8, 0.5), 1.0, 1e-12);
check('y<f_q, q=0.5: (12-10)*0.5', L.pinballLoss(10, 12, 0.5), 1.0, 1e-12);
check('y===f_q -> 0 (either branch)', L.pinballLoss(5, 5, 0.3), 0, 1e-12);
check('y>f_q, q=0.9: (1-0)*0.9', L.pinballLoss(1, 0, 0.9), 0.9, 1e-12);
check('y<f_q, q=0.9: (1-0)*0.1', L.pinballLoss(0, 1, 0.9), 0.1, 1e-12);
check('y>f_q, q=0.1: (1-0)*0.1', L.pinballLoss(1, 0, 0.1), 0.1, 1e-12);
check('y<f_q, q=0.1: (1-0)*0.9', L.pinballLoss(0, 1, 0.1), 0.9, 1e-12);
check('asymmetry: under-forecast at q=0.9 costs 9x over-forecast',
  L.pinballLoss(10, 0, 0.9) / L.pinballLoss(0, 10, 0.9), 9, 1e-9);

/* ===================================================================== *
 * B. pinballMean / interval80Hit / absErrMedian -- a hand-computed decile
 *    fan: f_q = 10*q for q in {0.1..0.9}, y = 5 (the exact median).
 *    Per-decile losses computed by hand in the file header derivation:
 *    0.4, 0.6, 0.6, 0.4, 0, 0.4, 0.6, 0.6, 0.4 -> mean 4.0/9.
 * ===================================================================== */
section('B. pinballMean / interval80Hit / absErrMedian (hand-computed fan)');
var fan = {};
L.DECILES.forEach(function (q) { fan[q.toFixed(1)] = +(10 * q).toFixed(1); });
var handLosses = [0.4, 0.6, 0.6, 0.4, 0, 0.4, 0.6, 0.6, 0.4];
var handSum = handLosses.reduce(function (a, b) { return a + b; }, 0);
check('pinballMean(y=5, fan) vs hand sum/9', L.pinballMean(5, fan), handSum / 9, 1e-9);
check('pinballMean(y=5, fan) vs literal 4/9', L.pinballMean(5, fan), 4 / 9, 1e-9);
var byd = L.pinballByDecile(5, fan);
check('pinballByDecile q=0.1 -> 0.4', byd['0.1'], 0.4, 1e-9);
check('pinballByDecile q=0.5 -> 0 (median hit exactly)', byd['0.5'], 0, 1e-12);
check('pinballByDecile q=0.9 -> 0.4', byd['0.9'], 0.4, 1e-9);
check('interval80Hit: y=5 inside [f0.1=1,f0.9=9]', L.interval80Hit(5, fan), true);
check('interval80Hit: y=0.5 below f0.1=1', L.interval80Hit(0.5, fan), false);
check('interval80Hit: y=9.5 above f0.9=9', L.interval80Hit(9.5, fan), false);
check('interval80Hit: boundary y===f0.1 counts as hit', L.interval80Hit(1, fan), true);
check('interval80Hit: boundary y===f0.9 counts as hit', L.interval80Hit(9, fan), true);
check('absErrMedian: |5-5|', L.absErrMedian(5, fan), 0, 1e-12);
check('absErrMedian: |8-5|', L.absErrMedian(8, fan), 3, 1e-12);

/* ===================================================================== *
 * C. scoreRegistration -- a synthetic registration, metrics checked by
 *    hand against the same fan + explicit baselines.
 * ===================================================================== */
section('C. scoreRegistration (synthetic registration + outturn)');
var reg1 = {
  id: 'unit-test--2099-01--r1',
  series: { slug: 'unit-test' },
  forecast: { deciles: fan },
  baselines: { naive: { point: 4 }, rw_drift: { point: 6 } }
};
var m1 = L.scoreRegistration(reg1, 5);
check('scoreRegistration: pinball_mean matches pinballMean directly', m1.pinball_mean, L.pinballMean(5, fan), 1e-12);
check('scoreRegistration: interval80_hit true', m1.interval80_hit, true);
check('scoreRegistration: abs_err_median |5-5|=0', m1.abs_err_median, 0, 1e-12);
check('scoreRegistration: naive_abs_err |5-4|=1', m1.naive_abs_err, 1, 1e-12);
check('scoreRegistration: rw_drift_abs_err |5-6|=1', m1.rw_drift_abs_err, 1, 1e-12);
check('scoreRegistration: pinball_by_decile carried through, q=0.1', m1.pinball_by_decile['0.1'], 0.4, 1e-9);

/* a bad forecast: model median far off, naive happens to be spot on --
   naive should show as clearly better on abs error, model's pinball high */
var m2 = L.scoreRegistration(reg1, 4);
check('bad-model case: naive_abs_err = 0 (naive.point=4=y)', m2.naive_abs_err, 0, 1e-12);
check('bad-model case: abs_err_median = |4-5| = 1 > naive', m2.abs_err_median, 1, 1e-12);
check('bad-model case: naive beats model on abs error here', null, null, null,
  { pass: m2.naive_abs_err < m2.abs_err_median, exp: 'naive_abs_err < abs_err_median' });

/* ===================================================================== *
 * D. canonicalize -- deterministic sorted-key, no-whitespace JSON.
 * ===================================================================== */
section('D. canonicalize (sorted keys, no whitespace)');
check('key order does not matter', L.canonicalize({ b: 1, a: 2 }), '{"a":2,"b":1}');
check('nested objects sorted recursively', L.canonicalize({ z: { d: 1, c: 2 }, a: 1 }), '{"a":1,"z":{"c":2,"d":1}}');
check('arrays keep given order (not sorted)', L.canonicalize({ a: [3, 1, 2] }), '{"a":[3,1,2]}');
check('null and scalars pass through JSON.stringify', L.canonicalize({ a: null, b: true, c: 'x' }), '{"a":null,"b":true,"c":"x"}');
check('two orderings of the same object canonicalize identically',
  L.canonicalize({ x: 1, y: 2, z: 3 }) === L.canonicalize({ z: 3, x: 1, y: 2 }), true);

/* Non-ASCII text is \u-escaped to match Python's json.dumps default
   (ensure_ascii=True) -- the offline pipeline hashes registrations with
   exactly that call, so this is a cross-language interop requirement, not
   a style choice. Oracle strings/hashes below were computed independently
   in Python: json.dumps(obj, sort_keys=True, separators=(',', ':')) then
   hashlib.sha256(...).hexdigest(). */
check('canonicalize escapes an em dash like Python ensure_ascii=True',
  L.canonicalize({ a: '—', b: 'plain', title: 'Q1 — Q2 ’ test' }),
  '{"a":"\\u2014","b":"plain","title":"Q1 \\u2014 Q2 \\u2019 test"}');
check('canonicalize escapes a non-BMP emoji as a UTF-16 surrogate pair (matches Python)',
  L.canonicalize({ emoji: '😀 test' }), '{"emoji":"\\ud83d\\ude00 test"}');
check('sha256 of the em-dash oracle string matches the independent Python hash',
  L.sha256Hex(L.canonicalize({ a: '—', b: 'plain', title: 'Q1 — Q2 ’ test' })),
  '60735e797972a12f56ac9ad340e6dbb54117d505a4bd1b90c5fa222c851181f9');
check('sha256 of the emoji oracle string matches the independent Python hash',
  L.sha256Hex(L.canonicalize({ emoji: '😀 test' })),
  'a8c91ef0a6335bd806a4058cc5aeac664e33c52b2410aeb99282efbe8e57b444');

/* ===================================================================== *
 * E. sha256Hex -- published NIST FIPS 180-4 / RFC test vectors.
 * ===================================================================== */
section('E. sha256Hex (NIST test vectors)');
check('sha256("") ', L.sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
check('sha256("abc")', L.sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
check('sha256(448-bit vector)',
  L.sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
  '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
check('sha256 digest is 64 hex chars', L.sha256Hex('any string').length, 64, 0);
check('sha256 is deterministic (same input, same digest twice)',
  L.sha256Hex('deterministic-check') === L.sha256Hex('deterministic-check'), true);
check('sha256 differs on a one-character change (no obvious collision)',
  L.sha256Hex('registration-a') !== L.sha256Hex('registration-b'), true);
/* a UTF-8 case: euro sign + accented character, to exercise utf8Bytes'
   multi-byte path, checked against an independently-known digest of the
   UTF-8 bytes C2 80.. no -- use the literal string and cross-check length
   invariance instead (multi-byte input still yields a 64-hex digest). */
check('sha256 handles non-ASCII input (EUR sign) -> still 64 hex chars', L.sha256Hex('Luxembourg € debt').length, 64, 0);

/* ===================================================================== *
 * F. verifyRegistrationHash -- round-trip: hash a record, attach it, then
 *    verify; then tamper with one field and confirm verification fails.
 * ===================================================================== */
section('F. verifyRegistrationHash (round-trip + tamper detection)');
var recordFields = {
  fcreg: '0.1', id: 'unit-test--2099-01--r1',
  series: { slug: 'unit-test', title: 'Unit Test Series', dataset: 'ut_1', dims: { geo: 'XX' }, unit: 'PC', source_url: 'https://example.invalid/api' },
  target: { period: '2099-01', release: { expected: '2099-02-15', calendar_source: 'assumption', grace_days: 30 } },
  vintage_policy: 'first-published value at first successful fetch on/after release date scores; later revisions never re-open a verdict',
  engine: { name: 'timesfm', version: '1.2.7', checkpoint: 'google/timesfm-2.0-500m-pytorch', context_span: '2000-01..2098-12', data_cutoff: '2098-12' },
  forecast: { deciles: fan },
  baselines: { naive: { point: 4 }, rw_drift: { point: 6 } },
  created_utc: '2099-01-01T00:00:00Z'
};
var correctHash = L.sha256Hex(L.canonicalize(recordFields));
var validRecord = {};
for (var k in recordFields) validRecord[k] = recordFields[k];
validRecord.sha256 = correctHash;
var v1 = L.verifyRegistrationHash(validRecord);
check('verifyRegistrationHash: valid record verifies ok', v1.ok, true);
check('verifyRegistrationHash: computed matches expected', v1.computed, v1.expected);

var tampered = {};
for (k in validRecord) tampered[k] = validRecord[k];
tampered.forecast = { deciles: (function () { var f = {}; for (var kk in fan) f[kk] = fan[kk]; f['0.5'] = fan['0.5'] + 1; return f; })() };
var v2 = L.verifyRegistrationHash(tampered);
check('verifyRegistrationHash: tampered forecast fails verification', v2.ok, false);

var missingHash = {};
for (k in recordFields) missingHash[k] = recordFields[k];
var v3 = L.verifyRegistrationHash(missingHash);
check('verifyRegistrationHash: missing sha256 field reports not-ok, not a throw', v3.ok, false);

/* ===================================================================== *
 * G. aggregate -- a small synthetic registry, every number hand-checked.
 *    4 registrations: r1 SCORED (good), r2 SCORED (good), r3 UNEVALUABLE,
 *    r4 OPEN (no outcome record at all).
 * ===================================================================== */
section('G. aggregate (synthetic 4-registration registry)');
var seriesA_deciles = fan; /* reuse the same fan shape for two series */
function mkReg(id, slug) {
  return { id: id, series: { slug: slug, title: slug }, forecast: { deciles: seriesA_deciles }, baselines: { naive: { point: 4 }, rw_drift: { point: 6 } } };
}
var g_regs = [mkReg('r1', 'alpha'), mkReg('r2', 'alpha'), mkReg('r3', 'beta'), mkReg('r4', 'beta')];
var g_m1 = L.scoreRegistration(g_regs[0], 5);   /* hits interval, pinball 4/9 */
var g_m2 = L.scoreRegistration(g_regs[1], 9.5); /* misses interval (above f0.9=9) */
var g_outcomes = [
  { id: 'r1', verdict: 'SCORED', metrics: g_m1 },
  { id: 'r2', verdict: 'SCORED', metrics: g_m2 },
  { id: 'r3', verdict: 'UNEVALUABLE', reason: 'discontinued' }
  /* r4: no outcome record at all -> OPEN */
];
var agg = L.aggregate(g_regs, g_outcomes);
check('aggregate: total registrations = 4', agg.total, 4, 0);
check('aggregate: OPEN count = 1 (r4)', agg.counts.OPEN, 1, 0);
check('aggregate: SCORED count = 2 (r1, r2)', agg.counts.SCORED, 2, 0);
check('aggregate: UNEVALUABLE count = 1 (r3)', agg.counts.UNEVALUABLE, 1, 0);
check('aggregate: scoredCount = 2', agg.scoredCount, 2, 0);
check('aggregate: empirical80 coverage = 1/2 (only r1 hits)', agg.empiricalCoverage80, 0.5, 1e-12);
check('aggregate: nominal80 is fixed at 0.80', agg.nominalCoverage80, 0.80, 1e-12);
check('aggregate: bySeries.alpha.n = 2 (r1+r2, both SCORED)', agg.bySeries.alpha.n, 2, 0);
check('aggregate: bySeries.beta has no entry (0 SCORED)', agg.bySeries.beta, undefined);
var expectAlphaPinball = (g_m1.pinball_mean + g_m2.pinball_mean) / 2;
check('aggregate: bySeries.alpha.pinball_mean = mean(r1,r2)', agg.bySeries.alpha.pinball_mean, expectAlphaPinball, 1e-12);

/* the deliberately-empty registry: zero outcomes at all */
var aggEmpty = L.aggregate([mkReg('e1', 'alpha'), mkReg('e2', 'beta')], []);
check('aggregate (empty): OPEN = 2, SCORED = 0', aggEmpty.counts.OPEN === 2 && aggEmpty.counts.SCORED === 0, true);
check('aggregate (empty): empiricalCoverage80 is null, not 0 or NaN', aggEmpty.empiricalCoverage80, null);
check('aggregate (empty): bySeries is empty object', Object.keys(aggEmpty.bySeries).length, 0, 0);
check('aggregate (fully empty registry): total=0, no throw', L.aggregate([], []).total, 0, 0);

/* ===================================================================== *
 * H. upcomingGradings -- sorted by expected release date, OPEN only.
 * ===================================================================== */
section('H. upcomingGradings (OPEN-only, sorted by expected date)');
var uRegs = [
  { id: 'late', series: { slug: 's3', title: 'Late' }, target: { period: '2099-06', release: { expected: '2099-07-01' } } },
  { id: 'early', series: { slug: 's1', title: 'Early' }, target: { period: '2099-01', release: { expected: '2099-02-01' } } },
  { id: 'mid', series: { slug: 's2', title: 'Mid' }, target: { period: '2099-03', release: { expected: '2099-04-01' } } },
  { id: 'already-scored', series: { slug: 's4', title: 'Scored' }, target: { period: '2099-01', release: { expected: '2099-01-15' } } }
];
var uOutcomes = [{ id: 'already-scored', verdict: 'SCORED' }];
var upcoming = L.upcomingGradings(uRegs, uOutcomes);
check('upcomingGradings: excludes the already-scored id', upcoming.some(function (u) { return u.id === 'already-scored'; }), false);
check('upcomingGradings: 3 OPEN entries remain', upcoming.length, 3, 0);
check('upcomingGradings: sorted soonest-first', upcoming.map(function (u) { return u.id; }).join(','), 'early,mid,late');

/* ===================================================================== *
 * Report
 * ===================================================================== */
var w1 = 62, w2 = 14, w3 = 14, w4 = 8, w5 = 6;
function pad(s, w) { s = String(s); return s + Array(Math.max(0, w - s.length + 1)).join(' '); }
console.log(pad('CHECK', w1) + pad('measured', w2) + pad('expected', w3) + pad('tol', w4) + 'STATUS');
console.log(Array(w1 + w2 + w3 + w4 + 8).join('-'));
rows.forEach(function (r) {
  if (r.section) { console.log(''); console.log(r.section); return; }
  console.log(pad(r.name, w1) + pad(r.measured, w2) + pad(r.expected, w3) + pad(r.tol, w4) + r.status);
});
var total = rows.filter(function (r) { return !r.section; }).length;
console.log('');
console.log(total - failures + ' / ' + total + ' checks passed (' + (Date.now() - t0) + ' ms).');
if (failures > 0) { console.log(failures + ' FAILURE(S).'); process.exit(1); }
console.log('All checks green.');
