#!/usr/bin/env python3
"""Does this video ALREADY carry the brand vignettes at the head and the tail?

The owner's series open and close with an 11 s brand vignette. A file he already delivered or approved has them burned
in, and putting them in again doubles the brand and breaks the duration arithmetic. So this is the first thing to
measure, before any editing.

Three independent pieces of evidence, strongest first:
  1. frames vs an asset  — gray 64x36 frames at 0.5/3/6/9 s against the same instants of the vignette asset;
                           correlation >= 0.90 on 3 of 4 = present. Same for the tail.
  2. loudness step       — the first/last <len> s are ~3 dB louder than the middle (vignettes -14..-11 vs programme -18..-15).
  3. hard cut            — a scene change lands at <len> s and at D-<len> s.
Plus the arithmetic: D - 2*<len> must be a sensible body length (and match --body when given).

usage: detect_vignettes.py <video> [--asset <vignette.mov> ...] [--len 11] [--body <seconds>]
exit 0 = both vignettes present · 1 = missing or unsure (read the printed verdict)
"""
import argparse, os, re, subprocess, sys
import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument('video'); ap.add_argument('--asset', action='append', default=[])
ap.add_argument('--len', type=float, default=11.0); ap.add_argument('--body', type=float)
A = ap.parse_args()
run = lambda c: subprocess.run(c, capture_output=True, text=True)
L = A.len
D = float(run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', A.video]).stdout.strip())
W0, H0 = 64, 36

def gray(p, t):
    pre = max(0, t - 6)
    r = subprocess.run(['ffmpeg', '-v', 'error', '-ss', f'{pre:.3f}', '-i', p, '-ss', f'{t - pre:.3f}', '-frames:v', '1',
                        '-vf', f'scale={W0}:{H0},format=gray', '-f', 'rawvideo', '-'], capture_output=True).stdout
    a = np.frombuffer(r, np.uint8).astype(np.float32)
    return a[:W0 * H0].reshape(H0, W0) if a.size >= W0 * H0 else None

def cor(a, b):
    if a is None or b is None or a.std() < 1e-6 or b.std() < 1e-6: return 0.0
    return float(np.corrcoef(a.ravel(), b.ravel())[0, 1])

def loud(p, a0, d0):
    e = run(['ffmpeg', '-nostats', '-ss', f'{a0:.3f}', '-t', f'{d0:.3f}', '-i', p, '-vn', '-af', 'ebur128', '-f', 'null', '-']).stderr
    m = re.findall(r'I:\s+(-?[\d.]+) LUFS', e)
    return float(m[-1]) if m else None

print(f'{os.path.basename(A.video)}: {D:.2f} s; body if 2x{L:g} s of vignette = {D - 2 * L:.2f} s')
head = tail = None; why = []

# 1) against an asset
ts = [0.5, 3.0, 6.0, 9.0]
for asset in A.asset:
    if not os.path.exists(asset): continue
    ch = [cor(gray(A.video, t), gray(asset, t)) for t in ts]
    ct = [cor(gray(A.video, D - L + t), gray(asset, t)) for t in ts]
    why.append(f'asset {os.path.basename(asset)}: head {[round(x, 2) for x in ch]} tail {[round(x, 2) for x in ct]}')
    if sum(x >= 0.90 for x in ch) >= 3: head = True
    if sum(x >= 0.90 for x in ct) >= 3: tail = True

# 2) loudness step
if D > 3 * L:
    mid = loud(A.video, L, D - 2 * L); hi = loud(A.video, 0, L); ti = loud(A.video, D - L, L)
    if None not in (mid, hi, ti):
        why.append(f'loudness: head {hi:.1f} / middle {mid:.1f} / tail {ti:.1f} LUFS')
        if head is None and hi - mid > 1.5: head = True
        if tail is None and ti - mid > 1.5: tail = True

# 3) hard cut at the boundaries
for nm, t in (('head', L), ('tail', D - L)):
    e = run(['ffmpeg', '-nostats', '-ss', f'{max(0, t - 1.0):.3f}', '-t', '2.0', '-i', A.video, '-an',
             '-vf', "select='gt(scene,0.4)',metadata=print", '-f', 'null', '-']).stderr
    cuts = [float(x) for x in re.findall(r'pts_time:([\d.]+)', e)]
    near = [c for c in cuts if abs((max(0, t - 1.0) + c) - t) < 0.25]
    why.append(f'{nm} boundary: scene cuts {[round(c, 2) for c in cuts][:4]}{" (on the boundary)" if near else ""}')
    if near:
        if nm == 'head' and head is None: head = True
        if nm == 'tail' and tail is None: tail = True

if A.body is not None and abs((D - 2 * L) - A.body) > 0.2:
    why.append(f'arithmetic: D-2x{L:g} = {D - 2 * L:.2f} does NOT match the known body {A.body:.2f}')
    if head is None: head = False
    if tail is None: tail = False

for w in why: print(f'  {w}')
if head and tail:
    print(f'VERDICT: the vignettes are ALREADY there — do NOT add them again; work on the body '
          f'({L:g}..{D - L:.2f} s) and copy both vignettes from this file.')
    sys.exit(0)
if head is False and tail is False:
    print('VERDICT: no vignettes found — they can be added (11 s head + 11 s tail, asset of this exact resolution).')
else:
    print(f'VERDICT: UNSURE (head={head}, tail={tail}). Assume they ARE there, say so in one line, and ask.')
sys.exit(1)
