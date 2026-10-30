#!/usr/bin/env bash
# iclone os — the user-run agent update hand-off (Settings › Updates › Agent, door `agent-latest`).
#
# Fork-owned, packaged in the app's Resources/desktop-update/. Unlike upstream's posix.sh (run from the runtime
# checkout) it never swaps or rebuilds an app bundle: iclone os is not the stock Hermes.app the runtime builds.
#
# The whole job: wait for iclone os to exit, run `hermes update --yes --backup --branch main` in the runtime
# (a FULL pre-update backup first), retry once like posix.sh, write the result file the app reads at its next
# launch, record the user's runtime choice on success, reopen iclone os.
#
# No `--gateway`: that flag routes upstream's interactive prompts through a gateway chat; `--yes` answers them and
# the gateway fleet restart runs either way. `--desktop-pid` is this script's own wait, not a `hermes update` flag.
#
# Usage: iclone-agent-update.sh --install-root <HERMES_HOME/hermes-agent> --desktop-pid <pid> --target-sha <sha>
#          [--choice-file <userData/runtime-choice.json>] [--relaunch-bundle-id <id>] [--relaunch-app <path>]
set -u

INSTALL_ROOT="" DESKTOP_PID=0 TARGET_SHA="" CHOICE_FILE="" RELAUNCH_BUNDLE_ID="" RELAUNCH_APP="" BRANCH="main"
while [ $# -gt 0 ]; do
  case "$1" in
    --install-root) INSTALL_ROOT="$2"; shift 2 ;;
    --desktop-pid) DESKTOP_PID="$2"; shift 2 ;;
    --target-sha) TARGET_SHA="$2"; shift 2 ;;
    --choice-file) CHOICE_FILE="$2"; shift 2 ;;
    --relaunch-bundle-id) RELAUNCH_BUNDLE_ID="$2"; shift 2 ;;
    --relaunch-app) RELAUNCH_APP="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 64 ;;
  esac
done
[ -n "$INSTALL_ROOT" ] || { echo "--install-root is required" >&2; exit 64; }

HERMES_HOME="$(dirname "$INSTALL_ROOT")"
MARKER="$HERMES_HOME/.hermes-update-in-progress"
RESULT="$HERMES_HOME/.hermes-update-result.json"
LOG_DIR="$HERMES_HOME/logs"; mkdir -p "$LOG_DIR" 2>/dev/null || true
LOG="$LOG_DIR/iclone-agent-update.log"
STARTED_MS="$(($(date +%s) * 1000))"
FINAL_CODE=1 FINAL_MSG="The agent update did not complete."

log() { echo "$(date +%Y-%m-%dT%H:%M:%S%z) $1" >> "$LOG" 2>/dev/null; }
json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr '\n\r\t' '   '; }

write_result() {
  local ok=false
  [ "$FINAL_CODE" -eq 0 ] && ok=true
  printf '{"ok":%s,"exit_code":%s,"manual":false,"message":"%s","branch":"%s","finished_at":%s,"door":"agent-latest","target_sha":"%s","duration_ms":%s}' \
    "$ok" "$FINAL_CODE" "$(json_escape "$FINAL_MSG")" "$(json_escape "$BRANCH")" "$(date +%s)" \
    "$(json_escape "$TARGET_SHA")" "$(( $(date +%s) * 1000 - STARTED_MS ))" \
    > "$RESULT.tmp" 2>/dev/null && mv -f "$RESULT.tmp" "$RESULT" 2>/dev/null || true
}

# The runtime the user chose: Repair keeps it instead of reinstalling the release's pin.
write_choice() {
  [ -n "$CHOICE_FILE" ] || return 0
  local sha version
  sha="$(git -C "$INSTALL_ROOT" rev-parse HEAD 2>/dev/null | tr -d '[:space:]')"
  case "$sha" in *[!0-9a-f]*|'') log "runtime choice not recorded: HEAD unreadable"; return 0 ;; esac
  [ "${#sha}" -eq 40 ] || return 0
  version="$(sed -n 's/^__version__[[:space:]]*=[[:space:]]*["'\'']\([^"'\'']*\)["'\''].*/\1/p' "$INSTALL_ROOT/hermes_cli/__init__.py" 2>/dev/null | head -1)"
  printf '{"door":"agent-latest","sha":"%s","version":%s,"at":"%s"}\n' "$sha" \
    "$([ -n "$version" ] && printf '"%s"' "$(json_escape "$version")" || echo null)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    > "$CHOICE_FILE.tmp" 2>/dev/null && mv -f "$CHOICE_FILE.tmp" "$CHOICE_FILE" 2>/dev/null || true
}

