#!/bin/bash
# v0.0.7 PERF gates, every one of them RUN (CF1, critic B-m5: the runtime-integrity gate skipped in iso_env):
#   bash scripts/perf-v007/run-gates.sh [vitest args...]      (npm run test:perf:v007; through iso_env.sh)
#
# The runtime-integrity gate rebuilds the pinned runtime artifact, which needs two pinned tools nothing downloads here:
#   ICLONE_PERF_NODE   Node 26.8.1 (the pin's zlib makes the artifact's bytes); default
#                      <owner home>/Developer/iclone-cache/node-v26.8.1/node-v26.8.1-darwin-arm64/bin/node
#   ICLONE_RUNTIME_PY  the pin's CPython 3.14 interpreter; default <owner home>/Developer/iclone-wt/_py-pin/bin/python3.14
# <owner home> is the account's home from Directory Services, never $HOME (iso_env makes $HOME a throwaway); both are
# only executed, nothing under them is written. Either missing or not the pinned version: refused here (exit 3),
# and the gate itself fails rather than skips when ICLONE_PERF_V007=1 and they are absent.
set -u
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
desktop=$(cd "$here/../.." && pwd -P)
owner_home=$(/usr/bin/dscl . -read "/Users/$(/usr/bin/id -un)" NFSHomeDirectory 2>/dev/null | /usr/bin/awk '{print $2}')
node="${ICLONE_PERF_NODE:-$owner_home/Developer/iclone-cache/node-v26.8.1/node-v26.8.1-darwin-arm64/bin/node}"
py="${ICLONE_RUNTIME_PY:-$owner_home/Developer/iclone-wt/_py-pin/bin/python3.14}"

[ -x "$node" ] && [ "$("$node" -v 2>/dev/null)" = "v26.8.1" ] || { echo "run-gates: no pinned Node 26.8.1 at $node (set ICLONE_PERF_NODE)" >&2; exit 3; }
[ -x "$py" ] || { echo "run-gates: no pinned runtime interpreter at $py (set ICLONE_RUNTIME_PY)" >&2; exit 3; }
[ "$HOME" != "$owner_home" ] || { echo "run-gates: HOME is the owner's home: run through iso_env.sh" >&2; exit 3; }
# CF4b: without the own FSEvents addon there is no stream, every check walks the tree (~110 ms) and the gates read as
# a regression of the code (it was the build). Built from source by `node scripts/build-iclone-fsevents.mjs`.
[ -f "$desktop/native/iclone-fsevents/build/iclone_fsevents.node" ] || { echo "run-gates: no FSEvents addon at native/iclone-fsevents/build (run node scripts/build-iclone-fsevents.mjs)" >&2; exit 3; }

vitest="$desktop/node_modules/vitest/vitest.mjs"
[ -f "$vitest" ] || vitest="$desktop/../../node_modules/vitest/vitest.mjs"

cd "$desktop" || exit 3
echo "run-gates: node $("$node" -v) ($node), ICLONE_RUNTIME_PY=$py" >&2
# The pinned Node first on PATH too: every child the gates fork (vitest's pool, make-fixture.mjs) runs on it.
# --silent=false: the RESULT_JSON / SUMMARY lines each gate prints are what the release gate reads.
PATH="$(dirname "$node"):$PATH" ICLONE_RUNTIME_PY="$py" exec "$node" "$vitest" run --config vitest.perf-v007.config.ts --silent=false --reporter=verbose "$@"
