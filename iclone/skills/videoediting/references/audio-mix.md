# The mix

The order is always: **treated voice → music bed with ducking → keys → limiter → loudness gates**.

## 1. The voice

- Cleanup: **DeepFilterNet** + gentle EQ; target **−16.5 LUFS** before the mix.
- Mono → stereo: multiply by **0.7071** per channel (otherwise the sum rises 3 dB and the program comes out loud).
- The corrected voice comes from the engine: `out_<k>/<k>_voice_fixed.wav` (48 kHz, mono).

## 2. The music bed

- Track from `<your project folder>/SAMPLE PROJECT/TRACKS`, **one per episode** (never the same one twice in the series).
- Starts at **0:14** of the track (the first 14 s are intro), and **loops** via `acrossfade=d=4:c1=tri:c2=tri` between
  two offset copies — never a hard cut.
- Level: **−34 LUFS** measured on the bed itself (compute the gain with a trial `ebur128` and apply `volume=`).
- `afade` in **1.5 s** / out **2.0 s**.
- Ducking under the voice: `sidechaincompress=threshold=0.015:ratio=3:attack=40:release=700:makeup=1:level_sc=1`
  (the voice is the sidechain).
- In speed-ups ≥ 3 s (no voice) the bed **rises +12 dB** — that is the "music lift" that gate 8 measures (−27..−17 LUFS).

## 3. The robot's keys

`typing_wav.py <keys.json> <out.wav> <dur> -30` → **−30 dBFS** peak. The instants come from the page's engine
(`guide/<k>_keys.json`, or `<your project folder>/rec_keys.json` in EXAMPLE SERIES). When the voice is corrected, each instant goes through the
time map: `[round(fwd(t),4) for t in keys if fwd(t) < D-0.05]`.

## 4. The sum

```
[voice][bed_ducked][keys] amix=inputs=3:normalize=0:duration=longest
                            , alimiter=limit=0.891:level=false:attack=3:release=60
```

`limit=0.891` ≈ **−1.0 dBFS**; after the AAC the true peak stays ≤ −0.9 dBTP (gate 7).
`normalize=0` is mandatory — `amix` by default divides by the branches and buries the voice.

## 5. The vignettes

They have their own sound, louder (−14..−11 LUFS), and do **not** go through this mix: they enter the `concat` ready-made.
Never normalize the whole final file (it flattens the step and fails gate 6).

## 6. Traps already paid for

- **VFR** source: apply `fps=` **before** cutting; otherwise audio and picture drift over the course of the video.
- `apad` + `atrim=0:D` on every branch: without it `amix` ends at the shortest branch.
- Measure loudness **between the vignettes**, not on the whole file.
- The treated voice is the source of truth for duration: `ffprobe` the wav, never a duration table.
