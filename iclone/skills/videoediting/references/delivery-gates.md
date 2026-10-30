# Delivery gates — what proves a file is ready

Nothing is delivered without these numbers. In the sample_project series: `python3 verify3.py` (all 8 at once, also writes
`qa/proof_<k>.jpg` and `qa/proof_sheet.jpg`). Outside the series: `python3 tools/verify_delivery.py <video> …`.

## 1. The gates

| # | Gate | Value | Why |
|---|---|---|---|
| 1 | Duration | `vignette + body + vignette` (±0.06 s) | proves the brand was neither doubled nor lost, and that the body is the expected one |
| 2 | Picture | W×H of the cut, **50 fps**, H.264 **High**, **yuv420p**, **bt709** | opens everywhere; without it QuickTime and X re-encode |
| 3 | Sound | AAC, **48 kHz**, **stereo** | same |
| 4 | Sync | at 6 moments spread across the body, offset ≤ 1 frame | the picture must follow the new voice |
| 5 | Program loudness | **−18..−15 LUFS** (between the vignettes) | the streaming standard; his voice sits at −16.5 |
| 6 | Vignette loudness | **−14..−11 LUFS** | the brand is louder on purpose; if it flattened, the whole file was normalized |
| 7 | True peak | **≤ −0.9 dBTP** | no clipping after the AAC |
| 8 | Music lift | in every speed-up ≥ 3 s, short-term loudness **−27..−17 LUFS** | there is no voice in the speed-ups: the bed rises +12 dB so the video does not go dead |

## 2. Sync: by CORRELATION, never by a peak

Take a ~1.2 s strip of frames at 50 fps (grey, 480 px, **top part only**: the subtitle band and the robot
panel change between the source and the delivery), reduce the "change between frames" to a time series and **correlate**
it with the same strip from the source, sliding ±30 frames. The offset of the maximum correlation counts, and only if `r ≥ 0.5`.

*Why:* the old matcher looked for an isolated motion peak and latched onto a **second** identical peak (an
event that repeats on screen) → it gave a false FAIL of −0.52 s on v2, when the correlation showed 0.992 at +0.02 s.

Details that matter:
- measure **within a 1× segment** (never on top of a speed-up);
- `--no-panel` when the robot panel covers the left side in the delivery but not in the source (drops 35 % on the left);
- the right source is the **picture before the burned text** (raw, or the finished file when re-timing his
  picture), and the instant to compare is `vignette + fwd(t)` against `vignette + t`, with `fwd` from the time map.

## 3. The proofs that stay

- `qa/proof_<k>.jpg`: a frame with a subtitle **and** a robot box visible — proves the text went in.
- `qa/proof_sheet.jpg`: the sheet with all of them.
- The one-line-per-video table: `duration = 11+body+11 | WxH 50p | sync [...] | prog X LUFS, vignette Y, TP Z | lifts [...]`.
  It is what is shown to the owner; it is short and it is measured.

## 4. Before the render: the text gates

`python3 validate_text.py [k …]` runs **before** `run_r3.sh` and fails subtitles and boxes outside the rules
(`references/subtitles-and-boxes.md`). The durations come from the **audio** (`ffprobe` of `audio/<k>_voice.wav`), never from a
fixed table — a corrected episode is shorter than the recording.

## 5. Debugging order when something fails

1. `ffprobe` the file: the duration and the format tell you straight away whether it was the concat.
2. If the duration is right but the sync is not: check the time map and whether the picture was re-timed with it.
3. If the program loudness is off: check the mix (voice, bed, keys), not the limiter.
4. If the vignettes are off: someone normalized the whole file.
5. If `ffprobe` returns `N/A`: the MP4 is corrupted — almost always **two parallel renders of the same
   episode**. Kill both, delete the intermediate, redo it once.
