#!/usr/bin/env bash
# verify.sh — proves a runtime update actually worked. Run it AFTER
# `hermes update`, with the pre-flight's state snapshot still on disk.
#
# Usage:  bash scripts/verify.sh [path-to-state-snapshot]
#         (defaults to the newest ~/.hermes-update-backups/home-state-*)
#
# Every check prints what it saw, not just a tick. Exits non-zero if any
# check fails. "exit 0" from the updater is not evidence: on 2026-08-30 the
# same run reported a desktop GUI build as non-fatal while still exiting 0.

set -uo pipefail
# The runtime is a blob:none promisor clone: no lazy fetch, no index refresh write.
export GIT_NO_LAZY_FETCH=1 GIT_OPTIONAL_LOCKS=0

HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
INSTALL="$HERMES_HOME/hermes-agent"
SNAP="${1:-$(ls -dt "$HOME"/.hermes-update-backups/home-state-* 2>/dev/null | head -1)}"

fail=0
say() { printf '%s\n' "$*"; }
ok()  { printf '  \033[32mok\033[0m   %s\n' "$*"; }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; fail=1; }

say "── the runtime itself ───────────────────────────────────────────────"
VER=$(hermes --version 2>&1 | head -1)
[ -n "$VER" ] && ok "$VER" || bad "hermes --version produced nothing — the CLI is broken"

HEAD=$(git -C "$INSTALL" log -1 --format='%h %s' 2>/dev/null)
[ -n "$HEAD" ] && ok "HEAD $HEAD" || bad "cannot read HEAD in $INSTALL"

CHECK=$( cd "$INSTALL" && hermes update --check 2>&1 | tail -2 )
if printf '%s' "$CHECK" | grep -qi "up to date"; then
  ok "up to date with origin"
else
  bad "still reports an update: $CHECK"
fi

# Tree and stashes are read as FILES (contract decision 7): `git status`
# would refresh the index and `git stash list` walks a reflog through git.
GITDIR="$INSTALL/.git"
CHANGED=$(find "$INSTALL" \( -path "$INSTALL/.*" -o -path "$INSTALL/install-stamp.json" -o -name node_modules \
  -o -name venv -o -name __pycache__ -o -name dist -o -name build -o -name release -o -name web_dist \
  -o -name '*.egg-info' -o -name '.*_cache' \) -prune -o -type f -newer "$GITDIR/index" -print 2>/dev/null)
DIRTY=$(printf '%s' "$CHANGED" | grep -c . | tr -d ' ')
[ "$DIRTY" -eq 0 ] && ok "tree clean after the update" || bad "$DIRTY file(s) changed after the update's checkout"

say "── nothing of the owner's was parked or lost ────────────────────────"
STASHES=$(grep -c . "$GITDIR/logs/refs/stash" 2>/dev/null | tr -d ' ')
if [ "${STASHES:-0}" -eq 0 ]; then
  ok "no stashes — nothing was silently parked"
else
  bad "$STASHES stash(es) present; read them: git -C $INSTALL stash show -p stash@{0}"
fi

