import { useQuery } from '@tanstack/react-query'

import { fmtDate } from '@/lib/time'

import { SETTINGS_ROUTE } from '../../routes'

import type { BillingRefusal, BillingResult } from './api'
import { useBillingApi } from './api'
import { EMPTY_BILLING_VALUE, parseAmount } from './billing-amounts'
import { BILLING_COPY, type BillingCopy } from './copy'
import { resolveRefusal } from './errors'
import type { BillingStateResponse, SubscriptionStateResponse, SubscriptionTierOption, UsageModelData } from './types'

const FALLBACK_PORTAL_BILLING_URL = 'https://portal.nousresearch.com/billing'

// The billing endpoint is the authoritative source of truth for balance / cap /
// plan — the inference `x-nous-credits-*` headers are best-effort and can drift
// out of sync (notably in team/org accounts where another member's spend moves
// the shared balance without ever touching THIS client's headers). So the page
// never trusts a cache: `staleTime: 0` + `refetchOnMount: 'always'` force a
// fresh fetch every time it opens or regains focus, and it keeps polling every
// 30s while mounted (react-query only ticks an active observer; it pauses when
// the window is backgrounded — refetchIntervalInBackground defaults to false).
// A `credits.*` notice crossing additionally invalidates ['billing','state'] to
// pull the change in immediately rather than waiting for the next poll tick.
const BILLING_QUERY_OPTIONS = {
  refetchInterval: 30_000,
  refetchOnMount: 'always',
  refetchOnWindowFocus: true,
  retry: false,
  staleTime: 0
} as const

interface BillingSummaryItemView {
  label: string
  tone?: 'muted' | 'primary'
  value: string
}

export interface BillingNoticeView {
  action?: {
    label: string
    url: string
  }
  message: string
  title: string
  /** `warn` = an actionable blocker (e.g. no card); `info` = neutral guidance. */
  tone?: 'info' | 'warn'
}

interface BillingRowActionView {
  disabled?: boolean
  label: string
  url?: string
}

interface BillingChipView {
  disabled: boolean
  label: string
  /** When set, clicking the chip opens this URL externally. */
  url?: string
}

export interface BillingAccountRowView {
  action?: BillingRowActionView
  caption?: string
  chips?: BillingChipView[]
  description: string
  id: 'auto_reload' | 'buy_credits' | 'payment_method'
  /** The auto-refill row that edits its amounts in place (canonical-card enabled). */
  manageInApp?: true
  pill?: {
    label: string
    tone: 'muted' | 'primary'
  }
  secondaryPill?: string
  title: string
  value?: string
}

/**
 * A change scheduled at period end that `subscription.resume` can undo. A downgrade
 * names its target tier (and marks it in the grid); a cancellation has no target
 * (the whole plan lapses), so the grid shows no marker for it.
 */
type PendingPlanTransition =
  { kind: 'cancellation'; when: string } | { kind: 'downgrade'; tierName: string; when: string }

/**
 * The current-plan summary that replaces the old subscription row. Carries EITHER
 * one in-app `action` (View plans / Change plan) OR a portal `link` ("Adjust plan
 * ↗"), never both — a discriminated pair so consumers don't guard for the impossible
 * "both present" / "neither present" cases.
 */
export type BillingPlanCardView = {
  caption: string
  /** A scheduled downgrade / cancellation waiting at period end (drives the undo). */
  pending?: PendingPlanTransition
  price?: string
  tierName: string
} & ({ action: { label: string }; link?: undefined } | { action?: undefined; link: { label: string; url: string } })

interface BillingPlanTierBase {
  creditsDisplay?: string
  name: string
  priceDisplay: string
  tierId: string
}

/**
 * One card in the `bview=plans` grid, discriminated by `state`: `upgrade` carries its
 * portal `action`; `downgrade` is actionable IN-APP (the flow keys off `tierId`, so it
 * needs no url/caption); `scheduled` is the inert pending-downgrade target; `current`
 * is inert. The union lets consumers read `action` without defensive `?.`.
 */
export type BillingPlanTierView =
  | (BillingPlanTierBase & { state: 'current' })
  | (BillingPlanTierBase & { state: 'downgrade' })
  | (BillingPlanTierBase & { state: 'scheduled' })
  | (BillingPlanTierBase & { action: { label: string; url: string }; state: 'upgrade' })

