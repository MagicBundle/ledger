/* =====================================================================
 * Ledger — page controller. Reads window.Ledger (the scoring kernel,
 * ledger.js), window.Chassis, and the registry JSON embedded by build.js
 * in <script id="registryData" type="application/json">. Nothing here
 * fetches anything: the registry is baked into the page at build time,
 * and every "live" number is computed from that embedded snapshot, in
 * this browser, right now — there is no server behind this page at all.
 *
 * Sections wired here, matching body.html:
 *   I   regCards          — one decile-fan card per registration
 *   II  scoreboard        — Ledger.aggregate() + upcomingGradings()
 *   III ledgerRows / correctionsList — the append-only index + corrections
 *   IV  selfTestBtn/-Out  — runs closed-form + real-registry checks live
 * ===================================================================== */
(function () {
'use strict';

var Lg = window.Ledger, Ch = window.Chassis;
var $ = Ch.$;
var SVGNS = 'http://www.w3.org/2000/svg';

/* ---------------------------------------------------------------------
 * Registry loading: parsed once from the <script type="application/json">
 * tag build.js embeds. { registrations:[...], outcomes:[...], corrections:[...] }
 * ------------------------------------------------------------------- */
function loadRegistry() {
  var el = document.getElementById('registryData');
  if (!el) return { registrations: [], outcomes: [], corrections: [] };
  try {
    var data = JSON.parse(el.textContent);
    return {
      registrations: data.registrations || [],
      outcomes: data.outcomes || [],
      corrections: data.corrections || []
    };
  } catch (e) {
    console.error('registry parse failed', e);
    return { registrations: [], outcomes: [], corrections: [] };
  }
}
var REG = loadRegistry();
var outcomeById = {};
REG.outcomes.forEach(function (o) { outcomeById[o.id] = o; });

/* ---------------------------------------------------------------------
 * Small helpers.
 * ------------------------------------------------------------------- */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function fmtVal(v) {
  if (v == null || !isFinite(v)) return '—';
  var av = Math.abs(v);
  if (av >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
  var r = Math.round(v * 100) / 100;
  return String(r);
}
function fmtPct(v, d) { return (v == null || !isFinite(v)) ? '—' : (100 * v).toFixed(d == null ? 1 : d) + '%'; }
function dimsText(dims) {
  if (!dims) return '';
  return Object.keys(dims).map(function (k) { return k + '=' + dims[k]; }).join(', ');
}
function verdictOf(regId) {
  var oc = outcomeById[regId];
  return oc ? oc.verdict : 'OPEN';
}
function chipClassFor(v) { return v === 'SCORED' ? 'scored' : (v === 'UNEVALUABLE' ? 'unevaluable' : 'open'); }

/* ---------------------------------------------------------------------
 * SECTION I — the decile-fan SVG. Pure string template, coloured with
 * var(--token) so a theme flip repaints it via CSS alone (no JS redraw).
 * ------------------------------------------------------------------- */
var DECILE_KEYS = ['0.1', '0.2', '0.3', '0.4', '0.5', '0.6', '0.7', '0.8', '0.9'];

function fanSVGMarkup(reg) {
  var d = reg.forecast.deciles;
  var vals = DECILE_KEYS.map(function (k) { return d[k]; });
  vals.push(reg.baselines.naive.point, reg.baselines.rw_drift.point);
  var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
  var span = hi - lo;
  var pad = span > 0 ? span * 0.18 : (Math.abs(hi) * 0.05 || 1);
  var domainLo = lo - pad, domainHi = hi + pad;

  var W = 680, H = 118, ML = 18, MR = 18;
  var plotW = W - ML - MR;
  var cy = 50;
  function X(v) { return ML + (v - domainLo) / (domainHi - domainLo) * plotW; }

  var bands = [
    { a: '0.1', b: '0.9', h: 30, cls: 'fan-band-0' },
    { a: '0.2', b: '0.8', h: 22, cls: 'fan-band-1' },
    { a: '0.3', b: '0.7', h: 15, cls: 'fan-band-2' },
    { a: '0.4', b: '0.6', h: 9,  cls: 'fan-band-3' }
  ];
  var parts = [];
  parts.push('<line class="fan-axis" x1="' + ML + '" y1="' + cy + '" x2="' + (W - MR) + '" y2="' + cy + '"/>');
  bands.forEach(function (b) {
    var x0 = X(d[b.a]), x1 = X(d[b.b]);
    var x = Math.min(x0, x1), w = Math.max(1, Math.abs(x1 - x0));
    parts.push('<rect class="fan-band ' + b.cls + '" x="' + x.toFixed(2) + '" y="' + (cy - b.h / 2) + '" width="' + w.toFixed(2) + '" height="' + b.h + '" rx="2"/>');
  });
  var xNaive = X(reg.baselines.naive.point), xRw = X(reg.baselines.rw_drift.point);
  parts.push('<line class="fan-naive-line" x1="' + xNaive.toFixed(2) + '" y1="' + (cy - 26) + '" x2="' + xNaive.toFixed(2) + '" y2="' + (cy + 26) + '"/>');
  parts.push('<line class="fan-rw-line" x1="' + xRw.toFixed(2) + '" y1="' + (cy - 26) + '" x2="' + xRw.toFixed(2) + '" y2="' + (cy + 26) + '"/>');
  var xm = X(d['0.5']);
  parts.push('<line class="fan-median-line" x1="' + xm.toFixed(2) + '" y1="' + (cy - 22) + '" x2="' + xm.toFixed(2) + '" y2="' + (cy + 22) + '"/>');
  parts.push('<circle class="fan-median-dot" cx="' + xm.toFixed(2) + '" cy="' + cy + '" r="3.4"/>');

  var x01 = X(d['0.1']), x09 = X(d['0.9']);
  parts.push('<text class="fan-label" x="' + x01.toFixed(2) + '" y="' + (cy + 42) + '" text-anchor="start">' + esc(fmtVal(d['0.1'])) + '</text>');
  parts.push('<text class="fan-label strong" x="' + xm.toFixed(2) + '" y="' + (cy + 42) + '" text-anchor="middle">' + esc(fmtVal(d['0.5'])) + '</text>');
  parts.push('<text class="fan-label" x="' + x09.toFixed(2) + '" y="' + (cy + 42) + '" text-anchor="end">' + esc(fmtVal(d['0.9'])) + '</text>');
  parts.push('<text class="fan-target" x="' + (W - MR) + '" y="14" text-anchor="end">target ' + esc(reg.target.period) + '</text>');

  var label = 'Decile forecast fan for ' + reg.series.title + ', target ' + reg.target.period +
    ', median ' + fmtVal(d['0.5']) + ', 80% interval ' + fmtVal(d['0.1']) + ' to ' + fmtVal(d['0.9']);
  return '<div class="fanwrap"><svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(label) + '">' + parts.join('') + '</svg></div>';
}

/* ---------------------------------------------------------------------
 * SECTION I — registration cards.
 * ------------------------------------------------------------------- */
function renderRegCard(reg) {
  var verdict = verdictOf(reg.id);
  var chip = chipClassFor(verdict);
  var hv = Lg.verifyRegistrationHash(reg);
  var shortHash = reg.sha256.slice(0, 14) + '…';
  var html = '';
  html += '<div class="inst regcard">';
  html += '<div class="row"><span class="lab">' + esc(reg.series.title) + '</span><span class="vchip ' + chip + '">' + esc(verdict) + '</span></div>';
  html += '<div class="subline">' + esc(reg.series.dataset) + ' · ' + esc(dimsText(reg.series.dims)) + ' · ' + esc(reg.series.unit) + '</div>';
  html += fanSVGMarkup(reg);
  html += '<div class="legend fanlegend"><span class="sw-median">median &amp; 80/60/40% bands <span class="tag stored">stored</span></span>' +
          '<span class="sw-naive">naive baseline</span><span class="sw-rw">rw-drift baseline</span></div>';
  html += '<div class="stats">';
  html += '<span>target period<b>' + esc(reg.target.period) + '</b></span>';
  html += '<span>expected release<b>' + esc(reg.target.release.expected) + '</b><span class="sub">grace ' + esc(reg.target.release.grace_days) + 'd</span></span>';
  // Two different things live under "engine": the CHECKPOINT (the weights —
  // license-gated, must stay a 2.x Apache-2.0 id) and the VERSION (the
  // `timesfm` pip package that ran it — tooling, Apache-2.0 at every
  // version). Headline the weights, because that is what a reader means by
  // "which model"; the library version stays visible in the sub-line so the
  // registration remains fully described. Derived from the stored strings,
  // never hard-coded: the registration is immutable and this is display.
  var ckm = /timesfm-([0-9.]+)-([0-9]+m)/i.exec(reg.engine.checkpoint || '');
  var engineHead = ckm ? 'TimesFM ' + ckm[1] + ' \u00b7 ' + ckm[2] : esc(reg.engine.name) + ' ' + esc(reg.engine.version);
  var engineSub = esc(reg.engine.checkpoint) + ' \u00b7 ' + esc(reg.engine.name) + ' library ' + esc(reg.engine.version);
  html += '<span>engine<b>' + engineHead + '</b><span class="sub">' + engineSub + '</span></span>';
  html += '<span>data cutoff<b>' + esc(reg.engine.data_cutoff) + '</b><span class="sub">context ' + esc(reg.engine.context_span) + '</span></span>';
  html += '<span>naive / rw-drift<b>' + esc(fmtVal(reg.baselines.naive.point)) + ' / ' + esc(fmtVal(reg.baselines.rw_drift.point)) + '</b><span class="tag stored">stored</span></span>';
  html += '</div>';
  html += '<div class="ctrl">';
  html += '<button type="button" class="btn-bare hashbtn" data-full="' + esc(reg.sha256) + '" data-short="' + esc(shortHash) + '" data-expanded="0" title="' + esc(reg.sha256) + '">sha256 ' + esc(shortHash) + '</button>';
  html += hv.ok
    ? '<span class="tag live">hash verified, live, right now</span>'
    : '<span class="tag mismatch">HASH MISMATCH — see console</span>';
  html += '</div>';
  if (!hv.ok) console.error('registration hash mismatch', reg.id, hv);
  html += '<p class="cap">Source: <a href="' + esc(reg.series.source_url) + '" target="_blank" rel="noopener noreferrer">' + esc(reg.series.dataset) + ' API query</a> · committed <span class="num">' + esc(reg.created_utc) + '</span> <span class="tag stored">stored</span></p>';
  html += '</div>';
  return html;
}

function renderRegCards() {
  var el = $('regCards');
  if (!REG.registrations.length) { el.innerHTML = '<p class="foot">No registrations in the registry yet.</p>'; return; }
  var sorted = REG.registrations.slice().sort(function (a, b) { return a.created_utc < b.created_utc ? -1 : a.created_utc > b.created_utc ? 1 : 0; });
  el.innerHTML = sorted.map(renderRegCard).join('');
}

/* hash-reveal: tap toggles short <-> full; hover shows full via native title */
document.addEventListener('click', function (ev) {
  var btn = ev.target.closest && ev.target.closest('.hashbtn');
  if (!btn) return;
  var expanded = btn.getAttribute('data-expanded') === '1';
  btn.textContent = 'sha256 ' + (expanded ? btn.getAttribute('data-short') : btn.getAttribute('data-full'));
  btn.setAttribute('data-expanded', expanded ? '0' : '1');
});

/* ---------------------------------------------------------------------
 * SECTION II — scoreboard.
 * ------------------------------------------------------------------- */
function renderScoreboard() {
  var agg = Lg.aggregate(REG.registrations, REG.outcomes);
  var upcoming = Lg.upcomingGradings(REG.registrations, REG.outcomes);
  var el = $('scoreboard');
  var html = '';
  html += '<div class="row"><span class="lab">Verdict counts <span class="tag live">live</span></span>' +
    '<span class="sub">' + agg.total + ' registration' + (agg.total === 1 ? '' : 's') + ' total</span></div>';
  html += '<div class="stats" style="margin-top:10px">';
  html += '<span>open<b class="num">' + agg.counts.OPEN + '</b></span>';
  html += '<span>scored<b class="num">' + agg.counts.SCORED + '</b></span>';
  html += '<span>unevaluable<b class="num">' + agg.counts.UNEVALUABLE + '</b></span>';
  html += '</div>';

  if (agg.scoredCount === 0) {
    html += '<p class="empty-scoreboard"><span class="n">0</span> verdicts · scoreboard empty by design · precedence before performance</p>';
    html += '<p class="cap">Nothing below is graded yet because nothing below <i>can be</i> yet — every registration above is waiting on data that has not been published. That is deliberate: this instrument proves precedence by committing a forecast before the number exists, not by finding a favourable window to backtest against afterward.</p>';
    if (upcoming.length) {
      html += '<h3 style="margin-top:18px">Next expected gradings</h3><ul class="gradelist">';
      upcoming.forEach(function (u) {
        html += '<li><b class="num">' + esc(u.expected) + '</b><span>' + esc(u.title) + ' — target ' + esc(u.target) + '</span></li>';
      });
      html += '</ul>';
    }
  } else {
    var covPct = agg.empiricalCoverage80 == null ? null : agg.empiricalCoverage80 * 100;
    html += '<h3 style="margin-top:18px">80% interval coverage <span class="tag live">live</span></h3>';
    html += '<p class="cap">Empirical share of SCORED registrations whose registered [f<sub>0.1</sub>, f<sub>0.9</sub>] interval actually contained the outturn, against the nominal 80% the deciles are supposed to deliver. The black tick marks nominal; the bar is what actually happened.</p>';
    html += '<div class="covbar"><div class="fill" style="width:' + Math.max(0, Math.min(100, covPct)).toFixed(1) + '%"></div><div class="nominal" style="left:80%"></div></div>';
    html += '<div class="stats"><span>empirical coverage<b class="num">' + fmtPct(agg.empiricalCoverage80, 1) + '</b><span class="tag live">live</span></span>' +
      '<span>nominal coverage<b class="num">80.0%</b></span>' +
      '<span>scored registrations<b class="num">' + agg.scoredCount + '</b></span></div>';

    html += '<h3 style="margin-top:20px">Mean pinball loss by series <span class="tag live">live</span></h3>';
    html += '<div class="tablewrap" style="overflow-x:auto"><table class="led"><thead><tr><th>Series</th><th>n</th><th>mean pinball</th><th>median abs err (model)</th><th>naive abs err</th><th>rw-drift abs err</th></tr></thead><tbody>';
    Object.keys(agg.bySeries).sort().forEach(function (slug) {
      var s = agg.bySeries[slug];
      html += '<tr><td data-col="Series" class="n">' + esc(slug) + '</td>' +
        '<td data-col="n">' + s.n + '</td>' +
        '<td data-col="mean pinball">' + s.pinball_mean.toFixed(4) + '</td>' +
        '<td data-col="median abs err">' + s.abs_err_median_mean.toFixed(4) + '</td>' +
        '<td data-col="naive abs err">' + s.naive_abs_err_mean.toFixed(4) + '</td>' +
        '<td data-col="rw-drift abs err">' + s.rw_drift_abs_err_mean.toFixed(4) + '</td></tr>';
    });
    html += '</tbody></table></div>';
    html += '<p class="cap">Pinball loss and absolute error are different units (a nine-decile average vs one point-forecast error) and are never divided into each other here — the naive/rw-drift columns exist so a reader can see, series by series, whether the model’s median beat a baseline that requires no model at all.</p>';
  }
  el.innerHTML = html;
}

/* ---------------------------------------------------------------------
 * SECTION III — the ledger table + corrections.
 * ------------------------------------------------------------------- */
function renderLedgerTable() {
  var tbody = $('ledgerRows');
  var sorted = REG.registrations.slice().sort(function (a, b) { return a.created_utc < b.created_utc ? -1 : a.created_utc > b.created_utc ? 1 : 0; });
  if (!sorted.length) { tbody.innerHTML = '<tr><td colspan="6" class="n">No registrations yet.</td></tr>'; return; }
  tbody.innerHTML = sorted.map(function (reg) {
    var verdict = verdictOf(reg.id);
    var chip = chipClassFor(verdict);
    var shortHash = reg.sha256.slice(0, 10) + '…';
    return '<tr>' +
      '<td data-col="ID" class="n">' + esc(reg.id) + '</td>' +
      '<td data-col="Series">' + esc(reg.series.slug) + '</td>' +
      '<td data-col="Target" class="n">' + esc(reg.target.period) + '</td>' +
      '<td data-col="Committed" class="n">' + esc(reg.created_utc) + '</td>' +
      '<td data-col="SHA-256" class="hash" title="' + esc(reg.sha256) + '">' + esc(shortHash) + '</td>' +
      '<td data-col="Status"><span class="vchip ' + chip + '">' + esc(verdict) + '</span></td>' +
      '</tr>';
  }).join('');
}

function renderCorrections() {
  var el = $('correctionsList');
  if (!REG.corrections.length) {
    el.innerHTML = '<p>No corrections have been filed. Corrections appear here, dated, the moment any are — the original registration they refer to is never edited.</p>';
    return;
  }
  var sorted = REG.corrections.slice().sort(function (a, b) { return (a.date || '') < (b.date || '') ? -1 : 1; });
  el.innerHTML = '<table class="led"><thead><tr><th>Date</th><th>Applies to</th><th>Correction</th></tr></thead><tbody>' +
    sorted.map(function (c) {
      return '<tr><td data-col="Date" class="n">' + esc(c.date) + '</td><td data-col="Applies to" class="n">' + esc(c.applies_to) + '</td><td data-col="Correction">' + esc(c.text) + '</td></tr>';
    }).join('') + '</tbody></table>';
}

/* ---------------------------------------------------------------------
 * SECTION IV — self-test. Re-runs the same closed-form checks as
 * ledger.test.js (kept independent, not required()-shared, so a bug that
 * only manifests in the browser bundle still gets caught), plus a live
 * pass over the REAL embedded registry's hashes.
 * ------------------------------------------------------------------- */
function runSelfTest() {
  $('selfTestBtn').disabled = true;
  $('selfTestSummary').textContent = 'Running…';
  $('selfTestOut').textContent = '';
  setTimeout(function () {
    var lines = [], pass = 0, fail = 0;
    function check(name, ok, detail) {
      if (ok) pass++; else fail++;
      lines.push((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  — ' + detail : ''));
    }

    /* 1. pinball loss closed forms */
    check('pinballLoss(10,8,0.5) === 1.0', Lg.pinballLoss(10, 8, 0.5) === 1.0);
    check('pinballLoss(10,12,0.5) === 1.0', Lg.pinballLoss(10, 12, 0.5) === 1.0);
    check('pinballLoss(1,0,0.9) === 0.9 (under-forecast, high quantile)', Math.abs(Lg.pinballLoss(1, 0, 0.9) - 0.9) < 1e-12);
    check('pinballLoss(0,1,0.9) === 0.1 (over-forecast, high quantile)', Math.abs(Lg.pinballLoss(0, 1, 0.9) - 0.1) < 1e-12);

    /* 2. hand-computed fan: f_q = 10q, y = 5 -> mean 4/9 */
    var fan = {};
    Lg.DECILES.forEach(function (q) { fan[q.toFixed(1)] = +(10 * q).toFixed(1); });
    var pm = Lg.pinballMean(5, fan);
    check('pinballMean(5, {f_q=10q}) === 4/9', Math.abs(pm - 4 / 9) < 1e-9, pm.toFixed(6));
    check('interval80Hit boundary: y===f0.1 counts as a hit', Lg.interval80Hit(1, fan) === true);
    check('interval80Hit boundary: y===f0.9 counts as a hit', Lg.interval80Hit(9, fan) === true);
    check('interval80Hit: outside the interval is a miss', Lg.interval80Hit(9.5, fan) === false);

    /* 3. canonicalize + sha256: NIST vectors + round-trip + tamper */
    check('sha256Hex("") matches the NIST empty-string vector',
      Lg.sha256Hex('') === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    check('sha256Hex("abc") matches the NIST vector',
      Lg.sha256Hex('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    var sample = { fcreg: '0.1', id: 'x', forecast: { deciles: fan } };
    var h = Lg.sha256Hex(Lg.canonicalize(sample));
    var withHash = { fcreg: '0.1', id: 'x', forecast: { deciles: fan }, sha256: h };
    var vOk = Lg.verifyRegistrationHash(withHash);
    check('verifyRegistrationHash: round-trip on a fresh hash verifies', vOk.ok === true);
    var tampered = { fcreg: '0.1', id: 'x', forecast: { deciles: { '0.1': 999 } }, sha256: h };
    var vBad = Lg.verifyRegistrationHash(tampered);
    check('verifyRegistrationHash: a tampered field fails verification', vBad.ok === false);

    /* 4. aggregate on a synthetic mini-registry */
    var regs = [
      { id: 'r1', series: { slug: 'a' }, forecast: { deciles: fan }, baselines: { naive: { point: 4 }, rw_drift: { point: 6 } } },
      { id: 'r2', series: { slug: 'a' }, forecast: { deciles: fan }, baselines: { naive: { point: 4 }, rw_drift: { point: 6 } } }
    ];
    var m1 = Lg.scoreRegistration(regs[0], 5), m2 = Lg.scoreRegistration(regs[1], 9.5);
    var agg = Lg.aggregate(regs, [{ id: 'r1', verdict: 'SCORED', metrics: m1 }, { id: 'r2', verdict: 'SCORED', metrics: m2 }]);
    check('aggregate: SCORED=2, OPEN=0 on a fully-scored mini-registry', agg.counts.SCORED === 2 && agg.counts.OPEN === 0);
    check('aggregate: empirical80 coverage = 1/2 (only r1 hits)', Math.abs(agg.empiricalCoverage80 - 0.5) < 1e-12);
    var aggEmpty = Lg.aggregate(regs, []);
    check('aggregate: zero outcomes -> empiricalCoverage80 is null, not 0', aggEmpty.empiricalCoverage80 === null);

    /* 5. the REAL embedded registry: every stored hash re-verified live */
    lines.push('');
    lines.push('Live hash re-verification of the ' + REG.registrations.length + ' registration(s) embedded in this page:');
    REG.registrations.forEach(function (reg) {
      var v = Lg.verifyRegistrationHash(reg);
      check('sha256 of ' + reg.id + ' matches its own fields', v.ok, v.ok ? v.computed.slice(0, 16) + '…' : ('expected ' + v.expected + ' got ' + v.computed));
    });

    var summary = pass + ' / ' + (pass + fail) + ' checks passed, live, just now.';
    $('selfTestSummary').textContent = summary;
    $('selfTestOut').textContent = lines.join('\n');
    $('selfTestBtn').disabled = false;
  }, 20);
}

/* ---------------------------------------------------------------------
 * Boot.
 * ------------------------------------------------------------------- */
function boot() {
  renderRegCards();
  renderScoreboard();
  renderLedgerTable();
  renderCorrections();
  $('selfTestBtn').addEventListener('click', runSelfTest);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

})();
