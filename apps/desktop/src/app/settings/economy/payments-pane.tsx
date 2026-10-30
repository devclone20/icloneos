import { useStore } from '@nanostores/react'
import { type ReactNode, useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useI18n } from '@/i18n'
import {
  ALLOWLIST_MAX,
  checkMandateTerms,
  defaultMandateTerms,
  formatUsdc,
  type MandateTermsProblem,
  parseUsdc,
  type PaymentsActionResult,
  type PaymentsChangeResult,
  type PaymentsMandateResult,
  type PaymentsMandateTerms,
  type PaymentsSettingsView
} from '@/iclone-shared/payments'
import { triggerHaptic } from '@/lib/haptics'
import { Activity, CreditCard, FileText, Lock, PencilLine, Users } from '@/lib/icons'
import {
  $payments,
  requestPaymentMandate,
  revokePaymentMandate,
  savePaymentSettings,
  setPaymentsStop,
  watchPayments
} from '@/store/payments'

import { ListRow, SettingsContent, SettingsSection, SettingsSkeleton } from '../primitives'
import { SettingRow } from '../setting-row'

import { usePaymentsCopy } from './payments-copy'
import { momentText, usdcLabel, usdcTextLabel } from './payments-format'

const CAPS = ['perTxMicros', 'perDayMicros', 'perAgentDayMicros'] as const

type Cap = (typeof CAPS)[number]

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

const MANDATE_AMOUNTS = ['budget', 'min', 'max'] as const
const MANDATE_DATES = ['notBefore', 'notAfter', 'expiresAt'] as const

type MandateDate = (typeof MANDATE_DATES)[number]

const two = (value: number) => String(value).padStart(2, '0')

/** An instant as a `datetime-local` value, in the user's own time zone (minutes). */
function localInput(iso: string): string {
  const date = new Date(iso)

  return Number.isFinite(date.getTime())
    ? `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}T${two(date.getHours())}:${two(date.getMinutes())}`
    : ''
}

/** A `datetime-local` value (the user's own time zone) as an ISO instant; '' when it is not one. */
function isoOfLocal(text: string): string {
  const date = new Date(text)

  return text && Number.isFinite(date.getTime()) ? date.toISOString() : ''
}

function originOf(text: string): string | null {
  try {
    const url = new URL(text.trim())

    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null
  } catch {
    return null
  }
}

/**
 * V3-J — Settings › Economy › Payments (contract §4: every cap is the user's). A view of main's state: the per-user
 * caps, the hard stop, who agents may pay and the mandates. Every write is the user's own click on a
 * `data-payments-confirm` control, calling main synchronously inside the handler (main checks the click). Main decides
 * whether the change widens: a raise or a new payee opens the permission sheet, a lowering applies at once.
 */