export interface BillingUsageRowView {
  bar?: {
    label: string
    state: 'danger' | 'neutral' | 'ok'
    tone: 'cap' | 'subscription' | 'topup'
    track?: 'danger'
    value: number
  }
  caption: string
  id: 'monthly_cap' | 'subscription_credits' | 'topup_credits'
  title: string
  value: string
}

interface BillingViewBase {
  notice?: BillingNoticeView
  /** Payment section row. Absent outside the normal (logged-in) state. */
  paymentRow?: BillingAccountRowView
  /** Current-plan card (Plan section). Absent until billing.state resolves. */
  plan?: BillingPlanCardView
  /** Automatic-refill section row. */
  refillRow?: BillingAccountRowView
  summary: BillingSummaryItemView[]
  /** Live tier catalog for the plans sub-view (empty when unavailable). */
  tiers: BillingPlanTierView[]
  /** One-time top-up section row. */
  topupRow?: BillingAccountRowView
  usageRows: BillingUsageRowView[]
}

// Without a signed-in Nous Portal subscription the person pays their model provider directly: the
// view is one door to Providers, with nothing to summarise (U3-p2b-02).
type BillingView = BillingViewBase &
  ({ door: { route: string }; status: 'logged_out' } | { door?: never; status: 'loading' | 'normal' | 'refusal' })

export function useBillingState(enabled = true) {
  const api = useBillingApi()

  return useQuery({
    ...BILLING_QUERY_OPTIONS,
    enabled,
    queryFn: () => api.fetchBillingState(),
    queryKey: ['billing', 'state']
  })
}

export function useSubscriptionState(enabled = true) {
  const api = useBillingApi()

  return useQuery({
    ...BILLING_QUERY_OPTIONS,
    enabled,
    queryFn: () => api.fetchSubscriptionState(),
    queryKey: ['billing', 'subscription']
  })
}

export function deriveBillingView(
  stateResult?: BillingResult<BillingStateResponse>,
  subscriptionResult?: BillingResult<SubscriptionStateResponse>,
  copy: BillingCopy = BILLING_COPY.en
): BillingView {
  if (!stateResult) {
    return {
      status: 'loading',
      summary: emptySummary(copy),
      tiers: [],
      usageRows: []
    }
  }

  if (!stateResult.ok) {
    return {
      notice: refusalNotice(stateResult.refusal, copy),
      status: 'refusal',
      summary: emptySummary(copy),
      tiers: [],
      usageRows: []
    }
  }

  const billing = stateResult.data
  const subscription = subscriptionResult?.ok ? subscriptionResult.data : null

  if (!billing.logged_in || subscription?.logged_in === false) {
    return {
      door: { route: `${SETTINGS_ROUTE}?tab=providers` },
      status: 'logged_out',
      summary: [],
      tiers: [],
      usageRows: []
    }
  }

  // One "can change plans in-app" verdict, shared by the plan card (button vs portal
  // link) and the grid (whether upgrade tiles are actionable) so the invariant lives
  // in one place.
  const capable = plansCapable(subscription, subscriptionResult)
  // Computed once and threaded to both the card (caption + undo) and the grid
  // (Scheduled marker), so the two never disagree about what's pending.
  const pending = pendingTransition(subscription?.current)
  const tiers = derivePlanTiers(subscription, billing.portal_url, capable, pending, copy)

  return {
    notice: noCardNotice(billing, copy),
    paymentRow: paymentMethodRow(billing, copy),
    plan: derivePlanCard(billing, subscription, subscriptionResult, tiers, capable, pending, copy),
    refillRow: autoReloadRow(billing, copy),
    status: 'normal',
    summary: [
      { label: copy.summary.balance, value: displayBalance(billing) },
      { label: copy.summary.plan, value: displayPlan(subscription, copy, billing.usage) },
      {
        label: copy.summary.refill,
        tone: billing.auto_reload?.enabled ? 'primary' : billing.auto_reload ? 'muted' : undefined,
        value: billing.auto_reload
          ? billing.auto_reload.enabled
            ? copy.summary.enabled
            : copy.summary.off
          : EMPTY_BILLING_VALUE
      }
    ],
    tiers,
    topupRow: buyCreditsRow(billing, copy),
    usageRows: deriveUsageRows(billing, subscription, copy)
  }
}

