import { DEFAULT_REASONING_EFFORT } from '@/lib/reasoning-effort'
import { normalize } from '@/lib/text'
import * as runtimeContract from '@/types/runtime-contract.generated'

/** One model selector of a route, first match wins (see served.py `effort_routes`). */
interface EffortCase {
  /** The model (lowercased, `strip` removed) must contain one of these. */
  any?: readonly string[]
  /** Match on the last path segment with `_` read as `-` (the runtime's family test). */
  bare?: boolean
  /** The transport lowers the level again to a per-model catalog list known only
   *  at runtime (e.g. OpenRouter `supported_efforts`): `levels` are an upper bound. */
  catalog?: string
  exact?: readonly string[]
  levels: readonly string[]
  /** requested -> sent where the route does not take the nearest weaker level. */
  overrides?: Readonly<Record<string, string>>
  prefix?: string
  /** Match on the last path segment, lowercased (the runtime's `_flat_model_name`). */
  segment?: boolean
  set?: string
  strip?: string
  /** The model must contain none of these. */
  without?: readonly string[]
}

interface EffortRoute {
  cases: readonly EffortCase[]
  /** Chosen by base-URL host (exact or subdomain), ahead of the provider routes: for any
   *  provider when `providers` is empty, else only for those providers. */
  hosts?: readonly string[]
  providers: readonly string[]
  /** A built-in provider's copy of a host route: the runtime sends to its registry base URL
   *  on these hosts, so a row that names a base URL elsewhere is off this route. */
  registryHosts?: readonly string[]
  sha256?: string
  source: string
}

interface CodexEntry {
  astra: string
  astraIds: readonly string[]
  daybreakIds: readonly string[]
  gpt56: string
  gpt56Substrings: readonly string[]
  gpt6Prefixes: readonly string[]
  legacy: string
  noDisablePrefixes: readonly string[]
  provider: string
  ultraApiMode: string
}

/** The runtime's effort vocabulary: `EFFORT_ROUTES` of the generated contract types. */
export interface EffortRoutesTable {
  entry: { codex: CodexEntry; default: string }
  ladder: readonly string[]
  /** sha256 of each runtime function whose rules the table encodes (drift pins). */
  pins?: Readonly<Record<string, string>>
  routes: readonly EffortRoute[]
  sets: Readonly<Record<string, readonly string[]>>
}

export interface RouteCapabilities {
  can_disable_reasoning?: boolean
  reasoning?: boolean
  /** The provider catalog's levels for this model, when `model.options` carries them. */
  supported_efforts?: readonly string[]
}

// Read through the namespace so this module compiles against contract types
// generated before or after `effortRoutes` existed; without the table there
// are no levels and the composer keeps its single model label.
export const RUNTIME_EFFORT_ROUTES: EffortRoutesTable | null =
  (runtimeContract as unknown as { EFFORT_ROUTES?: EffortRoutesTable }).EFFORT_ROUTES ?? null

const OFF = 'none'

const bareModel = (model: string): string => normalize(model).split('/').pop() ?? ''

/** The route's ENTRY clamp (runtime `route_supported_efforts`): what
 *  `session.info.reasoning_effort_wire` reports for a requested level. */
function entryLevels(table: EffortRoutesTable, provider: string, model: string, apiMode?: string): readonly string[] {
  const codex = table.entry.codex

  if (provider !== codex.provider) {
    return table.sets[table.entry.default] ?? []
  }

  const bare = bareModel(model)

  const name =
    codex.astraIds.includes(bare) || codex.noDisablePrefixes.some(p => bare.startsWith(p))
      ? codex.astra
      : codex.gpt56Substrings.some(s => bare.includes(s)) ||
          codex.gpt6Prefixes.some(p => bare.startsWith(p)) ||
          codex.daybreakIds.includes(bare)
        ? codex.gpt56
        : codex.legacy

  const levels = table.sets[name] ?? []

  return apiMode === codex.ultraApiMode && levels.includes('max') ? [...levels, 'ultra'] : levels
}

const providerMatches = (route: EffortRoute, provider: string): boolean =>
  route.providers.some(name => provider === name || provider.startsWith(`${name}:`))

const hostOf = (baseUrl: string): string => {
  try {
    return new URL(baseUrl.includes('://') ? baseUrl : `https://${baseUrl}`).hostname.toLowerCase().replace(/\.$/, '')
  } catch {
    return ''
  }
}

const onHosts = (domains: readonly string[] | undefined, host: string): boolean =>
  Boolean(host) && Boolean(domains?.some(domain => host === domain || host.endsWith(`.${domain}`)))

function caseMatches(rule: EffortCase, model: string): boolean {
  const lowered = normalize(model)

  const subject = rule.bare
    ? (lowered.replaceAll('_', '-').split('/').pop() ?? '')
    : rule.segment
      ? (lowered.split('/').pop() ?? '')
      : rule.strip && lowered.startsWith(rule.strip)
        ? lowered.slice(rule.strip.length)
        : lowered

  return (
    (!rule.exact || rule.exact.includes(subject)) &&
    (!rule.prefix || subject.startsWith(rule.prefix)) &&
    (!rule.any || rule.any.some(token => subject.includes(token))) &&
    (!rule.without || !rule.without.some(token => subject.includes(token)))
  )
}

const NO_LEVELS: EffortCase = { levels: [] }

/** The provider transport's own case, or null when only the entry clamp applies. */
function transportCase(table: EffortRoutesTable, provider: string, model: string, baseUrl = ''): EffortCase | null {
  const host = hostOf(baseUrl)

  const route =
    table.routes.find(r => onHosts(r.hosts, host) && (!r.providers.length || providerMatches(r, provider))) ??
    table.routes.find(
      r =>
        !r.hosts?.length &&
        providerMatches(r, provider) &&
        (!host || !r.registryHosts || onHosts(r.registryHosts, host))
    )

  if (!route) {
    return null
  }

  return route.cases.find(rule => caseMatches(rule, model)) ?? NO_LEVELS
}

