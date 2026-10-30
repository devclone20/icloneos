/** The Bank's card and the gate states drawn around it (no card yet, a lapsed
 *  session, a sign-in link waiting in the agent inbox). */
import { Lock, MailCheck } from 'lucide-react'
import { memo, type ReactNode } from 'react'

import type { AgentcardAccountState } from '@/app/home/acp-setup'
import { type Translations, useI18n } from '@/i18n'

import { timeAgo, usd } from '../format'
import { Action } from '../ui'

import { type CardLimit, centsToUsd } from './bank-data'

/** What the card's back may claim: `live` was read just now; `signed-out` is a
 *  card known to exist whose state cannot be read until sign-in (only its last
 *  limit is known, never "Active"); `none` is no card at all. */
type CardFace = 'live' | 'none' | 'signed-out'

/** `template` with its one `{target}` slot filled by a node: each locale puts the slot where its grammar wants it. */
function withTarget(template: string, target: ReactNode): ReactNode {
  const [before, after = ''] = template.split('{target}')

  return (
    <>
      {before}
      {target}
      {after}
    </>
  )
}

// Every element inside is a span: the interactive variant is a <button>,
// which may only hold phrasing content.
export const CardVisual = memo(function CardVisual({
  agentName,
  face,
  flipped,
  funding,
  label,
  limit,
  locked,
  onToggle
}: {
  agentName: string
  face: CardFace
  flipped: boolean
  funding?: null | string
  /** The static variant's accessible name. */
  label?: string
  limit: CardLimit | undefined
  locked: boolean
  onToggle?: () => void
}) {
  const copy = useI18n().t.bank.card
  const className = ['bk-card', flipped ? 'bk-card--flipped' : '', locked ? 'bk-card--locked' : ''].join(' ').trim()
  const live = face === 'live'
  const spent = live && limit?.spentCents != null ? usd(centsToUsd(limit.spentCents)) : null

  const faces = (
    <span className="bk-card__inner">
      <span className="bk-card__face">
        <span className="bk-card__top">
          <span className="bk-card__brand">
            agent<span className="bk-card__mark">card</span>
          </span>
          <span aria-hidden="true" className="bk-card__chip" />
        </span>
        <span className="bk-card__number">•••• •••• •••• ••••</span>
        <span className="bk-card__bottom">
          <span className="bk-card__holder">
            <span>{copy.cardholder}</span>
            <b>{agentName}</b>
          </span>
          {locked ? <Lock size={16} strokeWidth={1.6} /> : null}
        </span>
        {onToggle ? <span className="bk-card__flip-hint">{copy.tapToFlip}</span> : null}
      </span>
      <span className="bk-card__face bk-card__face--back">
        <span className="bk-card__stripe" />
        <span className="bk-card__back-rows">
          <span className="bk-card__back-row">
            <span>{face === 'signed-out' ? copy.lastSpendLimit : copy.spendLimit}</span>
            <b>{face !== 'none' && limit ? usd(centsToUsd(limit.limitCents)) : '—'}</b>
          </span>
          {spent ? (
            <span className="bk-card__back-row">
              <span>{copy.spent}</span>
              <b>{spent}</b>
            </span>
          ) : null}
          <span className="bk-card__back-row">
            <span>{copy.status}</span>
            <b>{live ? (locked ? copy.locked : copy.active) : face === 'none' ? copy.notSignedUp : copy.signedOut}</b>
          </span>
          {live && funding ? (
            <span className="bk-card__back-row">
              <span>{copy.funding}</span>
              <b>{funding}</b>
            </span>
          ) : null}
        </span>
        {onToggle ? <span className="bk-card__flip-hint">{copy.tapToFlip}</span> : null}
      </span>
    </span>
  )

  if (!onToggle) {
    return (
      <span aria-label={label} className={className} role="img">
        {faces}
      </span>
    )
  }

  return (
    <button
      aria-label={flipped ? copy.showFront : copy.showBack}
      className={className}
      onClick={onToggle}
      type="button"
    >
      {faces}
    </button>
  )
})

// ── gate states: no card yet · sign-in pending ───────────────────────────

const ACCOUNT_SENTENCE = {
  'kyc-required': 'kycRequired',
  ready: 'ready',
  'signed-out': 'signedOut'
} as const satisfies Record<AgentcardAccountState, keyof Translations['bank']['gate']['agentcardAccount']>

/** Two sentences on one line: a space between them, none after a full-width full stop (ja, zh). */
function joinSentences(...sentences: string[]): string {
  return sentences.reduce((line, next) => (!line || /[。！？]$/.test(line) ? line + next : `${line} ${next}`), '')
}

/** The second path (the owner's own `agentcard` account), and its state when known, as the tail of a hint
 *  line that already exists: no element of its own. */
function otherPathTail(
  copy: Translations['bank']['gate'],
  lead: string,
  account: AgentcardAccountState | null | undefined
): string {
  const tail = joinSentences(copy.otherPath, account ? copy.agentcardAccount[ACCOUNT_SENTENCE[account]] : '')

  return joinSentences(lead, tail).slice(lead.length)
}