relaunch() {
  if [ "$(uname)" = "Darwin" ]; then
    if [ -n "$RELAUNCH_BUNDLE_ID" ] && open -b "$RELAUNCH_BUNDLE_ID" >> "$LOG" 2>&1; then return 0; fi
    if [ -n "$RELAUNCH_APP" ] && open "$RELAUNCH_APP" >> "$LOG" 2>&1; then return 0; fi
    return 1
  fi
  [ -n "$RELAUNCH_APP" ] && [ -x "$RELAUNCH_APP" ] || return 1
  nohup "$RELAUNCH_APP" > /dev/null 2>&1 &
}

finish() {
  [ "$FINAL_CODE" -eq 0 ] && write_choice
  write_result
  if [ "$(head -1 "$MARKER" 2>/dev/null | tr -d '[:space:]')" = "$$" ]; then rm -f "$MARKER" 2>/dev/null || true; fi
  relaunch || log "could not reopen iclone os; the result waits for the next launch"
  log "done: code $FINAL_CODE — $FINAL_MSG"
}
trap finish EXIT
trap 'FINAL_CODE=130 FINAL_MSG="The agent update was interrupted."; exit 130' INT TERM HUP

rm -f "$RESULT" 2>/dev/null || true
printf '%s\n%s\n' "$$" "$(date +%s)" > "$MARKER" 2>/dev/null || log "WARNING: could not write the update marker"

if [ "$DESKTOP_PID" -gt 0 ] 2>/dev/null; then
  for _ in $(seq 1 100); do kill -0 "$DESKTOP_PID" 2>/dev/null || break; sleep 0.3; done
  if kill -0 "$DESKTOP_PID" 2>/dev/null; then
    FINAL_CODE=4 FINAL_MSG="Nothing was changed: iclone os (pid $DESKTOP_PID) did not close within 30 s."
    exit 4
  fi
fi

# Only the runtime's own CLI: a hermes found on PATH may belong to another install than --install-root.
HERMES_BIN="$INSTALL_ROOT/venv/bin/hermes"
[ -x "$HERMES_BIN" ] || { FINAL_CODE=3 FINAL_MSG="Nothing was changed: the hermes CLI is missing. Repair the agent from Settings."; exit 3; }
cd "$INSTALL_ROOT" || { FINAL_CODE=3 FINAL_MSG="Nothing was changed: cannot enter $INSTALL_ROOT."; exit 3; }
export PYTHONUNBUFFERED=1

run_update() {
  log "running: hermes update --yes --backup --branch $BRANCH (target ${TARGET_SHA:-unknown})"
  OUT="$("$HERMES_BIN" update --yes --backup --branch "$BRANCH" 2>&1)"; CODE=$?
  printf '%s\n' "$OUT" >> "$LOG" 2>/dev/null
  log "hermes update exit code: $CODE"
}

run_update
# Exit 2 (close every Hermes window) and a parked branch are deterministic: a retry would fail the same way.
if [ "$CODE" -ne 0 ] && [ "$CODE" -ne 2 ] && ! printf '%s' "$OUT" | grep -q "CODE UPDATE SKIPPED"; then
  log "retrying once (a freshly pulled fix loads on the second run)"
  run_update
fi

if [ "$CODE" -eq 0 ]; then
  FINAL_CODE=0 FINAL_MSG="The agent is up to date."
elif printf '%s' "$OUT" | grep -q "CODE UPDATE SKIPPED"; then
  FINAL_CODE=8 FINAL_MSG="Update skipped: the agent checkout is on a branch that is not merged into $BRANCH."
else
  FINAL_CODE="$CODE" FINAL_MSG="The agent update failed (exit $CODE). The backup made before it is in $HERMES_HOME/backups."
fi
exit "$FINAL_CODE"
