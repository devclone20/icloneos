# The engine, step by step

Root: `$RIDERVOICE_DIR/engine/` · python: `$F5TTS_VENV/bin/python` · heavy work: `~/Movies/sample_project/`
(`src/` raw · `clean/` cleaned · `seg/` + `manifest.jsonl` · `sample_project/` · `dataset/` (= `$F5TTS_VENV/lib/python3.12/data`)
· `ckpts/` (= `.../lib/python3.12/ckpts`) · `eval/` · `samples/` · `logs/`).

## A. His new voice → training data
```bash
ffmpeg -i video.mov -vn -ac 1 -ar 48000 -c:a pcm_s24le src/x_raw.wav
<the DeepFilterNet venv>/bin/python engine/df_clean.py src/x_raw.wav clean/x_df.wav      # DeepFilterNet3 (voicefix venv)
engine/voice_chain.sh clean/x_df.wav clean/x.wav                                  # EQ/de-esser/comp/−16 LUFS
$F5TTS_VENV/bin/python engine/segment.py clean/x.wav seg x                      # 4 in parallel: engine/run_segment_all.sh
$F5TTS_VENV/bin/python engine/make_dataset.py batches seg/manifest.jsonl sample_project 36
#   → one Sonnet agent per batch with engine/SAMPLE_PROJECT.md → sample_project/batch_NN.out.json
$F5TTS_VENV/bin/python engine/make_dataset.py build seg/manifest.jsonl sample_project <name> 0.05
```
`segment.py`: verbatim whisper (prompt with fillers) → 1.5–12 s utterances cut at pauses → MMS_FA gives exact
boundaries → cuts fillers, n-gram repetitions, broken words → 2nd listen (WER ≤ 0.12, otherwise large-v3 decides, ≤ 0.25)
→ speech-level leftovers become 2nd-pass cuts, reverted if the listen loses a word → 24 kHz 16-bit.
If whisper "collapses" on a long file (few words), repeat in 30 s windows.

## B. Training
```bash
engine/train.sh <name> <epochs> [frames=3200] [lr=1e-5] [save=500]      # WARMUP=N PRETRAIN=<safetensors in trainer format>
engine/auto_eval.sh <name> <max_updates>                                   # evaluates each checkpoint → eval/SUMMARY.md
```
"Pretrained" format for the trainer: keys `ema_model.<param>` + `initted` + `step` (the inference slim has unprefixed keys and does NOT work for the trainer).

## C. Evaluate and choose
```bash
$F5TTS_VENV/bin/python engine/measure.py profile eval/profile_his_voice.json <40 clean sentences of his>
$F5TTS_VENV/bin/python engine/eval_ckpt.py <ckpt.pt|base> <tag> --ema 0 [--seed 23]
#   → Opus critic with engine/SAMPLE_PROJECT.md → eval/critic_rN.json
```

## D. Export and speak
```bash
# slim for inference (direct weights): see STATE.md 16:28 — torch.load(ckpt)["model_state_dict"] → safetensors
$F5TTS_VENV/bin/python engine/synth.py <ckpt> <vocab> <refs.json> out.wav "text" --ema 0 --speed 1.12 --seed 23 --pause 0.4 --verify 3
engine/make_samples.sh <ckpt> <output folder> [seed]      # SPEED= VERIFY= ; 8 texts from samples/scripts.json, measured and mastered
```

## Traps already paid for
- zsh does not word-split `$VAR`: compound arguments go in arrays (`"${ARR[@]}"`) or `${=VAR}`.
- `prepare_csv_wavs --pretrain` means a NEW pre-training: for fine-tuning do not pass the flag; it requires `data/Emilia_ZH_EN_pinyin/vocab.txt`.
- `files("f5_tts")/../../data` is `lib/python3.12/data`, not `site-packages/data`.
- Batch 4800 frames fp32 + 3 workers swaps 12 GB and takes 14 s/update; 3200 frames = 1.05 s/update.
- num_workers 16 (default) costs 12–18 s per epoch on the Mac; 3 is enough.
- EMA misleads on new checkpoints: evaluate with `--ema 0`.
- MLX whisper segfaults now and then: everything is resumable per file/segment.
- Never run two generators writing to the same `samples/raw` folder.
