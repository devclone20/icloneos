#!/usr/bin/env bash
# checkpoint.sh — commit + push EVERYTHING in progress (owner rule 2026-10-05: "commit piece by piece, nothing gets lost").
# Tracked changes, deletions and new non-ignored files; files > 50 MB are skipped and listed. Run by the lead every pulse.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"; cd "$ROOT" || exit 2
MAX=$((50 * 1024 * 1024)); skipped=()
while IFS= read -r -d '' rec; do
  st="${rec:0:2}"; f="${rec:3}"
  [[ "$st" == R* ]] && { IFS= read -r -d '' _old || true; }
  if [ -f "$f" ] && [ "$(stat -f %z "$f")" -gt "$MAX" ]; then skipped+=("$f"); continue; fi
  git add -A -- "$f" 2>/dev/null
done < <(git status --porcelain -z --untracked-files=all)
git diff --cached --quiet && { echo "checkpoint: nothing to commit"; exit 0; }
n=$(git diff --cached --name-only | wc -l | tr -d ' ')
prog=$(python3 CONTROL/run/tools/progress.py 2>/dev/null | head -1)
msg=$(mktemp); {
  echo "checkpoint $(date '+%Y-%m-%d %H:%M'): $n files in progress (running fronts, work-in-progress)"
  echo; echo "$prog"; git diff --cached --name-only | sed 's/^/- /' | head -60
  [ ${#skipped[@]} -gt 0 ] && { echo; echo "skipped (> 50 MB):"; printf -- '- %s\n' "${skipped[@]}"; }
  echo; echo "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"; } > "$msg"
git commit -q -F "$msg" && rm -f "$msg" && git log --oneline -1 && git push -q 2>&1 | grep -vE 'INF|^$' | tail -3
