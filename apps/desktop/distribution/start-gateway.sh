#!/bin/sh
# icloneOS Web: serve the web/ folder next to this script from a Hermes gateway on this machine.
# Usage: ./start-gateway.sh [--host 127.0.0.1] [--port 8787]
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
HOST=127.0.0.1
PORT=8787
while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST=$2; shift 2 ;;
    --port) PORT=$2; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
HERMES_BIN=${HERMES_BIN:-$(command -v hermes || true)}
if [ -z "$HERMES_BIN" ] && [ -x "$HOME/.hermes/hermes-agent/venv/bin/hermes" ]; then
  HERMES_BIN="$HOME/.hermes/hermes-agent/venv/bin/hermes"
fi
if [ -z "$HERMES_BIN" ]; then
  echo "Hermes is not installed on this machine. Install icloneOS (macOS or Linux) first; it installs the pinned Hermes runtime." >&2
  exit 1
fi
export HERMES_WEB_DIST="$HERE/web"
echo "icloneOS Web: http://$HOST:$PORT/  (open it in Chrome, then use Install app)"
exec "$HERMES_BIN" dashboard --host "$HOST" --port "$PORT" --no-open --skip-build
