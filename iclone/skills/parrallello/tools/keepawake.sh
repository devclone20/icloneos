#!/usr/bin/env bash
# keepawake.sh start|status|stop — caffeinate for the whole run (SAMPLE_PROJECT §9).
#   start  : no-op if the pid in CONTROL/watch/caffeinate.pid is a live caffeinate; else
#            `nohup caffeinate -ims -t 604800` (7 days; -i idle, -m disk, -s system on AC) and store its pid.
#            Never wraps Python (caffeinate dies with its child).
#   status : pid alive? + `pmset -g assertions` has caffeinate with PreventSystemSleep. exit 0 ok, 1 not ok.
#   stop   : kills only the pid stored in the pid file, and only if that pid is a caffeinate (ours).
# Env (tests): KEEPAWAKE_PIDFILE, KEEPAWAKE_SECS.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
PIDF="${KEEPAWAKE_PIDFILE:-$ROOT/CONTROL/watch/caffeinate.pid}"
SECS="${KEEPAWAKE_SECS:-604800}"
mkdir -p "$(dirname "$PIDF")"
ours() { # $1 pid -> 0 if alive and a caffeinate
  [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null && [ "$(ps -o comm= -p "$1" 2>/dev/null | xargs basename 2>/dev/null)" = "caffeinate" ]
}
pid="$(head -n1 "$PIDF" 2>/dev/null | tr -dc '0-9')"
case "${1:-}" in
  start)
    if ours "$pid"; then echo "keepawake: already running pid $pid"; exit 0; fi
    nohup caffeinate -ims -t "$SECS" >/dev/null 2>&1 &
    np=$!; echo "$np" > "$PIDF"; sleep 0.3
    if ours "$np"; then echo "keepawake: started pid $np (${SECS}s)"; else echo "keepawake: FAILED to start"; exit 1; fi ;;
  status)
    a="$(pmset -g assertions 2>/dev/null | grep -i caffeinate)"
    ps_ok=no; ours "$pid" && ps_ok=yes
    pss=no; printf '%s' "$a" | grep -q PreventSystemSleep && pss=yes
    echo "keepawake: pid ${pid:-none} alive=$ps_ok PreventSystemSleep=$pss"
    [ "$ps_ok" = yes ] && [ "$pss" = yes ] ;;
  stop)
    if ours "$pid"; then kill "$pid" && rm -f "$PIDF" && echo "keepawake: stopped pid $pid"
    else echo "keepawake: nothing of ours to stop (pid ${pid:-none})"; fi ;;
  *) echo "usage: keepawake.sh start|status|stop" >&2; exit 64 ;;
esac
