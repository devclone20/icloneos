/**
 * EconomyOS — Market · the owner's catalogue: offering and resource drafts
 * and the exact argv each write sends through the bridge (schemas: market-schema.ts).
 *
 * Every rule here mirrors a gate further down the line — the bridge's
 * allowlist (electron/iclone-acp.ts), the CLI's own checks, ACP's 40
 * offerings per agent — so a draft that would be refused is refused here, in
 * the owner's words, before a CLI is ever spawned. Pure, except the one write
 * door at the end.
 */
import { type AcpResult, acpWrite, asRecord, invalidateAcp, str } from '../cli'

import { type MarketOffering, type MarketResource, type OwnOffering, schemaModel, settled } from './market-data'
import type { Checked, SchemaDraft } from './market-schema'
import { emptySchemaDraft, fail, ok, sameSchema, schemaDraftFrom, schemaValue } from './market-schema'

// ── limits ──────────────────────────────────────────────────────────────────

/** ACP refuses the 41st with HTTP 400 "Offering limit of 40 reached". */
export const OFFERING_LIMIT = 40
// The bridge's text caps for `--name`, `--description` and a schema.
export const NAME_MAX = 120
export const DESCRIPTION_MAX = 2000
// The CLI refuses an SLA under 5 minutes; the bridge caps it at a year.
export const SLA_MIN = 5
const SLA_MAX = 525_600
export const URL_MAX = 500

// The bridge's `decimal`: what `--price-value` may carry.
const AMOUNT = /^\d{1,9}(\.\d{1,6})?$/
// A share is sent as WHOLE percent (the service lists `20` for 20 %), with
// up to 4 decimals — inside what the bridge's `decimal` takes.
const PERCENT = /^\d{1,3}(\.\d{1,4})?$/
const MINUTES = /^\d{1,6}$/
const ACP_ID = /^[A-Za-z0-9_.:-]{1,120}$/
// The bridge's `csvIds` admits at most 40 ids.
const SUBSCRIPTIONS_MAX = 40
// A write crosses the network after a cold CLI start; the bridge allows 180 s.
const WRITE_TIMEOUT_MS = 90_000

// ── types ───────────────────────────────────────────────────────────────────

export type PriceType = 'fixed' | 'percentage'
export interface OfferingDraft {
  name: string
  description: string
  priceType: PriceType
  /** As typed: USDC for a fixed price, a whole percent (5 = 5 %) for a share. */
  price: string
  slaMinutes: string
  requirements: SchemaDraft
  deliverable: SchemaDraft
  requiredFunds: boolean
  hidden: boolean
  subscriptionIds: string[]
}

/** An offering as the CLI takes it: every value already an argv word. */
export interface OfferingValues {
  name: string
  description: string
  priceType: PriceType
  priceValue: string
  slaMinutes: string
  requirements: string
  deliverable: string
  requiredFunds: boolean
  hidden: boolean
  subscriptionIds: string[]
}

type OfferingField =
  'deliverable' | 'description' | 'name' | 'price' | 'requirements' | 'slaMinutes' | 'subscriptionIds'

export interface ResourceDraft {
  name: string
  description: string
  url: string
  params: SchemaDraft
  hidden: boolean
}

interface ResourceValues {
  name: string
  description: string
  url: string
  params: string
  hidden: boolean
}

type ResourceField = 'description' | 'name' | 'params' | 'url'

/** Values ready to send, or every field's problem in words. */
interface DraftCheck<V, F extends string> {
  values: null | V
  errors: Partial<Record<F, string>>
}

// ── words and numbers ───────────────────────────────────────────────────────

/** A number as plain decimal text, never an exponent: 0.05, 12.5, 3. */
function decimalText(value: number, digits: number): string {
  return value.toFixed(digits).replace(/\.?0+$/, '')
}

function lineValue(input: string, noun: string, max: number): Checked<string> {
  const text = input.replace(/\s+/g, ' ').trim()

  if (!text) {
    return fail(`Give it ${noun}.`)
  }

  return text.length <= max ? ok(text) : fail(`Keep it under ${max} characters.`)
}

function proseValue(input: string, noun: string, max: number): Checked<string> {
  const text = input.replace(/\0/g, '').trim()

  if (!text) {
    return fail(`Give it ${noun}.`)
  }

  return text.length <= max ? ok(text) : fail(`Keep it under ${max.toLocaleString('en-US')} characters.`)
}

/** `--price-value`: USDC for a fixed price; a share goes as the percent the
 *  owner typed (5 = 5 %) — the unit the service stores and lists. */
