import { Copy, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'

import { IcButton } from '@/components/onboarding/ic-system'
import { useI18n } from '@/i18n'
import type { HomeSettingsFinding, HomeSettingsRefusal, HomeSettingsReplaceFailure } from '@/iclone-shared/home-settings'

/** `undefined` until main has answered, so no surface flashes a way out that does not apply. */
export function useHomeSettingsRefusal(
  active: boolean,
  profile: null | string,
  doing: 'install' | 'start' = 'start'
): [HomeSettingsRefusal | null | undefined, (refusal: HomeSettingsRefusal | null) => void] {
  const unanswered = () => (window.hermesDesktop?.homeSettings ? undefined : null)
  const [refusal, setRefusal] = useState<HomeSettingsRefusal | null | undefined>(unanswered)

  useEffect(() => {
    if (!active) {
      setRefusal(unanswered())

      return
    }

    const bridge = window.hermesDesktop?.homeSettings

    if (!bridge) {
      return
    }

    let current = true

    void bridge
      .check(profile, doing)
      .catch(() => null)
      .then(answer => {
        if (current) {
          setRefusal(answer)
        }
      })

    return () => {
      current = false
    }
  }, [active, doing, profile])

  return [refusal, setRefusal]
}

interface OutcomeOfFile {
  failure?: HomeSettingsReplaceFailure
  file: string
  replaced?: boolean
  target: string
}

interface HomeSettingsRefusalPanelProps {
  doing?: 'install' | 'start'
  onChange: (refusal: HomeSettingsRefusal) => void
  profile: null | string
  refusal: HomeSettingsRefusal
}

/** The same surface wherever a start or an install stops on the owner's settings files. */
export function HomeSettingsRefusalPanel({ doing = 'start', onChange, profile, refusal }: HomeSettingsRefusalPanelProps) {
  const { t } = useI18n()
  const copy = t.boot.failure
  const [busyFile, setBusyFile] = useState<null | string>(null)
  const [outcome, setOutcome] = useState<null | OutcomeOfFile>(null)

  const replace = async (finding: HomeSettingsFinding, target: string) => {
    setBusyFile(finding.file)
    setOutcome(null)

    try {
      const result = await window.hermesDesktop?.homeSettings?.replaceWithCopy({ doing, file: finding.file, profile, target })

      if (result) {
        setOutcome({
          failure: result.ok ? undefined : result.reason,
          file: finding.file,
          replaced: result.ok,
          target
        })
        onChange(result.refusal ?? { code: refusal.code, findings: [] })
      }
    } catch {
      setOutcome({ failure: 'not-written', file: finding.file, target })
    } finally {
      setBusyFile(null)
    }
  }

  return (
    <div className="grid gap-4" data-testid="home-settings-refusal">
      {refusal.findings.map(finding => (
        <div className="grid gap-3" data-file={finding.file} data-kind={finding.kind} key={finding.file}>
          <div
            className="ic-sys-callout max-h-40 min-w-0 select-text overflow-y-auto px-3 py-2.5 [overflow-wrap:anywhere]"
            data-testid="boot-failure-error"
            data-tone="danger"
          >
            {finding.reason}
          </div>

          {finding.kind === 'link-outside' && finding.target ? (
            <div className="grid justify-items-start gap-2">
              <p className="ic-sys-body min-w-0 [overflow-wrap:anywhere]">
                {copy.homeSettingsReplaceExplain(finding.target, finding.path)}
              </p>
              <IcButton
                data-action="replace-with-copy"
                data-confinement-confirm=""
                disabled={busyFile !== null}
                onClick={() => void replace(finding, finding.target as string)}
                variant="secondary"
              >
                {busyFile === finding.file ? <Loader2 className="animate-spin" /> : <Copy />}
                {copy.homeSettingsReplace}
              </IcButton>
            </div>
          ) : null}

          {finding.command ? (
            <div className="grid gap-1">
              <p className="ic-sys-hint">{copy.homeSettingsTerminal}</p>
              <code className="block min-w-0 select-text font-mono text-xs text-(--ic-text-2) [overflow-wrap:anywhere]">
                {finding.command}
              </code>
            </div>
          ) : null}

          {outcome?.file === finding.file && outcome.failure ? (
            <p className="ic-sys-body text-(--ic-danger)" role="alert">
              {copy.homeSettingsCopyFailed[outcome.failure](outcome.target)}
            </p>
          ) : null}
        </div>
      ))}

      {outcome?.replaced ? (
        <p className="ic-sys-body" role="status">
          {copy.homeSettingsReplaced(outcome.file)}
        </p>
      ) : null}
    </div>
  )
}
