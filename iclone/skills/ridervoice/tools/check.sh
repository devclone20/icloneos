#!/bin/zsh
# Measure a spoken file against his real-voice profile. usage: check.sh <wav|mp3> "<text that was spoken>"
E="${RIDERVOICE_DIR:?}/engine"; M="${RIDERVOICE_HOME:?}"; export PYTORCH_ENABLE_MPS_FALLBACK=1
"${F5TTS_VENV:?}"/bin/python "$E/measure.py" measure $M/profile_his_voice.json "$1" "$2" 2>/dev/null | grep "^{" | python3 -c "
import json,sys; m=json.load(sys.stdin)
gates={'wer':m['wer']<=0.10,'fillers':not m['fillers'],'repeats':not m['repeats'],'spk_sim':m['spk_sim']>=0.90,'f0_delta_st':m['f0_delta_st'] is not None and abs(m['f0_delta_st'])<=2.5,'rate':m['rate_ratio'] is not None and 0.85<=m['rate_ratio']<=1.25,'noise':m['noise_floor_dbfs']<=-55}
print(json.dumps({k:m[k] for k in ('dur','wer','fillers','repeats','spk_sim','f0_delta_st','f0_spread_st','rate_ratio','pause_median','noise_floor_dbfs','peak_dbfs')}))
print('GATES:', 'PASS' if all(gates.values()) else 'FAIL '+str([k for k,v in gates.items() if not v]))"
