# Correcting the owner's voice with his own voice

Engine: `$VIDEOEDITING_PIPELINE_DIR/sample_project/fix_episode.py`
Python: `$F5TTS_VENV/bin/python` (F5-TTS 1.1.22, MLX whisper, torchaudio MMS_FA)

## 1. The principle

Two operations, never more:

- **cut** — deletes an "uh", a stutter, an extra word from the real recording. It is his voice, with nothing added.
- **gen** — regenerates a short stretch by F5-TTS **in-filling**: the model receives his surrounding audio as
  reference and fills in only the gap. **Only that stretch** is replaced; the rest of the recording is not touched.

The whole sentence is never re-read, the episode is never re-recorded, a generic voice is never used.
If the model cannot say the word the way he would say it, **his stays** (`skip: true`).

## 2. The per-episode pipeline

```bash
cd $VIDEOEDITING_PIPELINE_DIR/sample_project
$F5TTS_VENV/bin/python find_fixes.py  <k>          # speech ↔ subtitle: where they differ
$F5TTS_VENV/bin/python prep_edits.py  <k>          # real differences, merging those < 0.8 s apart
$F5TTS_VENV/bin/python evidence.py    <k>          # 2 whisper models + wide window, per task (resumable)
python3 report_tasks.py <k>                           # prep/<k>_brief.md for the agent
#   → EDITOR agent → edits_<k>.json
python3 check_edits.py <k> edits_<k>.json             # must say OK
./run_fix.sh <k> out_<k>                              # the engine (up to 8 passes, resumable)
./run_critic.sh <k> out_<k>                           # measurements per correction (+ mel PNG)
./run_critic.sh <k> out_<k> --episode                 # whole-episode measurement
#   → CRITIC agent → out_<k>/critic/verdicts.json
python3 apply_verdicts.py edits_<k>.json out_<k>/critic/verdicts.json <round>
#   repeat run_fix + critic until 0 redos
```

Outputs that matter: `out_<k>/<k>_voice_fixed.wav` (the new voice) and `out_<k>/<k>_timemap.json`
(lines `[a, b, na, nb, id]`: the stretch `a..b` of the original now occupies `na..nb` in the new one — it is what makes the picture,
the subtitles and the keys follow the voice).

## 3. The engine's gates

**T1 — he really says the new words.** VERBATIM transcription with two models
(`whisper-large-v3-turbo` and `whisper-large-v3-mlx`) and an `initial_prompt` full of fillers, so the model does not
"clean up" what it hears. Requires:
- local similarity ≥ `local_min` (default 0.85) between the expected and the heard in the window;
- no new filler (`uh`, `um`, …);
- **no duplicated word at the joint** — unless he really repeats it
  (`adj_ok = {w for k, w in enumerate(exp[:-1]) if w == exp[k+1]}`);
- all new words heard.

**T2 — no voice left over without a word.** `leftovers()` looks for voiced stretches that no word explains; any leftover
≥ 0.25 s fails. It is the test that catches the invented syllable and the hesitation that stayed in.

**T3 — prosody against the REPLACED stretch.** `ref_prosody(before, a_rel, b_rel)` measures the level and the pitch jumps
of the original stretch that is going to be replaced; the new one is compared **with that**, not with the context:
|Δpitch| ≤ 3 semitones at entry and exit, absolute net of 6 st, |Δlevel| ≤ 3 dB.
*Why:* his speech in those spots is 4–6 dB below the context (measured: −4.4 / −5.5 / −6.1 dB). Measuring against the
context failed faithful corrections.

Also: `clicks_db` only counts as a click if there is a sample step at the joint (on consonants it fires by itself);
`pace_dur` uses the **smaller** of the estimate and his own pace for the same words
(`est = min(est, (s1-s0) * letters/own_letters * 1.05)`) — giving more time than the words need makes F5 fill
with silence or invent a syllable.

## 4. The format of `edits_<k>.json`

