/** The market data module's `briefs` section — its public names are re-exported by ../market-data.ts. */
import type { Json } from '../../cli'
import { briefText, oneLine } from '../../format'

import { ACP_ID, BASE_CHAIN_ID, EVM_ADDRESS, SOLANA_ADDRESS, SOLANA_CHAIN_ID } from './constants'
import { presenceOf, slaLabel } from './offerings'
import { round } from './primitives'
import type { MarketAgent, MarketOffering, MarketResource, SchemaField, SchemaModel } from './types'

// ── briefs for the iNFT ─────────────────────────────────────────────────────

/** The chain to create a job on: Base when the provider is there. */
export function hireChainId(chainIds: number[]): number {
  if (chainIds.length === 0 || chainIds.includes(BASE_CHAIN_ID)) {
    return BASE_CHAIN_ID
  }

  return chainIds.find(id => id !== SOLANA_CHAIN_ID) ?? chainIds[0]
}

function placeholderFor(field: SchemaField): unknown {
  if (field.hasDefault) {
    return field.defaultValue
  }

  if (field.enumValues.length > 0) {
    return `<one of: ${field.enumValues.map(value => briefText(value, 40, 'single')).join(' | ')}>`
  }

  const hint = field.description || (field.example ? `e.g. ${field.example}` : '')

  return `<${field.label}${hint ? ` — ${briefText(hint, 90, 'single')}` : ''}>`
}

/** The `--requirements` JSON with a `<…>` for each value the owner fills in. */
function requirementsTemplate(model: SchemaModel): Json {
  if (model.kind === 'none') {
    return {}
  }

  if (model.kind === 'text') {
    return { answer: `<my answer — ${briefText(model.text, 120, 'single')}>` }
  }

  return Object.fromEntries(
    model.fields.filter(field => field.required).map(field => [field.name, placeholderFor(field)])
  )
}

/** One argv word for a POSIX shell, whatever it contains. */
export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`
}

/** Markdown inline code no backtick inside `text` can close early — the
 *  brief shows the command this way, and its words come from listings. */
export function codeSpan(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length))
  const fence = '`'.repeat(longest + 1)
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : ''

  return `${fence}${pad}${text}${pad}${fence}`
}

/** An id from a listing, only when it has the shape the bridge admits. */
function briefId(value: string): string {
  return ACP_ID.test(value) ? value : ''
}

/** A schema field as the brief names it: one line, however it was sent. */
function fieldWord(field: SchemaField): string {
  return `${oneLine(field.name, 60)} (${oneLine(field.label, 40)})`
}

/** The provider's wallet on the chain the job is created on — only when it
 *  is well-formed, since it lands in a shell command; '' otherwise. */
export function providerWallet(agent: Pick<MarketAgent, 'chainIds' | 'solWalletAddress' | 'walletAddress'>): string {
  if (hireChainId(agent.chainIds) === SOLANA_CHAIN_ID) {
    return SOLANA_ADDRESS.test(agent.solWalletAddress) ? agent.solWalletAddress : ''
  }

  return EVM_ADDRESS.test(agent.walletAddress) ? agent.walletAddress : ''
}

/** The `acp client create-job` line: every word from a listing is one
 *  single-quoted shell word, whatever it contains. */
export function hireCommand(agent: MarketAgent, offering: MarketOffering): string {
  return [
    'acp client create-job',
    `--provider ${shellQuote(providerWallet(agent) || '<provider wallet>')}`,
    `--offering-name ${shellQuote(oneLine(offering.name, 200))}`,
    `--chain-id ${hireChainId(agent.chainIds)}`,
    `--requirements ${shellQuote(JSON.stringify(requirementsTemplate(offering.requirements)))}`
  ].join(' ')
}

