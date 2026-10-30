#!/bin/zsh
# Camera & Action — finish a recorder's MP4 for editors WITHOUT re-encoding (no pixel touched):
#   · every frame exactly 1/fps apart (MediaRecorder stamps frames with the wall clock: variable timestamps),
#   · the H.264 level the stream really is (Chrome labels 3024 × 1964 @ 60 as 5.1; its macroblock rate is 5.2),
#   · the index at the front (+faststart) and a duration in the header (the recorder's file is fragmented).
#   tools/conform-cfr.sh <in.mp4> <out.mp4> [fps=60]
# The video gets shorter than the take by its dropped frames × 1/fps. Then check it: tools/probe-video.sh <out.mp4> --decode
set -eu
in=${1:?usage: conform-cfr.sh <in.mp4> <out.mp4> [fps]}; out=${2:?usage: conform-cfr.sh <in.mp4> <out.mp4> [fps]}; fps=${3:-60}
command -v ffmpeg >/dev/null || { echo "ffmpeg is needed (brew install ffmpeg)"; exit 2; }
wh=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0:s=x "$in"); w=${wh%x*}; h=${wh#*x}
mbs=$(( ((w + 15) / 16) * ((h + 15) / 16) * fps ))
if   (( mbs <=  245760 )); then level=4.2
elif (( mbs <=  983040 )); then level=5.1
elif (( mbs <= 2073600 )); then level=5.2
else level=6.2; fi
tmp="${out%.*}.conform-$$.h264"
trap 'rm -f "$tmp"' EXIT
ffmpeg -v error -y -i "$in" -map 0:v -c:v copy -bsf:v "h264_mp4toannexb,h264_metadata=level=$level" -f h264 "$tmp"
ffmpeg -v error -y -r "$fps" -i "$tmp" -c copy -movflags +faststart "$out"
n_in=$(ffprobe -v error -select_streams v:0 -count_packets -show_entries stream=nb_read_packets -of csv=p=0 "$in")
n_out=$(ffprobe -v error -select_streams v:0 -count_packets -show_entries stream=nb_read_packets -of csv=p=0 "$out")
[[ "$n_in" == "$n_out" ]] || { echo "frame count changed: $n_in → $n_out"; exit 1; }
echo "$out · ${w}x${h} · $n_out frames at exactly $fps fps · H.264 level $level · faststart"
