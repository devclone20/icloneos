# The picture: virtual raw, plan/cut, and audio-only mode

## 1. Normal mode — the picture is rebuilt

`apply_to_video.sh <k> out_<k>` does, in this order:

1. **`apply_voicefix.py`** — writes a **"virtual raw"**: a **picture-only** ProRes that follows the corrected voice,
   using the time map (a cut drops those frames; a regenerated stretch plays its frames at the ratio of the
   two durations). *Why:* this way the rest of the pipeline runs **unchanged** — to it, it is just a new recording.
2. **`retime_cues.py`** — subtitles and boxes to the new timing.
3. **`activity.py`** — the screen activity of the new raw (it is what decides where speed-ups are allowed).
4. **`edit3.py plan`** / **`edit3.py cut`** — speed-up plan and cut. `SLOW_D`: where he **types**, the typing is
   the action → do not speed up. `--nofast` when the episode must not have speed-ups (v7).
5. **`run_r3.sh boxes`** — boxes → HTML → frames in Chrome → panel + keys → mix.
6. **`run_r3.sh final`** — subtitles → MP4 → `deliver3.py` (srt, voice, README, data/).

## 2. Audio-only mode — the approved picture is kept

When the owner has already approved the picture (subtitles and panel burned in) and only the voice changes:
`sample_project/v2/fix_audio_only.py <finished.mp4> <out_dir> <key> <out.mp4>`

1. cuts the **body** out of the finished file (`trim=start=11:end=11+D_body`) and **re-times it** by the map: one
   `trim`+`setpts=(PTS-STARTPTS)/sp` per map line, `tpad=stop_mode=clone` + `trim=end=d_new` for the exact frame,
   `format=yuv420p,setsar=1,settb=AVTB`, and a `concat` of all the pieces;
2. moves each robot key by the map and rebuilds the keys track;
3. rebuilds the body's sound (voice + bed with ducking + keys + limiter);
4. joins the **two vignettes taken from the finished file itself** and writes the final MP4.

**This mode's own check:** the picture at the mapped time must **be** the approved picture. It is measured by
direct frame comparison (`tools/verify_delivery.py --mode frames`): on the mapped time it gives r ≈ 0.998–0.9999; off the map
it drops (measured: 0.03). The "rate of change" correlation does **not** work here — in a screencast events repeat and it gives
false offsets of hundreds of ms.
On a **still** screen, any neighbouring frame matches equally well: the gate treats that as 0 (rule `r0 ≥ 0.99 and
r_best − r0 < 0.005`) instead of inventing an offset.

## 3. Iron rules

- **Never two integrations of the same episode at the same time.** It corrupted the v2 MP4 (`ffprobe` → `N/A`) and
  `sample_project/v1.mov` ("Invalid data"). Kill the duplicates, delete the intermediate, redo it once.
- **VFR** source → `fps=` before cutting.
- Paths of shared tools change: `render_guide2.mjs` imported `chrome.mjs` from a folder that moved,
  and `make_guide_page2.py` pointed to a deleted HTML — confirm the paths before blaming the render.
- After the cut, `cut/<k>.mov` is the W×H reference for gate 2: the vignette must have the same.