export function buildManageSubscriptionUrl(
  subscription?: null | Pick<SubscriptionStateResponse, 'org_id' | 'portal_url'>,
  fallbackPortalUrl?: null | string,
  // Optional tier to pre-select on the portal, appended as `plan=<tierId>`
  // (validated server-side by the NAS reader, draft #748).
  tierId?: null | string
): string {
  // The hard-coded portal is the LAST-RESORT origin, not a bare early return:
  // org_id / plan must still be applied to it so a null portal_url never silently
  // strips the params that route the user to the right org + pre-selected tier.
  const portalUrls = [subscription?.portal_url, fallbackPortalUrl, FALLBACK_PORTAL_BILLING_URL].filter(
    (url): url is string => typeof url === 'string' && url.length > 0
  )

  for (const portalUrl of portalUrls) {
    try {
      const url = new URL('/manage-subscription', new URL(portalUrl).origin)

      if (subscription?.org_id) {
        url.searchParams.set('org_id', subscription.org_id)
      }

      if (tierId) {
        url.searchParams.set('plan', tierId)
      }

      return url.toString()
    } catch {
      // Try the next candidate; malformed portal URLs should not break settings.
    }
  }

  return FALLBACK_PORTAL_BILLING_URL
}

export function formatBillingDate(value?: null | string): string {
  if (!value) {
    return EMPTY_BILLING_VALUE
  }

  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return EMPTY_BILLING_VALUE
  }

  return fmtDate.format(date)
}

function emptySummary(copy: BillingCopy): BillingSummaryItemView[] {
  return [
    { label: copy.summary.balance, value: EMPTY_BILLING_VALUE },
    { label: copy.summary.plan, value: EMPTY_BILLING_VALUE },
    { label: copy.summary.refill, value: EMPTY_BILLING_VALUE }
  ]
}

function refusalNotice(refusal: BillingRefusal, copy: BillingCopy): BillingNoticeView {
  const resolved = resolveRefusal(refusal, copy)
  const portalUrl = resolved.action.type === 'portal' ? resolved.action.url : undefined

  return {
    action: portalUrl ? { label: copy.notice.openPortal, url: portalUrl } : undefined,
    message: resolved.message,
    title: resolved.title,
    tone: 'warn'
  }
}

// A logged-in account with no card can't buy credits or manage auto-refill, and
// every one of those controls disables silently — so lead the page with a single
// warn banner that names the blocker and links straight to the fix.
function noCardNotice(billing: BillingStateResponse, copy: BillingCopy): BillingNoticeView | undefined {
  if (billing.card) {
    return undefined
  }

  return {
    action: { label: copy.notice.addCard, url: billing.portal_url ?? FALLBACK_PORTAL_BILLING_URL },
    message: copy.notice.noCardMessage,
    title: copy.notice.noCardTitle,
    tone: 'warn'
  }
}

// The active tier from the UNFILTERED catalog — a grandfathered current tier is
// is_enabled:false, so it must still resolve here (by is_current or matching id).
function findCurrentTier(subscription: null | SubscriptionStateResponse): SubscriptionTierOption | undefined {
  const current = subscription?.current

  return subscription?.tiers?.find(tier => tier.is_current || tier.tier_id === current?.tier_id)
}

// Whether this account can change plans in-app: a personal (non-team) subscription
// the server says the user can change, whose payload actually loaded.
function plansCapable(
  subscription: null | SubscriptionStateResponse,
  subscriptionResult: BillingResult<SubscriptionStateResponse> | undefined
): boolean {
  if (!subscription || (subscriptionResult && !subscriptionResult.ok)) {
    return false
  }

  return subscription.context !== 'team' && Boolean(subscription.can_change_plan)
}

// Monthly credits are dollars; NAS sends a bare decimal string. Never render a
// bare number — always "$110 credits/mo" (mirrors the retired subscriptionTierChips).
function creditsPerMonthDisplay(monthlyCredits: null | string, copy: BillingCopy): string | undefined {
  const credits = Number((monthlyCredits ?? '').replace(/,/g, ''))

  return Number.isFinite(credits) && credits > 0
    ? copy.plans.creditsPerMonth(`$${credits.toLocaleString('en-US')}`)
    : undefined
}

/**
 * A monthly-credits delta from a plan-change preview. NAS sends a bare dollar
 * decimal ("-88"); credits are DOLLARS, so render it as signed dollars
 * ("−$88/mo"), never the raw number. Zero / absent → null so the caller hides
 * the line entirely.
 */
