#!/usr/bin/env bash
# adoption.sh — the adoption backlog since CURSOR: counts per disposition and
# the inbox's top rows. Prints at most 30 lines.
#
# Usage:  bash scripts/adoption.sh [--full]
#
#   --full  rescan from the import origin instead of CURSOR
#
# Exit: 0 ok · 4 the scan itself failed.
#
# Writes only the uncommitted backlog (.git/iclone/adoption/backlog.json). It
# never fetches: run `git fetch upstream` in the app repo first when the
# printed upstream date is stale.

set -uo pipefail
export GIT_NO_LAZY_FETCH=1 GIT_OPTIONAL_LOCKS=0

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
ENGINE="$REPO/apps/desktop/electron/iclone-compat/adoption.ts"
CURSOR_FILE="$REPO/iclone/upstream/adoption/CURSOR"
OUT="$REPO/.git/iclone/adoption/backlog.json"
FULL=()
case "${1:-}" in
  --full) FULL=(--full) ;;
  -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
  '') ;;
  *) printf 'adoption.sh: unknown argument %s\n' "$1" >&2; exit 4 ;;
esac

[ -f "$ENGINE" ] || { printf 'adoption.sh: missing %s\n' "${ENGINE#"$REPO"/}"; exit 4; }
TIP="$(git -C "$REPO" log -1 --format='%h %cs' upstream/main 2>/dev/null)" \
  || { printf 'adoption.sh: no upstream/main in the app repo (git fetch upstream)\n'; exit 4; }
CURSOR="$(grep -m1 -E '^[0-9a-f]{7,40}$' "$CURSOR_FILE" 2>/dev/null || true)"
if [ -n "$CURSOR" ]; then
  WAITING="$(git -C "$REPO" rev-list --count "$CURSOR..upstream/main" 2>/dev/null || echo '?')"
  printf 'upstream/main %s · cursor %s · %s commit(s) waiting\n' "$TIP" "${CURSOR:0:10}" "$WAITING"
else
  printf 'upstream/main %s · no CURSOR yet (first scan starts at the import origin)\n' "$TIP"
fi

mkdir -p "$(dirname "$OUT")"
LOG="$(mktemp -t iclone-adoption.XXXXXX)"
trap 'rm -f "$LOG"' EXIT
(cd "$REPO" && node "$ENGINE" scan ${FULL[@]+"${FULL[@]}"} --out "$OUT") >"$LOG" 2>&1 \
  || { printf 'scan failed\n'; tail -5 "$LOG"; exit 4; }

node - "$OUT" <<'JS'
const b = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'))
const disp = Array.isArray(b.dispositions)
  ? b.dispositions.map((d) => d.disposition)
  : Object.values(b.dispositions ?? {})
const counts = {}
for (const d of disp) counts[String(d).split(':')[0]] = (counts[String(d).split(':')[0]] ?? 0) + 1
const out = [`change-sets ${disp.length} · ${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(' · ') || 'none'}`]
const inbox = (b.inbox ?? []).slice(0, 12)
out.push(`inbox: ${inbox.length} row(s)`)
for (const r of inbox) {
  const id = String(r.cs ?? r.id ?? r.sha ?? '?').slice(0, 16)
  const title = String(r.title ?? r.subject ?? '').slice(0, 60)
  const terms = (r.terms ?? []).slice(0, 4).join(', ')
  out.push(`  ${String(r.score ?? '-').padStart(5)} ${id} ${title}${terms ? ` [${terms}]` : ''}`)
}
process.stdout.write(`${out.slice(0, 26).join('\n')}\n`)
JS
printf 'backlog: %s\n' "${OUT#"$REPO"/}"
