#!/usr/bin/env bash
# preflight.sh — every gate that must pass before `hermes update` touches the
# runtime, plus the two backups that make a rollback real.
#
# Read-only except for the backups it creates. Exits non-zero if ANY gate
# fails: a failed pre-flight is a stop, not a warning.
#
# Usage:  [ICLONE_UPDATE_TARGET=<sha|ref>] bash scripts/preflight.sh   (default upstream/main)
#
# The gate that matters most is the clean-tree one. `hermes update` on this
# machine printed, on 2026-08-30, when the install was still a SHALLOW clone:
#
#     ⚠ Fast-forward not possible (history diverged), resetting to match remote
#
# The clone has been FULL since (43,945 commits on 2026-09-26) and the update
# fast-forwards; but a reset --hard is still what the updater does whenever
# history diverges, and --keep-stash parks uncommitted edits in a stash nobody
# ever reads again. Both are silent. The only defence is refusing to start on
# a dirty tree.

set -uo pipefail
# The runtime is a blob:none promisor clone: no lazy fetch, no index refresh write.
export GIT_NO_LAZY_FETCH=1 GIT_OPTIONAL_LOCKS=0

HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
INSTALL="$HERMES_HOME/hermes-agent"
BACKUPS="$HOME/.hermes-update-backups"
MIN_FREE_GB=10

fail=0
say()  { printf '%s\n' "$*"; }
ok()   { printf '  \033[32mok\033[0m   %s\n' "$*"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; fail=1; }
warn() { printf '  \033[33mnote\033[0m %s\n' "$*"; }

say "── 0. the contract verdict at the target ───────────────────────────"
TARGET="${ICLONE_UPDATE_TARGET:-upstream/main}"
bash "$(dirname "${BASH_SOURCE[0]}")/contract.sh" --rev "$TARGET" | sed 's/^/       /'
case "${PIPESTATUS[0]}" in
  0) ok "GREEN at $TARGET" ;;
  1) warn "AMBER at $TARGET — the owner accepts it in the pane, not you" ;;
  2) bad "RED at $TARGET — fix the app forward first (references/compat.md)" ;;
  *) bad "UNKNOWN at $TARGET — UNKNOWN is never GREEN" ;;
esac

say "── 1. the install root ──────────────────────────────────────────────"
if [ -d "$INSTALL/.git" ]; then
  ok "$INSTALL is a git checkout"
else
  bad "$INSTALL is not a git checkout — nothing here applies; stop."
  exit 1
fi

# Sections 1-2 read the checkout as FILES (contract decision 7): `git status`
# would refresh the index and `git stash list` walks a reflog through git.
GITDIR="$INSTALL/.git"
[ -f "$GITDIR/shallow" ] && warn "shallow clone: local commit counts are meaningless, and a pull resets rather than fast-forwards"
[ -f "$GITDIR/shallow" ] || ok "full clone — the update can fast-forward"

say "── 2. the working tree must be clean ────────────────────────────────"
for op in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD rebase-merge rebase-apply; do
  [ -e "$GITDIR/$op" ] && bad "a $op is in progress in $INSTALL — finish or abort it first"
done
# Every checkout rewrites .git/index, so a file newer than it was edited or
# created after the last checkout. The pruned names are the gitignored build
# outputs, caches and install stamps the updater itself writes after checkout.
CHANGED=$(find "$INSTALL" \( -path "$INSTALL/.*" -o -path "$INSTALL/install-stamp.json" -o -name node_modules \
  -o -name venv -o -name __pycache__ -o -name dist -o -name build -o -name release -o -name web_dist \
  -o -name '*.egg-info' -o -name '.*_cache' \) -prune -o -type f -newer "$GITDIR/index" -print 2>/dev/null)
DIRTY=$(printf '%s' "$CHANGED" | grep -c . | tr -d ' ')
if [ "$DIRTY" -eq 0 ]; then
  ok "no file changed since the last checkout"
else
  bad "$DIRTY file(s) changed since the last checkout — the update would reset or park them"
  printf '%s\n' "$CHANGED" | sed "s|^$INSTALL/||" | head -20 | sed 's/^/       /'
  say "       Decide with the owner before continuing. Do not just clean."
fi