export function PaymentsPane() {
  const copy = usePaymentsCopy()
  const { locale } = useI18n()
  const store = useStore($payments)
  const [caps, setCaps] = useState<Partial<Record<Cap, string>>>({})
  const [capError, setCapError] = useState<Cap | null>(null)
  const [payee, setPayee] = useState('')
  const [origin, setOrigin] = useState('')

  const [listError, setListError] = useState<{
    kind: 'origins' | 'payees'
    problem: 'full' | 'invalid' | 'listed'
  } | null>(null)

  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  // A new mandate: the user's edits over defaults read from the caps at the instant the pane opened (whole minutes).
  const [draft, setDraft] = useState<Partial<PaymentsMandateTerms>>({})
  const [opened] = useState(() => new Date(Math.floor(Date.now() / 60_000) * 60_000))
  const [termsProblem, setTermsProblem] = useState<MandateTermsProblem | null>(null)

  useEffect(() => watchPayments(), [])

  if (store.status === 'unavailable') {
    return (
      <SettingsContent>
        <p className="mb-4 text-xs leading-5 text-muted-foreground">{copy.desktopOnly}</p>
      </SettingsContent>
    )
  }

  if (!store.state || !store.settings) {
    return (
      <SettingsSkeleton
        sections={[
          { heading: true, rows: 3 },
          { heading: true, rows: 3 }
        ]}
      />
    )
  }

  const { state, settings } = store

  const settle = (
    pending: Promise<PaymentsActionResult | PaymentsChangeResult | PaymentsMandateResult>,
    onOk?: () => void,
    okText = copy.saved
  ) => {
    setBusy(true)
    void pending.then(result => {
      setBusy(false)

      if (result.ok) {
        onOk?.()
        setFeedback({ ok: true, text: okText })
      } else {
        // An allowlist refusal names what main refused (fix Jm1), as data worded here (J4-5): the reason, then which.
        const problems = 'problems' in result && result.problems ? result.problems : []

        const detail = problems
          .map(problem => {
            const list = problem.list === 'payees' ? copy.allowlist.payees : copy.allowlist.origins

            return problem.kind === 'not_list'
              ? copy.allowlist.problems.notList(list)
              : problem.kind === 'too_many'
                ? copy.allowlist.problems.tooMany(list, problem.count, ALLOWLIST_MAX)
                : copy.allowlist.problems.entries(list, problem.entries.join(', '), problem.more)
          })
          .join(' ')

        setFeedback({
          ok: false,
          text: detail ? `${copy.refusals[result.reason]} ${detail}` : copy.refusals[result.reason]
        })
      }
    })
  }

  /** Inside the click handler: the bridge reads the click lock before anything awaits. */
  const change = (next: PaymentsSettingsView, onOk?: () => void) => {
    triggerHaptic('selection')
    settle(savePaymentSettings(settings, next), onOk)
  }

  const saveCaps = () => {
    const next: PaymentsSettingsView = { ...settings }

    for (const cap of CAPS) {
      const text = caps[cap]

      if (text === undefined) {
        continue
      }

      const micros = parseUsdc(text)

      if (micros === null) {
        setCapError(cap)

        return
      }

      next[cap] = micros
    }

    setCapError(null)
    change(next, () => setCaps({}))
  }

  /** Why `value` cannot join the `kind` list (fix Jm1: at most ALLOWLIST_MAX entries, none twice), or null. */
  const listProblem = (kind: 'origins' | 'payees', value: string | null) =>
    value === null
      ? 'invalid'
      : settings[kind].includes(value)
        ? 'listed'
        : settings[kind].length >= ALLOWLIST_MAX
          ? 'full'
          : null

  const addPayee = () => {
    const value = ADDRESS_RE.test(payee.trim()) ? payee.trim().toLowerCase() : null
    const problem = listProblem('payees', value)

    if (problem || value === null) {
      setListError({ kind: 'payees', problem: problem ?? 'invalid' })

      return
    }

    setListError(null)
    change({ ...settings, payees: [...settings.payees, value] }, () => setPayee(''))
  }

  const addOrigin = () => {
    const value = originOf(origin)
    const problem = listProblem('origins', value)

    if (problem || value === null) {
      setListError({ kind: 'origins', problem: problem ?? 'invalid' })

      return
    }

    setListError(null)
    change({ ...settings, origins: [...settings.origins, value] }, () => setOrigin(''))
  }

  const listErrorText = (kind: 'origins' | 'payees'): string | undefined =>
    listError?.kind !== kind
      ? undefined
      : listError.problem === 'full'
        ? copy.allowlist.full(ALLOWLIST_MAX)
        : listError.problem === 'listed'
          ? copy.allowlist.listed
          : kind === 'payees'
            ? copy.allowlist.invalidPayee
            : copy.allowlist.invalidOrigin

  const terms: PaymentsMandateTerms = {
    ...defaultMandateTerms(settings, state.agents[0]?.agent ?? '', opened),
    ...draft,
    payees: (draft.payees ?? settings.payees).filter(entry => settings.payees.includes(entry))
  }

  const editTerms = (patch: Partial<PaymentsMandateTerms>) => {
    setTermsProblem(null)
    setDraft(current => ({ ...current, ...patch }))
  }

  /** Inside the click handler: the terms are checked here for words, and by main again before its own sheet. */
  const signMandate = () => {
    const checked = checkMandateTerms(terms, settings.payees, new Date())

    if (!checked.ok) {
      setTermsProblem(checked.problem)

      return
    }

    setTermsProblem(null)
    triggerHaptic('selection')
    settle(requestPaymentMandate(checked.checked.terms), () => setDraft({}), copy.issue.signed)
  }

  const amountLabel: Record<(typeof MANDATE_AMOUNTS)[number], { title: string; hint: string }> = {
    budget: { title: copy.issue.budget, hint: copy.issue.budgetHint },
    min: { title: copy.issue.min, hint: copy.issue.rangeHint },
    max: { title: copy.issue.max, hint: copy.issue.rangeHint }
  }

  const dateLabel: Record<MandateDate, string> = {
    notBefore: copy.issue.starts,
    notAfter: copy.issue.ends,
    expiresAt: copy.issue.expires
  }

  const capLabel: Record<Cap, { title: string; hint: string }> = {
    perTxMicros: { title: copy.caps.perTx, hint: copy.caps.perTxHint },
    perDayMicros: { title: copy.caps.perDay, hint: copy.caps.perDayHint },
    perAgentDayMicros: { title: copy.caps.perAgentDay, hint: copy.caps.perAgentDayHint }
  }

  const listRows = (kind: 'origins' | 'payees'): ReactNode =>
    settings[kind].length === 0 ? (
      <ListRow title={copy.allowlist.empty} />
    ) : (
      settings[kind].map(entry => (
        <SettingRow
          control={
            <Button
              data-payments-confirm=""
              data-payments-remove={kind}
              disabled={busy}
              onClick={() => change({ ...settings, [kind]: settings[kind].filter(item => item !== entry) })}
              size="xs"
              variant="ghost"
            >
              {copy.allowlist.remove}
            </Button>
          }
          detail={entry}
          key={entry}
          title={kind === 'payees' ? copy.allowlist.payees : copy.allowlist.origins}
        />
      ))
    )

  return (
    <SettingsContent>
      <p className="mb-4 text-xs leading-5 text-muted-foreground">{copy.intro}</p>
      {feedback ? (
        <p
          className="mb-4 text-xs leading-5 text-muted-foreground"
          data-payments-feedback={feedback.ok ? 'ok' : 'refused'}
          role="status"
        >
          {feedback.text}
        </p>
      ) : null}

      <SettingsSection icon={Activity} title={copy.status.title}>
        <ListRow
          description={state.ready ? copy.status.readyHint : copy.status.notReady[state.reason ?? 'disabled']}
          title={state.ready ? copy.status.ready : copy.status.off}
        />
        <ListRow
          description={copy.status.pocketHint}
          hint={state.pocket ?? copy.status.noPocket}
          title={copy.status.pocket}
        />
        <SettingRow
          control={
            <span className="text-xs text-muted-foreground tabular-nums" data-payments-today="">
              {copy.status.todayValue(usdcLabel(state.todayMicros, locale), usdcLabel(settings.perDayMicros, locale))}
            </span>
          }
          error={state.ledgerOk ? undefined : copy.status.ledgerBroken}
          hint={state.network}
          title={copy.status.today}
        />
        {state.unprotectedProfiles.length > 0 ? (
          <SettingRow
            control={
              <span className="text-xs text-muted-foreground" data-payments-unprotected="">
                {state.unprotectedProfiles.join(', ')}
              </span>
            }
            error={copy.status.unprotectedHint}
            title={copy.status.unprotected}
          />
        ) : null}
      </SettingsSection>

      <SettingsSection icon={Lock} title={copy.stop.title}>
        <SettingRow
          control={
            <span data-payments-confirm="">
              <Switch
                checked={state.stopped}
                data-payments-stop=""
                disabled={busy}
                onCheckedChange={on => {
                  triggerHaptic('selection')
                  settle(setPaymentsStop(on))
                }}
              />
            </span>
          }
          hint={copy.stop.hint}
          title={copy.stop.label}
        />
      </SettingsSection>

      <SettingsSection icon={CreditCard} title={copy.caps.title}>
        {CAPS.map(cap => (
          <SettingRow
            control={
              <Input
                aria-invalid={capError === cap || undefined}
                data-payments-cap={cap}
                disabled={busy}
                inputMode="decimal"
                onChange={event => setCaps(current => ({ ...current, [cap]: event.target.value }))}
                suffix="USDC"
                value={caps[cap] ?? formatUsdc(settings[cap])}
              />
            }
            error={capError === cap ? copy.caps.invalid : undefined}
            field
            hint={capLabel[cap].hint}
            key={cap}
            title={capLabel[cap].title}
          />
        ))}
        <SettingRow
          control={
            <Button data-payments-confirm="" data-payments-save="" disabled={busy} onClick={saveCaps} size="sm">
              {copy.caps.save}
            </Button>
          }
          hint={copy.caps.note}
          title={copy.caps.title}
        />
      </SettingsSection>

      <SettingsSection icon={Users} title={copy.allowlist.title}>
        <SettingRow
          control={
            <div className="flex items-center gap-1.5">
              <Input
                aria-invalid={listError?.kind === 'payees' || undefined}
                data-payments-add-input="payees"
                disabled={busy}
                onChange={event => setPayee(event.target.value)}
                placeholder="0x…"
                value={payee}
              />
              <Button
                data-payments-add="payees"
                data-payments-confirm=""
                disabled={busy}
                onClick={addPayee}
                size="sm"
                variant="outline"
              >
                {copy.allowlist.add}
              </Button>
            </div>
          }
          error={listErrorText('payees')}
          field
          hint={copy.allowlist.payeesHint}
          title={copy.allowlist.payees}
        />
        {listRows('payees')}
        <SettingRow
          control={
            <div className="flex items-center gap-1.5">
              <Input
                aria-invalid={listError?.kind === 'origins' || undefined}
                data-payments-add-input="origins"
                disabled={busy}
                onChange={event => setOrigin(event.target.value)}
                placeholder="https://…"
                value={origin}
              />
              <Button
                data-payments-add="origins"
                data-payments-confirm=""
                disabled={busy}
                onClick={addOrigin}
                size="sm"
                variant="outline"
              >
                {copy.allowlist.add}
              </Button>
            </div>
          }
          error={listErrorText('origins')}
          field
          hint={copy.allowlist.originsHint}
          title={copy.allowlist.origins}
        />
        {listRows('origins')}
      </SettingsSection>

      <SettingsSection icon={PencilLine} title={copy.issue.title}>
        <ListRow description={copy.issue.intro} title={copy.issue.title} />
        <SettingRow
          control={
            <Input
              aria-invalid={termsProblem === 'agent' || undefined}
              data-payments-mandate-field="agent"
              disabled={busy}
              onChange={event => editTerms({ agent: event.target.value.trim() })}
              placeholder="inft-…"
              value={terms.agent}
            />
          }
          field
          hint={copy.issue.agentHint}
          title={copy.issue.agent}
        />
        {MANDATE_AMOUNTS.map(field => (
          <SettingRow
            control={
              <Input
                aria-invalid={termsProblem === 'amount' || undefined}
                data-payments-mandate-field={field}
                disabled={busy}
                inputMode="decimal"
                onChange={event => editTerms({ [field]: event.target.value })}
                suffix="USDC"
                value={terms[field]}
              />
            }
            field
            hint={amountLabel[field].hint}
            key={field}
            title={amountLabel[field].title}
          />
        ))}
        {settings.payees.length === 0 ? (
          <ListRow description={copy.issue.noPayees} title={copy.issue.payees} />
        ) : (
          settings.payees.map(entry => (
            <SettingRow
              control={
                <Switch
                  checked={terms.payees.includes(entry)}
                  data-payments-mandate-payee={entry}
                  disabled={busy}
                  onCheckedChange={on =>
                    editTerms({
                      payees: on
                        ? settings.payees.filter(item => item === entry || terms.payees.includes(item))
                        : terms.payees.filter(item => item !== entry)
                    })
                  }
                />
              }
              detail={entry}
              hint={copy.issue.payeesHint}
              key={entry}
              title={copy.issue.payees}
            />
          ))
        )}
        {MANDATE_DATES.map(field => (
          <SettingRow
            control={
              <Input
                aria-invalid={termsProblem === 'dates' || undefined}
                data-payments-mandate-field={field}
                disabled={busy}
                onChange={event => editTerms({ [field]: isoOfLocal(event.target.value) })}
                type="datetime-local"
                value={localInput(terms[field])}
              />
            }
            field
            hint={copy.issue.datesHint}
            key={field}
            title={dateLabel[field]}
          />
        ))}
      </SettingsSection>

      <SettingsSection icon={FileText} title={copy.issue.review}>
        <div data-payments-mandate-review="">
          <ListRow title={copy.issue.summary.agent(terms.agent || '—')} />
          <ListRow title={copy.issue.summary.budget(usdcTextLabel(terms.budget, locale))} />
          <ListRow
            title={copy.issue.summary.range(usdcTextLabel(terms.min, locale), usdcTextLabel(terms.max, locale))}
          />
          <ListRow title={copy.issue.summary.payees(terms.payees.length)} />
          {terms.payees.map(entry => (
            <ListRow hint={entry} key={entry} title={copy.issue.payee} />
          ))}
          <ListRow
            title={copy.issue.summary.window(momentText(terms.notBefore, locale), momentText(terms.notAfter, locale))}
          />
          <ListRow title={copy.issue.summary.expires(momentText(terms.expiresAt, locale))} />
          <ListRow
            title={copy.issue.summary.caps(
              usdcLabel(settings.perTxMicros, locale),
              usdcLabel(settings.perDayMicros, locale),
              usdcLabel(settings.perAgentDayMicros, locale)
            )}
          />
        </div>
        <SettingRow
          control={
            <Button
              data-payments-confirm=""
              data-payments-sign-mandate=""
              disabled={busy || !state.ready}
              onClick={signMandate}
              size="sm"
            >
              {copy.issue.sign}
            </Button>
          }
          error={termsProblem ? copy.issue.problems[termsProblem] : undefined}
          hint={copy.issue.signHint}
          title={copy.issue.title}
        />
      </SettingsSection>

      <SettingsSection icon={FileText} title={copy.mandates.title}>
        {store.mandates.length === 0 ? (
          <ListRow description={copy.mandates.empty} title={copy.mandates.title} />
        ) : (
          store.mandates.map(mandate => (
            <SettingRow
              control={
                mandate.revoked ? (
                  <span className="text-xs text-muted-foreground">{copy.mandates.revoked}</span>
                ) : (
                  <Button
                    data-payments-confirm=""
                    data-payments-revoke={mandate.jti}
                    disabled={busy}
                    onClick={() => {
                      triggerHaptic('selection')
                      settle(revokePaymentMandate(mandate.jti))
                    }}
                    size="xs"
                    variant="ghost"
                  >
                    {copy.mandates.revoke}
                  </Button>
                )
              }
              detail={mandate.jti}
              hint={copy.mandates.terms(usdcTextLabel(mandate.budget, locale), momentText(mandate.expiresAt, locale))}
              key={mandate.jti}
              title={copy.mandates.forAgent(mandate.agent)}
            />
          ))
        )}
      </SettingsSection>
    </SettingsContent>
  )
}
