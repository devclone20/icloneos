import { useI18n } from '@/i18n'
import { IS_MAC } from '@/lib/keybinds/combo'
import type { HermesConfigRecord } from '@/types/hermes'

import { getNested } from './helpers'
import { Pill } from './primitives'
import { SettingRow } from './setting-row'

type EngineNote = 'free' | 'fastest' | 'premium' | 'offline' | 'cloud'

// One-line latency/privacy character per TTS engine. Keep in sync with
// `tts.provider`'s options in constants.ts — cosmetic guidance, not a source
// of truth for what is installed.
const TTS_ENGINE_NOTES: Record<string, EngineNote> = {
  edge: 'free',
  elevenlabs: 'fastest',
  openai: 'premium',
  xai: 'premium',
  minimax: 'premium',
  mistral: 'premium',
  gemini: 'premium',
  deepinfra: 'premium',
  neutts: 'offline',
  kittentts: 'offline',
  piper: 'offline'
}

/**
 * The first row of Settings → Voice: which speech engines are active and
 * whether this app talks to them directly (fastest) or through the agent.
 * Purely informational: it reads the loaded config and never writes, so it
 * cannot drift the settings below it out of sync.
 */
export function VoiceReadinessHint({ config }: { config: HermesConfigRecord }) {
  const { t } = useI18n()
  const v = t.settings.config.voiceReadiness
  const sttEnabled = Boolean(getNested(config, 'stt.enabled'))
  const sttProviderRaw = getNested(config, 'stt.provider')
  const sttProvider = typeof sttProviderRaw === 'string' ? sttProviderRaw.trim() : ''
  const ttsProvider = String(getNested(config, 'tts.provider') ?? 'edge')
  const clientDirect = getNested(config, 'voice.client_direct') !== false
  const autoTts = Boolean(getNested(config, 'voice.auto_tts'))
  const sttSummary = !sttEnabled ? v.off : sttProvider || v.auto

  return (
    <SettingRow
      below={IS_MAC ? <p className="text-xs text-muted-foreground">{v.mic}</p> : undefined}
      control={<Pill tone={clientDirect ? 'primary' : 'muted'}>{clientDirect ? v.direct : v.relayed}</Pill>}
      data-tour="voice-readiness"
      hint={
        <>
          <span className="block">
            {v.listening(sttSummary)} · {v.speaking(ttsProvider, autoTts)}
          </span>
          <span className="block">
            {v.notes[TTS_ENGINE_NOTES[ttsProvider] ?? 'cloud']} {clientDirect ? v.directNote : v.relayedNote}
          </span>
        </>
      }
      title={v.title}
    />
  )
}
