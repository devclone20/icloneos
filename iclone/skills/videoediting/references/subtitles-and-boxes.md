# Subtitles and robot boxes

Everything in **English (US)**. The mechanical gate is `validate_text.py`, which runs **before** any render.

## 1. Subtitles — Apple TV style

| Rule | Value |
|---|---|
| Reading speed | ≤ **20 characters/second** |
| Duration | ≥ **1.0 s** and ≤ **6.5 s** |
| Gap between subtitles | ≥ **0.08 s** (never overlapping) |
| Lines | ≤ 2, each ≤ **42 characters** |
| Coverage | every spoken word inside a subtitle (±0.4 s), fillers excluded |
| Names | brand mistakes forbidden: `AI NFT`, `iClone`/`iCloneOS` (it is **iclone os**), `Virtual Protocol` (it is **Virtuals Protocol**), `the owner` (it is **the owner**), `Economy OS` |
| Promises | forbidden: `mint date`, `download now`, `available today/now`, selling iNFTs |

File: `text/cues_<k>.json` = `{"cues":[{"start","end","text"}]}`, in **recording time** (source), not cut time.
`retime_cues.py <k>` moves them to the corrected voice's timing; `map_text.py` moves them to the cut's timing.

## 2. Robot boxes

| Rule | Value |
|---|---|
| Distance between boxes | ≥ **12 s** (in the source **and** in the cut timeline) |
| Start | t ≥ **6.0 s** |
| End | ≥ **3 s** before the cut ends |
| Duration | **7–14 s**, and ≥ `len(text)/14 + 3` |
| Text | `Name: explanation`, ≤ **118** characters, ASCII only, 2–40 characters before the `: ` |
| Series | a concept (`key`) **never** repeats across the whole series |
| Pixel box | `node check_wrap14.mjs text/defs_<k>.json` must pass (the text fits the drawn box) |

File: `text/defs_<k>.json` = `{"defs":[{t,dur,pose,key,text}]}`.

## 3. After correcting the voice, the text gets tight

Shortening the voice changes **everything** that depends on time. Having to fine-tune by hand is normal, and it is quick:

- a subtitle now has less time for the same text → **> 20 chars/s**: shorten the text or move the start
  (the cases already paid for: v1 cue 15, v3 cue 22, v5 cue 21, v6 cue 12);
- two robot boxes end up < 12 s apart, or the last one ends up < 3 s from the end → move the box (v4 box 1 34.58 → 32.8;
  v3 `on_chain` 46.1 → 48.0);
- always run `validate_text.py <k>` after every adjustment, and only then render.

## 4. Render

- Subtitles: `subs_render.py` (overlay) inside `run_r3.sh final`; the delivery `.srt` comes from the same JSON, already in the
  final timing, in `deliver3.py`.
- Boxes: `map_text.py --defs-only` → `make_guide_page2.py` (HTML) → `render_guide2.mjs` (Chrome, 50 fps, 4 in
  parallel) → `panel_overlay2.py` (panel over the video) → `typing_wav.py` (the robot's keys).
- The robot panel types: the **keys** come from the page's own engine (deterministic), not from a random generator —
  that is what keeps them anchored to the frame.