function requirementsLines(model: SchemaModel): string[] {
  if (model.kind === 'none') {
    return ['No requirements to fill in.']
  }

  if (model.kind === 'text') {
    return [
      `Requirements — the provider asks: "${briefText(model.text, 280, 'single')}". Put my answer in --requirements.`
    ]
  }

  const optional = model.fields.filter(field => !field.required)

  const lines = [
    model.fields.some(field => field.required)
      ? 'Requirements — replace each <…> in --requirements with my values.'
      : 'Requirements — every field is optional.'
  ]

  if (optional.length > 0) {
    lines.push(`Optional: ${optional.map(fieldWord).join(', ')}.`)
  }

  return lines
}

/** What the provider hands back, in one line. */
export function deliverableLine(model: SchemaModel): string {
  if (model.kind === 'none') {
    return ''
  }

  if (model.kind === 'text') {
    return `Expect back: ${oneLine(model.text, 200)}`
  }

  return `Expect back: ${model.fields.map(fieldWord).join(', ')}.`
}

function briefPrice(offering: MarketOffering): string {
  if (offering.priceValue == null) {
    return 'the listed price'
  }

  return offering.priceType === 'percentage'
    ? `${round(offering.priceValue, 2)}% of the job value`
    : `${offering.priceValue} USDC`
}

/** One line per fact: every listing-sourced word is flattened, so nothing a
 *  provider publishes can add a line of instructions to the brief. */
export function hireBrief(agent: MarketAgent, offering: MarketOffering, now = Date.now()): string {
  const sla = slaLabel(offering.slaMinutes)
  const terms = [`at ${briefPrice(offering)}`, sla ? `delivered within ${sla}` : ''].filter(Boolean).join(', ')
  const agentId = briefId(agent.id)
  const offeringId = briefId(offering.id)
  const agentRef = `${oneLine(agent.name, 80)}${agentId ? ` (agent ${agentId})` : ''}`
  const offeringRef = `"${oneLine(offering.name, 200)}"${offeringId ? ` (offering ${offeringId})` : ''}`
  const presence = presenceOf(agent, now)
  const expect = deliverableLine(offering.deliverable)

  return [
    `hire ${agentRef} for the offering ${offeringRef} ${terms}.`,
    ...requirementsLines(offering.requirements),
    ...(expect ? [expect] : []),
    ...(offering.requiredFunds ? ['This offering needs funds up front — tell me the amount before you fund it.'] : []),
    ...(presence.online
      ? []
      : [
          `The provider is offline (${presence.label}) — expect a delay before it accepts; if the job expires unanswered, tell me instead of re-creating it.`
        ]),
    ...(providerWallet(agent)
      ? []
      : ['The listing has no valid wallet for that chain — replace <provider wallet> before running the command.']),
    `Create the job with ${codeSpan(hireCommand(agent, offering))}, fund it, and report back.`
  ].join('\n')
}

export const OFFERING_BRIEF =
  'create an ACP offering for yourself — propose a name, a one-line description, a fixed price in USDC, an SLA in minutes, the requirements as a JSON schema and the deliverable, based on what you do best. Show me the exact `acp offering create` command and wait for my go before running it.'

export type ResourceChange = 'delete' | 'update'

/** `acp resource update|delete` only run interactively in this CLI version,
 *  so the app hands them to the iNFT, which drives a terminal session. */
export function resourceBrief(resource: Pick<MarketResource, 'id' | 'name' | 'url'>, change: ResourceChange): string {
  const id = briefId(resource.id)
  const ref = `"${oneLine(resource.name, 120)}"${id ? ` (resource ${id})` : ''}`

  return [
    change === 'update'
      ? `update my ACP resource ${ref}${resource.url ? ` at ${oneLine(resource.url, 200)}` : ''}.`
      : `delete my ACP resource ${ref}.`,
    change === 'update'
      ? 'Ask me what to change — name, description, URL or params schema — and show me the new values before you save.'
      : 'Confirm with me once more before you remove it.',
    `\`acp resource ${change}\` only runs interactively, so drive it in a terminal session and report back.`
  ].join('\n')
}
