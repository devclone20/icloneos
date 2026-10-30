/**
 * iCLONE OS — THE door for switching the iNFT you talk to (renderer).
 *
 * Every caller (composer pill, collection panel, Settings, the setup wizard,
 * go-live, sign-in restore / sign-out) goes through `switchInft`. One state
 * machine (`$inftSwitch`) the UI renders; every stage bounded; latest click
 * wins; the composer is never gated by a switch (this module writes none of
 * the atoms that disable it).
 *
 *   resolving — the soul is read/built and registered (`ensurePersona`), the
 *               auto-create sweep yields to it;
 *   applying  — `config.set personality` on the gateway (10 s). A stale apply
 *               is NOT aborted: it finishes, then the newest value is sent, so
 *               the wire order is the click order;
 *   waiting   — the gateway is reconnecting: the switch finishes on its own as
 *               soon as it is open again.
 *
 * The write never names a session: pinned on a live chat, the runtime splices
 * a role=user "[System: … adopt the following persona]" row into ITS history,
 * and a sealed soul reads that as a prompt injection (two quick switches stack
 * two contradicting rows). The persisted personality is what every agent built
 * afterwards reads — a new chat, or a chat resumed from disk — so after the
 * write the switch moves the window to the persona's own chat: its last one,
 * else a fresh draft. A persona never inherits a chat born under another.
 */
import { atom } from 'nanostores'

import { openSession, type OpenSessionNavigate } from '@/app/open-session'
import { NEW_CHAT_ROUTE } from '@/app/routes'
import { sleep } from '@/iclone-shared/async'
import { profileSlugFor, slugForInft } from '@/iclone-shared/inft-slug'
import { isTimeoutError, withTimeout } from '@/lib/with-timeout'
import { $gateway } from '@/store/gateway'
import { $gatewayState, $selectedStoredSessionId, $sessions } from '@/store/session'

import type { INftCardData } from './collections'
import { ensurePersona, holdSweep, sourceFromCard } from './inft-profile'
import { ICLONE_STORAGE } from './lib/storage-keys'
import { clearInftChoice, dismissInft, summonInft } from './stage-store'

const RESOLVE_TIMEOUT_MS = 20_000
export const APPLY_TIMEOUT_MS = 10_000
export const RECONNECT_WAIT_MS = 30_000
const DONE_VISIBLE_MS = 1_500

type InftSwitchOrigin = 'pill' | 'collection' | 'settings' | 'wizard' | 'go-live' | 'restore' | 'sign-out' | 'stage'

type InftSwitchScope = 'session' | 'next-chat' | 'reopened'

type InftSwitchState =
  | { phase: 'idle' }
  | { phase: 'resolving' | 'applying' | 'waiting'; slug: string; name: string; startedAt: number }
  | { phase: 'done'; slug: string; name: string; scope: InftSwitchScope }
  | { phase: 'failed'; slug: string; name: string; reason: string }

interface SwitchResult {
  slug: string
  /** True when the persona applied — the agent now speaks as this iNFT. */
  personaApplied: boolean
  scope?: InftSwitchScope
  /** Human-readable reason when the persona could not apply (stage still works). */
  error?: string
  /** A newer switch superseded this one; its outcome belongs to the newer one. */
  stale?: boolean
}

interface SwitchOptions {
  origin: InftSwitchOrigin
  /** Pill / collection pass it so a persona can reopen its last conversation. */
  navigate?: OpenSessionNavigate
  /** The stage ✕: the iNFT leaves, the remembered choice stays. */
  keepChoice?: boolean
}

export const $inftSwitch = atom<InftSwitchState>({ phase: 'idle' })

/** The iNFT the agent speaks as (null = plain Hermes), for labels that would
 *  otherwise name the Hermes profile it rides on ('default'). */
export const $activeInftName = atom<null | string>(null)

/** The name to show for the iNFT on a profile wake: the one being switched to,
 *  else the active one; null when no iNFT is involved. */
export function inftWakeName(): null | string {
  const state = $inftSwitch.get()

  return state.phase !== 'idle' && state.slug ? state.name : $activeInftName.get()
}

