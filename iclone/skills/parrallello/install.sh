#!/usr/bin/env bash
# parrallello — install the control plane into a project.  Usage: install.sh "<project root>"
# Idempotent: never overwrites a file that already exists in the project (adapted copies win).
set -euo pipefail
ROOT="${1:?usage: install.sh <project root>}"
SK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -d "$ROOT" ] || { echo "no such dir: $ROOT" >&2; exit 2; }
RUN="$ROOT/CONTROL/run"; NOS="$ROOT/CONTROL/local.nosync"
mkdir -p "$RUN/tools" "$RUN/workflows" "$RUN/tickets" "$RUN/baseline" "$ROOT/CONTROL/sampleproject" \
         "$NOS/logs" "$NOS/jobs" "$NOS/scratch" "$NOS/snap" "$NOS/handoff" "$NOS/gates" "$NOS/stage"
copy() { if [ -e "$2" ]; then echo "keep  ${2#$ROOT/}"; else cp "$1" "$2"; echo "new   ${2#$ROOT/}"; fi; }
for f in "$SK"/tools/*; do [ -f "$f" ] || continue; copy "$f" "$RUN/tools/$(basename "$f")"; done
chmod +x "$RUN"/tools/*.sh "$RUN"/tools/*.py 2>/dev/null || true
copy "$SK/templates/RULES.md" "$RUN/RULES.md"
for f in "$SK"/templates/workflows/*.js; do copy "$f" "$RUN/workflows/$(basename "$f")"; done
GI="$ROOT/.gitignore"
if ! { [ -f "$GI" ] && grep -qE '^\*\.nosync/?$' "$GI"; }; then printf '\n# parrallello local run data\n*.nosync/\n' >> "$GI"; echo "gitignore += *.nosync/"; fi
if git -C "$ROOT" check-ignore -q "$NOS/x" 2>/dev/null; then echo "ok    CONTROL/local.nosync is ignored"; else echo "WARN  CONTROL/local.nosync is NOT ignored by git" >&2; fi
echo "next: write CONTROL/SAMPLE_PROJECT.md (references/plan-template.md) and CONTROL/run/fronts.json, then run P0 (workflows/setup.js)"
