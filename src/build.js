/* build.js — concatenate the Ledger page per the sibling instruments'
 * build pattern (see phantom/src/build.js).
 *
 *   <style>  = chassis.css + page CSS (from body.html's <style> block)
 *   registry = data/registry/ledger.json IF PRESENT, else
 *              src/fixtures/ledger.fixture.json (the build-time fixture:
 *              4 open registrations, zero outcomes, so the deliberate
 *              empty state is what actually renders until a real pipeline
 *              run produces data/registry/ledger.json)
 *   <script> = registryData (JSON, non-executing) + ledger.js (the scoring
 *              kernel) + chassis.js + app.js
 *
 * Deliberately NO Google Fonts / no external <link> of any kind: unlike
 * phantom, Ledger's spec requires zero external requests at runtime, so
 * this page falls back to chassis.css's system-font stack (Georgia/serif,
 * ui-monospace/monospace) rather than reaching out for Spectral/IBM Plex
 * Mono. Emits ../index.html as an artifact-body FRAGMENT: no <html>,
 * <head>, or <body> tags -- meta/link/style/script siblings only, exactly
 * like the sibling instruments, meant to be embedded into the site shell.
 *
 * Run:  node build.js   (from this dir)
 */
'use strict';
var fs = require('fs');
var path = require('path');

var here = __dirname;                    /* ledger/src */
var ledgerRoot = path.join(here, '..');  /* ledger/    */

var kernelJs   = fs.readFileSync(path.join(here, 'ledger.js'), 'utf8');
var chassisCss = fs.readFileSync(path.join(here, 'chassis.css'), 'utf8');
var chassisJs  = fs.readFileSync(path.join(here, 'chassis.js'), 'utf8');
var bodyRaw    = fs.readFileSync(path.join(here, 'body.html'), 'utf8');
var appJs      = fs.readFileSync(path.join(here, 'app.js'), 'utf8');

/* ---- registry: real pipeline output if present, else the build fixture ---- */
var realRegistryPath = path.join(ledgerRoot, 'data', 'registry', 'ledger.json');
var fixturePath = path.join(here, 'fixtures', 'ledger.fixture.json');
var registrySource, registryPathUsed;
if (fs.existsSync(realRegistryPath)) {
  registrySource = fs.readFileSync(realRegistryPath, 'utf8');
  registryPathUsed = realRegistryPath;
} else {
  registrySource = fs.readFileSync(fixturePath, 'utf8');
  registryPathUsed = fixturePath;
}
var registry = JSON.parse(registrySource); /* validates it is well-formed JSON before embedding */
if (!registry.registrations) { console.error('registry JSON missing "registrations" array:', registryPathUsed); process.exit(1); }
registry.outcomes = registry.outcomes || [];
registry.corrections = registry.corrections || [];

/* body.html = <style>…page css…</style> + DOM. Split them out. */
var sIdx = bodyRaw.indexOf('<style>');
var eIdx = bodyRaw.indexOf('</style>');
if (sIdx < 0 || eIdx < 0) { console.error('body.html: <style> block not found'); process.exit(1); }
var pageCss = bodyRaw.slice(sIdx + '<style>'.length, eIdx).trim();
var domHtml = bodyRaw.slice(eIdx + '</style>'.length).trim();

/* Embed the registry as a non-executing JSON script tag. Escaping "</" ->
 * "<\/" is the standard guard against the literal byte sequence "</script"
 * appearing inside a string value and prematurely closing the tag -- this
 * registry is DATA (series titles, URLs, notes), not code, so it gets this
 * guard where the kernel/chassis/app sources (authored code, never
 * containing that sequence) do not need it. */
var registryJson = JSON.stringify(registry, null, 2).replace(/<\//g, '<\\/');

var out =
`<meta charset="utf-8">
<title>Ledger</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<style>
/* ===== chassis.css (shared) ===== */
${chassisCss}

/* ===== page-specific (slots override chassis) ===== */
${pageCss}
</style>

${domHtml}

<script id="registryData" type="application/json">
${registryJson}
</script>
<script id="kernelSrc">
${kernelJs}
</script>
<script>
${chassisJs}
</script>
<script>
${appJs}
</script>
`;

var outFile = path.join(ledgerRoot, 'index.html');
fs.writeFileSync(outFile, out);
console.log('registry source:', registryPathUsed,
  '(' + registry.registrations.length + ' registrations, ' + registry.outcomes.length + ' outcomes, ' + registry.corrections.length + ' corrections)');
console.log('built', outFile, '(' + out.length + ' bytes)');