export function NoCardYet({
  agentName,
  agentcardAccount,
  onOpenSetup
}: {
  agentName: string
  /** The owner's own AgentCard account (`agentcard` CLI), read-only; null/absent = not known. */
  agentcardAccount?: AgentcardAccountState | null
  onOpenSetup: () => void
}) {
  const copy = useI18n().t.bank.gate

  return (
    <div className="bk-gate">
      <CardVisual agentName={agentName} face="none" flipped label={copy.notSetUpLabel} limit={undefined} locked />
      <p className="bk-gate__title">{copy.noCardTitle}</p>
      <p className="bk-gate__hint">
        {copy.noCardHint(agentName)}
        {otherPathTail(copy, copy.noCardHint(agentName), agentcardAccount)}
      </p>
      <ol className="bk-steps">
        <li className="bk-step">
          <span className="bk-step__num">1</span>
          <span>
            <b>{copy.stepSignUp}</b> — {copy.stepSignUpHint}
          </span>
        </li>
        <li className="bk-step">
          <span className="bk-step__num">2</span>
          <span>
            <b>{copy.stepVerify}</b> — {copy.stepVerifyHint}
          </span>
        </li>
        <li className="bk-step">
          <span className="bk-step__num">3</span>
          <span>
            <b>{copy.stepPayment}</b> — {copy.stepPaymentHint}
          </span>
        </li>
        <li className="bk-step">
          <span className="bk-step__num">4</span>
          <span>
            <b>{copy.stepLimit}</b> — {copy.stepLimitHint}
          </span>
        </li>
      </ol>
      <div className="bk-gate__actions">
        <Action kind="primary" onClick={onOpenSetup}>
          {copy.openSetup}
        </Action>
      </div>
    </div>
  )
}

/** The Virtuals session lapsed, so the card cannot be read. A card already seen
 *  ready stays on screen, dimmed; with none seen there is no card to show, only
 *  the sign-in. Either way the only way forward is signing in, never a signup. */
export function SessionExpired({
  agentName,
  cardKnown,
  email,
  limit,
  onSignIn
}: {
  agentName: string
  cardKnown?: boolean
  email?: string
  limit: CardLimit | undefined
  onSignIn: () => void
}) {
  const copy = useI18n().t.bank.gate
  const account = email ? <> &middot; {email}</> : null

  return (
    <div className={cardKnown ? 'bk-gate bk-gate--expired' : 'bk-gate'}>
      {cardKnown ? (
        <>
          <CardVisual
            agentName={agentName}
            face="signed-out"
            flipped={false}
            label={copy.signedOutLabel}
            limit={limit}
            locked={false}
          />
          <p className="bk-gate__hint">
            {copy.useCardAgain}
            {account}
          </p>
        </>
      ) : (
        <>
          <Lock size={30} strokeWidth={1.5} />
          <p className="bk-gate__title">{copy.signInRequired}</p>
          <p className="bk-gate__hint">
            {copy.readCardAgain}
            {account}
          </p>
        </>
      )}
      <div className="bk-gate__actions">
        <Action kind="primary" onClick={onSignIn}>
          {copy.signInAgain}
        </Action>
      </div>
    </div>
  )
}

/** A link is waiting in the agent inbox. A card already seen ready stays on
 *  screen, dimmed, like the lapsed session — never replaced by the gate alone. */
export function SignInPending({
  agentName,
  agentcardAccount,
  cardKnown,
  email,
  limit,
  onAskInft,
  onOpenSetup,
  onResend,
  resendWait,
  sentAt
}: {
  agentName: string
  /** The owner's own AgentCard account (`agentcard` CLI), read-only; null/absent = not known. */
  agentcardAccount?: AgentcardAccountState | null
  cardKnown?: boolean
  email?: string
  limit: CardLimit | undefined
  onAskInft: () => void
  onOpenSetup: () => void
  /** Sends one fresh link (`card signup`, on this click only); absent when the address is not known. */
  onResend?: () => void
  /** Seconds until Resend may be pressed again; 0 = now. */
  resendWait: number
  /** Epoch ms the CLI confirmed the last send; null = not known (a read never stamps it). */
  sentAt: null | number
}) {
  const copy = useI18n().t.bank.gate
  const target = email ? <b>{email}</b> : copy.agentInbox(agentName)
  const sentText = sentAt ? copy.linkSentAgo(timeAgo(sentAt)) : undefined
  const sent = sentText ? <span className="bk-gate__sent"> · {sentText}</span> : null

  return (
    <div className={cardKnown ? 'bk-gate bk-gate--expired' : 'bk-gate'}>
      {cardKnown ? (
        <CardVisual
          agentName={agentName}
          face="signed-out"
          flipped={false}
          label={copy.signInRequiredLabel}
          limit={limit}
          locked={false}
        />
      ) : (
        <MailCheck size={30} strokeWidth={1.5} />
      )}
      {cardKnown ? (
        <p className="bk-gate__hint">
          {withTarget(copy.linkSentCardKnown, target)}
          {sent}
          {otherPathTail(copy, sentText ?? copy.linkSentCardKnown, agentcardAccount)}
        </p>
      ) : (
        <>
          <p className="bk-gate__title">{copy.signInRequired}</p>
          <p className="bk-gate__hint">
            {withTarget(copy.linkSent, target)}
            {sent}
            {otherPathTail(copy, sentText ?? copy.linkSent, agentcardAccount)}
          </p>
        </>
      )}
      <div className="bk-gate__actions">
        <Action kind="primary" onClick={onOpenSetup}>
          {copy.openSetup}
        </Action>
        {onResend ? (
          <Action
            disabled={resendWait > 0}
            onClick={onResend}
            title={resendWait > 0 ? copy.resendIn(resendWait) : undefined}
          >
            {resendWait > 0 ? copy.resendIn(resendWait) : copy.resendLink}
          </Action>
        ) : null}
        <Action onClick={onAskInft}>{copy.askFetchLink(agentName)}</Action>
      </div>
    </div>
  )
}