let epoch = 0
let manualPicks = 0
let inFlight: { cardId: string | null; promise: Promise<SwitchResult> } | null = null
let lastRequest: { card: INftCardData | null; opts: SwitchOptions } | null = null
let staleApply: Promise<void> | null = null
let activeSlug: string | null = null
/** When `activeSlug` began speaking (ms): a chat started after it is its own. */
let activeSince = 0
let doneTimer: ReturnType<typeof setTimeout> | null = null

// ── the switch log ───────────────────────────────────────────────────────────

/** `[inft-switch] <slug> <phase> <ms> <reason?>` — failures go out at error
 *  level, which the renderer-log bridge copies into desktop.log. */
function switchLog(slug: string, phase: string, startedAt: number, reason?: string): void {
  const line = `[inft-switch] ${slug || 'hermes'} ${phase} ${Math.round(Date.now() - startedAt)}${reason ? ` ${reason}` : ''}`

  if (phase === 'failed') {
    console.error(line)
  } else {
    console.info(line)
  }
}

// ── errors ───────────────────────────────────────────────────────────────────

const RECONNECTING = 'Hermes is reconnecting — try again in a moment.'
const SWITCH_FAILED = 'Switching failed — retry.'
const LOG_REASON_MAX = 160
// The regex chain runs on the renderer main thread: a 100 KB message must not
// stall it, and nothing past the 160-character log line is ever shown.
const RAW_REASON_MAX = 4096

function isNotConnected(message: string): boolean {
  return /gateway is not connected|not connected|socket (is )?closed/i.test(message)
}

/** The text of anything thrown, without ever throwing itself: an object with
 *  no prototype or a hostile toString() must still reach fail(). */
export function safeErrorMessage(err: unknown): string {
  try {
    return err instanceof Error ? String(err.message) : String(err)
  } catch {
    return 'unknown error'
  }
}

/** Turn any thrown error into copy the owner can act on — never a raw stack or
 *  an IPC method name. */
export function friendlySelectError(err: unknown): string {
  // Total: a hostile value (a Proxy whose traps throw reaches isTimeoutError's
  // instanceof) falls back to the fixed copy instead of escaping fail().
  try {
    return classifySelectError(err)
  } catch {
    return SWITCH_FAILED
  }
}

function classifySelectError(err: unknown): string {
  const message = safeErrorMessage(err)

  if (/still starting|gateway unavailable/i.test(message)) {
    return 'Hermes is still starting up — try again in a moment.'
  }

  if (isNotConnected(message)) {
    return RECONNECTING
  }

  if (isTimeoutError(err) || /timed out|timeout/i.test(message)) {
    return 'Hermes did not answer in time — retry.'
  }

  if (/Unknown personality/i.test(message)) {
    return 'Hermes has not registered this soul yet — retry in a moment.'
  }

  if (/no soul|has no soul|unreachable|not answered/i.test(message)) {
    return 'This token has no reachable soul on-chain yet.'
  }

  if (/bridge unavailable/i.test(message)) {
    return 'The profile engine is unavailable in this window.'
  }

  return SWITCH_FAILED
}

// Credential families recognised by their own shape, so a value leaks no
// matter what label (or none) the upstream message gives it.
const PREFIXED_SECRETS: readonly [RegExp, string][] = [
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{6,}/g, 'sk-***'],
  [/\bgithub_pat_[A-Za-z0-9_]{6,}/g, 'github_pat_***'],
  [/\bgh[opusr]_[A-Za-z0-9]{6,}/g, 'gh*_***'],
  [/\bAIza[A-Za-z0-9_-]{6,}/g, 'AIza***'],
  [/\bxox[abposr]-[A-Za-z0-9-]{6,}/g, 'xox*-***'],
  [/\bfw_[A-Za-z0-9]{6,}/g, 'fw_***'],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*)?/g, 'jwt***']
]

