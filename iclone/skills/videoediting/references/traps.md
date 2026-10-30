# Traps already paid for — read before debugging

Every line cost real time. If a symptom appears here, this is the cause.

## Assembly / delivery

1. **Two renders of the same episode in parallel corrupt the file.** `ffprobe` returns `N/A` (v2) or
   "Invalid data" on the virtual raw (v1). → kill the duplicates, delete the intermediate, redo it **once**.
2. **Doubled vignettes.** An already delivered file carries the 11 + 11; adding them again breaks the duration and the sync.
   → `tools/detect_vignettes.py` **before** assembling.
3. **False sync FAIL (−0.52 s on v2).** The matcher looked for an isolated motion peak and latched onto
   the second identical peak. → correlation over a few seconds within a 1× segment; for a re-timed copy,
   direct **frame** comparison (r ≈ 0.998), and on a still screen the offset counts as 0.
4. **Fixed durations in the text validator.** A corrected episode is shorter. → `ffprobe` of
   `audio/<k>_voice.wav`.
5. **Loudness normalized on the whole file** flattens the vignette step. → normalize only the body.
6. **VFR source cut without `fps=`** → sound drift over the course of the video.
7. **Paths of shared tools move** (`chrome.mjs`, the guide's source HTML) → confirm the
   paths before blaming the render.
8. **`amix` without `normalize=0`** buries the voice; without `apad`+`atrim` it ends at the shortest branch.

## Voice

9. **The level/pitch gate against the context failed faithful corrections**: his speech in those spots is 4–6 dB
   lower (−4.4 / −5.5 / −6.1 measured). → compare with the prosody of the **replaced stretch** (`ref_prosody`), absolute
   net of 6 st.
10. **Generous `pace_dur`** → F5 filled with silence or invented a syllable ("the approval **is**", "JSON **form**
    file"). → `est = min(est, his_pace × 1.05)`.
11. **Duplicated word at the joint** ("your, your", "CLI CLI CLI", "log in, log in", "protocol protocol",
    "because because", "a visual … where where"). Three distinct causes: the duplicate test accepted the word if
    it existed in the context; `widen` repeated the neighbour; and `text_alt` had words **outside** the span. → the test
    only allows a duplicate if he really repeats it; `widen` does not repeat the neighbour; and extra words **extend the span**.
12. **A widened plan crossing a sentence end eats his pause** (1.46 s deleted in d1-13). → `no_widen`.
13. **`local` low with `flaws` empty** = tokenization ("login" vs "log in"). → lower `local_min` (0.78–0.83), never
    rewrite what he says.
14. **Overlapping corrections silently abort the assembly** (v4 01/02, v5 05/06, v1 21/22 and 41/42, v3 02/03 and
    18/19, d1 01/02). The old wav stays in place. → merge the pair into one entry **and** always confirm the wav's date.
15. **`run_fix.sh` only redoes ids with no entry in the report.** To retry a failure, delete that id's entry from
    `out_<k>/<k>_report.json`.
16. **A product name the model refuses.** F5 copies his pronunciation from the reference: "cloud code" stayed
    "cloud" with 11 seeds, `dur_scale` and even the phonetic spelling "Clawed". Both models read the mistake. → `keep_original`:
    his voice with the wrong name is worth more than a synthetic stretch with the same wrong name.
17. **The aligner closes words 0.05–0.10 s early** — that leftover is not a hesitation.
18. **`clicks_db` fires on consonants** (/s/, /f/): it is only a click with a sample step at the joint.
19. **`span` with words inside fails T1** — `span` is only for voice that no word explains.
20. **MLX segfaults** (rc=139) → everything resumable, always.
21. **Shortening the voice tightens subtitles and boxes** → expect fine-tuning in `text/cues_<k>.json` and `text/defs_<k>.json` for
    every episode, and run `validate_text.py` after each one.