export function formatMonthlyCreditsDelta(copy: BillingCopy, delta?: null | string): null | string {
  const amount = parseAmount(delta)

  if (amount == null || amount === 0) {
    return null
  }

  return copy.plans.perMonth(`${amount < 0 ? '−' : '+'}${formatMoney(Math.abs(amount))}`)
}

/**
 * The current-plan card. It offers the in-app "View plans" / "Change plan" button
 * ONLY when the account is plans-capable AND the grid has an actual UPGRADE to offer
 * — a top-tier subscriber (only downgrades / current below them) would otherwise open
 * a grid with nothing to do. In every no-button case (teams, non-changers, refused
 * subscription, top tier, empty catalog) the card ALWAYS carries the portal
 * escape-hatch link so the user is never stranded on an info-only card.
 */
function derivePlanCard(
  billing: BillingStateResponse,
  subscription: null | SubscriptionStateResponse,
  subscriptionResult: BillingResult<SubscriptionStateResponse> | undefined,
  tiers: BillingPlanTierView[],
  capable: boolean,
  pending: PendingPlanTransition | undefined,
  copy: BillingCopy
): BillingPlanCardView {
  const current = subscription?.current
  const tierName = current?.tier_name ?? billing.usage?.plan_name ?? copy.plan.free
  // Price resolves against the UNFILTERED catalog so a grandfathered current tier
  // still shows its price.
  const price = findCurrentTier(subscription)?.dollars_per_month_display
  const renewal = formatBillingDate(current?.cycle_ends_at ?? billing.usage?.renews_at)
  const unavailable = subscriptionResult ? !subscriptionResult.ok : false

  const caption = unavailable
    ? copy.plan.unavailable
    : pending
      ? pending.kind === 'downgrade'
        ? copy.plan.changesTo(pending.tierName, pending.when)
        : copy.plan.cancels(pending.when)
      : current
        ? copy.plan.renews(renewal)
        : copy.plan.noSubscription

  // Actionable = a paid tier above (upgrade) or an in-app downgrade below the current
  // one. Ticket 11 counts downgrades (they act in-app, so they carry no `action`); a
  // top-tier subscriber with neither still gets the portal-link fallback below.
  const hasActionableTier = tiers.some(tier => tier.state === 'upgrade' || tier.state === 'downgrade')

  if (capable && hasActionableTier) {
    return { action: { label: current ? copy.plan.change : copy.plan.view }, caption, pending, price, tierName }
  }

  return {
    caption,
    // No in-app action → always hand off to the portal so the user isn't stranded.
    link: {
      label: copy.plan.adjust,
      url: buildManageSubscriptionUrl(subscription, subscription?.portal_url ?? billing.portal_url)
    },
    pending,
    price,
    tierName
  }
}

// The change scheduled at period end (undoable via subscription.resume). NAS may
// carry a pending downgrade (`pending_downgrade_*`, with a target tier name) and/or a
// scheduled cancellation (`cancel_at_period_end` + `cancellation_effective_*`).
// Precedence: a downgrade WINS if both are somehow set — it names a concrete target
// tier, the stronger, more specific signal, and is what the grid marks.
function pendingTransition(
  current: null | undefined | NonNullable<SubscriptionStateResponse['current']>
): PendingPlanTransition | undefined {
  if (current?.pending_downgrade_tier_name && current.pending_downgrade_at) {
    return {
      kind: 'downgrade',
      tierName: current.pending_downgrade_tier_name,
      when: current.pending_downgrade_display ?? formatBillingDate(current.pending_downgrade_at)
    }
  }

  if (current?.cancel_at_period_end && current.cancellation_effective_at) {
    return {
      kind: 'cancellation',
      when: current.cancellation_effective_display ?? formatBillingDate(current.cancellation_effective_at)
    }
  }

  return undefined
}

/**
 * The plans-grid catalog. Each card's state depends on its order relative to the
 * current tier: current = inert marker; higher = "Choose ↗" opening the portal with
 * the tier pre-selected; lower = an in-app "Downgrade" (chargeless, scheduled via the
 * gateway). The already-scheduled downgrade target renders as an inert "Scheduled"
 * marker; other lower tiers stay actionable (picking one reschedules). With no active
 * subscription the lowest-order ($0 / free) tier stands in as the current plan, so
 * there is no "subscribe to Free" upgrade and no downgrade state.
 *
 * Empty unless `capable`: only a plans-capable account gets actionable tiles, and the
 * plan card / deep-link gate on the same verdict — so the grid never mints an
 * upgrade action nobody may take. `fallbackPortalUrl` (billing.portal_url) backs the
 * Choose URLs when the subscription payload has no portal_url, so org_id + plan are
 * never dropped.
 */
