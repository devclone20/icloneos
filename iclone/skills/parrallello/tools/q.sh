#!/usr/bin/env bash
# q.sh <cmd...> — run a command quietly: the full output goes to CONTROL/local.nosync/logs/<ts>_<slug>.log,
# the context gets only `EXIT <rc> (<secs>s) log: <path>` + the last 15 output lines (each cut to 240 chars).
# A single argument that is not an executable is run through `bash -c` (so `q.sh "cd x && make"` works).
# The exit code of q.sh is the command's exit code. Env: Q_TAIL (default 15).
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
LOGS="$ROOT/CONTROL/local.nosync/logs"
mkdir -p "$LOGS"
[ $# -ge 1 ] || { echo "usage: q.sh <cmd...>" >&2; exit 64; }
TAILN="${Q_TAIL:-15}"
ts="$(date +%Y%m%d_%H%M%S)"
slug="$(printf '%s' "$*" | sed 's#[^ ]*/##g' | tr -c 'A-Za-z0-9._-' '_' | tr -s '_' | cut -c1-48)"
slug="${slug#_}"; slug="${slug%_}"; slug="${slug:-cmd}"
log="$LOGS/${ts}_${slug}.log"; k=1
while [ -e "$log" ]; do log="$LOGS/${ts}_${slug}_$k.log"; k=$((k + 1)); done
out="$log.out"
{ printf '# cwd: %s\n# cmd:' "$PWD"; printf ' %q' "$@"; printf '\n# start: %s\n' "$(date -u +%FT%TZ)"; } > "$log"
t0=$(date +%s)
if [ $# -eq 1 ] && ! command -v -- "$1" >/dev/null 2>&1 && [ ! -x "$1" ]; then
  bash -c "$1" > "$out" 2>&1 < /dev/null
else
  "$@" > "$out" 2>&1 < /dev/null
fi
rc=$?
secs=$(( $(date +%s) - t0 ))
cat "$out" >> "$log"
printf '# exit: %s  secs: %s  end: %s\n' "$rc" "$secs" "$(date -u +%FT%TZ)" >> "$log"
echo "EXIT $rc (${secs}s) lines=$(wc -l < "$out" | tr -d ' ') log: $log"
tail -n "$TAILN" "$out" | cut -c1-240
rm -f "$out"
exit "$rc"
