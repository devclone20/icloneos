#!/usr/bin/env bash
# contract.sh — the compatibility verdict of OUR lock against the installed
# runtime and, optionally, a target revision. Prints at most 30 lines.
#
# Usage:  bash scripts/contract.sh [--rev <sha|ref>] [--runtime <checkout>] [--lock-diff]
#
#   --rev        also verify against this revision, read from the APP repo's
#                `upstream` objects (e.g. upstream/main, or the update target)
#   --runtime    the installed runtime checkout (default $HERMES_HOME/hermes-agent)
#   --lock-diff  regenerate the lock from the code first and fail on any diff
#
# Exit: 0 GREEN · 1 AMBER · 2 RED · 3 UNKNOWN · 4 the check itself failed.
#
# Read-only. The installed runtime is read as FILES (its HEAD working tree):
# it is a blob:none promisor clone, so a non-HEAD read would lazy-fetch and an
# index refresh would write. Other revisions come from the app repo only.

set -uo pipefail
export GIT_NO_LAZY_FETCH=1 GIT_OPTIONAL_LOCKS=0

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
RUNTIME="$HERMES_HOME/hermes-agent"
REV=""
LOCK_DIFF=0
while [ $# -gt 0 ]; do
  case "$1" in
    --rev) REV="${2:-}"; shift 2 ;;
    --runtime) RUNTIME="${2:-}"; shift 2 ;;
    --lock-diff) LOCK_DIFF=1; shift ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) printf 'contract.sh: unknown argument %s\n' "$1" >&2; exit 4 ;;
  esac
done

LOCK="$REPO/iclone/contract/runtime.lock.json"
SERVED="$REPO/iclone/contract/served.py"
VERIFY="$REPO/apps/desktop/electron/iclone-compat/verify.ts"
for f in "$LOCK" "$SERVED" "$VERIFY"; do
  [ -f "$f" ] || { printf 'contract.sh: missing %s\n' "${f#"$REPO"/}"; exit 4; }
done

WORK="$(mktemp -d -t iclone-contract.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

if [ "$LOCK_DIFF" = 1 ]; then
  node "$REPO/iclone/contract/extract.mjs" --out "$WORK/lock" >"$WORK/extract.log" 2>&1 \
    || { printf 'lock: extract failed\n'; tail -5 "$WORK/extract.log"; exit 4; }
  if cmp -s "$LOCK" "$WORK/lock/runtime.lock.json"; then
    printf 'lock: regenerates with 0 diff\n'
  else
    printf 'lock: DIFF — review it before anything else\n'
    diff "$LOCK" "$WORK/lock/runtime.lock.json" | head -8
    exit 4
  fi
fi

SPECS=()
if [ -f "$RUNTIME/.git/HEAD" ]; then
  python3 -B "$SERVED" --runtime "$RUNTIME" --lock "$LOCK" --out "$WORK/installed.json" 2>&1 | tail -1
  [ -f "$WORK/installed.json" ] && SPECS+=(--spec "$WORK/installed.json")
else
  printf 'installed: no runtime checkout at %s\n' "$RUNTIME"
fi
if [ -n "$REV" ]; then
  python3 -B "$SERVED" --repo "$REPO/.git" --rev "$REV" --lock "$LOCK" --out "$WORK/target.json" 2>&1 | tail -1
  [ -f "$WORK/target.json" ] && SPECS+=(--spec "$WORK/target.json")
fi
[ ${#SPECS[@]} -gt 0 ] || { printf 'verdict: UNKNOWN (no spec could be built)\n'; exit 3; }

node "$VERIFY" --lock "$LOCK" "${SPECS[@]}" --kind preview >"$WORK/verdict.json" 2>"$WORK/verify.log" \
  || { printf 'verify failed\n'; tail -5 "$WORK/verify.log"; exit 4; }

node - "$WORK/verdict.json" <<'JS'
const v = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'))
const cards = Array.isArray(v.cards) ? v.cards : []
const out = [`verdict: ${v.level ?? 'UNKNOWN'} · ${cards.length} card(s) · ${v.computedMs ?? '?'} ms`]
for (const s of v.perSpec ?? []) out.push(`  spec ${String(s.rev ?? '?').slice(0, 12)}: ${s.level}`)
for (const c of cards.slice(0, 8)) {
  const names = (c.names ?? []).slice(0, 6).join(', ')
  const more = (c.names?.length ?? 0) > 6 ? ` +${c.names.length - 6}` : ''
  out.push(`  ${c.level} ${c.root}: ${c.items ?? 0} item(s), ${c.sites ?? 0} site(s)${c.ticket ? ` · ${c.ticket}` : ''}`)
  if (names) out.push(`    ${names}${more}`)
  if (c.upstream?.length) out.push(`    upstream ${c.upstream.slice(0, 4).join(' ')}`)
}
if (cards.length > 8) out.push(`  … ${cards.length - 8} more card(s)`)
process.stdout.write(`${out.slice(0, 26).join('\n')}\n`)
JS

case "$(node -e 'process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).level))' "$WORK/verdict.json")" in
  GREEN) exit 0 ;;
  AMBER) exit 1 ;;
  RED) exit 2 ;;
  *) exit 3 ;;
esac