function derivePlanTiers(
  subscription: null | SubscriptionStateResponse,
  fallbackPortalUrl: null | string,
  capable: boolean,
  pending: PendingPlanTransition | undefined,
  copy: BillingCopy
): BillingPlanTierView[] {
  if (!capable || !subscription) {
    return []
  }

  const allTiers = subscription.tiers ?? []
  const current = subscription.current
  const explicitCurrent = findCurrentTier(subscription)

  // The grid shows the enabled catalog plus the grandfathered current tier (so it
  // still renders as the inert "Current plan" card), sorted low→high.
  const gridTiers = allTiers
    .filter(tier => tier.is_enabled || tier.tier_id === explicitCurrent?.tier_id)
    .slice()
    .sort((a, b) => a.tier_order - b.tier_order)

  if (gridTiers.length === 0) {
    return []
  }

  // No active subscription → the lowest-order ($0 / free) tier stands in as the
  // current plan: inert, never a "subscribe to Free" upgrade, and (being lowest)
  // never leaving room for a downgrade.
  const currentTier = explicitCurrent ?? (current == null ? gridTiers[0] : undefined)
  const currentOrder = currentTier?.tier_order
  const manageBase = subscription.portal_url ?? fallbackPortalUrl
  // Only a downgrade has a target tier to mark; a cancellation has none.
  const pendingName = pending?.kind === 'downgrade' ? pending.tierName : null

  return gridTiers.map((tier): BillingPlanTierView => {
    const base: BillingPlanTierBase = {
      creditsDisplay: creditsPerMonthDisplay(tier.monthly_credits, copy),
      name: tier.name,
      priceDisplay: tier.dollars_per_month_display,
      tierId: tier.tier_id
    }

    if (currentTier && tier.tier_id === currentTier.tier_id) {
      return { ...base, state: 'current' }
    }

    // A scheduled downgrade target is inert (matched by name — NAS sends no id for
    // the pending target). Name is a safe key: SubscriptionTypes.name is @unique in
    // NAS, so two tiers can't collide. Checked before the downgrade branch since the
    // target IS a lower tier.
    if (pendingName && tier.name === pendingName) {
      return { ...base, state: 'scheduled' }
    }

    // Downgrade = strictly below the current tier's order → an in-app chargeless
    // change (the PlanCard wires the confirm flow by tierId).
    if (currentOrder != null && tier.tier_order < currentOrder) {
      return { ...base, state: 'downgrade' }
    }

    return {
      ...base,
      action: { label: copy.plan.choose, url: buildManageSubscriptionUrl(subscription, manageBase, tier.tier_id) },
      state: 'upgrade'
    }
  })
}

function paymentMethodRow(billing: BillingStateResponse, copy: BillingCopy): BillingAccountRowView {
  const portalUrl = billing.portal_url ?? FALLBACK_PORTAL_BILLING_URL
  const card = billing.card

  if (!card) {
    // No card → a single "Add payment method" link, the way every other app does
    // it. The reason (buys/auto-refill are blocked) already leads the page as a
    // notice, so the row stays a bare call-to-action with no redundant status text.
    return {
      action: { label: copy.payment.add, url: portalUrl },
      description: '',
      id: 'payment_method',
      title: copy.payment.title
    }
  }

  return {
    action: { label: copy.payment.update, url: portalUrl },
    description: copy.payment.hint,
    id: 'payment_method',
    title: copy.payment.title,
    value: `${capitalize(card.brand)} •••• ${card.last4}${provenanceSuffix(copy, card.resolved_via)}`
  }
}

