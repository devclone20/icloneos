# The brand vignettes — the law

The owner's series open and close with the **brand vignette**: **11.0 s at the head + 11.0 s at the tail**, at the same size and
the same 50 fps as the body, louder than the program (−14..−11 LUFS against −18..−15).

## 1. The law

**If the video already has the vignettes, they are never added again.**
A video already delivered or already approved carries the vignettes burned in. Adding them again gives 22 s of brand at the head, breaks the
duration arithmetic (`11 + body + 11`) and blows the sync gate. In that case:

- work **only on the body** (`trim=start=11:end=11+D_body`);
- the two vignettes **are copied from the finished file itself** (`trim=0:11` and `trim=D-11:D`), video **and** audio, without
  re-encoding anything beyond what the concat forces;
- the final duration goes back to `11 + new_body + 11`.

**If the video has no vignettes**, they can be added naturally — that is the norm for a new delivery — or exactly as the
owner says (head only, none, another brand). Do not ask by routine: add the 11 + 11 pair and say in one line
that it was added.

**In doubt, assume it already has them** and say in one line what you measured. Adding is reversible; delivering a
file with the brand doubled is not.

## 2. How it is detected (measured, not guessed)

`python3 tools/detect_vignettes.py <video> [--asset <vignette.mov>] [--len 11]`

Three independent proofs, in order of strength:

1. **Frame comparison against the asset** (if an asset of that resolution exists): 64×36 grey frames at 0.5 / 3 / 6 / 9 s
   against the same instants of the asset → correlation ≥ 0.90 in 3 of the 4 = vignette present. Same for the tail.
2. **Loudness step**: the first and last 11 s in `ebur128` ~3 dB above the middle of the file.
3. **Hard cut at 11 s and at D−11 s**: `select='gt(scene,0.4)'` fires exactly at those boundaries.

Arithmetic that confirms: `(D − 22)` is the body duration and must match the voice/EDL duration. If `D − 22` does not
make sense (negative, or different from the known body), the file probably does **not** have the pair.

## 3. The assets

```
$VIDEOEDITING_PIPELINE_DIR/assets/
  vignette_<width>x<height>_<fps>.mov     # iNFT series #7 (sample_project)
  vignette_<width>x<height>_<fps>.mov     # series intro (v7)
```

- One asset **per output resolution**. Never stretch: if the body is 2704×1756, make a new asset with `scale` +
  `pad` that preserves the brand's framing, never `setsar`/stretch.
- 50 fps, ProRes or H.264 High, same `bt709`, 48 kHz stereo audio.
- The vignette has its own sound (it does not go into the music bed or the ducking): the concat takes `[vi][ai]`,
  `[body_v][body_a]`, `[vo][ao]`.

## 4. The correct concat (the one used in audio-only mode)

```
[0:v]trim=0:11,setpts=PTS-STARTPTS,fps=50,format=yuv420p,setsar=1,settb=AVTB[vi];
[0:a]atrim=0:11,asetpts=PTS-STARTPTS,<fmt>[ai];
[0:v]trim=D-11:D,setpts=PTS-STARTPTS,fps=50,...[vo];
[0:a]atrim=D-11:D,asetpts=PTS-STARTPTS,<fmt>[ao];
[1:v]fps=50,...[vb];[2:a]<fmt>[ab];
[vi][ai][vb][ab][vo][ao]concat=n=3:v=1:a=1[v][a]
```

`settb=AVTB` and `setsar=1` on all three branches — without them the concat drops frames at the joint and the sync gate fails
by 1–2 frames.

## 5. Traps already paid for

- **Doubling the brand** is the most expensive mistake: the file looks fine in the first seconds and it only shows after 11 s.
  Detect it BEFORE, always.
- The tail vignette must be read from `D − 11`, with `D` coming from `ffprobe`, not from the duration you "know".
- Do not normalize the loudness of the whole file after joining the vignettes: that flattens the step and the vignette
  gate (−14..−11) fails. Normalize the body, never the whole.