// `label: value` / `label=value` / `label => value`, including labels that end
// a longer name (access_token, client_secret, x-api-key). The text is decoded
// first (decodeEscapes); the escaped and percent-encoded separators below
// still catch what is nested deeper than DECODE_LAYERS. The label starts only
// where a label run starts (not at every inner word boundary), so a long
// hyphenated run stays linear.
const SEPARATOR = String.raw`(?:\\*["']|%(?:25)*22)?\s*(?:=>|[:=]|%(?:25)*3[AD])\s*(?:\\*["']|%(?:25)*22)?`
const LABEL_START = String.raw`(?<![A-Za-z0-9_-])`
const VALUE = String.raw`[^\s"'\\,;&}]+`

const LABELLED_SECRET = new RegExp(
  `${LABEL_START}([A-Za-z0-9_-]*?(?:api[-_]?key|key|token|secret|password|passwd|authorization))(${SEPARATOR})(?:(?:bearer|basic|token)\\s+)?${VALUE}`,
  'gi'
)

// An authorization value is masked whole whatever its scheme (Bearer, Basic,
// Token, ApiKey, Key, Bot, Digest…): the scheme word goes with the credential.
const AUTHORIZATION_SECRET = new RegExp(
  `${LABEL_START}([A-Za-z0-9_-]*?authorization${SEPARATOR})(?:[A-Za-z][A-Za-z0-9_-]{0,20}\\s+)?${VALUE}`,
  'gi'
)

// Prose labels: "Incorrect API key provided: <value>", "API key not valid: <value>".
const PROSE_SECRET = /\b((?:api[ -]?key|secret|password)\b[^:=\n"]{0,24}?[:=]\s*["']?)[^\s"',;&}]+/gi

// `Basic <base64>` outside a label; the value must look encoded (a digit or
// base64 punctuation) so prose like "basic configuration" stays readable.
const BASIC_CREDENTIAL = /\bbasic\s+(?=[A-Za-z0-9+/]*[\d+/=])[A-Za-z0-9+/]{8,}={0,2}/gi

// `scheme://user:password@host` keeps the host, loses the credentials.
const URL_USERINFO = /\/\/[^\s/@:]+:[^\s/@]+@/g

// Anything long and opaque that mixes letters and digits is treated as a key
// (24 characters or more). Base64 adds '/', '+' and '='. A run is judged as a
// path, segment by segment, when it holds a '.', '-' or '_' (base64 never
// does) or a plain lowercase word between slashes; inside a path, a segment
// whose '.'/'-'/'_' sub-token of 12 or more characters mixes upper case, lower
// case and digits is a key too, and once one segment is masked every other
// mixed segment of 8 or more goes with it. A '+' makes a run base64 only when
// it has no '-', '.' or lowercase word (c++ paths and model ids stay
// readable). A '/'-led run whose long segments all look encoded is base64 as
// a whole, short letters-only segments included. A long segment built from
// readable sub-tokens (claude-sonnet-4-5+thinking-20250929) is not opaque.
const OPAQUE_RUN = /[A-Za-z0-9_.\-/+=]{12,}/g
const RUN_SEGMENT = /[^/=]+/g
const SUB_TOKEN = /[._+-]/
const OPAQUE_MIN = 24
const MIXED_SEGMENT_MIN = 12
const NEIGHBOUR_MIN = 8

function isOpaque(run: string): boolean {
  return /[A-Za-z]/.test(run) && /\d/.test(run)
}

function mixesCaseAndDigits(segment: string): boolean {
  return /[a-z]/.test(segment) && /[A-Z]/.test(segment) && /\d/.test(segment)
}

function subTokens(segment: string): string[] {
  return segment.split(SUB_TOKEN).filter(Boolean)
}

function isBase64Run(run: string): boolean {
  const segments = run.split('/').filter(Boolean)
  const hasLowercaseWord = segments.some(segment => /^[a-z]{3,}$/.test(segment))

  if (run.includes('+') && !/[.-]/.test(run) && !hasLowercaseWord) {
    return true
  }

  if (/[._-]/.test(run) || run.includes('+')) {
    return false
  }

  if (run.includes('/') && hasLowercaseWord) {
    return false
  }

  if (!run.startsWith('/') || run.endsWith('=')) {
    return true
  }

  const long = segments.filter(segment => segment.length >= MIXED_SEGMENT_MIN)

  return (long.length > 0 ? long : segments).every(segment => isOpaque(segment))
}