# `git stash list` is the reflog of refs/stash: one line per parked stash.
STASHES=$(grep -c . "$GITDIR/logs/refs/stash" 2>/dev/null | tr -d ' ')
if [ "${STASHES:-0}" -eq 0 ]; then
  ok "no stashes parked"
else
  warn "$STASHES stash(es) already parked here — read them before adding another:"
  cut -f2 "$GITDIR/logs/refs/stash" | sed 's/^/       /'
fi

say "── 3. where we are ──────────────────────────────────────────────────"
SHA=$(git -C "$INSTALL" rev-parse HEAD)
SHORT=$(git -C "$INSTALL" rev-parse --short HEAD)
ok "HEAD $SHORT — $(git -C "$INSTALL" log -1 --format=%s | cut -c1-64)"

say "── 4. disk ──────────────────────────────────────────────────────────"
FREE_GB=$(df -g / 2>/dev/null | awk 'NR==2 {print $4}')
if [ -n "$FREE_GB" ] && [ "$FREE_GB" -ge "$MIN_FREE_GB" ]; then
  ok "${FREE_GB}G free"
else
  bad "only ${FREE_GB:-?}G free — want at least ${MIN_FREE_GB}G"
fi

say "── 5. rollback clone ────────────────────────────────────────────────"
CLONE="$BACKUPS/hermes-agent-$SHORT"
mkdir -p "$BACKUPS"
if [ -d "$CLONE" ]; then
  ok "already have $CLONE"
else
  # -c is APFS clonefile: copy-on-write, seconds, ~no extra disk until the
  # trees diverge. Falls back to a real copy on filesystems without it.
  if cp -Rc "$INSTALL" "$CLONE" 2>/dev/null || cp -R "$INSTALL" "$CLONE"; then
    ok "cloned to $CLONE ($(du -sh "$CLONE" 2>/dev/null | cut -f1) logical)"
  else
    bad "could not clone the install root — without this there is no rollback"
  fi
fi

say "── 6. the owner's own state (never the secrets) ─────────────────────"
STATE="$BACKUPS/home-state-$(date +%Y%m%d-%H%M)"
mkdir -p "$STATE"
for item in skills desktop-plugins config.yaml SOUL.md agents skins; do
  [ -e "$HERMES_HOME/$item" ] && cp -Rc "$HERMES_HOME/$item" "$STATE/" 2>/dev/null \
    || { [ -e "$HERMES_HOME/$item" ] && cp -R "$HERMES_HOME/$item" "$STATE/" 2>/dev/null; }
done
ok "state snapshot at $STATE"
warn ".env and auth.json are deliberately NOT copied — live secrets stay in one place."
warn "\`hermes update --backup\` zips HERMES_HOME properly if a full restore is ever wanted."

say "── 7. what is holding the runtime open ──────────────────────────────"
RUNNING=0
for app in "iclone os" "Hermes"; do
  if pgrep -f "/$app.app/Contents/MacOS/" >/dev/null 2>&1; then
    warn "$app.app is running — quit it: osascript -e 'tell application \"$app\" to quit'"
    RUNNING=1
  fi
done
# The backend's argv differs by runtime version (`hermes_cli.main serve` up
# to v0.21.3, a managed `python3 -I -c … runpy` from v0.21.5): match the
# interpreter path under HERMES_HOME, which is what every version shares.
if pgrep -f "$HERMES_HOME/(tools/python|hermes-agent/venv)" >/dev/null 2>&1; then
  warn "a backend is up (killing the app does NOT kill it): pkill -f '$HERMES_HOME/(tools/python|hermes-agent/venv)'"
  RUNNING=1
fi
[ "$RUNNING" -eq 0 ] && ok "nothing is holding the runtime open"

say "── 8. the updater's own read-only view ──────────────────────────────"
( cd "$INSTALL" && hermes update --plan 2>&1 | sed 's/^/  /' )
( cd "$INSTALL" && hermes update --check 2>&1 | tail -3 | sed 's/^/  /' )

say ""
if [ "$fail" -eq 0 ]; then
  say "PRE-FLIGHT PASSED. Rollback: $CLONE"
  say "Next:  cd $INSTALL && hermes update --yes --backup"
  say "       (no --gateway from a terminal; never --no-backup)"
  exit 0
fi

say "PRE-FLIGHT FAILED — do not update. Fix the FAIL lines above."
exit 1