function buyCreditsRow(billing: BillingStateResponse, copy: BillingCopy): BillingAccountRowView {
  if (!billing.card) {
    // The no-card blocker is already spelled out by the page-level warn banner
    // (noCardNotice); repeating it here — emoji and all — just clutters the row,
    // so keep the plain "what buying does" line and let the controls sit disabled.
    return {
      action: { disabled: true, label: copy.buy.action },
      chips: billing.charge_presets.map(amount => ({ disabled: true, label: formatMoney(amount) })),
      description: copy.buy.hint,
      id: 'buy_credits',
      title: copy.buy.title
    }
  }

  const disabledReason = buyCreditsDisabledReason(billing, copy)

  if (disabledReason) {
    return {
      description: disabledReason,
      id: 'buy_credits',
      title: copy.buy.title
    }
  }

  return {
    action: { disabled: true, label: copy.buy.action },
    chips: billing.charge_presets.map(amount => ({ disabled: true, label: formatMoney(amount) })),
    description: copy.buy.hint,
    id: 'buy_credits',
    title: copy.buy.title
  }
}

// The generic first sentence shared by the off / absent / divergent states,
// where the concrete amounts aren't the headline. The configured state overrides
// this with the disambiguating "Charges $X … below $Y." sentence (spec §8).
function autoReloadRow(billing: BillingStateResponse, copy: BillingCopy): BillingAccountRowView {
  const autoReload = billing.auto_reload

  if (!autoReload) {
    return {
      action: { disabled: true, label: copy.refill.manage },
      caption: copy.refill.manageOnPortal,
      description: copy.refill.generic,
      id: 'auto_reload',
      pill: { label: EMPTY_BILLING_VALUE, tone: 'muted' },
      title: copy.refill.title
    }
  }

  if (!autoReload.enabled) {
    return {
      caption: copy.refill.turnOnPortal,
      description: copy.refill.generic,
      id: 'auto_reload',
      pill: { label: copy.summary.off, tone: 'muted' },
      title: copy.refill.title
    }
  }

  // A null card (gateway emits it for a missing/unknown-kind card) falls through to
  // the default enabled path below — the same treatment as a canonical card.
  if (autoReload.card?.kind === 'distinct') {
    const { brand, last4 } = autoReload.card
    const cardLabel = brand && last4 ? `${capitalize(brand)} ••${last4}` : copy.refill.differentCard
    const portalUrl = billing.portal_url ?? FALLBACK_PORTAL_BILLING_URL

    return {
      action: { label: copy.refill.reconcile, url: portalUrl },
      caption: copy.refill.distinctCaption(cardLabel),
      description: copy.refill.generic,
      id: 'auto_reload',
      pill: { label: copy.summary.enabled, tone: 'primary' },
      title: copy.refill.title
    }
  }

  const reloadTo = autoReload.reload_to_display || formatMoney(autoReload.reload_to_usd)
  const threshold = autoReload.threshold_display || formatMoney(autoReload.threshold_usd)

  return {
    action: { label: copy.refill.manage },
    // Numbers live in the first sentence (spec §8); the swap region below carries
    // the editable fields, so no redundant caption here.
    description: copy.refill.charges(reloadTo, threshold),
    id: 'auto_reload',
    // The only row that edits in place — AutoReloadRow keys its swap layout off this
    // flag rather than sniffing the action label.
    manageInApp: true,
    pill: { label: copy.summary.enabled, tone: 'primary' },
    title: copy.refill.title
  }
}

