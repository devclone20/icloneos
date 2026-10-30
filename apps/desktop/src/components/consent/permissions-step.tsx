import { useRef } from 'react'

import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { triggerHaptic } from '@/lib/haptics'
import { cn } from '@/lib/utils'

import { isTranslatedBank, useConsentCopy } from './copy'
import { consentGroups, neverUsedRows } from './rows'
import { ScrollBox } from './scroll-box'
import { ConsentFooter, ConsentHeader } from './terms-step'
import type { BundledPolicy, ConsentPermissionKey, ConsentPermissions } from './types'

const GROUP_TITLE = 'pt-4 pb-1 text-[0.6875rem] font-medium tracking-[0.08em] text-(--ui-text-tertiary) uppercase'
const GROUP_HINT = 'pb-1 text-[0.75rem] leading-4 text-(--ui-text-tertiary)'
const NAME = 'block text-[length:var(--conversation-text-font-size)] font-medium text-foreground'

const PURPOSE =
  'mt-1 block text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ui-text-tertiary)'

const EFFECT = 'mt-1 block text-[0.75rem] leading-4 text-muted-foreground'
const ROW = 'flex items-start justify-between gap-6 py-3'

export function PermissionsStep({
  busy,
  error,
  onAllowAll,
  onChange,
  onSave,
  onSkip,
  policy,
  values
}: {
  busy: boolean
  error: string | null
  onAllowAll: () => void
  onChange: (key: ConsentPermissionKey, on: boolean) => void
  onSave: () => void
  onSkip: () => void
  policy: BundledPolicy
  values: ConsentPermissions
}) {
  const bank = useConsentCopy()
  const copy = bank.sheet
  const continueRef = useRef<HTMLButtonElement>(null)

  // Keychain is informational (its real state), so "all on" means every switch the user can change.
  const allOn = consentGroups(policy, bank).every(group =>
    group.rows.every(row => row.key === 'keychain' || values[row.key] === true)
  )

  return (
    <>
      <ConsentHeader
        eyebrow={copy.permissionsEyebrow}
        lead={policy.permissionsIntro}
        note={isTranslatedBank(bank) ? copy.policyLanguage : undefined}
        title={copy.permissionsTitle}
      />
      <ScrollBox className="max-h-[min(34rem,62dvh)] px-5 pb-2">
        {consentGroups(policy, bank).map(group => (
          <section data-consent-group={group.id} key={group.id}>
            <h3 className={GROUP_TITLE}>{group.title}</h3>
            <p className={GROUP_HINT}>{group.hint}</p>
            <div className="divide-y divide-(--stroke-nous)">
              {group.rows.map(row =>
                row.key === 'keychain' ? (
                  <KeychainRow key={row.key} name={row.name} on={values.keychain === true} />
                ) : (
                  <div className={ROW} data-consent-permission={row.key} key={row.key}>
                    <label className="min-w-0 cursor-pointer" htmlFor={`consent-permission-${row.key}`}>
                      <span className={NAME}>{row.name}</span>
                      <span className={PURPOSE}>{row.purpose}</span>
                      <span className={EFFECT}>{row.effect}</span>
                    </label>
                    <Switch
                      aria-label={row.name}
                      checked={values[row.key] === true}
                      className="mt-0.5 shrink-0"
                      id={`consent-permission-${row.key}`}
                      onCheckedChange={on => {
                        triggerHaptic('selection')
                        onChange(row.key, on)
                      }}
                    />
                  </div>
                )
              )}
            </div>
          </section>
        ))}
        <section data-consent-group="never-used">
          <h3 className={GROUP_TITLE}>{bank.groups.neverUsed}</h3>
          <p className={GROUP_HINT}>{bank.groups.neverUsedHint}</p>
          <div className="divide-y divide-(--stroke-nous)">
            {neverUsedRows(bank).map(row => (
              <div className="py-3" data-consent-never-used={row.key} key={row.key}>
                <span className={NAME}>{row.name}</span>
                <span className={PURPOSE}>{row.line}</span>
              </div>
            ))}
          </div>
        </section>
        <p className="py-3 text-[0.75rem] leading-4 text-(--ui-text-tertiary)">{copy.permissionsFooter}</p>
      </ScrollBox>
      <ConsentFooter error={error}>
        <Button data-consent-skip="" disabled={busy} onClick={onSkip} variant="ghost">
          {copy.skip}
        </Button>
        <Button
          data-consent-allow-all=""
          disabled={busy || allOn}
          onClick={() => {
            triggerHaptic('selection')
            onAllowAll()
            // The choice is confirmed on the next press: Continue records it and opens the app.
            requestAnimationFrame(() => continueRef.current?.focus())
          }}
          variant="outline"
        >
          {allOn ? copy.allAllowed : copy.allowAll}
        </Button>
        <Button data-consent-save="" disabled={busy} onClick={onSave} ref={continueRef}>
          {busy ? copy.saving : copy.continue}
        </Button>
      </ConsentFooter>
    </>
  )
}

/** Keychain is the Mac's real state (U1-p2-02): a status chip and where it changes, never a switch that cannot move. */
function KeychainRow({ name, on }: { name: string; on: boolean }) {
  const bank = useConsentCopy()
  const copy = bank.sheet

  return (
    <div className={ROW} data-consent-permission="keychain">
      <div className="min-w-0">
        <span className={NAME}>{name}</span>
        <span className={PURPOSE}>{copy.keychainLine(on)}</span>
        <span className={EFFECT}>{copy.keychainChange}</span>
      </div>
      <span
        className={cn(
          'mt-0.5 shrink-0 rounded-full border px-2 py-0.5 text-[0.6875rem] font-medium',
          on ? 'border-primary/40 text-primary' : 'border-(--stroke-nous) text-(--ui-text-tertiary)'
        )}
        data-consent-keychain-state={on ? 'on' : 'off'}
      >
        {bank.settings.keychainState(on)}
      </span>
    </div>
  )
}