function isKeySegment(segment: string, inPath: boolean): boolean {
  if (
    segment.length >= OPAQUE_MIN &&
    isOpaque(segment) &&
    (!SUB_TOKEN.test(segment) || subTokens(segment).some(token => token.length >= NEIGHBOUR_MIN && isOpaque(token)))
  ) {
    return true
  }

  return (
    inPath &&
    segment.length >= MIXED_SEGMENT_MIN &&
    subTokens(segment).some(token => token.length >= MIXED_SEGMENT_MIN && mixesCaseAndDigits(token))
  )
}

function maskOpaqueRun(run: string): string {
  if (isBase64Run(run) && run.length >= OPAQUE_MIN && isOpaque(run)) {
    return '***'
  }

  const inPath = run.includes('/')
  const segments = run.match(RUN_SEGMENT) ?? []
  const anyKey = inPath && segments.some(segment => isKeySegment(segment, inPath))

  return run.replace(RUN_SEGMENT, segment =>
    isKeySegment(segment, inPath) || (anyKey && segment.length >= NEIGHBOUR_MIN && mixesCaseAndDigits(segment))
      ? '***'
      : segment
  )
}

// Characters a value is made of before decoding (percent escapes included):
// a cut inside such a run is walked back to the character before it.
const RAW_VALUE_CHAR = /[A-Za-z0-9_.\-/+=%]/

/** The raw message up to RAW_REASON_MAX, cut back to the last whitespace (or,
 *  with none, to the start of the trailing value run) so a value split by the
 *  cap never survives as a short unmasked fragment. */
function capRawReason(raw: string): string {
  if (raw.length <= RAW_REASON_MAX) {
    return raw
  }

  const cut = raw.slice(0, RAW_REASON_MAX)
  let end = cut.length

  while (end > 0 && !/\s/.test(cut[end - 1])) {
    end -= 1
  }

  if (end > 0) {
    return cut.slice(0, end)
  }

  end = cut.length

  while (end > 0 && RAW_VALUE_CHAR.test(cut[end - 1])) {
    end -= 1
  }

  return end > 0 ? cut.slice(0, end) : cut
}

// Upstream messages carry the same credential percent-encoded (nested %25),
// as \uXXXX or \\uXXXX escapes, as HTML entities or behind backslash runs.
// Decoding up to DECODE_LAYERS deep lets one plain chain see them all; only
// printable ASCII is decoded, so the log line never gains control characters.
const DECODE_LAYERS = 3
const NAMED_ENTITIES: Readonly<Record<string, string>> = { quot: '"', apos: "'", amp: '&', lt: '<', gt: '>' }

function printable(code: number, original: string): string {
  return code >= 0x20 && code <= 0x7e ? String.fromCharCode(code) : original
}

