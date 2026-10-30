#!/usr/bin/env python3
"""Measured delivery gates for one finished video (the portable half of sample_project's verify3.py).

Checks, printing one line per gate and a verdict:
  - duration = <vig> + body + <vig> (±0.06 s), when --body is given (or --ref + --timemap, which gives the body length)
  - container/codec: W×H, 50 fps (or --fps), H.264 High, yuv420p, bt709, AAC 48 kHz stereo
  - programme loudness between the vignettes (default -18..-15 LUFS), vignettes (-14..-11), true peak <= -0.9 dBTP
  - picture sync, when --ref and --timemap are given: at 6 moments spread over the body, the frame strip of this file at
    <vig> + fwd(t) is correlated against the reference's strip at <vig> + t; the best offset must be within ±1 frame.
    Correlation over ~1.2 s, never a single peak: a repeated on-screen event makes a single-peak matcher lock onto the
    wrong one (paid for on sample_project v2, a false -0.52 s FAIL).

usage: verify_delivery.py <video> [--ref <finished_or_raw>] [--timemap <k_timemap.json>] [--body <seconds>]
                          [--vig 11] [--fps 50] [--prog -18 -15] [--vign -14 -11] [--tp -0.9] [--no-panel]
"""
import argparse, json, os, re, subprocess, sys
import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument('video'); ap.add_argument('--ref'); ap.add_argument('--timemap'); ap.add_argument('--body', type=float)
ap.add_argument('--vig', type=float, default=11.0); ap.add_argument('--fps', default='50')
ap.add_argument('--prog', nargs=2, type=float, default=[-18.0, -15.0])
ap.add_argument('--vign', nargs=2, type=float, default=[-14.0, -11.0])
ap.add_argument('--tp', type=float, default=-0.9)
ap.add_argument('--mode', choices=['auto','frames','signal'], default='auto')
ap.add_argument('--search', type=float, default=1.5, help='half-width of the sync search, in seconds')
ap.add_argument('--no-panel', action='store_true', help='drop the left 35%% of the frame (the robot panel covers it in the MP4 but not in the raw)')
A = ap.parse_args()
fails, notes = [], []
run = lambda c: subprocess.run(c, capture_output=True, text=True)
dur = lambda p: float(run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p]).stdout.strip())

# ---- format
pr = json.loads(run(['ffprobe', '-v', 'error', '-show_entries',
                     'format=duration:stream=codec_name,profile,width,height,r_frame_rate,pix_fmt,color_space,sample_rate,channels',
                     '-of', 'json', A.video]).stdout)
v = next(s for s in pr['streams'] if s['codec_name'] == 'h264')
a = next((s for s in pr['streams'] if s['codec_name'] == 'aac'), None)
D = float(pr['format']['duration'])
print(f"{os.path.basename(A.video)}: {D:.2f} s, {v['width']}x{v['height']}, {v['r_frame_rate']}, {v.get('profile')}, {v['pix_fmt']}")
if v['r_frame_rate'] != f'{A.fps}/1': fails.append(f"frame rate {v['r_frame_rate']} != {A.fps}/1")
if v.get('profile') != 'High' or v['pix_fmt'] != 'yuv420p': fails.append(f"video format {v.get('profile')} {v['pix_fmt']}")
if v.get('color_space') not in (None, 'bt709'): notes.append(f"colour space {v.get('color_space')}")
if not a or a['sample_rate'] != '48000' or a['channels'] != 2: fails.append(f'audio format {a}')

# ---- duration arithmetic
body = A.body
tmap = json.load(open(A.timemap)) if A.timemap else None
if body is None and tmap: body = tmap[-1][3]
if body is not None:
    want = body + 2 * A.vig
    print(f"  duration: {A.vig} + {body:.2f} + {A.vig} = {want:.2f} (measured {D:.2f})")
    if abs(D - want) > 0.06: fails.append(f'duration {D:.2f} != {want:.2f}')

# ---- loudness
def loud(p, a0=None, d0=None):
    c = ['ffmpeg', '-nostats'] + (['-ss', f'{a0:.3f}', '-t', f'{d0:.3f}'] if a0 is not None else []) + \
        ['-i', p, '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-']
    e = run(c).stderr
    I = float(re.findall(r'I:\s+(-?[\d.]+) LUFS', e)[-1])
    P = re.findall(r'Peak:\s+(-?[\d.inf]+) dBFS', e)
    return I, (float(P[-1]) if P and P[-1] != '-inf' else -99.0)
prog, peak = loud(A.video, A.vig, D - 2 * A.vig)
vig_i, _ = loud(A.video, 0, A.vig)
vig_o, _ = loud(A.video, D - A.vig, A.vig)
print(f"  loudness: programme {prog:.1f} LUFS, vignettes {vig_i:.1f} / {vig_o:.1f}, true peak {peak:.1f} dBTP")
if not (A.prog[0] <= prog <= A.prog[1]): fails.append(f'programme {prog:.1f} LUFS outside {A.prog}')
for nm, x in (('intro', vig_i), ('outro', vig_o)):
    if not (A.vign[0] <= x <= A.vign[1]): fails.append(f'{nm} vignette {x:.1f} LUFS outside {A.vign}')
if peak > A.tp: fails.append(f'true peak {peak:.1f} > {A.tp}')

