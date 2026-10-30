#!/bin/zsh
# Camera & Action — what a video file really is: size, codec, level, frames, real fps, constant rate or not, the largest gap between
# two frames, gaps over a frame and a half, and (with --decode) a whole decode with timestamps passed through (0 errors expected).
#   tools/probe-video.sh <file> [<file> …] [--decode]
# The instrument is the FILE: never trust a recorder's count of frames it sent (an encoder that cannot keep up drops frames silently).
set -u
decode=0; files=()
for a in "$@"; do [[ "$a" == "--decode" ]] && decode=1 || files+=("$a"); done
(( ${#files[@]} )) || { echo "usage: probe-video.sh <file> [...] [--decode]"; exit 2; }
command -v ffprobe >/dev/null || { echo "ffprobe is needed (brew install ffmpeg)"; exit 2; }
bad=0
for f in "${files[@]}"; do
  [[ -f "$f" ]] || { echo "missing: $f"; bad=1; continue; }
  meta=$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,profile,level,width,height,pix_fmt,r_frame_rate,avg_frame_rate,color_space -show_entries format=duration,size,format_name -of default=nw=1 "$f" | tr '\n' ' ')
  ffprobe -v error -select_streams v:0 -show_entries packet=pts_time -of csv=p=0 "$f" | python3 -c '
import sys
ts = sorted(float(x) for x in sys.stdin.read().split() if x.strip())
n = len(ts)
if n < 2: print("  frames:", n); sys.exit(0)
gaps = [b - a for a, b in zip(ts, ts[1:])]
step = sorted(gaps)[len(gaps) // 2]                  # the typical frame interval
span = ts[-1] - ts[0] + step
over = sum(1 for g in gaps if g > 1.5 * step)
kind = "constant rate" if max(gaps) - min(gaps) < 1e-4 else "variable timestamps"
print(f"  frames {n} · span {span:.3f} s · {n / span:.2f} fps · interval {step * 1000:.3f} ms · largest gap {max(gaps) * 1000:.0f} ms · gaps over 1.5 frames {over} · {kind}")
' > /tmp/probe_video_$$.txt
  echo "$f"; echo "  $meta"; cat /tmp/probe_video_$$.txt; rm -f /tmp/probe_video_$$.txt
  if (( decode )); then
    errs=$(ffmpeg -v error -hwaccel videotoolbox -i "$f" -map 0:v -fps_mode passthrough -f null - 2>&1 | grep -c .)
    echo "  whole decode: $errs error line(s)"; (( errs )) && bad=1
  fi
done
exit $bad
