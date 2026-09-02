/* =====================================================================
 * suite/chassis/chassis.js
 * Framework-free helpers shared by the STEM instruments suite.
 *
 * Every export below was lifted from at least TWO of the three shipped
 * pages (repulsion / arctic / fever); the "from:" note on each says
 * where.  Single-page code (Fever's spinCanvas, Arctic's tileCanvas /
 * relief / marching-squares, Repulsion's drawStrip / drawHist) is NOT
 * here on purpose — it is domain rendering, not chassis.
 *
 * The seedable PRNG makeRng is NOT duplicated here: it lives in the
 * kernel (repulsion/ensemble.js exports Ensemble.makeRng, aliased .rng)
 * and pages import it from whichever kernel they inline.  See README.
 *
 * Loads the same way the kernels do: attaches to window/self when
 * concatenated into a page, and to module.exports so the node tests can
 * require it.  Nothing here touches document / matchMedia / Worker at
 * load time — only when a helper is called — so require() is safe.
 * ===================================================================== */
(function(root){
'use strict';

/* ---------- tiny DOM + format (all three pages) ---------- */
var $ = function(id){ return document.getElementById(id); };
/* from: all three.  '—' for null/undefined/non-finite, else toFixed(d). */
function fmt(v, d){ return (v === null || v === undefined || !isFinite(v)) ? '—' : v.toFixed(d); }

var FONT_M = '11px "IBM Plex Mono", ui-monospace, monospace';   /* from: all three */
var FONT_S = '11px "IBM Plex Mono", ui-monospace, Menlo, monospace';

/* from: all three.  One-shot feature probe; pages toggle a #noCanvas note. */
function canvasSupported(){
  try{ return !!document.createElement('canvas').getContext('2d'); }catch(e){ return false; }
}
function prefersReducedMotion(){
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/* =====================================================================
 * CANVAS SIZING — fit() with the data-h fix.
 * from: all three (the data-h caching originates in Repulsion; Arctic &
 * Fever added fitBox / fitSquare on top).
 *
 * The fix: a CSS-stretched canvas has NO intrinsic height once width is
 * driven to 100%, so the FIRST fit caches the author's height="NN"
 * attribute into dataset.h and pins style.height, and every later fit
 * reads back that cached number instead of the now-meaningless
 * getAttribute('height').  Without it the canvas collapses on the second
 * layout pass.  DPR is clamped to 2 so retina phones do not allocate 3x
 * or 4x the pixels for no visible gain.
 * ===================================================================== */
function fit(cv){
  var dpr = Math.min((typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1) || 1, 2);
  if(!cv.dataset.h){ cv.dataset.h = cv.getAttribute('height'); cv.style.height = cv.dataset.h + 'px'; }
  var h = +cv.dataset.h, w = cv.clientWidth;
  if(cv.width !== Math.round(w*dpr) || cv.height !== Math.round(h*dpr)){
    cv.width = Math.round(w*dpr); cv.height = Math.round(h*dpr);
  }
  var g = cv.getContext('2d'); if(!g) return null;
  g.setTransform(dpr,0,0,dpr,0,0);
  return {g:g, w:w, h:h};
}
/* from: arctic + fever (SHAPE only — the two pages floor at different
 * heights).  Re-pin data-h to a computed height (used to keep a board
 * square as the column resizes), then fit().
 *
 * `floor` is an ABSOLUTE minimum height, INDEPENDENT of any fitSquare
 * clamp-min: Fever's fitBox hardcodes 60, Arctic's hardcodes 120.  The
 * default here is Fever's 60; a page whose panels must not fall below
 * 120px (Arctic's filmstrip thumbnails) passes floor:120 — see
 * fitSquare.  Keeping the two numbers as one shared default is
 * impossible (they differ), so the floor is a parameter, not a constant.
 * Earlier drafts threaded the fitSquare `min` in as this floor, which is
 * a no-op — fitBox already gets h>=min — and so silently dropped Arctic's
 * 120 floor whenever it sat ABOVE the clamp-min (min 110 thumbnails). */
function fitBox(cv, h, floor){
  h = Math.max(floor === undefined ? 60 : floor, Math.round(h));
  if(cv.dataset.h !== String(h)){ cv.dataset.h = String(h); cv.style.height = h + 'px'; }
  return fit(cv);
}
/* from: arctic + fever (SHAPE only).  Square panel: height tracks width,
 * clamped to [min,max]; `floor` is the absolute minimum handed to fitBox
 * (default 60, Fever's).  Arctic call sites pass floor:120 to preserve
 * their unconditional 120px floor, e.g. fitSquare(cv, 110, 240, 120). */
function fitSquare(cv, min, max, floor){
  var w = cv.clientWidth || (min || 200);
  return fitBox(cv, Math.max(min || 80, Math.min(max || 520, w)), floor === undefined ? 60 : floor);
}

/* =====================================================================
 * THEME — colour reading + the live theme system.
 * from: all three.
 * ===================================================================== */
/* from: fever + arctic.  '#abc' -> [170,187,204]; '#aabbcc' -> [.. ..]. */
function hexRGB(h){
  h = String(h).replace('#','');
  if(h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
  return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
}
/* from: all three (Fever/Arctic shape).  Reads a list of --custom-property
 * names off :root into a flat object, keyed with '-' -> '_', plus a .rgb
 * sub-object holding the hex ones parsed to [r,g,b].  Returns
 * { C, themeKey } where themeKey is a cheap change-detector for caches
 * (pages pass the tokens that flip hardest between light and dark). */
function readColors(names, themeKeyVars){
  var s = getComputedStyle(document.documentElement), C = {}, i;
  for(i=0;i<names.length;i++){
    C[names[i].replace(/-/g,'_')] = s.getPropertyValue('--'+names[i]).trim();
  }
  C.rgb = {};
  for(var k in C){
    if(typeof C[k] === 'string' && C[k].charAt(0) === '#') C.rgb[k] = hexRGB(C[k]);
  }
  var keyVars = themeKeyVars || ['card','ink','line'];
  var key = '';
  for(i=0;i<keyVars.length;i++) key += (i?'|':'') + (C[keyVars[i].replace(/-/g,'_')] || '');
  return { C:C, themeKey:key };
}
/* from: all three.  Fires onChange whenever the effective theme changes,
 * by BOTH routes: an OS-level prefers-color-scheme flip AND a
 * data-theme attribute toggle on <html>.  onChange is where a page
 * re-reads its colours and redraws.  Returns a disposer.  Guard the
 * redraw in the page (all three wrap it in try/catch). */
function watchTheme(onChange){
  var mq = matchMedia('(prefers-color-scheme: dark)');
  var mqHandler = function(){ onChange(); };
  if(mq.addEventListener) mq.addEventListener('change', mqHandler);
  else if(mq.addListener) mq.addListener(mqHandler);          /* older Safari */
  var mo = new MutationObserver(function(){ onChange(); });
  mo.observe(document.documentElement, {attributes:true, attributeFilter:['data-theme']});
  return function dispose(){
    if(mq.removeEventListener) mq.removeEventListener('change', mqHandler);
    else if(mq.removeListener) mq.removeListener(mqHandler);
    mo.disconnect();
  };
}

/* =====================================================================
 * WORKERS — makeWorker(): one Blob-URL Worker over inlined kernel source.
 * from: arctic + fever (Repulsion has no worker).
 *
 * Both pages build a Worker from a Blob that is  "var window=self;\n" +
 * the inlined kernel <script> text + the page's WORKER_BODY.  The
 * "var window=self;" prelude lets a kernel written to export onto
 * `window` run unchanged inside a Worker (where the global is `self`).
 * A page usually builds two Workers off ONE blob URL (a UI worker and a
 * background worker) — pass reuseUrl to share it.
 * ===================================================================== */
function _scriptText(scriptElOrId, mustContain){
  var el = (typeof scriptElOrId === 'string') ? document.getElementById(scriptElOrId) : scriptElOrId;
  if(!el && mustContain){
    /* fallback scan so the lookup never depends on document order */
    var scripts = document.scripts;
    for(var i=0;i<scripts.length;i++){
      if(scripts[i].textContent.indexOf(mustContain) >= 0){ el = scripts[i]; break; }
    }
  }
  return el ? el.textContent : '';
}
/* Returns { worker, url } or throws.  opts:
 *   body       (string)  the WORKER_BODY appended after the kernel   [required]
 *   mustContain(string)  a token that must appear in the kernel source, both
 *                        as the fallback-scan key and as a sanity check
 *   prelude    (string)  defaults to 'var window = self;\n'
 *   reuseUrl   (string)  reuse a blob URL returned by an earlier call
 *   onMessage, onError   handlers wired onto the worker
 * Caller owns termination; revoke the URL when the last worker is gone. */
function makeWorker(scriptElOrId, opts){
  opts = opts || {};
  var url = opts.reuseUrl;
  if(!url){
    var src = _scriptText(scriptElOrId, opts.mustContain);
    if(opts.mustContain && (!src || src.indexOf(opts.mustContain) < 0)){
      throw new Error('kernel source not found for the Worker');
    }
    var prelude = opts.prelude === undefined ? 'var window = self;\n' : opts.prelude;
    var blob = new Blob([prelude, src, '\n', opts.body || ''], {type:'text/javascript'});
    url = URL.createObjectURL(blob);
  }
  var w = new Worker(url);
  if(opts.onMessage) w.onmessage = opts.onMessage;
  if(opts.onError) w.onerror = opts.onError;
  return { worker:w, url:url };
}

/* =====================================================================
 * BATCH / TOKEN — drop stale worker responses after a resample race.
 * from: arctic (S4.token, nToken) + fever (S1.batch, S4.token/snapToken).
 *
 * Every request stamps the current id; when a response comes back the
 * page keeps it only if its id still matches.  makeBatch() packages that
 * so a page does not hand-roll `if(d.token !== S4.token) return;`.
 * ===================================================================== */
function makeBatch(){
  var current = 0;
  return {
    next:   function(){ return ++current; },       /* stamp a new request */
    get current(){ return current; },
    accepts: function(id){ return id === current; }, /* true iff not stale */
    is: function(id){ return id === current; }
  };
}

/* =====================================================================
 * BACKGROUND SAMPLER SCHEDULER — gated on document.hidden.
 * SHAPE from: arctic scheduleTick + fever scheduleTick / scheduleHero.
 * DEFAULT CONSTANTS from: fever only (see below).
 *
 * A self-re-arming setTimeout loop that posts a "tick" to a background
 * worker, NEVER while the tab is hidden, with a fast warm-up phase (fill
 * empty charts while the reader is scrolling in) that decays to a slow
 * steady state (accumulators are capped, so a left-open tab costs a
 * fraction of a core).  Honours reduced motion.  Re-arms itself on
 * visibilitychange.  The page's onTick does the postMessage.
 *
 * ONLY the algorithmic shape is shared by both pages.  The default
 * warmTicks/fast/slow/reducedFast/reducedSlow below are Fever's exact
 * numbers (120 / 20 / 450 / 150 / 600); Arctic's scheduleTick uses a
 * different cadence — warmTicks 4, fast 60, slow 420, and a single FLAT
 * reduced-motion gap of 1400ms with no warm/steady split.  A page on
 * Arctic's tuning MUST pass those explicitly:
 *   makeSampler({ warmTicks:4, fast:60, slow:420,
 *                 reducedFast:1400, reducedSlow:1400, ... })
 * (the flat reduced gap is expressed by setting both reduced* to 1400).
 * Do NOT assume the defaults are validated against both pages.
 * ===================================================================== */
function makeSampler(opts){
  opts = opts || {};
  var onTick   = opts.onTick || function(){};
  var warmTicks= opts.warmTicks === undefined ? 120 : opts.warmTicks;
  var fast     = opts.fast === undefined ? 20  : opts.fast;   /* ms, warm-up  */
  var slow     = opts.slow === undefined ? 450 : opts.slow;   /* ms, steady   */
  var reducedFast = opts.reducedFast === undefined ? 150 : opts.reducedFast;
  var reducedSlow = opts.reducedSlow === undefined ? 600 : opts.reducedSlow;
  var canRun   = opts.canRun || function(){ return true; };   /* e.g. workerOK && running */
  var reduced  = opts.reduced === undefined ? prefersReducedMotion() : opts.reduced;
  var n = 0, timer = null, stopped = false;

  function gap(){
    if(n < warmTicks) return reduced ? reducedFast : fast;
    return reduced ? reducedSlow : slow;
  }
  function schedule(){
    clearTimeout(timer);
    if(stopped || document.hidden) return;             /* hidden: visibilitychange re-arms */
    if(!canRun()){ timer = setTimeout(schedule, 200); return; }  /* re-poll until canRun recovers (was: die permanently — phantom review) */
    timer = setTimeout(function(){ n++; onTick(n); schedule(); }, gap());
  }
  var visHandler = function(){ if(!document.hidden) schedule(); };
  document.addEventListener('visibilitychange', visHandler);

  return {
    /* start() resets the warm-tick counter so a reused sampler re-warms
     * instead of being stuck in the slow phase (phantom review). */
    start: function(){ n = 0; stopped = false; schedule(); },
    /* call from the worker's onmessage to pace the NEXT tick off completion
     * (both pages re-schedule from inside the response handler) */
    kick: schedule,
    stop: function(){ stopped = true; clearTimeout(timer); },
    get ticks(){ return n; },
    dispose: function(){ this.stop(); document.removeEventListener('visibilitychange', visHandler); }
  };
}

/* =====================================================================
 * makeRaf — a requestAnimationFrame loop for MAIN-THREAD animated pages
 * (sunflower's growing seed head, flash's fireflies).  makeSampler above
 * is worker/timeout-shaped and pages had to coerce it (warmTicks ~1e9) to
 * drive a per-frame animation; this is the right tool for that job.
 *  - onFrame(dtMs) is called once per frame while the tab is visible and
 *    opts.canRun() is true; dtMs is the clamped time since the last frame.
 *  - Hidden-gated (rAF already pauses when hidden; we also reset the clock
 *    so there is no dt spike on resume) and reduced-motion aware: under
 *    reduced motion start() is a no-op unless opts.runWhenReduced, so the
 *    page should draw its initial state ONCE and then call start().
 * ===================================================================== */
function makeRaf(onFrame, opts){
  opts = opts || {};
  var reduced = opts.reduced === undefined ? prefersReducedMotion() : opts.reduced;
  var canRun  = opts.canRun || function(){ return true; };
  var maxDt   = opts.maxDt === undefined ? 100 : opts.maxDt;   /* clamp long gaps */
  var raf = 0, last = 0, stopped = true;
  function loop(ts){
    if(stopped) return;
    if(document.hidden || !canRun()){ last = 0; raf = requestAnimationFrame(loop); return; }
    var dt = last ? Math.min(ts - last, maxDt) : 16; last = ts;
    onFrame(dt);
    raf = requestAnimationFrame(loop);
  }
  return {
    start: function(){ if(reduced && !opts.runWhenReduced) return; if(!stopped) return; stopped = false; last = 0; raf = requestAnimationFrame(loop); },
    stop:  function(){ stopped = true; if(raf) cancelAnimationFrame(raf); raf = 0; },
    get running(){ return !stopped; },
    dispose: function(){ this.stop(); }
  };
}

/* =====================================================================
 * DEBOUNCE — coalesce slider input into one worker request.
 * from: arctic requestDial (140ms) + fever requestDial (160ms).
 * ===================================================================== */
function debounce(fn, ms){
  var t = null;
  var wrapped = function(){
    var args = arguments, self = this;
    clearTimeout(t);
    t = setTimeout(function(){ fn.apply(self, args); }, ms);
  };
  wrapped.cancel = function(){ clearTimeout(t); };
  return wrapped;
}

/* =====================================================================
 * RING BUFFER — a bounded accumulator that keeps the last N.
 * from: arctic (S2.radii.slice(-400); worker rows.slice(-2000)) +
 *       fever (tauSeen capped at 60 by deleting the oldest key).
 * A plain array grows without bound in a left-open tab; this drops from
 * the front once full.
 * ===================================================================== */
function ringBuffer(cap){
  var a = [];
  return {
    push: function(v){ a.push(v); if(a.length > cap) a.splice(0, a.length - cap); return a; },
    get length(){ return a.length; },
    get array(){ return a; },              /* live reference, already bounded */
    toArray: function(){ return a.slice(); },
    clear: function(){ a.length = 0; },
    last: function(){ return a.length ? a[a.length-1] : undefined; }
  };
}

/* =====================================================================
 * CHART / AXIS PRIMITIVES.
 *
 * TWO tiers, honestly labelled:
 *   SHARED (in >=2 pages today): frame(), dot(), hline() — Arctic + Fever
 *     both define and call these (identical frame(); Repulsion has its own
 *     simpler axis in drawHist, which stays page-local).
 *   FORWARD-LOOKING (Fever-only today): ring(), vline(), curve(),
 *     emptyMsg().  These live only in Fever right now — Arctic draws its
 *     reference marks and theory curves by hand (inline setLineDash).
 *     They are promoted here deliberately as the chart vocabulary that
 *     pairs with frame()/dot()/hline() for the NEXT pages, NOT because
 *     they already appear in two pages.  If a future page never needs
 *     them they can be pushed back down into Fever as page-local code.
 * ===================================================================== */
/* frame(): grid lines, y/x tick labels, optional axis titles, and the
 * left+bottom axis rules.  Returns { X, Y, L, R, T, B, pw, ph } — X/Y
 * map data coords to pixels.  Needs a colour object C with .line .ink2
 * .ink3 (pass the object your readColors() built). */
function frame(g, w, h, o, C){
  var L = o.L===undefined?46:o.L, Rm = o.R===undefined?14:o.R,
      Tp = o.T===undefined?14:o.T, B = o.B===undefined?34:o.B;
  var pw = w-L-Rm, ph = h-Tp-B;
  var X = function(v){ return L + (v-o.x0)/(o.x1-o.x0)*pw; };
  var Y = function(v){ return Tp + ph - (v-o.y0)/(o.y1-o.y0)*ph; };
  var t, i;
  g.strokeStyle = C.line; g.lineWidth = 1; g.beginPath();
  for(i=0;i<o.yticks.length;i++){ var y = Y(o.yticks[i])+0.5; g.moveTo(L, y); g.lineTo(w-Rm, y); }
  g.stroke();
  g.fillStyle = C.ink2; g.font = FONT_M; g.textAlign='right'; g.textBaseline='middle';
  for(i=0;i<o.yticks.length;i++){ t = o.yticks[i]; g.fillText(o.yfmt? o.yfmt(t) : t.toFixed(2), L-6, Y(t)); }
  g.textAlign='center'; g.textBaseline='top';
  for(i=0;i<o.xticks.length;i++){ t = o.xticks[i]; var v = (t && t.v!==undefined)?t.v:t; g.fillText(o.xfmt? o.xfmt(v) : String(v), X(v), h-B+7); }
  if(o.xlabel){ g.fillStyle = C.ink2; g.font = FONT_S; g.fillText(o.xlabel, L+pw/2, h-B+21); }
  /* Rotated y-axis title.  It sits in the left margin, centered on the plot
   * midpoint — the SAME height as the middle y-tick label, so a fixed x
   * collides with that tick (review finding: garbled "R(phi)" over a tick).
   * Place it LEFT of the tick-label column by measuring the widest tick
   * label (tick labels use FONT_M).  o.ylabelX overrides the auto x. */
  if(o.ylabel){
    g.font = FONT_M; var maxTW = 0;
    for(i=0;i<o.yticks.length;i++){ var lab = o.yfmt? o.yfmt(o.yticks[i]) : o.yticks[i].toFixed(2); var tw = g.measureText(''+lab).width; if(tw>maxTW) maxTW = tw; }
    var lx = o.ylabelX!==undefined ? o.ylabelX : Math.max(8, (L-6) - maxTW - 7);
    g.fillStyle = C.ink2; g.font = FONT_S;
    g.save(); g.translate(lx, Tp+ph/2); g.rotate(-Math.PI/2); g.textAlign='center'; g.textBaseline='middle'; g.fillText(o.ylabel, 0, 0); g.restore();
  }
  g.strokeStyle = C.ink3; g.beginPath();
  g.moveTo(L+0.5, Tp); g.lineTo(L+0.5, Tp+ph+0.5); g.lineTo(w-Rm, Tp+ph+0.5); g.stroke();
  return {X:X, Y:Y, L:L, R:Rm, T:Tp, B:B, pw:pw, ph:ph};
}
function dot(g, x, y, r, colour, alpha){
  g.fillStyle = colour; g.globalAlpha = alpha===undefined?1:alpha;
  g.beginPath(); g.arc(x, y, r, 0, 2*Math.PI); g.fill(); g.globalAlpha = 1;
}
function ring(g, x, y, r, colour, alpha){
  g.strokeStyle = colour; g.lineWidth = 1.6; g.globalAlpha = alpha===undefined?1:alpha;
  g.beginPath(); g.arc(x, y, r, 0, 2*Math.PI); g.stroke(); g.globalAlpha = 1;
}
function hline(g, f, y, colour, dash, width){
  g.strokeStyle = colour; g.lineWidth = width||1.5; if(dash) g.setLineDash(dash);
  g.beginPath(); g.moveTo(f.L, f.Y(y)); g.lineTo(f.L+f.pw, f.Y(y)); g.stroke(); g.setLineDash([]);
}
/* Vertical line at data-x.  Full plot height by default.  Optional `ext`
 * (review finding from sunflower: q_k markers needed baseline->y=2 and the
 * ladder ticks needed a dot cap):
 *   ext.y0 / ext.y1  data-space y-values for the bottom/top of the segment
 *   ext.cap          radius of a filled dot drawn at the top of the segment
 * Back-compatible: callers that omit `ext` get the original full-height line. */
function vline(g, f, x, colour, dash, width, ext){
  var yTop = f.T, yBot = f.T + f.ph;
  if(ext){
    if(ext.y0 !== undefined) yBot = f.Y(ext.y0);
    if(ext.y1 !== undefined) yTop = f.Y(ext.y1);
  }
  g.strokeStyle = colour; g.lineWidth = width||1.5; if(dash) g.setLineDash(dash);
  g.beginPath(); g.moveTo(f.X(x), yTop); g.lineTo(f.X(x), yBot); g.stroke(); g.setLineDash([]);
  if(ext && ext.cap){ g.fillStyle = colour; g.beginPath(); g.arc(f.X(x), yTop, ext.cap, 0, 6.2831853); g.fill(); }
}
function curve(g, f, x0, x1, fn, colour, dash, width){
  g.strokeStyle = colour; g.lineWidth = width||1.8; if(dash) g.setLineDash(dash);
  g.beginPath();
  var started = false;
  for(var i=0;i<=220;i++){
    var x = x0 + (x1-x0)*i/220, y = fn(x);
    if(y === null || !isFinite(y)){ started = false; continue; }
    var px = f.X(x), py = f.Y(y);
    if(!started){ g.moveTo(px,py); started = true; } else g.lineTo(px,py);
  }
  g.stroke(); g.setLineDash([]);
}
function emptyMsg(g, f, txt, C){
  g.fillStyle = C.ink2; g.font = FONT_S; g.textAlign='center'; g.textBaseline='middle';
  g.fillText(txt, f.L+f.pw/2, f.T+f.ph/2);
}
/* from: fever blit() + arctic blitTiling() — the "draw an offscreen
 * ImageData scaled up with smoothing OFF" pattern both use for pixel art. */
function blitSharp(g, off, x, y, w, h){
  g.imageSmoothingEnabled = false;
  g.drawImage(off, x, y, w, h);
  g.imageSmoothingEnabled = true;
}
/* Progressive left-to-right reveal of an offscreen buffer, drawn sharp
 * (smoothing off) and scaled to fill destW x destH.  reveal in [0,1] shows
 * the left fraction; the offscreen's own left fraction is the source, so the
 * image grows in from the left at true aspect.  from: branch (streaming ray
 * field + dial previews); the reveal partner to blitSharp for pages that
 * build an image up over time (a space-time diagram, a growing field). */
function blitCrop(g, off, destW, destH, reveal){
  g.clearRect(0, 0, destW, destH);
  var f = reveal === undefined ? 1 : Math.max(0, Math.min(1, reveal));
  var srcW = Math.max(1, Math.round(off.width * f));
  var dstW = Math.max(1, Math.round(destW * f));
  g.imageSmoothingEnabled = false;
  g.drawImage(off, 0, 0, srcW, off.height, 0, 0, dstW, destH);
  g.imageSmoothingEnabled = true;
}

/* =====================================================================
 * ACCESSIBILITY.
 * from: aria-valuetext on sliders — arctic (labelP/labelN) + fever
 *       (labelDial/labelGuess); role=img + aria-label on canvas — all
 *       three; aria-live announcer — all three (scoreAnnounce etc.).
 * ===================================================================== */
/* Give a range input a spoken value: the raw number is useless read
 * aloud, so pair it with the nearest landmark's name. */
function setSliderText(slider, text){ slider.setAttribute('aria-valuetext', text); }
/* Update the sentence a screen reader reads for a canvas.  Every live
 * canvas in the suite is role="img" with an aria-label kept in sync with
 * what it currently shows. */
function labelCanvas(cv, text){ cv.setAttribute('aria-label', text); }
/* A polite announcer over an aria-live region.  IMPORTANT (review
 * finding): announce ONCE per settled state, not on every worker frame —
 * a verbose live region that fires each tick floods the screen reader.
 * Pass the SETTLED summary (e.g. end-of-round score), not intermediate
 * numbers.  Returns a function; calling it with the same text is a no-op
 * so re-renders do not re-announce. */
function makeAnnouncer(el){
  var last = null;
  return function(msg){
    if(msg === last) return;
    last = msg;
    el.textContent = msg;
  };
}

/* ---------- export ---------- */
var api = {
  $:$, fmt:fmt, FONT_M:FONT_M, FONT_S:FONT_S,
  canvasSupported:canvasSupported, prefersReducedMotion:prefersReducedMotion,
  fit:fit, fitBox:fitBox, fitSquare:fitSquare,
  hexRGB:hexRGB, readColors:readColors, watchTheme:watchTheme,
  makeWorker:makeWorker, makeBatch:makeBatch, makeSampler:makeSampler, makeRaf:makeRaf,
  debounce:debounce, ringBuffer:ringBuffer,
  frame:frame, dot:dot, ring:ring, hline:hline, vline:vline, curve:curve,
  emptyMsg:emptyMsg, blitSharp:blitSharp, blitCrop:blitCrop,
  setSliderText:setSliderText, labelCanvas:labelCanvas, makeAnnouncer:makeAnnouncer
};
if(root) root.Chassis = api;
if(typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this)));