const catalogLevels = (caps: RouteCapabilities | null | undefined): readonly string[] | null => {
  const listed = Array.isArray(caps?.supported_efforts) ? caps.supported_efforts.map(normalize).filter(Boolean) : []

  return listed.length ? listed : null
}

/** A transport case's levels: a catalog-lowered case uses the catalog's own
 *  list when the runtime reported it (`levels` stay the upper bound). */
function transportLevels(
  rule: EffortCase | null,
  caps: RouteCapabilities | null | undefined
): readonly string[] | null {
  if (!rule) {
    return null
  }

  const listed = rule.catalog ? catalogLevels(caps) : null

  return listed ? rule.levels.filter(level => listed.includes(level)) : rule.levels
}

export interface RouteOptions {
  /** The route's API mode, when known: e.g. Codex `codex_app_server` adds `ultra`. */
  apiMode?: string
  /** The provider's base URL, when known: host-chosen transports (e.g. TokenHub) apply only with it. */
  baseUrl?: string
  caps?: RouteCapabilities | null
  table?: EffortRoutesTable | null
}

const tableOf = (options: RouteOptions): EffortRoutesTable | null =>
  options.table === undefined ? RUNTIME_EFFORT_ROUTES : options.table

/**
 * The levels this route sends VERBATIM, in ladder order — the only rows an
 * effort control may offer. `none` is never a level (thinking off is a
 * separate switch). Empty when the runtime reports no reasoning for the model,
 * the route has no effort knob (e.g. budget-token Claude families), or the
 * contract types predate the table.
 */
export function routeEffortLevels(provider: string, model: string, options: RouteOptions = {}): string[] {
  const table = tableOf(options)
  const routeProvider = normalize(provider)

  if (!table || !routeProvider || !model.trim() || options.caps?.reasoning === false) {
    return []
  }

  const entry = entryLevels(table, routeProvider, model, options.apiMode)
  const transport = transportLevels(transportCase(table, routeProvider, model, options.baseUrl), options.caps)

  return table.ladder.filter(
    level => level !== OFF && entry.includes(level) && (!transport || transport.includes(level))
  )
}

/**
 * What the route really sends for a requested level: the entry clamp, then
 * the transport's declared map (e.g. Claude without xhigh sends `max`, Kimi K3
 * sends `high` for `medium`), else its nearest weaker level. '' when the route
 * has no effort knob. The runtime's wire echo shows only the entry clamp, so
 * this is the one honest "sends X" source for adapter-level mappings.
 */
export function routeSentLevel(provider: string, model: string, level: string, options: RouteOptions = {}): string {
  const table = tableOf(options)
  const want = normalize(level)
  const levels = routeEffortLevels(provider, model, options)

  if (!table || !want || want === OFF || !levels.length) {
    return ''
  }

  const routeProvider = normalize(provider)
  const entry = entryLevels(table, routeProvider, model, options.apiMode).filter(l => l !== OFF)
  const entered = clampToRouteLevels(want, entry, table.ladder)
  const transport = transportCase(table, routeProvider, model, options.baseUrl)
  const mapped = levels.includes(entered) ? entered : transport?.overrides?.[entered]

  return mapped && levels.includes(mapped) ? mapped : clampToRouteLevels(entered, levels, table.ladder)
}

/**
 * The catalog (e.g. `openrouter`) that may still lower a level on this route,
 * when the runtime did not report that catalog's list for the model: the
 * listed levels are then an upper bound, never a promise. '' otherwise.
 */
export function routeEffortCatalog(provider: string, model: string, options: RouteOptions = {}): string {
  const table = tableOf(options)

  if (!table || !routeEffortLevels(provider, model, options).length) {
    return ''
  }

  const rule = transportCase(table, normalize(provider), model, options.baseUrl)

  return rule?.catalog && !catalogLevels(options.caps) ? rule.catalog : ''
}

/** Runtime `clamp_effort` over a route's levels: verbatim when listed, else the
 *  nearest WEAKER level (a clamp never escalates cost), else the weakest. */
export function clampToRouteLevels(requested: string, levels: readonly string[], ladder: readonly string[]): string {
  const want = normalize(requested)

  if (!levels.length || levels.includes(want)) {
    return levels.length ? want : ''
  }

  const rank = ladder.indexOf(want)
  const weaker = levels.filter(level => ladder.indexOf(level) < rank)

  return rank >= 0 && weaker.length ? weaker[weaker.length - 1] : levels[0]
}

/** The level a route uses when the model has no preset: Hermes' default when
 *  the route lists it, else its nearest weaker level. */
export const routeDefaultEffort = (levels: readonly string[], ladder: readonly string[]): string =>
  clampToRouteLevels(DEFAULT_REASONING_EFFORT, levels, ladder)

/** Relative thinking-token weight, 1-5 dots, from the level's ladder rank (so
 *  a level reads the same on every model). */
export function effortDots(level: string, ladder: readonly string[]): number {
  const rank = ladder.filter(l => l !== OFF).indexOf(normalize(level))

  return rank < 0 ? 0 : Math.min(5, Math.max(1, rank))
}

/** How the runtime echoed a requested level: `unknown` when `session.info`
 *  carried no wire field (older runtime, or not echoed yet) — never a guess. */
export function effortWireState(requested: string, wire: string): 'clamped' | 'unknown' | 'verbatim' {
  const want = normalize(requested)
  const sent = normalize(wire)

  if (!want || want === OFF || !sent) {
    return 'unknown'
  }

  return sent === want ? 'verbatim' : 'clamped'
}
