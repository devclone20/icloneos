import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import type { DesktopUninstallMode, DesktopUninstallSummary } from '@/global'
import { useI18n } from '@/i18n'
import { errorMessage } from '@/iclone-shared/errors'
import { AlertTriangle, Loader2, Trash2 } from '@/lib/icons'

import { useUninstallCopy } from './machine/uninstall-copy'
import { SectionHeading } from './primitives'
import { SettingRow } from './setting-row'

// Which removals need a local agent: full also removes the agent (and its user data), so a lite client with no
// local agent offers the app-only removal, the one correct option there.
const OPTIONS: { mode: DesktopUninstallMode; needsAgent: boolean }[] = [
  { mode: 'gui', needsAgent: false },
  { mode: 'lite', needsAgent: true },
  { mode: 'full', needsAgent: true }
]

export function UninstallSection() {
  const { t } = useI18n()
  const u = useUninstallCopy()
  const [summary, setSummary] = useState<DesktopUninstallSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState<DesktopUninstallMode | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const bridge = window.hermesDesktop?.uninstall

    if (!bridge) {
      setLoading(false)

      return
    }

    void bridge
      .summary()
      .then(result => {
        if (alive) {
          setSummary(result)
        }
      })
      .catch(() => {
        // Non-fatal — we degrade to offering the GUI-only option.
      })
      .finally(() => {
        if (alive) {
          setLoading(false)
        }
      })

    return () => {
      alive = false
    }
  }, [])

  const bridge = window.hermesDesktop?.uninstall

  if (!bridge) {
    return null
  }

  // Gate the agent-removing options on whether an agent is actually present.
  // A future lite client that ships without the bundled agent shows GUI-only.
  const agentInstalled = summary?.agent_installed ?? false
  const visibleOptions = OPTIONS.filter(opt => agentInstalled || !opt.needsAgent)

  const handleConfirm = async () => {
    if (!pending) {
      return
    }

    setRunning(true)
    setError(null)

    try {
      const result = await bridge.run(pending)

      if (!result.ok) {
        setError(result.message || result.error || u.startFailed)
        setRunning(false)
        setPending(null)
      }
      // On success the app quits shortly; keep the spinner up until it does.
    } catch (err) {
      setError(errorMessage(err))
      setRunning(false)
      setPending(null)
    }
  }

  const pendingOption = OPTIONS.find(opt => opt.mode === pending) ?? null

  return (
    <div className="mx-auto mt-8 w-full max-w-2xl">
      <SectionHeading icon={AlertTriangle} title={t.settings.about.dangerTitle} />

      {loading ? (
        <SettingRow control={<Loader2 className="size-3.5 animate-spin text-muted-foreground" />} title={u.checking} />
      ) : pendingOption ? (
        <SettingRow
          control={
            <div className="flex flex-wrap items-center justify-end gap-3">
              <Button disabled={running} onClick={() => setPending(null)} size="sm" variant="text">
                {u.cancel}
              </Button>
              <Button disabled={running} onClick={() => void handleConfirm()} size="sm" variant="destructive">
                {running && <Loader2 className="size-3 animate-spin" />}
                {running ? u.removing : u.remove}
              </Button>
            </div>
          }
          detail={summary?.running_app_path}
          error={error}
          hint={u.confirmHint(u.options[pendingOption.mode].removes)}
          title={u.confirmTitle}
        />
      ) : (
        <>
          <SettingRow hint={u.chooseHint} title={u.chooseTitle} />
          {visibleOptions.map(opt => (
            <SettingRow
              control={
                <Button
                  onClick={() => {
                    setError(null)
                    setPending(opt.mode)
                  }}
                  size="sm"
                  variant="textStrong"
                >
                  <Trash2 className="size-3" />
                  {u.choose}
                </Button>
              }
              hint={u.options[opt.mode].hint}
              key={opt.mode}
              title={u.options[opt.mode].title}
            />
          ))}
        </>
      )}
    </div>
  )
}