# ---- picture sync
# Two instruments, and the right one depends on what the reference IS:
#   frames  — the reference holds the SAME pictures (a re-timed copy of a finished file): the frame at vig+fwd(t) must BE the
#             reference frame at vig+t, so the best frame-to-frame match over a ±search window gives the offset. Decisive:
#             r ~0.998 on the mapped frame against ~0.03 off the map.
#   signal  — the reference is a different render (raw without the burned text): only the rhythm of on-screen change can be
#             compared, by correlating ~2 s of frame-to-frame change. Weaker: a screencast repeats similar events, so this
#             alone gives false offsets of hundreds of ms (measured on 1.1, where the frames proved r=0.998 in sync).
if A.ref and tmap:
    W0, H0 = 480, int(round(480 * v['height'] / v['width'] / 2)) * 2
    def frames(p, t, secs):
        pre = max(0, t - 6)
        r = subprocess.run(['ffmpeg', '-v', 'error', '-ss', f'{pre:.3f}', '-i', p, '-ss', f'{t - pre:.3f}',
                            '-t', f'{secs:.3f}', '-vf', f'fps={A.fps},scale={W0}:{H0},format=gray', '-f', 'rawvideo', '-'],
                           capture_output=True).stdout
        f = np.frombuffer(r, np.uint8).astype(np.float32)
        f = f[:len(f) // (W0 * H0) * W0 * H0].reshape(-1, H0, W0)[:, :int(H0 * 0.72)]
        return f[:, :, int(W0 * 0.35):] if A.no_panel else f
    def strip(p, t, secs=1.2):
        pre = max(0, t - 6)
        r = subprocess.run(['ffmpeg', '-v', 'error', '-ss', f'{pre:.3f}', '-i', p, '-ss', f'{t - pre:.3f}',
                            '-t', f'{secs:.3f}', '-vf', f'fps={A.fps},scale={W0}:{H0},format=gray', '-f', 'rawvideo', '-'],
                           capture_output=True).stdout
        f = np.frombuffer(r, np.uint8).astype(np.float32)
        f = f[:len(f) // (W0 * H0) * W0 * H0].reshape(-1, H0, W0)[:, :int(H0 * 0.72)]
        if A.no_panel: f = f[:, :, int(W0 * 0.35):]
        return np.abs(np.diff(f, axis=0)).mean(axis=(1, 2)) if len(f) > 1 else np.zeros(1)
    fwd = lambda t: next((na + (t - s) * ((nb - na) / (e - s) if e > s else 0) for s, e, na, nb, *_ in tmap if s <= t <= e), tmap[-1][3])
    bounds = sorted([r[0] for r in tmap] + [r[1] for r in tmap])
    offs = []; SW = A.search; SEC = 2.0; how = []
    cor = lambda x, y: float(np.corrcoef(x.ravel(), y.ravel())[0, 1])
    for q in range(6):
        t = body * (q + 0.5) / 6
        far = [x for x in np.arange(t - 6, t + 6, 0.25) if 1.0 < x < body - SEC - 1.0 and
               min(abs(x - c) for c in bounds) > 1.5 and min(abs(x + SEC - c) for c in bounds) > 1.5]
        if far: t = min(far, key=lambda x: abs(x - t))      # a window that no splice crosses
        off = r = None
        if A.mode in ('frames', 'auto'):                    # the same picture, re-timed: match the frame itself
            ref1 = frames(A.ref, A.vig + t, 1.0 / float(A.fps))
            cand = frames(A.video, A.vig + fwd(t) - SW, 2 * SW + 1.0 / float(A.fps))
            if len(ref1) and len(cand) > 2:
                n = int(round(SW * float(A.fps)))
                cc = [(cor(ref1[0], cand[j]), (j - n) / float(A.fps)) for j in range(len(cand))]
                r, off = max(cc, key=lambda x: x[0])
                r0 = cc[n][0] if n < len(cc) else -1
                if r < 0.90 and A.mode == 'auto': off = None     # not the same picture: fall back to the rhythm
                elif r0 >= 0.99 and r - r0 < 0.005:              # a still screen matches its neighbours just as well:
                    off, r = 0.0, r0; how.append('frames(static)')   # the mapped frame IS right, the peak is unresolvable
                else: how.append('frames')
        if off is None:                                     # a different render: correlate the rhythm of change
            b = strip(A.video, A.vig + fwd(t) - SW, SEC + 2 * SW); s = strip(A.ref, A.vig + t, SEC)
            if len(s) < 4 or len(b) < len(s) + 4 or s.std() < 1e-3: continue
            n = int(round(SW * float(A.fps)))
            cc = [(float(np.corrcoef(s, b[j:j + len(s)])[0, 1]), (j - n) / float(A.fps)) for j in range(len(b) - len(s))]
            r, off = max(cc, key=lambda x: x[0]); how.append('signal')
            if r < 0.5: notes.append(f'sync at {t:.1f}s: correlation only {r:.2f} (skipped)'); continue
        offs.append(round(off, 3))
        if abs(off) > 1.5 / float(A.fps): fails.append(f'sync at {t:.1f}s off by {off:+.3f} s (r={r:.2f}, {how[-1]})')
    print(f"  sync offsets: {offs} ({'/'.join(sorted(set(how)))})")

for n in notes: print(f"  note: {n}")
print('\n'.join('FAIL ' + f for f in fails) if fails else 'ALL GATES PASS')
sys.exit(1 if fails else 0)