function decodeLayer(text: string): string {
  return text
    .replace(/%([0-9A-Fa-f]{2})/g, (match, hex: string) => printable(parseInt(hex, 16), match))
    .replace(/(?<!\\)\\+u([0-9A-Fa-f]{4})/g, (match, hex: string) => printable(parseInt(hex, 16), match))
    .replace(
      /&(?:#(\d{1,3})|#x([0-9A-Fa-f]{1,2})|(quot|apos|amp|lt|gt));/gi,
      (match, dec?: string, hex?: string, name?: string) =>
        name ? NAMED_ENTITIES[name.toLowerCase()] : printable(dec ? parseInt(dec, 10) : parseInt(hex ?? '', 16), match)
    )
    .replace(/(?<!\\)\\+(?=["'])/g, '')
}

function decodeEscapes(text: string): string {
  let decoded = text

  for (let layer = 0; layer < DECODE_LAYERS; layer += 1) {
    const next = decodeLayer(decoded)

    if (next === decoded) {
      break
    }

    decoded = next
  }

  return decoded
}

/** The log keeps the cause, not the secret: IPC wrappers stripped, key-like
 *  values masked, one line, capped. */
export function redactSwitchReason(err: unknown): string {
  const raw = decodeEscapes(capRawReason(safeErrorMessage(err)))

  let redacted = raw.replace(/Error invoking remote method '[^']*':\s*/gi, '').replace(/^(?:\s*Error:\s*)+/i, '')

  for (const [pattern, mask] of PREFIXED_SECRETS) {
    redacted = redacted.replace(pattern, mask)
  }

  redacted = redacted
    .replace(URL_USERINFO, '//***@')
    .replace(/\bbearer\s+[^\s"',;}]+/gi, 'bearer ***')
    .replace(BASIC_CREDENTIAL, 'Basic ***')
    .replace(AUTHORIZATION_SECRET, '$1***')
    .replace(LABELLED_SECRET, '$1$2***')
    .replace(PROSE_SECRET, '$1***')
    .replace(OPAQUE_RUN, maskOpaqueRun)
    .replace(/\s+/g, ' ')
    .trim()

  return redacted.length > LOG_REASON_MAX ? `${redacted.slice(0, LOG_REASON_MAX)}…` : redacted
}

// ── per-persona last conversation ────────────────────────────────────────────

const LAST_SESSION_KEY = ICLONE_STORAGE.inftLastSession.key
let rememberWired = false

function lastSessionFor(slug: string): string | null {
  try {
    return window.localStorage.getItem(LAST_SESSION_KEY + slug)
  } catch {
    return null
  }
}

function rememberSession(slug: string, storedId: string): void {
  try {
    window.localStorage.setItem(LAST_SESSION_KEY + slug, storedId)
  } catch {
    // Storage full or blocked: the memory is a convenience, never a failure.
  }
}

function wireRemember(): void {
  if (rememberWired) {
    return
  }

  rememberWired = true
  $selectedStoredSessionId.subscribe(id => {
    // Only a chat BORN while the persona speaks is its own: its agent was built
    // with that persona. An older chat opened meanwhile (or the one on screen
    // when the switch landed) was built for someone else. Mid-switch the
    // previous persona is still `activeSlug`, so nothing is recorded then.
    if (id && activeSlug && !isSwitching() && bornUnderActive(id) && !ownedByAnotherPersona(id, activeSlug)) {
      rememberSession(activeSlug, id)
    }
  })
}

function bornUnderActive(storedId: string): boolean {
  const row = $sessions.get().find(session => session.id === storedId)

  return Boolean(row && Number.isFinite(row.started_at) && row.started_at * 1000 >= activeSince)
}

function isSwitching(): boolean {
  const { phase } = $inftSwitch.get()

  return phase === 'resolving' || phase === 'applying' || phase === 'waiting'
}

/** Whose last conversation is this stored id (another persona's), if any. */
function ownedByAnotherPersona(storedId: string, slug: string): boolean {
  try {
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i)

      if (key?.startsWith(LAST_SESSION_KEY) && key !== LAST_SESSION_KEY + slug) {
        if (window.localStorage.getItem(key) === storedId) {
          return true
        }
      }
    }
  } catch {
    return false
  }

  return false
}

/** Move the window to the persona's own chat once its personality is
 *  persisted: its last conversation (a cold resume builds the agent from the
 *  persisted personality; a warm one was born with it), else a fresh draft
 *  when the chat on screen belongs to someone else. */
function landOnOwnChat(slug: string, navigate: OpenSessionNavigate | undefined): InftSwitchScope {
  const current = $selectedStoredSessionId.get()
  const remembered = slug ? lastSessionFor(slug) : null

  // Hermes owns every chat no persona remembers.
  if (current && (slug ? current === remembered : !ownedByAnotherPersona(current, slug))) {
    return 'session'
  }

  if (!navigate) {
    return 'next-chat'
  }

  if (remembered && $sessions.get().some(session => session.id === remembered)) {
    openSession(remembered, navigate, 'in-place')

    return 'reopened'
  }

  if (current) {
    navigate(NEW_CHAT_ROUTE)
  }

  return 'next-chat'
}

/** One line of copy per state — the pill, the home chip and Settings agree. */
export function inftSwitchLabel(state: InftSwitchState): string {
  switch (state.phase) {
    case 'resolving':

    case 'applying':
      return `Switching to ${state.name}…`

    case 'waiting':
      return `${state.name}: Hermes is reconnecting — finishing when it is back`

    case 'done':
      return state.scope === 'next-chat'
        ? `${state.name} ✓ — ready for every new chat`
        : state.scope === 'reopened'
          ? `${state.name} ✓ — back in its last chat`
          : `${state.name} ✓`

    case 'failed':
      return `${state.name} failed — ${state.reason}`

    default:
      return ''
  }
}

// ── the state machine ────────────────────────────────────────────────────────

function setState(next: InftSwitchState): void {
  if (doneTimer) {
    clearTimeout(doneTimer)
    doneTimer = null
  }

  $inftSwitch.set(next)
}

/** Switch to `card` (null = Hermes). Latest call wins; a repeat click on the
 *  iNFT already switching joins the in-flight switch instead of writing twice. */
export function switchInft(card: INftCardData | null, opts: SwitchOptions): Promise<SwitchResult> {
  wireRemember()

  const phase = $inftSwitch.get().phase
  const cardId = card?.id ?? null

  if (
    inFlight &&
    inFlight.cardId === cardId &&
    (phase === 'resolving' || phase === 'applying' || phase === 'waiting')
  ) {
    return inFlight.promise
  }

  if (opts.origin === 'sign-out') {
    manualPicks = 0
  } else if (opts.origin === 'restore') {
    // The sign-in restore never steals the stage from a pick the owner made.
    if (manualPicks > 0) {
      return Promise.resolve({ slug: '', personaApplied: false, stale: true })
    }
  } else {
    manualPicks += 1
  }

  const mine = ++epoch

  lastRequest = { card, opts }

  const promise = runSwitch(card, opts, mine)

  inFlight = { cardId, promise }

  return promise
}

/** Re-run the last switch (the pill's "retry"). */
export function retryInftSwitch(): Promise<SwitchResult> | null {
  if (!lastRequest) {
    return null
  }

  const { card, opts } = lastRequest

  inFlight = null

  return switchInft(card, { ...opts, origin: opts.origin === 'restore' ? 'pill' : opts.origin })
}

/** Return to Hermes (default) — clear the persona, dismiss the stage. */
export function deselectInft(origin: InftSwitchOrigin = 'pill'): Promise<SwitchResult> {
  return switchInft(null, { origin })
}

/** The stage ✕: the iNFT leaves the screen AND stops speaking, but the
 *  remembered choice stays, so the next sign-in presents it again. */
export function hideInft(): Promise<SwitchResult> {
  return switchInft(null, { origin: 'stage', keepChoice: true })
}

async function runSwitch(card: INftCardData | null, opts: SwitchOptions, mine: number): Promise<SwitchResult> {
  const startedAt = Date.now()

  // Stage first, sync: the 3D model never waits on the persona.
  if (!card) {
    dismissInft()

    if (!opts.keepChoice) {
      clearInftChoice()
    }
  } else if (card.modelUrl) {
    summonInft({ id: card.id, name: card.name, modelUrl: card.modelUrl })
  } else {
    // A soul without a model is still a persona (the composer pill lists it).
    dismissInft()
  }

  const source = card?.bootstrap ? sourceFromCard(card.id, card.name, card.bootstrap) : null
  const slug = source?.contract && source.tokenId ? profileSlugFor(source.contract, source.tokenId) : ''
  const name = card?.name ?? 'Hermes'
  const stale = (): SwitchResult => ({ slug, personaApplied: false, stale: true })

  if (source && slug && card) {
    setState({ phase: 'resolving', slug, name, startedAt })
    switchLog(slug, 'resolving', startedAt)

    const release = holdSweep()

    try {
      await withTimeout(
        ensurePersona(source, slug, slugForInft(card.id)),
        RESOLVE_TIMEOUT_MS,
        `Resolving ${name} timed out`
      )
    } catch (err) {
      return mine === epoch ? fail(slug, name, startedAt, friendlySelectError(err), err) : stale()
    } finally {
      release()
    }

    if (mine !== epoch) {
      return stale()
    }
  }

  return apply({ slug, name, startedAt, mine, navigate: opts.navigate })
}

interface ApplyArgs {
  slug: string
  name: string
  startedAt: number
  mine: number
  navigate?: OpenSessionNavigate
}

async function apply(args: ApplyArgs): Promise<SwitchResult> {
  const { slug, name, startedAt, mine } = args
  const gateway = $gateway.get()

  if (!gateway) {
    return fail(slug, name, startedAt, 'Hermes is still starting up — try again in a moment.')
  }

  if ($gatewayState.get() !== 'open') {
    return waitForGateway(args)
  }

  setState({ phase: 'applying', slug, name, startedAt })
  switchLog(slug, 'applying', startedAt)

  // Let a superseded apply finish on the wire first, then send the newest.
  if (staleApply) {
    await Promise.race([staleApply, sleep(APPLY_TIMEOUT_MS)])
  }

  if (mine !== epoch) {
    return { slug, personaApplied: false, stale: true }
  }

  const rpc = gateway.request('config.set', { key: 'personality', value: slug || 'none' }, APPLY_TIMEOUT_MS)

  const settled = rpc.then(
    () => undefined,
    () => undefined
  )

  staleApply = settled
  void settled.then(() => {
    if (staleApply === settled) {
      staleApply = null
    }
  })

  try {
    await rpc
  } catch (err) {
    if (mine !== epoch) {
      return { slug, personaApplied: false, stale: true }
    }

    return isNotConnected(safeErrorMessage(err))
      ? waitForGateway(args)
      : fail(slug, name, startedAt, friendlySelectError(err), err)
  }

  if (mine !== epoch) {
    return { slug, personaApplied: false, stale: true }
  }

  activeSlug = slug || null
  activeSince = Date.now()
  $activeInftName.set(slug ? name : null)

  const scope = landOnOwnChat(slug, args.navigate)

  setState({ phase: 'done', slug, name, scope })
  switchLog(slug, 'done', startedAt, scope)
  doneTimer = setTimeout(() => {
    if (mine === epoch && $inftSwitch.get().phase === 'done') {
      $inftSwitch.set({ phase: 'idle' })
    }
  }, DONE_VISIBLE_MS)

  return { slug, personaApplied: true, scope }
}

/** The gateway is reconnecting: show why, and finish the switch by itself as
 *  soon as it is open again (bounded). */
function waitForGateway(args: ApplyArgs): Promise<SwitchResult> {
  const { slug, name, startedAt, mine } = args

  setState({ phase: 'waiting', slug, name, startedAt })
  switchLog(slug, 'waiting', startedAt, 'gateway-reconnecting')

  return new Promise<SwitchResult>(resolve => {
    let unsubscribe: (() => void) | null = null

    const timer = setTimeout(() => {
      unsubscribe?.()
      resolve(mine === epoch ? fail(slug, name, startedAt, RECONNECTING) : { slug, personaApplied: false, stale: true })
    }, RECONNECT_WAIT_MS)

    unsubscribe = $gatewayState.listen(state => {
      if (mine !== epoch) {
        clearTimeout(timer)
        unsubscribe?.()
        resolve({ slug, personaApplied: false, stale: true })

        return
      }

      if (state === 'open' && $gateway.get()) {
        clearTimeout(timer)
        unsubscribe?.()
        resolve(apply(args))
      }
    })
  })
}

function fail(slug: string, name: string, startedAt: number, reason: string, cause?: unknown): SwitchResult {
  setState({ phase: 'failed', slug, name, reason })
  switchLog(slug, 'failed', startedAt, cause === undefined ? reason : redactSwitchReason(cause))

  return { slug, personaApplied: false, error: reason }
}

/** Test seam: forget module state between cases. */
export function resetInftSwitchForTests(): void {
  epoch = 0
  manualPicks = 0
  inFlight = null
  lastRequest = null
  staleApply = null
  activeSlug = null
  activeSince = 0
  $activeInftName.set(null)
  setState({ phase: 'idle' })
}