export function priceValueArg(type: PriceType, input: string): Checked<string> {
  const text = input.trim()

  if (!text) {
    return fail(type === 'fixed' ? 'Set a price in USDC.' : 'Set the share of the job’s value.')
  }

  if (type === 'fixed') {
    if (!AMOUNT.test(text)) {
      return fail('Write the price as a plain number, like 0.5 — up to 6 decimals.')
    }

    return Number(text) > 0 ? ok(text) : fail('The price must be above 0.')
  }

  if (!PERCENT.test(text)) {
    return fail('Write the share as a percent, like 5 or 2.5 — up to 4 decimals.')
  }

  const percent = Number(text)

  if (percent <= 0 || percent > 100) {
    return fail('The share must be above 0% and at most 100%.')
  }

  return ok(decimalText(percent, 4))
}

/** What the price box shows for a saved price. */
export function priceInputOf(offering: Pick<MarketOffering, 'priceType' | 'priceValue'>): string {
  if (offering.priceValue == null) {
    return ''
  }

  return offering.priceType === 'percentage' ? decimalText(offering.priceValue, 4) : decimalText(offering.priceValue, 6)
}

export function slaArg(input: string): Checked<string> {
  const text = input.trim()

  if (!MINUTES.test(text)) {
    return fail('Write the SLA in whole minutes.')
  }

  const minutes = Number(text)

  if (minutes < SLA_MIN) {
    return fail(`ACP needs at least ${SLA_MIN} minutes.`)
  }

  return minutes <= SLA_MAX ? ok(String(minutes)) : fail('At most 525,600 minutes — a year.')
}

function idsValue(ids: readonly string[]): Checked<string[]> {
  if (ids.length > SUBSCRIPTIONS_MAX) {
    return fail(`Attach at most ${SUBSCRIPTIONS_MAX} packages.`)
  }

  return ids.every(id => ACP_ID.test(id)) ? ok([...ids]) : fail('A package id is not one ACP issued.')
}

// ── offerings ───────────────────────────────────────────────────────────────

export function emptyOfferingDraft(): OfferingDraft {
  return {
    name: '',
    description: '',
    priceType: 'fixed',
    price: '',
    slaMinutes: '60',
    requirements: emptySchemaDraft('fields'),
    deliverable: emptySchemaDraft('text'),
    requiredFunds: false,
    hidden: false,
    subscriptionIds: []
  }
}

function priceTypeOf(value: string): PriceType {
  return value === 'percentage' ? 'percentage' : 'fixed'
}

export function draftFromOffering(offering: OwnOffering): OfferingDraft {
  return {
    name: offering.name,
    description: offering.description,
    priceType: priceTypeOf(offering.priceType),
    price: priceInputOf(offering),
    slaMinutes: offering.slaMinutes == null ? '' : String(Math.round(offering.slaMinutes)),
    requirements: schemaDraftFrom(offering.source.requirements, offering.requirements, 'fields'),
    deliverable: schemaDraftFrom(offering.source.deliverable, offering.deliverable, 'text'),
    requiredFunds: offering.requiredFunds,
    hidden: offering.isHidden,
    subscriptionIds: [...offering.source.subscriptionIds]
  }
}

export function checkOffering(draft: OfferingDraft): DraftCheck<OfferingValues, OfferingField> {
  const name = lineValue(draft.name, 'a name', NAME_MAX)
  const description = proseValue(draft.description, 'a description', DESCRIPTION_MAX)
  const price = priceValueArg(draft.priceType, draft.price)
  const slaMinutes = slaArg(draft.slaMinutes)
  const requirements = schemaValue(draft.requirements, 'requirements')
  const deliverable = schemaValue(draft.deliverable, 'deliverable')
  const subscriptionIds = idsValue(draft.subscriptionIds)

  const errors: Partial<Record<OfferingField, string>> = {
    ...(name.ok ? {} : { name: name.error }),
    ...(description.ok ? {} : { description: description.error }),
    ...(price.ok ? {} : { price: price.error }),
    ...(slaMinutes.ok ? {} : { slaMinutes: slaMinutes.error }),
    ...(requirements.ok ? {} : { requirements: requirements.error }),
    ...(deliverable.ok ? {} : { deliverable: deliverable.error }),
    ...(subscriptionIds.ok ? {} : { subscriptionIds: subscriptionIds.error })
  }

  if (
    !name.ok ||
    !description.ok ||
    !price.ok ||
    !slaMinutes.ok ||
    !requirements.ok ||
    !deliverable.ok ||
    !subscriptionIds.ok
  ) {
    return { values: null, errors }
  }

  return {
    values: {
      name: name.value,
      description: description.value,
      priceType: draft.priceType,
      priceValue: price.value,
      slaMinutes: slaMinutes.value,
      requirements: requirements.value,
      deliverable: deliverable.value,
      requiredFunds: draft.requiredFunds,
      hidden: draft.hidden,
      subscriptionIds: subscriptionIds.value
    },
    errors
  }
}

