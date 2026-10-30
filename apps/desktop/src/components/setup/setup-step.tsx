import { type ReactNode, useState } from 'react'

import { Button } from '@/components/ui/button'
import { triggerHaptic } from '@/lib/haptics'

import { ScrollBox } from '../consent/scroll-box'
import { ConsentFooter, ConsentHeader } from '../consent/terms-step'

import { SetupAgentLevels } from './agent-levels'
import { useSetupCopy } from './copy'
import { SetupPackageRows, SetupSystemRows } from './rows'
import type { SetupChoice, SetupSection } from './types'

// The section's title shares its row with its Skip: the row carries the top space, so the two sit on one line.
const SECTION_TITLE = 'text-[0.6875rem] font-medium tracking-[0.08em] text-(--ui-text-tertiary) uppercase'
const GROUP_HINT = 'pb-1 text-[0.75rem] leading-4 text-(--ui-text-tertiary)'
const SKIPPED = 'py-3 text-[0.75rem] leading-4 text-(--ui-text-tertiary)'

const BODY: Readonly<Record<SetupSection, () => ReactNode>> = {
  packages: () => <SetupPackageRows />,
  system: () => <SetupSystemRows />,
  agent: () => <SetupAgentLevels />
}

/** Every shown section as stored: skipped where the user pressed its Skip, done otherwise. */
export function setupChoices(sections: readonly SetupSection[], skipped: ReadonlySet<SetupSection>) {
  return Object.fromEntries(sections.map(section => [section, skipped.has(section) ? 'skipped' : 'done'])) as Partial<
    Record<SetupSection, SetupChoice>
  >
}

/**
 * V3-ON (ruling 44) — the Set up step: ONE screen, the sections the user never decided, each with its own Skip.
 * "Done" records every shown section once (done, or skipped where its Skip was pressed); "Skip all" records them all
 * skipped. Neither waits on an install or on macOS: the workspace opens the moment either is pressed.
 */
export function SetupStep({
  busy,
  error,
  failed,
  onDone,
  onSkipAll,
  sections
}: {
  busy: boolean
  error: string | null
  /** r2 M2: the last save failed — Try again, or Continue to the app (nothing recorded, offered from Settings). */
  failed?: { onRetry: () => void; onContinue: () => void }
  onDone: (choices: Partial<Record<SetupSection, SetupChoice>>) => void
  onSkipAll: (choices: Partial<Record<SetupSection, SetupChoice>>) => void
  sections: readonly SetupSection[]
}) {
  const copy = useSetupCopy()
  const [skipped, setSkipped] = useState<ReadonlySet<SetupSection>>(() => new Set())

  const toggle = (section: SetupSection) =>
    setSkipped(current => {
      const next = new Set(current)

      if (!next.delete(section)) {
        next.add(section)
      }

      return next
    })

  return (
    <>
      <ConsentHeader eyebrow={copy.sheet.eyebrow} lead={copy.sheet.lead} title={copy.sheet.title} />
      <ScrollBox className="max-h-[min(34rem,62dvh)] px-5 pb-2">
        {sections.map(section => {
          const off = skipped.has(section)

          return (
            <section data-setup-section={section} data-setup-skipped={off ? '' : undefined} key={section}>
              <div className="flex items-center justify-between gap-3 pt-4">
                <h3 className={SECTION_TITLE}>{copy.sections[section].title}</h3>
                <Button
                  aria-pressed={off}
                  data-setup-skip={section}
                  disabled={busy}
                  onClick={() => {
                    triggerHaptic('selection')
                    toggle(section)
                  }}
                  size="sm"
                  variant="ghost"
                >
                  {off ? copy.sheet.undo : copy.sheet.skip}
                </Button>
              </div>
              <p className={GROUP_HINT}>{copy.sections[section].hint}</p>
              {off ? <p className={SKIPPED}>{copy.sheet.skipped}</p> : BODY[section]()}
            </section>
          )
        })}
      </ScrollBox>
      <ConsentFooter error={failed ? copy.sheet.saveFailed : error}>
        {failed ? (
          // r2 M2: never a trap — try the save again, or open the app with nothing recorded.
          <>
            <Button data-setup-continue="" disabled={busy} onClick={failed.onContinue} variant="ghost">
              {copy.sheet.continueToApp}
            </Button>
            <Button data-setup-retry-save="" disabled={busy} onClick={failed.onRetry}>
              {busy ? copy.sheet.saving : copy.sheet.tryAgain}
            </Button>
          </>
        ) : (
          <>
            <Button
              data-setup-skip-all=""
              disabled={busy}
              onClick={() => onSkipAll(setupChoices(sections, new Set(sections)))}
              variant="ghost"
            >
              {copy.sheet.skipAll}
            </Button>
            <Button data-setup-done="" disabled={busy} onClick={() => onDone(setupChoices(sections, skipped))}>
              {busy ? copy.sheet.saving : copy.sheet.done}
            </Button>
          </>
        )}
      </ConsentFooter>
    </>
  )
}