```json
[{"id": "07", "type": "cut", "from": ["to", 93.83], "to": ["to", 93.83], "note": "why"},
 {"id": "08", "type": "cut", "span": [164.67, 165.16], "note": "hesitation that whisper did not write"},
 {"id": "12", "type": "gen", "from": ["go", 135.21], "to": ["settings", 135.51],
  "text": "go to settings", "note": "why"}]
```

`from`/`to` are **aligned words** (word + exact MMS_FA time). `span` is only used for voice that **no**
word explains; with words inside it T1 always fails.

**Overrides** (from the critic or by hand):
`seeds` · `dur_scale` · `widen` / `no_widen` · `text_alt` · `cut_pad` · `local_min` · `allow_flaws` · `max_stretch` ·
`skip` (the original stays) · `piece_ops` · `post_gain_db`.

`<k>_ref_fixes.json` = `[["wrong_word", t, "right_word"], …]` corrects the **text of the reference window**:
if whisper misspelled a word that he says correctly next to the stretch, F5 receives the wrong text and imitates it.

## 5. When a gate fails — what to do

| Symptom | Measured cause | Remedy |
|---|---|---|
| `local` low, `flaws` empty | tokenization: the model writes "log in" where the text says "login" | lower `local_min` to 0.78–0.83; do **not** rewrite the text |
| `missing:<word>` but it sounds fine in context | a tight window cuts the neighbouring word | `allow_flaws` with that word, and the critic confirms in context |
| word repeated at the joint ("because because", "where where") | the `text_alt` has words **outside** the span: he says his and the generated one | extend `from`/`to` to **swallow** the neighbouring word, never write it in the text |
| his pause gone | the widened plan crossed a sentence end and glued two breaths together | `no_widen: true` (and `local_min` a little lower) |
| `pitch_abs` alone, perfect text | he himself makes a big jump there (e.g. raises his voice to quote the agent) | `allow_flaws: ["pitch_abs"]` + critic check against the replaced stretch |
| generated duration too long, invented syllable | generous `pace_dur` | already fixed in the engine; if it comes back, `dur_scale` < 1 |
| the model says another word (product name) | F5 copies **his** pronunciation from the reference | 5–6 new seeds + `dur_scale` 1.1; then phonetic spelling (`Clawed` for `Claude`); if **both** models still read the mistake → `skip: true` |
| `overlapping corrections at X s` and the wav is not written | two corrections collide (the real points fall outside the words) | merge the two into a single entry with the full text |

**Iron rule:** after every `run_fix.sh`, read the `N/M corrections passed` line **and** `ls -la` of
`<k>_voice_fixed.wav`. The engine stops without writing when there is an overlap, and the old wav stays there, misleading.

**To retry a correction that failed:** `run_fix.sh` only redoes ids **with no entry** in the report —
delete that id's entry from `out_<k>/<k>_report.json` before running again.

## 6. Listening without bias

- The `initial_prompt` biases the model's ear: to **prove** he said a word, re-listen **without** a prompt or
  measure the fricative (4–12 kHz energy).
- The aligner closes words 0.05–0.10 s early: that "leftover" at the end of a word is **not** a hesitation — do not cut it.
- A word that whisper writes differently from what he says (plural, proper name) is confirmed with both models +
  the forced aligner (which of the two spellings the aligner prefers, and by how much).
- MLX segfaults: every long step saves per item and resumes.

## 7. Reference numbers (sample_project)

8 episodes, 184 differences listed → **73 cuts + 107 regenerated stretches**, 4 refused and left as the original.
Final durations: v7 179.72 · p01 93.94 · v1 240.04 · v2 107.08 · v3 208.36 · v4 70.84 · v5 105.64 · v6 145.32 s —
all with `ALL DELIVERY GATES PASS`.
SAMPLE PROJECT 1.1 (`d1`): 60 tasks → 28 entries (8 cuts + 20 gens), 27 accepted, 1 kept as the original
("cloud code" → "Claude Code": F5 always reads "cloud"); voice 259.56 → 254.25 s.