/** Why a new offering cannot be created, or null — before any CLI runs. */
export function offeringLimitProblem(count: null | number): null | string {
  if (count == null) {
    return 'Your offerings are still being read — try again in a moment.'
  }

  return count >= OFFERING_LIMIT
    ? `ACP allows ${OFFERING_LIMIT} offerings per agent — delete one before adding another.`
    : null
}

/** `acp offering create`: every flag the CLI would otherwise prompt for. */
export function offeringCreateArgv(values: OfferingValues): string[] {
  return [
    'offering',
    'create',
    '--name',
    values.name,
    '--description',
    values.description,
    '--price-type',
    values.priceType,
    '--price-value',
    values.priceValue,
    '--sla-minutes',
    values.slaMinutes,
    '--requirements',
    values.requirements,
    '--deliverable',
    values.deliverable,
    values.requiredFunds ? '--required-funds' : '--no-required-funds',
    values.hidden ? '--hidden' : '--no-hidden',
    ...(values.subscriptionIds.length > 0 ? ['--subscription-ids', values.subscriptionIds.join(',')] : []),
    '--json'
  ]
}

/** A saved offering in argv terms — what an update is compared against. */
export function offeringValuesOf(offering: OwnOffering): OfferingValues {
  return {
    name: offering.name,
    description: offering.description.trim(),
    priceType: priceTypeOf(offering.priceType),
    priceValue: offering.priceValue == null ? '' : decimalText(offering.priceValue, 6),
    slaMinutes: offering.slaMinutes == null ? '' : String(Math.round(offering.slaMinutes)),
    requirements: offering.source.requirements,
    deliverable: offering.source.deliverable,
    requiredFunds: offering.requiredFunds,
    hidden: offering.isHidden,
    subscriptionIds: offering.source.subscriptionIds
  }
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',')
}

export function canAddress(id: string): boolean {
  return ACP_ID.test(id)
}

/**
 * `acp offering update` with only what changed — `ok(null)` when nothing did.
 * Detaching every package is refused: the CLI clears them with an empty
 * `--subscription-ids`, which the bridge does not admit.
 */
export function offeringUpdateArgv(id: string, next: OfferingValues, saved: OfferingValues): Checked<null | string[]> {
  if (!canAddress(id)) {
    return fail('This offering’s id cannot be addressed from here.')
  }

  const changes: string[] = []

  if (next.name !== saved.name) {
    changes.push('--name', next.name)
  }

  if (next.description !== saved.description) {
    changes.push('--description', next.description)
  }

  if (next.priceType !== saved.priceType) {
    changes.push('--price-type', next.priceType)
  }

  if (next.priceType !== saved.priceType || Number(next.priceValue) !== Number(saved.priceValue)) {
    changes.push('--price-value', next.priceValue)
  }

  if (next.slaMinutes !== saved.slaMinutes) {
    changes.push('--sla-minutes', next.slaMinutes)
  }

  if (!sameSchema(next.requirements, saved.requirements)) {
    changes.push('--requirements', next.requirements)
  }

  if (!sameSchema(next.deliverable, saved.deliverable)) {
    changes.push('--deliverable', next.deliverable)
  }

  if (next.requiredFunds !== saved.requiredFunds) {
    changes.push(next.requiredFunds ? '--required-funds' : '--no-required-funds')
  }

  if (next.hidden !== saved.hidden) {
    changes.push(next.hidden ? '--hidden' : '--no-hidden')
  }

  if (!sameIds(next.subscriptionIds, saved.subscriptionIds)) {
    if (next.subscriptionIds.length === 0) {
      return fail('Detaching every package isn’t possible from here — keep one, or ask your iNFT to clear them.')
    }

    changes.push('--subscription-ids', next.subscriptionIds.join(','))
  }

  return ok(changes.length > 0 ? ['offering', 'update', '--offering-id', id, ...changes, '--json'] : null)
}

/** Without `--force` the CLI asks to confirm, and the bridge refuses a prompt:
 *  the owner's confirmation happens in the app, before this is built. */
export function offeringDeleteArgv(id: string): null | string[] {
  return canAddress(id) ? ['offering', 'delete', '--offering-id', id, '--force', '--json'] : null
}

