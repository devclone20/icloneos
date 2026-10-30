#!/bin/zsh
# One line of truth about each video file: duration, size, codec, fps, profile, pixel format, colour, audio.
# usage: probe_delivery.sh <video> [more videos...]
for f in "$@"; do
  python3 - "$f" <<'PY'
import json, os, subprocess, sys
f = sys.argv[1]
p = json.loads(subprocess.run(['ffprobe', '-v', 'error', '-show_entries',
    'format=duration:stream=codec_name,profile,width,height,r_frame_rate,pix_fmt,color_space,sample_rate,channels',
    '-of', 'json', f], capture_output=True, text=True).stdout or '{}')
vs = [s for s in p.get('streams', []) if s['codec_name'] == 'h264' or s['codec_name'].startswith('prores')]
as_ = [s for s in p.get('streams', []) if s['codec_name'] in ('aac', 'pcm_s24le', 'pcm_s16le', 'pcm_f32le')]
v = vs[0] if vs else {}; a = as_[0] if as_ else {}
d = float(p.get('format', {}).get('duration', 0))
print(f"{os.path.basename(f)}: {d:.2f}s {v.get('width')}x{v.get('height')} {v.get('r_frame_rate')} "
      f"{v.get('codec_name')} {v.get('profile')} {v.get('pix_fmt')} {v.get('color_space')} | "
      f"{a.get('codec_name')} {a.get('sample_rate')}Hz {a.get('channels')}ch")
PY
done
