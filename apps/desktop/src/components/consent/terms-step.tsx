import { createContext, type ReactNode, useContext, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ExternalLink } from '@/lib/icons'

import { isTranslatedBank, useConsentCopy } from './copy'
import { PolicyReader } from './policy-reader'
import { ScrollBox } from './scroll-box'
import { consentBridge } from './store'
import type { BundledPolicy } from './types'

const CONTINUE_HINT_ID = 'consent-continue-hint'

export function TermsStep({
  busy,
  error,
  onContinue,
  policy,
  update
}: {
  busy: boolean
  error: string | null
  onContinue: (accepted: boolean) => void
  policy: BundledPolicy
  update: boolean
}) {
  const bank = useConsentCopy()
  const copy = bank.sheet
  const translated = isTranslatedBank(bank)
  const [accepted, setAccepted] = useState(false)
  const [reading, setReading] = useState(false)
  const acceptanceRef = useRef<HTMLDivElement>(null)
  const toggleReading = () => setReading(open => !open)

  return (
    <>
      <ConsentHeader
        eyebrow={copy.eyebrow(policy.title, policy.version, policy.effectiveLabel)}
        lead={update ? copy.updateLead : copy.termsLead}
        title={update ? copy.updateTitle : copy.termsTitle}
      />
      <ScrollBox className="max-h-[min(26rem,44dvh)] px-5 pt-3 pb-4">
        <ul className="grid gap-2.5">
          {policy.short.map(item => (
            <li className="text-[0.8125rem] leading-5 text-(--ui-text-secondary)" key={item.lead}>
              <span className="font-medium text-foreground">{item.lead}</span> {item.text}
            </li>
          ))}
        </ul>
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1">
          <Button className="px-0" onClick={() => void consentBridge()?.openPolicy()} size="sm" variant="link">
            {copy.readFull}
            <ExternalLink className="size-3.5" />
          </Button>
          <Button aria-expanded={reading} className="px-0" onClick={toggleReading} size="sm" variant="link">
            {reading ? copy.hideOffline : copy.readOffline}
          </Button>
        </div>
        {translated ? (
          <p className="mt-2 text-[0.75rem] leading-4 text-(--ui-text-tertiary)">{copy.policyLanguage}</p>
        ) : null}
        {reading ? (
          <div className="mt-2">
            <PolicyReader />
          </div>
        ) : null}
      </ScrollBox>
      {/* The acceptance lives outside the scroll box (U1-p2-01): the required box is never below a fold. */}
      <div
        className="grid gap-3 border-t border-(--stroke-nous) px-5 pt-4 pb-1"
        data-consent-acceptance=""
        ref={acceptanceRef}
      >
        {/* Part of the required acceptance (APP_STORE_GAPS blocker 2): nothing here pretends to gate the send. */}
        <p className="text-[0.8125rem] leading-5 text-(--ui-text-secondary)" data-consent-ai-disclosure="">
          {copy.aiDisclosure}
        </p>
        <label className="flex cursor-pointer items-start gap-3" htmlFor="consent-accept">
          <Checkbox
            checked={accepted}
            className="mt-0.5"
            data-consent-accept=""
            id="consent-accept"
            onCheckedChange={value => setAccepted(value === true)}
          />
          <span className="text-[0.8125rem] leading-5 font-medium text-foreground" id="consent-accept-label">
            {copy.accept(policy.title, policy.version)}
          </span>
        </label>
      </div>
      <ConsentFooter error={error} hint={accepted ? null : { id: CONTINUE_HINT_ID, text: copy.acceptHint }}>
        <Button data-consent-quit="" onClick={() => void consentBridge()?.quit()} variant="ghost">
          {copy.quit}
        </Button>
        {/* Inactive, not disabled: it stays reachable, says why, and sends the focus to the box it waits for. */}
        <Button
          aria-describedby={accepted ? undefined : CONTINUE_HINT_ID}
          aria-disabled={accepted ? undefined : true}
          className={accepted ? undefined : 'opacity-50'}
          data-consent-continue=""
          disabled={busy}
          onClick={() => {
            if (!accepted) {
              acceptanceRef.current?.querySelector<HTMLElement>('#consent-accept')?.focus()

              return
            }

            onContinue(true)
          }}
        >
          {busy ? copy.saving : copy.continue}
        </Button>
      </ConsentFooter>
    </>
  )
}

/**
 * FX-5: the sheet's "Step n of m" badge (index.tsx provides it while the sheet has more than one step). Every header
 * lays it out in its own top row, after the language switcher, so the two never overlap in any language or direction.
 */
export const ConsentStepBadge = createContext<string | null>(null)

/** `aside`: the header's end slot (U2-p2b-01), which used to carry the language door. Ruling 69 (owner,
 *  2026-10-25): the app ships in ENGLISH ONLY, the picker draws nothing, and no step passes an aside — an empty
 *  slot is not a design. The slot stays for the day a language returns (G-31). */
export function ConsentHeader({
  aside,
  eyebrow,
  lead,
  note,
  title
}: {
  aside?: ReactNode
  eyebrow: string
  lead: string
  note?: string
  title: string
}) {
  const badge = useContext(ConsentStepBadge)

  return (
    <div className="px-5 pt-5 pb-1">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[0.6875rem] font-medium tracking-[0.06em] text-(--ui-text-tertiary) uppercase">{eyebrow}</p>
        <div className="flex shrink-0 items-center gap-3">
          {aside}
          {badge ? (
            <span className="text-[0.6875rem] whitespace-nowrap text-(--ui-text-tertiary)" data-consent-step-badge="">
              {badge}
            </span>
          ) : null}
        </div>
      </div>
      <h2 className="mt-1.5 text-[0.9375rem] font-semibold tracking-tight" id="consent-title">
        {title}
      </h2>
      <p className="mt-1 max-w-xl text-[0.8125rem] leading-5 text-(--ui-text-tertiary)">{lead}</p>
      {note ? <p className="mt-1 text-[0.75rem] leading-4 text-(--ui-text-tertiary)">{note}</p> : null}
    </div>
  )
}

export function ConsentFooter({
  children,
  error,
  hint
}: {
  children: React.ReactNode
  error: string | null
  hint?: { id: string; text: string } | null
}) {
  return (
    <div className="flex items-center gap-3 border-t border-(--stroke-nous) px-5 py-3.5">
      <p aria-live="polite" className="min-w-0 flex-1 text-[0.75rem] text-(--ui-text-tertiary)" role="status">
        {error}
      </p>
      <div className="flex shrink-0 items-center gap-2">
        {hint ? (
          <span className="text-[0.75rem] text-(--ui-text-tertiary)" data-consent-hint="" id={hint.id}>
            {hint.text}
          </span>
        ) : null}
        {children}
      </div>
    </div>
  )
}
