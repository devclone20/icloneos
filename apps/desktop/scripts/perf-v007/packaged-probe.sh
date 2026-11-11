#!/bin/bash
# v0.0.7 PERF probe for the packaged app:
#   packaged-probe.sh <pid> [seconds=5]         one sample of <seconds>
#   packaged-probe.sh <pid> --window <seconds>  CF1 (critic B-m2): back-to-back 5 s samples over <seconds>, each judged
#                                               on its own, so a background refresh of the F7 guard cannot fall
#                                               between two short samples. The refresh starts every max(4 min, 10 x
#                                               its last length) after the last one began (hardlinks.ts refreshCadence,
#                                               CF4): set --window to at least that interval to catch one.
#
# Read-only. Runs `sample <pid> <s>` (Apple's sampler: it suspends nothing the user sees and never signals the
# process) on the main process of a running icloneOS, idle with a big project root open, and reports for its MAIN
# thread (Thread_..., "DispatchQueue_1: com.apple.main-thread"):
#   busy  = samples not parked in a wait (mach_msg / kevent / __psynch_cvwait / __select / __workq_kernreturn), as %
#   fs    = samples whose stack is in lstat / readdir / scandir / getdirentries / open / stat, as %
# and, for every OTHER thread, its fs samples: a window where they pass SCAN_FS_SAMPLES is a window with a scan
# running (the walk worker and the libuv pool stat the tree), reported as `scan` so the busy % during the refresh is
# read on its own line.
# Target (PERF.packaged.idle): busy < 10 % (with --window: in EVERY 5 s window, so also during the refresh). Prints
# RESULT_JSON and SUMMARY like the vitest gates. Never kills, signals, or attaches anything else; the sample text goes
# to private temp files that are removed at the end.
set -u
pid="${1:-}"; secs="${2:-5}"; window=""
WINDOW_S=5
SCAN_FS_SAMPLES=20
case "$pid" in ''|*[!0-9]*) echo "usage: packaged-probe.sh <pid> [seconds | --window <seconds>]" >&2; exit 2 ;; esac
if [ "$secs" = "--window" ]; then
  window="${3:-}"
  case "$window" in ''|*[!0-9]*) echo "packaged-probe: --window needs a whole number of seconds" >&2; exit 2 ;; esac
  [ "$window" -ge "$WINDOW_S" ] || { echo "packaged-probe: --window must be at least ${WINDOW_S}s" >&2; exit 2; }
  secs="$WINDOW_S"
fi
case "$secs" in ''|*[!0-9]*) echo "packaged-probe: seconds must be a whole number" >&2; exit 2 ;; esac
/bin/ps -p "$pid" -o comm= >/dev/null 2>&1 || { echo "packaged-probe: no process $pid" >&2; exit 2; }

dir=$(/usr/bin/mktemp -d "${TMPDIR:-/private/tmp/}pv7-sample.XXXXXX") || exit 2
trap '/bin/rm -rf "$dir"' EXIT

# One sample file -> "busy_pct fs_pct other_fs_samples main_samples wait_samples fs_samples" on stdout.
# The call graph indents each frame; a frame line is "<indent><count> <symbol> ...". The main thread block runs from
# its "Thread_" header (marked main-thread) to the next "Thread_" header. Its first count is the thread's total;
# leaf-ish attribution: a frame counts toward a bucket once, at the shallowest frame of that bucket on each branch.
judge() {
  /usr/bin/awk '
    function depth(line) { match(line, /^[ +!:|]*/); return RLENGTH }
    /^ *[0-9]+ Thread_/ {
      inmain = ($0 ~ /main-thread/ || ($0 ~ /Thread_[0-9]+ *$/ && !seen)); seen = 1
      if (inmain && !done) { match($0, /[0-9]+/); total = substr($0, RSTART, RLENGTH) + 0 }
      else if (total > 0) { done = 1 }
      inother = !inmain; fsd = -1; waitd = -1; ofsd = -1; next
    }
    /^Total number in stack|^Binary Images/ { inmain = 0; inother = 0 }
    inmain || inother {
      d = depth($0); rest = substr($0, d + 1)
      if (!match(rest, /^[0-9]+ /)) next
      n = substr(rest, 1, RLENGTH - 1) + 0; sym = substr(rest, RLENGTH + 1)
      isfs = sym ~ /(^|[^a-z_])(lstat|lstat64|stat|stat64|fstatat|readdir|scandir|getdirentries|getattrlistbulk|open|openat|open\$NOCANCEL|__open|__open_nocancel|uv_fs_lstat|uv_fs_scandir|uv__fs_scandir|uv__fs_work)([^a-z_]|$)/
      if (inother) {
        if (ofsd >= 0 && d <= ofsd) ofsd = -1
        if (ofsd < 0 && isfs) { ofs += n; ofsd = d }
        next
      }
      if (done) next
      if (fsd >= 0 && d <= fsd) fsd = -1
      if (waitd >= 0 && d <= waitd) waitd = -1
      if (fsd < 0 && isfs) { fs += n; fsd = d }
      if (waitd < 0 && sym ~ /(mach_msg|mach_msg2_trap|mach_msg_trap|kevent|__psynch_cvwait|__select|__workq_kernreturn|__semwait_signal|__ulock_wait)/) { wait += n; waitd = d }
    }
    END {
      if (total <= 0) { print "packaged-probe: no main thread found in the sample" > "/dev/stderr"; exit 3 }
      printf "%.2f %.2f %d %d %d %d\n", 100 * (total - wait) / total, 100 * fs / total, ofs, total, wait, fs
    }
  ' "$1"
}