/** The offering card the draft would publish — the editor's live preview. */
export function previewOffering(draft: OfferingDraft): MarketOffering {
  const price = priceValueArg(draft.priceType, draft.price)
  const sla = slaArg(draft.slaMinutes)
  const requirements = schemaValue(draft.requirements, 'requirements')
  const deliverable = schemaValue(draft.deliverable, 'deliverable')

  return {
    id: '',
    agentId: '',
    name: draft.name.replace(/\s+/g, ' ').trim() || 'Untitled offering',
    description: draft.description.trim(),
    deliverable: deliverable.ok ? schemaModel(deliverable.value) : { kind: 'none' },
    requirements: requirements.ok ? schemaModel(requirements.value) : { kind: 'none' },
    slaMinutes: sla.ok ? Number(sla.value) : null,
    priceType: draft.priceType,
    priceValue: price.ok ? Number(price.value) : null,
    requiredFunds: draft.requiredFunds,
    isHidden: draft.hidden,
    isPrivate: false
  }
}

// ── resources ───────────────────────────────────────────────────────────────

export function emptyResourceDraft(): ResourceDraft {
  return { name: '', description: '', url: '', params: emptySchemaDraft('fields', 0), hidden: false }
}

/** `--url`: https only, and what a buyer may read — no credentials in it. */
export function httpsUrlArg(input: string): Checked<string> {
  const url = input.trim()

  if (!url) {
    return fail('Give the endpoint’s URL.')
  }

  if (url.length > URL_MAX || /\s/.test(url)) {
    return fail(`A URL has no spaces and stays under ${URL_MAX} characters.`)
  }

  if (!url.startsWith('https://')) {
    return fail('Start the URL with https:// — ACP only lists secure endpoints.')
  }

  let parsed: URL

  try {
    parsed = new URL(url)
  } catch {
    return fail('Write a full URL, like https://api.example.com/v1/quote.')
  }

  if (!parsed.hostname) {
    return fail('Write a full URL, like https://api.example.com/v1/quote.')
  }

  return parsed.username || parsed.password
    ? fail('Keep credentials out of the URL — every buyer can read it.')
    : ok(url)
}

export function checkResource(draft: ResourceDraft): DraftCheck<ResourceValues, ResourceField> {
  const name = lineValue(draft.name, 'a name', NAME_MAX)
  const description = proseValue(draft.description, 'a description', DESCRIPTION_MAX)
  const url = httpsUrlArg(draft.url)

  const params: Checked<string> =
    draft.params.mode === 'text'
      ? fail('Params must be a JSON schema — use fields or JSON.')
      : schemaValue(draft.params, 'params', true)

  const errors: Partial<Record<ResourceField, string>> = {
    ...(name.ok ? {} : { name: name.error }),
    ...(description.ok ? {} : { description: description.error }),
    ...(url.ok ? {} : { url: url.error }),
    ...(params.ok ? {} : { params: params.error })
  }

  if (!name.ok || !description.ok || !url.ok || !params.ok) {
    return { values: null, errors }
  }

  return {
    values: {
      name: name.value,
      description: description.value,
      url: url.value,
      params: params.value,
      hidden: draft.hidden
    },
    errors
  }
}

/** `acp resource create`: every flag the CLI would otherwise prompt for. */
export function resourceCreateArgv(values: ResourceValues): string[] {
  return [
    'resource',
    'create',
    '--name',
    values.name,
    '--description',
    values.description,
    '--url',
    values.url,
    '--params',
    values.params,
    values.hidden ? '--hidden' : '--no-hidden',
    '--json'
  ]
}

export function previewResource(draft: ResourceDraft): MarketResource {
  const url = httpsUrlArg(draft.url)
  const params = draft.params.mode === 'text' ? null : schemaValue(draft.params, 'params', true)

  return {
    id: '',
    agentId: '',
    name: draft.name.replace(/\s+/g, ' ').trim() || 'Untitled resource',
    description: draft.description.trim(),
    url: url.ok ? url.value : '',
    params: params?.ok ? schemaModel(params.value) : { kind: 'none' },
    isHidden: draft.hidden
  }
}

// ── the write door ──────────────────────────────────────────────────────────

type CatalogueScope = 'offering' | 'resource'

/**
 * Every catalogue write: queued behind the iNFT's other CLI calls, never
 * cached, and followed by forgetting the list it changes — failed writes
 * too, since one that timed out on the way back may still have landed.
 */
export async function writeCatalogue(
  inftId: string,
  slug: string,
  argv: string[],
  scope: CatalogueScope
): Promise<AcpResult<unknown>> {
  const result = await settled(acpWrite(inftId, slug, argv, WRITE_TIMEOUT_MS))

  invalidateAcp(slug, [scope])

  return result
}

/** The id the CLI answered a create with ('' when it did not say). */
export function writtenId(result: AcpResult<unknown>): string {
  return result.ok ? str(asRecord(result.data), 'id') : ''
}
