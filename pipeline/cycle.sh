#!/bin/bash
# cycle.sh — the unattended Ledger cycle. Run daily by launchd
# (~/Library/LaunchAgents/io.iterativeintelligence.ledger.plist); safe to run
# by hand at any time. Every step is idempotent: on a day with nothing to do
# it scores nothing, registers nothing, commits nothing, and exits 0.
#
#   1. score            grade any registration whose data has landed
#   2. register --series all
#                        for each series, register the period after the
#                        latest observed one — SKIP if it already exists
#   3. if the registry changed: compile, rebuild the page, run the
#      independent reference check + kernel tests, commit, push (ledger)
#   4. then sync ONLY the Ledger page into the site repo, commit, push
#      (Cloudflare deploys on push)
#
# Failure policy: any failed step writes logs/LAST-FAILURE, posts a macOS
# notification, and exits non-zero. Nothing is pushed unless the reference
# check and tests pass. The watchdog (a scheduled Claude task) reads
# logs/status.json and raises the alarm if a run is stale or failed.
#
# CYCLE_DRY=1 does everything except commit/push (for testing).

set -u
set -o pipefail

LEDGER="/Users/jeromeverony/Documents/Claude Code projects/Exploration/ledger"
SITE="/Users/jeromeverony/Documents/Claude Code projects/Exploration/site"
PY="$LEDGER/pipeline/.venv/bin/python"
NODE="/Users/jeromeverony/.nvm/versions/node/v20.20.2/bin/node"
export PATH="/Users/jeromeverony/.nvm/versions/node/v20.20.2/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export HF_HUB_OFFLINE=1   # the 2.5 checkpoint is cached; never pull anything new unattended

LOGDIR="$LEDGER/pipeline/logs"
mkdir -p "$LOGDIR"
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
LOG="$LOGDIR/cycle-$(date +%Y-%m-%d).log"
DRY="${CYCLE_DRY:-0}"

log() { printf '%s  %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$LOG"; }

notify() {  # title, body
  /usr/bin/osascript -e "display notification \"$2\" with title \"$1\" sound name \"Basso\"" >/dev/null 2>&1 || true
}

status_write() {  # state, detail
  cat > "$LOGDIR/status.json" <<EOF
{"ran_utc":"$STAMP","state":"$1","detail":"$2","registered":${REGISTERED:-0},"scored":${SCORED:-0},"pushed_ledger":${PUSHED_LEDGER:-false},"pushed_site":${PUSHED_SITE:-false},"dry":$([ "$DRY" = 1 ] && echo true || echo false)}
EOF
}

fail() {
  log "FAIL: $*"
  printf '%s  %s\n' "$STAMP" "$*" >> "$LOGDIR/LAST-FAILURE"
  status_write failed "$*"
  notify "Ledger cycle FAILED" "$*"
  exit 1
}

REGISTERED=0; SCORED=0; PUSHED_LEDGER=false; PUSHED_SITE=false

log "=== Ledger cycle start ($STAMP) dry=$DRY ==="
cd "$LEDGER" || fail "ledger directory missing"

# Refuse to operate on a repository that has diverged from origin: an
# unattended push must never force anything.
git fetch -q origin main 2>>"$LOG" || log "warn: fetch failed (offline?) — continuing with local state"
if [ "$(git rev-list --count HEAD..origin/main 2>/dev/null || echo 0)" != "0" ]; then
  fail "origin/main has commits this machine lacks — pull by hand before the next cycle"
fi

# 1 · score
SCORE_OUT="$("$PY" pipeline/ledger_pipeline.py score 2>&1)"; SCORE_RC=$?
printf '%s\n' "$SCORE_OUT" >> "$LOG"
SCORED=$(printf '%s\n' "$SCORE_OUT" | grep -c ': SCORED\|: UNEVALUABLE' || true)
[ "$SCORE_RC" -ne 0 ] && log "warn: score exited non-zero (see log; usually Eurostat unreachable) — open registrations are retried tomorrow"

# 2 · register (SKIP = already registered = fine; FAIL = real problem)
REG_OUT="$("$PY" pipeline/ledger_pipeline.py register --series all 2>&1)"
printf '%s\n' "$REG_OUT" >> "$LOG"
REGISTERED=$(printf '%s\n' "$REG_OUT" | grep -c '^\[register\] [a-z-]*--' || true)
REG_FAILS=$(printf '%s\n' "$REG_OUT" | grep -c '^\[register\] FAIL' || true)
[ "$REG_FAILS" -ne 0 ] && log "warn: $REG_FAILS series failed to register (see log) — will retry tomorrow"

# 3 · anything new in the registry?
if [ -z "$(git status --porcelain data/registry/registrations data/registry/outcomes data/registry/corrections)" ]; then
  log "registry unchanged: scored=$SCORED registered=$REGISTERED — nothing to publish"
  status_write idle "nothing due"
  log "=== done ==="
  exit 0
fi

log "registry changed: scored=$SCORED registered=$REGISTERED — compiling and verifying"
"$PY" pipeline/ledger_pipeline.py compile >>"$LOG" 2>&1 || fail "compile failed"
"$NODE" src/build.js >>"$LOG" 2>&1 || fail "page build failed"
/usr/bin/python3 pipeline/reference_check.py >>"$LOG" 2>&1 || fail "independent reference check did not pass — nothing pushed"
( cd src && "$NODE" ledger.test.js >>"$LOG" 2>&1 ) || fail "kernel tests failed — nothing pushed"

MSG="ledger: cycle $(date +%Y-%m-%d) — scored $SCORED, registered $REGISTERED"
if [ "$DRY" = 1 ]; then
  log "dry run: would commit + push ledger and site"
  git status --short | tee -a "$LOG"
  status_write dry "would publish: $MSG"
  exit 0
fi

git add data/registry index.html >>"$LOG" 2>&1 || fail "git add failed"
git commit -q -m "$MSG" >>"$LOG" 2>&1 || fail "git commit failed"
git push -q origin main >>"$LOG" 2>&1 || fail "git push (ledger) failed — the registration is committed locally but NOT yet public"
[ "$(git rev-list --count origin/main..HEAD)" = "0" ] || fail "push reported success but HEAD is still ahead of origin"
PUSHED_LEDGER=true
log "ledger pushed: $(git rev-parse --short HEAD)"

# 4 · the site: only the Ledger page, nothing else
cd "$SITE" || fail "site directory missing"
SYNC_ONLY=ledger "$NODE" scripts/sync-content.mjs >>"$LOG" 2>&1 || fail "site sync failed"
if [ -n "$(git status --porcelain public/instruments/ledger/index.html)" ]; then
  git add public/instruments/ledger/index.html >>"$LOG" 2>&1 || fail "site git add failed"
  git commit -q -m "Ledger page: $MSG" >>"$LOG" 2>&1 || fail "site git commit failed"
  git push -q origin main >>"$LOG" 2>&1 || fail "git push (site) failed — ledger is public, site page is stale"
  PUSHED_SITE=true
  log "site pushed: $(git rev-parse --short HEAD)"
else
  log "site page unchanged"
fi

rm -f "$LOGDIR/LAST-FAILURE"
status_write published "$MSG"
notify "Ledger cycle published" "$MSG"
log "=== done ==="
exit 0