sample_once() {
  /usr/bin/sample "$pid" "$secs" 1 -mayDie -file "$1" >/dev/null 2>&1 || { echo "packaged-probe: sample failed" >&2; exit 3; }
}

if [ -z "$window" ]; then
  echo "packaged-probe: sampling pid $pid ($(/bin/ps -p "$pid" -o comm= | /usr/bin/sed 's|.*/||')) for ${secs}s" >&2
  sample_once "$dir/s"
  read -r busy fsp _ofs total wait fs < <(judge "$dir/s") || exit 3
  pass=$(/usr/bin/awk -v b="$busy" 'BEGIN { print (b < 10 ? "true" : "false") }')
  printf 'INFO_JSON {"gate":"PERF.packaged.idle","pid":%d,"mainSamples":%d,"waitSamples":%d,"fsSamples":%d,"fsPct":%.2f}\n' "$pid" "$total" "$wait" "$fs" "$fsp"
  printf 'RESULT_JSON {"gate":"PERF.packaged.idle","pass":%s,"items":[{"id":"PERF.packaged.idle.busy_pct","value":%.2f,"target":"< 10 %%","pass":%s},{"id":"PERF.packaged.idle.fs_pct","value":%.2f,"target":"report","pass":true}]}\n' "$pass" "$busy" "$pass" "$fsp"
  printf 'SUMMARY %d/2 PASS (PERF.packaged.idle)\n' "$([ "$pass" = true ] && echo 2 || echo 1)"
  [ "$pass" = true ]
  exit $?
fi

windows=$(( window / WINDOW_S ))
echo "packaged-probe: sampling pid $pid ($(/bin/ps -p "$pid" -o comm= | /usr/bin/sed 's|.*/||')) in $windows windows of ${WINDOW_S}s" >&2
: > "$dir/judged"
for i in $(/usr/bin/seq 1 "$windows"); do
  /bin/ps -p "$pid" >/dev/null 2>&1 || { echo "packaged-probe: process $pid ended in window $i" >&2; exit 3; }
  sample_once "$dir/w"
  judge "$dir/w" >> "$dir/judged" || exit 3
  /usr/bin/tail -n 1 "$dir/judged" | /usr/bin/awk -v i="$i" -v s="$SCAN_FS_SAMPLES" '{ printf "packaged-probe: window %d busy %.2f %% fs %.2f %%%s\n", i, $1, $2, ($3 >= s ? " (scan running)" : "") }' >&2
done

/usr/bin/awk -v pid="$pid" -v s="$SCAN_FS_SAMPLES" -v w="$WINDOW_S" '
  { n += 1; if ($1 > max) { max = $1; at = n }; sum += $1
    if ($3 >= s) { scans += 1; if ($1 > smax) smax = $1 } }
  END {
    pass = max < 10 ? "true" : "false"; spass = smax < 10 ? "true" : "false"
    printf "INFO_JSON {\"gate\":\"PERF.packaged.idle\",\"pid\":%d,\"windows\":%d,\"windowS\":%d,\"maxAtWindow\":%d,\"scanWindows\":%d}\n", pid, n, w, at, scans
    printf "RESULT_JSON {\"gate\":\"PERF.packaged.idle\",\"pass\":%s,\"items\":[", (pass == "true" && spass == "true") ? "true" : "false"
    printf "{\"id\":\"PERF.packaged.idle.busy_pct_max_window\",\"value\":%.2f,\"target\":\"< 10 %%\",\"pass\":%s},", max, pass
    printf "{\"id\":\"PERF.packaged.idle.busy_pct_mean\",\"value\":%.2f,\"target\":\"report\",\"pass\":true},", sum / n
    printf "{\"id\":\"PERF.packaged.idle.busy_pct_during_scan\",\"value\":%s,\"target\":\"< 10 %%\",\"pass\":%s},", (scans ? sprintf("%.2f", smax) : "\"no scan in the window\""), spass
    printf "{\"id\":\"PERF.packaged.idle.scan_windows\",\"value\":%d,\"target\":\"report (>= 1 with a stream-backed root and --window >= 300)\",\"pass\":true}]}\n", scans
    ok = (pass == "true") + (spass == "true") + 2
    printf "SUMMARY %d/4 PASS (PERF.packaged.idle)\n", ok
    exit (ok == 4 ? 0 : 1)
  }
' "$dir/judged"