function deriveUsageRows(
  billing: BillingStateResponse,
  subscription: null | SubscriptionStateResponse,
  copy: BillingCopy
): BillingUsageRowView[] {
  const rows: BillingUsageRowView[] = []
  const current = subscription?.current
  const remaining = parseAmount(current?.credits_remaining)
  const monthly = parseAmount(current?.monthly_credits)
  const usage = subscription?.usage ?? billing.usage

  // Remaining can go slightly negative (usage settles after credits hit zero).
  // A raw "-$0.79 left" reads as broken — clamp to $0 and name the overage.
  const subscriptionValue =
    remaining != null && monthly != null
      ? remaining < 0
        ? `${copy.usage.left(formatMoney(0), formatMoney(monthly))} · ${copy.usage.over(formatMoney(Math.abs(remaining)))}`
        : copy.usage.left(formatMoney(remaining), formatMoney(monthly))
      : (usage?.subscription_remaining_display ?? usage?.plan_bar?.remaining_display ?? EMPTY_BILLING_VALUE)

  const remainingFraction = remaining != null && monthly != null && monthly > 0 ? remaining / monthly : null

  rows.push({
    bar:
      remainingFraction != null
        ? {
            label: copy.usage.subscriptionRemaining,
            state: remainingFraction <= 0.1 ? 'danger' : 'ok',
            tone: 'subscription',
            track: remaining != null && remaining <= 0 ? 'danger' : undefined,
            value: clamp01(remainingFraction)
          }
        : undefined,
    caption: copy.usage.resets(formatBillingDate(current?.cycle_ends_at ?? usage?.renews_at)),
    id: 'subscription_credits',
    title: copy.usage.subscription,
    value: subscriptionValue
  })

  const topupValue = topupCreditsValue(billing, usage)

  // No bar: top-ups have no denominator (the wire carries only the current
  // balance, and the pool is open-ended), so a fill fraction would be fiction.
  rows.push({
    caption: copy.usage.noExpiry,
    id: 'topup_credits',
    title: copy.usage.topup,
    value: topupValue
  })

  const cap = billing.monthly_cap

  if (cap && cap.limit_usd != null) {
    const limit = parseAmount(cap.limit_usd)
    const spent = parseAmount(cap.spent_this_month_usd) ?? 0
    const usedFraction = limit != null && limit > 0 ? spent / limit : null
    const value = copy.usage.used(cap.spent_display || formatMoney(spent), cap.limit_display || formatMoney(limit))

    rows.push({
      bar:
        usedFraction != null
          ? {
              label: copy.usage.capUsed,
              state: usedFraction >= 0.9 ? 'danger' : 'ok',
              tone: 'cap',
              track: usedFraction >= 1 ? 'danger' : undefined,
              value: clamp01(usedFraction)
            }
          : undefined,
      caption: cap.is_default_ceiling ? copy.usage.defaultCeiling : copy.usage.monthlyRemote,
      id: 'monthly_cap',
      title: copy.usage.cap,
      value
    })
  }

  return rows
}

function displayBalance(billing: BillingStateResponse): string {
  return nonEmpty(billing.balance_display) ?? formatMoney(billing.balance_usd)
}

function displayPlan(
  subscription: null | SubscriptionStateResponse,
  copy: BillingCopy,
  usage?: UsageModelData
): string {
  const current = subscription?.current
  const tier = current?.tier_name ?? usage?.plan_name

  if (!tier) {
    return EMPTY_BILLING_VALUE
  }

  const price = findCurrentTier(subscription)?.dollars_per_month_display

  return price ? `${tier} · ${copy.plans.perMonth(price)}` : tier
}

function topupCreditsValue(billing: BillingStateResponse, usage?: UsageModelData): string {
  return (
    usage?.topup_remaining_display ??
    usage?.topup_bar?.remaining_display ??
    nonEmpty(billing.balance_display) ??
    formatMoney(billing.balance_usd)
  )
}

function buyCreditsDisabledReason(billing: BillingStateResponse, copy: BillingCopy): null | string {
  if (!billing.is_admin) {
    return resolveRefusal({ kind: 'role_required', message: '' }, copy).message
  }

  if (!billing.cli_billing_enabled) {
    return resolveRefusal(
      { kind: 'cli_billing_disabled', message: '', portalUrl: billing.portal_url ?? undefined },
      copy
    ).message
  }

  if (!billing.can_charge) {
    return resolveRefusal(
      { kind: 'remote_spending_disabled', message: '', portalUrl: billing.portal_url ?? undefined },
      copy
    ).message
  }

  return null
}

function provenanceSuffix(copy: BillingCopy, resolvedVia?: null | string): string {
  const labels: Record<string, string> = copy.provenance
  const label = resolvedVia ? labels[resolvedVia] : undefined

  // An unknown source is a backend code, never shown.
  return label ? ` - ${label}` : ''
}

function capitalize(value: string): string {
  return value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : value
}

function nonEmpty(value?: null | string): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function formatMoney(value?: null | number | string): string {
  const amount = parseAmount(value)

  if (amount == null) {
    return EMPTY_BILLING_VALUE
  }

  // Pin en-US so the symbol is always "$" — the server's *_display strings
  // ("$996.47") sit next to these, and other locales render USD as "US$".
  return new Intl.NumberFormat('en-US', {
    currency: 'USD',
    maximumFractionDigits: amount % 1 === 0 ? 0 : 2,
    minimumFractionDigits: amount % 1 === 0 ? 0 : 2,
    style: 'currency'
  }).format(amount)
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }

  return Math.max(0, Math.min(1, value))
}
