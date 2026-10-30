# The two agents: EDITOR and CRITIC

An episode has dozens of by-ear decisions. It is done with **two** agents per episode: one decides, the other tries to
fail it. The long contracts live in the pipeline (`sample_project/EDITOR_GUIDE.md`, `sample_project/SAMPLE_PROJECT.md`); this is
what cannot be missing from the briefing.

## 1. EDITOR — decides each task

Receives: `prep/<k>_brief.md` (one task per difference, with the aligned words, the two transcriptions and the
hidden hesitations), `prep/<k>_tasks.json`, and the audio.

Must:
- decide **cut**, **gen** or **skip** per task, with a note saying why;
- **re-listen** to the doubtful ones before deciding (the `initial_prompt` biases: listen without a prompt, or measure the fricative);
- never put into a `gen`'s text a word he says **immediately next to it** (the model says it twice) —
  if that word is needed, **extend the span** to swallow it;
- write `<k>_ref_fixes.json` when whisper misspelled a word inside the reference window;
- write `prep/<k>_decisions.md` with one line per task;
- finish with the list of the **decisions it is least sure about** (that is what the critic will attack first).

Does not run the engine, does not touch the video.

## 2. CRITIC — adversarial, only approves with numbers

Receives: `out_<k>/critic/<id>.json` (measurements) + `out_<k>/critic/<id>.png` (mel), `out_<k>/<k>_report.json`,
`edits_<k>.json`, the editor's notes, and **which corrections passed with relaxed gates**.

Must:
- give a verdict on **all** ids: `pass` | `redo` | `keep_original`, with the overrides defined in the guide;
- measure pitch and level **against the replaced stretch** (`ref.lvl`, `ref.jin`, `ref.jout`), never against the context;
- fail: duplicated word at the joint, word that did not land (both models still read the mistake), his pause
  deleted, rushed stretch, wrong level, audible joint;
- justify each "pass" of a relaxed item **with the number** that saves it;
- say, for each `redo`, what is wrong and what changed in the override.

Does not run the engine, does not touch the video, does not edit `edits_<k>.json` (that is `apply_verdicts.py`'s job).

## 3. Rounds

`run_fix.sh` → `run_critic.sh` (+ `--episode`) → critic → `apply_verdicts.py edits_<k>.json … <round>` →
delete the ids to redo from the report → `run_fix.sh` again. Repeat **until 0 redos**.
In practice: 1 to 3 rounds per episode. A correction that fails two rounds in a row with the same cause goes to
`keep_original` — and the reason goes in the edit's `note`.

## 4. Operation

- Batches of **6 ids** per measurement pass (MLX segfaults; everything is resumable and skips what already has a `.json`).
- One agent per episode at a time; different episodes in parallel.
- The agent returns **only** the short report: counts per verdict and one line per non-approved item.
