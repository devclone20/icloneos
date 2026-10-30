#!/bin/zsh
# Speak a text in the owner's voice. usage: say.sh "<text or @file.txt>" <out.wav|out.mp3> [--speed 1.12] [--seed 23] [--verify 3] [--pause 0.4] [--no-master]
# Model: $RIDERVOICE_HOME/model/rider_v1_ck2000.safetensors (F5-TTS v1 Base fine-tuned). Engine: $RIDERVOICE_DIR/engine.
set -e
TEXT=$1; OUT=$2; shift 2
E="${RIDERVOICE_DIR:?}/engine"; M="${RIDERVOICE_HOME:?}"; PY="${F5TTS_VENV:?}"/bin/python
export PYTORCH_ENABLE_MPS_FALLBACK=1
SPEED=1.12; SEED=23; VERIFY=3; PAUSE=0.4; MASTER=1
while [ $# -gt 0 ]; do case $1 in --speed) SPEED=$2; shift 2;; --seed) SEED=$2; shift 2;; --verify) VERIFY=$2; shift 2;; --pause) PAUSE=$2; shift 2;; --no-master) MASTER=0; shift;; *) echo "unknown $1"; exit 2;; esac; done
RAW="${OUT%.*}.raw24k.wav"
$PY "$E/synth.py" $M/model/rider_v1_ck2000.safetensors $M/model/vocab.txt $M/refs.json "$RAW" "$TEXT" --ema 0 --speed $SPEED --seed $SEED --pause $PAUSE --verify $VERIFY 2>&1 | grep -E "^\[|wrote"
if [ $MASTER = 1 ]; then
  case "$OUT" in *.mp3) ffmpeg -v error -y -i "$RAW" -af "loudnorm=I=-16:TP=-1.5:LRA=9" -ar 48000 -ac 1 -c:a libmp3lame -b:a 192k "$OUT";;
                  *)     ffmpeg -v error -y -i "$RAW" -af "loudnorm=I=-16:TP=-1.5:LRA=9" -ar 48000 -ac 1 -c:a pcm_s16le "$OUT";; esac
  rm -f "$RAW"
else mv "$RAW" "$OUT"; fi
echo "-> $OUT"