# The update syncs bundled skills. Diffing against the pre-flight snapshot is
# the only way to tell "moved category" from "deleted".
if [ -n "$SNAP" ] && [ -d "$SNAP/skills" ]; then
  ( cd "$SNAP/skills" && find . -name SKILL.md | sed 's|^\./||' | sort ) > /tmp/_sk_before
  ( cd "$HERMES_HOME/skills" && find . -name SKILL.md | sed 's|^\./||' | sort ) > /tmp/_sk_after
  GONE=$(comm -23 /tmp/_sk_before /tmp/_sk_after)
  NEW=$(comm -13 /tmp/_sk_before /tmp/_sk_after)
  B=$(wc -l < /tmp/_sk_before | tr -d ' '); A=$(wc -l < /tmp/_sk_after | tr -d ' ')
  ok "skills $B -> $A"
  if [ -n "$GONE" ]; then
    say "       gone from their old path:"; printf '%s\n' "$GONE" | sed 's/^/         /'
    say "       (match each against the update log's \"moved to new upstream paths\";"
    say "        anything not listed there was DELETED — restore it from $SNAP)"
  fi
  [ -n "$NEW" ] && { say "       new:"; printf '%s\n' "$NEW" | sed 's/^/         /'; }

  for s in "$SNAP"/skills/iclone/*/; do
    n=$(basename "$s")
    [ -f "$HERMES_HOME/skills/iclone/$n/SKILL.md" ] \
      && ok "ours survived: iclone/$n" \
      || bad "OUR SKILL IS GONE: iclone/$n — restore from $SNAP"
  done
else
  say "  (no pre-flight state snapshot found — cannot diff the skills)"
fi

say "── the app on top of it ─────────────────────────────────────────────"
open -a "/Applications/iclone os.app" 2>/dev/null || say "  (iclone os not installed in /Applications)"
# The backend's command line changed across runtime versions (v0.21.3: a
# `hermes_cli.main serve` process; v0.21.5: a managed python running runpy),
# so it is found by what never changes — a python from HERMES_HOME that
# answers /api/health — not by its argv.
backend_pid() {
  for pid in $(pgrep -f "$HERMES_HOME/(tools/python|hermes-agent/venv)" 2>/dev/null); do
    port=$(lsof -aPi -p "$pid" 2>/dev/null | awk '/LISTEN/ {print $9}' | sed -E 's/.*:([0-9]+)$/\1/' | head -1)
    [ -n "$port" ] || continue
    if curl -s -m 5 "http://127.0.0.1:$port/api/health" 2>/dev/null | grep -q '"ok":true'; then
      printf '%s %s\n' "$pid" "$port"
      return 0
    fi
  done
  return 1
}
for i in $(seq 1 20); do
  backend_pid >/dev/null 2>&1 && break
  sleep 2
done

APP_PID=$(pgrep -f "/Applications/iclone os.app/Contents/MacOS/" | head -1)
[ -n "$APP_PID" ] && ok "iclone os is running (pid $APP_PID)" || bad "iclone os did not stay up"

BE=$(backend_pid)
if [ -n "$BE" ]; then
  BE_PID=${BE%% *}; PORT=${BE##* }
  H=$(curl -s -m 8 "http://127.0.0.1:$PORT/api/health")
  ok "it spawned a backend from the updated runtime (pid $BE_PID, port $PORT)"
  ok "backend health: $H"
else
  bad "no backend answers /api/health — the app cannot talk to the runtime"
fi

say "── receipt, health commit, contract verdict, probe ─────────────────"
SHA=$(git -C "$INSTALL" rev-parse HEAD 2>/dev/null)
# json_get <file|-> <dotted.path>: prints the value, or nothing when absent.
json_get() {
  python3 -c 'import json,sys
d=json.load(sys.stdin if sys.argv[1]=="-" else open(sys.argv[1]))
for k in sys.argv[2].split("."): d=d.get(k) if isinstance(d,dict) else None
print("" if d is None else json.dumps(d) if isinstance(d,(dict,list,bool)) else d)' "$@" 2>/dev/null
}
RECEIPT="$HERMES_HOME/logs/update_receipts/latest.json"
if [ -f "$RECEIPT" ]; then
  OUTCOME=$(json_get "$RECEIPT" outcome); POST=$(json_get "$RECEIPT" post_update.sha)
  [ "$OUTCOME" = "success" ] && ok "receipt outcome: success" || bad "receipt outcome: ${OUTCOME:-missing}"
  [ -n "$POST" ] && [ "$POST" = "$SHA" ] && ok "receipt post_update.sha = HEAD ${SHA:0:10}" \
    || bad "receipt post_update.sha ${POST:-missing} is not HEAD ${SHA:0:10}"
  FAILED=$(python3 -c 'import json,sys
s=json.load(open(sys.argv[1])).get("steps")
print("missing" if not isinstance(s,list) or not s else " ".join(x.get("name","?") for x in s if x.get("ok") is not True))' \
    "$RECEIPT" 2>/dev/null || echo unreadable)
  [ -z "$FAILED" ] && ok "every receipt step reported ok" || bad "receipt steps not ok: $FAILED"
else
  bad "no update receipt at $RECEIPT — the update left no evidence"
fi

HC=$(printf '%s' "${H:-}" | json_get - commit)
[ -n "$HC" ] && [ "${SHA#"$HC"}" != "$SHA" ] && ok "health.commit $HC is the runtime HEAD" \
  || bad "health.commit ${HC:-missing} is not the runtime HEAD ${SHA:0:10} — the backend runs other code"

bash "$(dirname "${BASH_SOURCE[0]}")/contract.sh" | sed 's/^/       /'
case "${PIPESTATUS[0]}" in
  0) ok "contract verdict GREEN at the installed runtime" ;;
  1) ok "contract verdict AMBER at the installed runtime — the owner reads it in the pane" ;;
  2) bad "contract verdict RED at the installed runtime — keep it and fix the app forward (references/compat.md)" ;;
  *) bad "contract verdict UNKNOWN at the installed runtime — UNKNOWN is never GREEN" ;;
esac

# The app re-derives its verdict and runs the probe after an update (references/compat.md).
LATEST="${ICLONE_USER_DATA:-$HOME/Library/Application Support/iclone os}/iclone-compat/latest.json"
if [ -f "$LATEST" ]; then
  TO=$(json_get "$LATEST" runtime.to); GONE=$(json_get "$LATEST" probe.gone); UNSAFE=$(json_get "$LATEST" probe.unsafe)
  [ -n "$TO" ] && [ "${SHA#"$TO"}" != "$SHA" ] && ok "the app's verdict is for HEAD ($TO)" \
    || bad "the app's verdict is for ${TO:-nothing}, not HEAD — relaunch the app and re-run"
  if [ -z "$GONE" ]; then
    bad "the app's verdict has no probe result — the probe never ran"
  elif [ "$GONE" = "0" ] && [ "$UNSAFE" != "true" ]; then
    ok "probe: $(json_get "$LATEST" probe.ok) ok, 0 gone"
  else
    bad "probe: $GONE method(s) gone${UNSAFE:+, unsafe=$UNSAFE} — read the RED card in the pane"
  fi
else
  bad "no app verdict at $LATEST — launch the app once so it derives one"
fi

say "── the desktop log since this launch ────────────────────────────────"
LOG="$HERMES_HOME/logs/desktop.log"
if [ -f "$LOG" ]; then
  if tail -40 "$LOG" | grep -q "backend is ready"; then
    ok "boot reached 'Hermes backend is ready'"
  else
    bad "the last boot never reported a ready backend — read $LOG"
  fi
  # JSON-RPC event lines carry `"error": null` fields — they are not errors.
  ERRS=$(tail -40 "$LOG" | grep -v '"jsonrpc"' | grep -icE "error|exception|refused|crash")
  [ "$ERRS" -eq 0 ] && ok "no errors in the last 40 log lines" || bad "$ERRS error line(s) in the last 40 — read $LOG"
fi

say ""
say "STILL YOURS TO DO BY HAND (a script cannot see a screen):"
say "  · send one real turn in Message — a reply proves renderer → backend → provider"
say "  · confirm the iNFT home, the dock and the theme still paint"
say "  · open Settings and walk the panes"
say ""
[ "$fail" -eq 0 ] && { say "AUTOMATED CHECKS PASSED."; exit 0; }
say "VERIFICATION FAILED — see the FAIL lines. Rollback is in ~/.hermes-update-backups/."
exit 1
