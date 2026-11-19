import { useCallback, useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { w1bVoiceExtra } from '@/i18n/en/v009-w1b'
import { Loader2 } from '@/lib/icons'

import type {
  VoiceExtraBridge,
  VoiceExtraInstallAnswer,
  VoiceExtraStatus
} from '../../../electron/voice-extra-types'

import { SettingRow } from './setting-row'

/**
 * v0.0.9 W1b — Settings › Voice › Local speech recognition. The voice extra installs APP-SIDE (electron/voice-extra.ts)
 * into the app's private dependency home, only when the owner clicks Install (`data-voice-extra-confirm`: the
 * preload's `voiceExtra` lock; main checks the V3-F gesture). The agent never installs it by itself.
 */

/** The bridge (`window.hermesDesktop.icloneVoiceExtra`); absent in a browser and on an older preload. */
export function voiceExtraBridge(): VoiceExtraBridge | undefined {
  return (window.hermesDesktop as unknown as { icloneVoiceExtra?: VoiceExtraBridge } | undefined)?.icloneVoiceExtra
}

function statusText(status: VoiceExtraStatus): string {
  const words = w1bVoiceExtra.state

  if (status.state === 'installed') {
    return status.restartNeeded ? words.installedRestart : words.installed
  }

  return words[status.state]
}

function answerError(answer: VoiceExtraInstallAnswer | null): string | null {
  if (!answer) {
    return w1bVoiceExtra.refused.unmanaged
  }

  if (answer.ok) {
    return null
  }

  return 'refused' in answer ? w1bVoiceExtra.refused[answer.refused] : answer.error
}

export function VoiceExtraRow() {
  const bridge = voiceExtraBridge()
  const [status, setStatus] = useState<VoiceExtraStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true

    void bridge
      ?.status()
      .then(next => {
        if (live && next) {
          setStatus(next)
        }
      })
      .catch(() => undefined)

    return () => {
      live = false
    }
  }, [bridge])

  const install = useCallback(() => {
    if (!bridge || busy) {
      return
    }

    // The bridge call stays inside the click (before any await): the preload takes the owner's confirm right here.
    const pending = bridge.install()

    setBusy(true)
    setError(null)
    setStatus({ state: 'installing' })
    void pending
      .then(answer => {
        setError(answerError(answer))

        return bridge.status()
      })
      .then(next => setStatus(next ?? null))
      .catch(() => setError(w1bVoiceExtra.refused.unmanaged))
      .finally(() => setBusy(false))
  }, [bridge, busy])

  if (!bridge) {
    return null
  }

  const canInstall = status?.state === 'absent'

  return (
    <SettingRow
      busy={busy}
      control={
        canInstall || busy ? (
          <Button data-voice-extra-confirm disabled={busy} onClick={install} size="sm" variant="textStrong">
            {busy ? <Loader2 className="size-3 animate-spin" /> : null}
            {busy ? w1bVoiceExtra.installing : error ? w1bVoiceExtra.retry : w1bVoiceExtra.install}
          </Button>
        ) : undefined
      }
      data-tour="voice-extra"
      error={error ?? undefined}
      hint={status ? statusText(status) : undefined}
      title={w1bVoiceExtra.title}
    />
  )
}
