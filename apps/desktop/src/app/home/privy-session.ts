/**
 * iCLONE OS — Privy wallet session + iNFT roster (renderer store).
 *
 * Mirrors the `$zoomPercent` idiom in `src/store/zoom.ts`: a plain nanostores
 * atom the main process pushes into over IPC (`iclonePrivy.onSession`), plus
 * thin action functions the UI calls. Every bridge access is optional-chained
 * so a build without the bridge degrades to "unavailable" instead of throwing.
 */
import { atom } from 'nanostores'

import { rosterAfterScan, rosterAfterTick } from '@/app/settings/inft-book/book-roster'
import { checkedCards, seedBookSelection, summonableCards } from '@/app/settings/inft-book/book-seed'
import { $bookChecked, selectionFor } from '@/app/settings/inft-book/book-store'
import type { HomeTickResult } from '@/app/settings/inft-book/book-types'
import { translateNow } from '@/i18n/runtime'
import { notify } from '@/store/notifications'
import { isAuxiliaryWindow, isPeerInstanceWindow } from '@/store/windows'

import type { INftCardData } from './collections'
import { clearEconBadges } from './econ/badges'
import { forgetPrefetch } from './econ/prefetch'
import type { InftProfileSource, ResolvedInftProfile } from './inft-bootstrap'
import { buildAllProfiles } from './inft-profile'
import type { InftScanResult } from './inft-scan'
import { toInftCards } from './inft-scan'
import { deselectInft, switchInft } from './inft-switch'
import { ICLONE_STORAGE } from './lib/storage-keys'
import { $ownership, observeOwnership, startOwnershipSync, withDeactivatedCards } from './ownership'
import { $activeInft, HERMES_CHOICE, recallInftChoice } from './stage-store'

interface IclonePrivySessionPayload {
  status: 'in' | 'out'
  address: string | null
  userId: string | null
  label: string | null
  /** Main's status answer only: 'out' on the first launch of a new version that was signed in before it. */
  afterUpdate?: true
}

interface PrivySessionState {
  status: 'in' | 'out'
  address?: string
  label?: string
}

type InftRosterStatus = 'idle' | 'loading' | 'ready' | 'error'

interface IclonePrivyBridge {
  /** K143: a refusal names its reason (the fixed sign-in port is held, or the page is not in this build). */
  open: () => Promise<PrivyOpenAnswer>
  logout: () => Promise<{ ok: boolean; error?: string }>
  scan: (address: string) => Promise<InftScanResult>
  /** The 3-minute refresh: page 1 + ownerOf proofs of the checked ids (absent in older builds). */
  scanTick?: (address: string, checkedIds: string[]) => Promise<HomeTickResult>
  resolveProfile: (item: InftProfileSource) => Promise<ResolvedInftProfile>
  onSession: (callback: (session: IclonePrivySessionPayload) => void) => () => void
  /** The `persist:iclone-privy` partition's real state, read by main; null
   *  when main could not tell (absent in builds without the relay). */
  status?: () => Promise<IclonePrivySessionPayload | null>
}

const SIGNED_OUT: PrivySessionState = { status: 'out' }

export const $privySession = atom<PrivySessionState>(SIGNED_OUT)
export const $inftRoster = atom<INftCardData[]>([])
export const $inftRosterStatus = atom<InftRosterStatus>('idle')
export const $inftRosterError = atom<string | null>(null)
/** True while the boot restore re-scans the remembered wallet: the home says
 *  "restoring your wallet…" instead of offering the connect button. */
export const $privyRestoring = atom<boolean>(false)
/** True when main said the wallet was signed out by the app update (V3-0b): the home's line says so, once. */
export const $privySignedOutByUpdate = atom<boolean>(false)

// ── the remembered wallet identity ───────────────────────────────────────────
// The renderer keeps the PUBLIC identity (address + label, never a token) only
// as a hint that a restore is worth showing: "restoring your wallet…" for at
// most RESTORE_TIMEOUT_MS while main reads the partition. Signed in is decided
// by main alone (status() or a session push); sign-out and an 'out' forget it.

/** @public — privy-session.test.ts reads it through a fresh `await import()` per test. */
export const RESTORE_TIMEOUT_MS = 10_000

// Bumped by every session change (a push, an applied answer, a sign-out). A
// status answer applies only if nothing changed since it was asked, however
// late it lands — main's word is final; only the placeholder is bounded.
let sessionEpoch = 0

const LAST_SESSION_KEY = ICLONE_STORAGE.privyLastSession.key
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

interface RememberedIdentity {
  address: string
  label?: string
}

function rememberIdentity(identity: RememberedIdentity): void {
  try {
    window.localStorage.setItem(LAST_SESSION_KEY, JSON.stringify(identity))
  } catch {
    // Storage blocked: the next boot simply asks for a sign-in again.
  }
}

function forgetIdentity(): void {
  try {
    window.localStorage.removeItem(LAST_SESSION_KEY)
  } catch {
    // Nothing remembered to forget.
  }
}

function recallIdentity(): RememberedIdentity | null {
  try {
    const raw = window.localStorage.getItem(LAST_SESSION_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null

    if (!parsed || typeof parsed !== 'object') {
      return null
    }

    const { address, label } = parsed as { address?: unknown; label?: unknown }

    if (typeof address !== 'string' || !ADDRESS_RE.test(address)) {
      return null
    }

    return { address, label: typeof label === 'string' ? label.slice(0, 120) : undefined }
  } catch {
    return null
  }
}

function iclonePrivyBridge(): IclonePrivyBridge | undefined {
  if (typeof window === 'undefined') {
    return undefined
  }

  return (window.hermesDesktop as unknown as { iclonePrivy?: IclonePrivyBridge } | undefined)?.iclonePrivy
}

function resetRoster(): void {
  cancelSeedRetry()
  lastCards = null
  fullScanTicket = null
  $inftRoster.set([])
  $inftRosterStatus.set('idle')
  $inftRosterError.set(null)
}

export interface PrivyOpenAnswer {
  ok: boolean
  error?: string
  reason?: 'port-in-use' | 'unavailable' | 'listen-failed'
  port?: number
}

const isPort = (port: unknown): port is number =>
  typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536

/**
 * The words for a refused sign-in (K143), in the app's language. The port is fixed on purpose (the Privy-allowlisted
 * origin), so "in use" says which port and what to do; an older main without `reason` gets the generic line (its
 * English `error` is for logs, never shown).
 */
export function privyOpenRefusalCopy(answer: PrivyOpenAnswer | null | undefined): { title: string; message: string } {
  const title = translateNow('desktop.home.signInCouldNotOpen')

  // n2: the port line only with the port main reported; without one the generic line, never a guessed number.
  if (answer?.reason === 'port-in-use' && isPort(answer.port)) {
    return { title, message: translateNow('desktop.home.signInPortInUse', answer.port) }
  }

  if (answer?.reason === 'unavailable') {
    return { title, message: translateNow('desktop.home.signInUnavailable') }
  }

  return { title, message: translateNow('desktop.home.signInFailed') }
}

/** Open (or focus) the Privy login window. A no-op — not an error toast —
 *  when the bridge isn't wired yet; the caller UI should hide/disable the
 *  affordance in that case rather than lean on this to fail loudly. */
export function openPrivyLogin(): void {
  // A refusal (port held by another copy of the app, page missing from the build) is said, never swallowed: the
  // button otherwise just returns to "connect wallet" and looks dead.
  const refused = (answer: PrivyOpenAnswer | null | undefined) =>
    notify({ durationMs: 10_000, kind: 'error', ...privyOpenRefusalCopy(answer) })

  void iclonePrivyBridge()
    ?.open()
    .then(result => {
      if (result && !result.ok) {
        refused(result)
      }
    })
    .catch(() => refused(null))
}

/** Sign out: clears the main process's Privy session partition and this
 *  store's state immediately (optimistic — matches `$zoomPercent`'s pattern
 *  of trusting the local write and letting the next push reconcile it). */
export function logoutPrivy(): void {
  scanEpoch += 1
  sessionEpoch += 1
  void iclonePrivyBridge()?.logout()
  $privySession.set(SIGNED_OUT)
  $privyRestoring.set(false)
  $privySignedOutByUpdate.set(false)
  forgetIdentity()
  resetRoster()
  // The old wallet's iNFT must not stay on stage, speaking, for a new one —
  // nor its warmed reads and dock counts serve the next.
  void deselectInft('sign-out')
  forgetPrefetch()
  clearEconBadges()
}

// A scan that finishes after a logout, or after a newer scan started, must
// not write its roster (it could bring a signed-out wallet's iNFTs back and
// re-summon one). Every scan takes a ticket and checks it after the await.
let scanEpoch = 0

// The last scanned wallet cards (no ownership ghosts) and whose they are: an
// incomplete scan and the 3-minute refresh build on them.
let lastCards: { address: string; cards: INftCardData[] } | null = null
// The ticket of the full scan in flight (null = none): the refresh never overlaps one.
let fullScanTicket: null | number = null
let refreshing = false

// The O1 seed needs one whole-wallet scan. A sign-in scan that is incomplete
// (a page flapped, an indexer down) or failed (offline) is retried on its own,
// backing off to every 15 minutes, until one is complete or capped; sign-out
// and a wallet switch cancel it. A retry never runs beside another full scan.
const SEED_RETRY_MS: readonly number[] = [30_000, 60_000, 120_000, 300_000, 900_000]

let seedRetry: { address: string; attempt: number; timer: null | ReturnType<typeof setTimeout> } | null = null

function cancelSeedRetry(): void {
  if (seedRetry?.timer) {
    clearTimeout(seedRetry.timer)
  }

  seedRetry = null
}

function scheduleSeedRetry(address: string): void {
  const attempt = seedRetry?.address === address ? seedRetry.attempt : 0
  const delay = SEED_RETRY_MS[Math.min(attempt, SEED_RETRY_MS.length - 1)] ?? 900_000

  cancelSeedRetry()

  const timer = setTimeout(() => {
    if (seedRetry?.timer !== timer) {
      return
    }

    seedRetry.timer = null
    const session = $privySession.get()

    if (session.status !== 'in' || session.address !== address) {
      cancelSeedRetry()

      return
    }

    // A full scan already running (the Book's Rescan, a re-sign-in) decides, and reschedules if it falls short.
    if (fullScanTicket === null) {
      void rescan()
    }
  }, delay)

  seedRetry = { address, attempt: attempt + 1, timer }
}

/**
 * K20: the retry exists for the seed. Once the wallet has a Book selection, the 3-minute tick keeps the checked set
 * fresh, so a scan that stays incomplete (an indexer down, a page cap, a repeated cursor: K107) or fails does not
 * full-scan the wallet again on a timer; Rescan and the next sign-in still do.
 */
function retrySeedUnlessSettled(address: string): void {
  if (selectionFor($bookChecked.get(), address)) {
    cancelSeedRetry()

    return
  }

  scheduleSeedRetry(address)
}

/**
 * K19: the connection is back. A pending seed retry may be parked on the
 * 15-minute step after a long outage; it runs now instead, and its backoff
 * starts again from 30 s. A full scan already running decides on its own
 * (and reschedules from the reset step if it still falls short).
 *
 * @public — wired to the window's `online` event here; privy-session.refresh.test.ts calls it directly (K106).
 */
export function onBackOnline(): void {
  if (!seedRetry) {
    return
  }

  const { address } = seedRetry
  const session = $privySession.get()

  if (session.status !== 'in' || session.address !== address) {
    cancelSeedRetry()

    return
  }

  if (seedRetry.timer) {
    clearTimeout(seedRetry.timer)
  }

  seedRetry = { address, attempt: 0, timer: null }

  if (fullScanTicket === null) {
    void rescan()
  }
}

/** Re-scan the signed-in wallet's iNFTs. No-op when signed out or when the
 *  bridge is unavailable — `$inftRosterStatus`/`$inftRosterError` carry the
 *  reason so the panel can show it instead of an empty list going unexplained. */
export async function rescan(options: { present?: boolean } = {}): Promise<void> {
  const { address } = $privySession.get()

  if (!address) {
    resetRoster()

    return
  }

  const bridge = iclonePrivyBridge()

  if (!bridge) {
    $inftRosterStatus.set('error')
    $inftRosterError.set('Wallet scan is unavailable in this build.')

    return
  }

  $inftRosterStatus.set('loading')
  $inftRosterError.set(null)

  if (seedRetry?.address !== address) {
    cancelSeedRetry()
  } else if (seedRetry.timer) {
    clearTimeout(seedRetry.timer)
    seedRetry.timer = null
  }

  const ticket = ++scanEpoch

  fullScanTicket = ticket

  try {
    const result = await bridge.scan(address)

    if (ticket !== scanEpoch || $privySession.get().address !== address) {
      return
    }

    // K21: a sender main refuses gets null, not a result — an error the panel can show, never a TypeError.
    if (!result?.ok) {
      $inftRosterStatus.set('error')
      $inftRosterError.set(
        result ? (result.error ?? translateNow('inftBook.scanFailed')) : translateNow('inftBook.scanRefused')
      )
      retrySeedUnlessSettled(address)

      return
    }

    const complete = result.complete === true
    // The 5 000 ceiling is the most the app ever reads of a wallet: a capped scan is whole enough to seed.
    const seedable = complete || result.capped === true
    const previous = lastCards?.address === address ? lastCards.cards : null
    const cards = rosterAfterScan(previous, toInftCards(result), complete)

    // O1, the first scan after the upgrade: the seed needs the whole wallet,
    // so only a complete (or capped) scan may write it, and it lands before the roster.
    const settled = seedable && (await seedBookSelection(address, cards))

    if (ticket !== scanEpoch || $privySession.get().address !== address) {
      return
    }

    if (settled) {
      cancelSeedRetry()
    } else {
      retrySeedUnlessSettled(address)
    }

    startOwnershipSync()
    publishRoster(address, cards, ticket)
    $inftRosterStatus.set('ready')
    // The iNFT Book rule: only what the owner checked for Home is summoned on
    // sign-in — never the whole wallet. Fire-and-forget — it must never block the roster or the stage.
    autoSummon(summonableCards(address, cards), options.present)
  } catch (e) {
    if (ticket !== scanEpoch) {
      return
    }

    $inftRosterStatus.set('error')
    $inftRosterError.set(e instanceof Error ? e.message : translateNow('inftBook.scanFailed'))

    if ($privySession.get().address === address) {
      retrySeedUnlessSettled(address)
    }
  } finally {
    if (fullScanTicket === ticket) {
      fullScanTicket = null
    }
  }
}

/** Sets the roster from scanned cards; profiles are built for the checked (+ the active) only. */
function publishRoster(address: string, cards: INftCardData[], ticket: number): void {
  lastCards = { address, cards }
  $inftRoster.set(withDeactivatedCards(cards, $ownership.get()))
  // R9: the guard proves every configured iNFT's ownership (3 verifications)
  // and keeps a proven-lost one on the roster with its mandatory signal.
  void observeOwnership(address, cards).then(() => {
    if (ticket === scanEpoch && $privySession.get().address === address) {
      $inftRoster.set(withDeactivatedCards(cards, $ownership.get()))
    }
  })
  void buildAllProfiles(checkedCards(address, cards, $activeInft.get()?.id ?? null))
}

/** The 3-minute refresh: page 1 of each chain (new arrivals) plus ownerOf proofs
 *  of the checked set — never the whole wallet, never while a scan runs, and
 *  with no loading state (Home does not flicker). */
export async function refreshRoster(): Promise<void> {
  const { address, status } = $privySession.get()
  const tick = iclonePrivyBridge()?.scanTick

  if (status !== 'in' || !address || !tick || fullScanTicket !== null || refreshing) {
    return
  }

  const ticket = scanEpoch
  const base = lastCards?.address === address ? lastCards.cards : []

  refreshing = true

  try {
    const result = await tick(
      address,
      checkedCards(address, base).map(card => card.id)
    )

    if (!result?.ok || result.skipped || ticket !== scanEpoch || $privySession.get().address !== address) {
      return
    }

    const arrivals = toInftCards({ ok: true, source: 'indexer', agents: result.arrivals })

    publishRoster(address, rosterAfterTick(base, arrivals, result.owners), ticket)
  } catch {
    // The next tick tries again; the roster stays as it is.
  } finally {
    refreshing = false
  }
}

/** The engine PRESENTS the wallet's iNFT on SIGN-IN only (owner rule): the
 *  last summoned card when it is still in the roster, else the first
 *  performable one. It must NEVER re-summon on a periodic re-scan — otherwise
 *  the owner's explicit "Back to Hermes" (deselect) is undone ~3 minutes later
 *  when the roster refreshes. Never replaces an iNFT already on stage. */
function autoSummon(cards: INftCardData[], present = false): void {
  if (!present || $activeInft.get()) {
    return
  }

  const remembered = recallInftChoice()

  // "Back to Hermes" is a choice too — it survives the next sign-in.
  if (remembered === HERMES_CHOICE) {
    return
  }

  const pick = cards.find(c => c.id === remembered && c.modelUrl) ?? cards.find(c => c.modelUrl)

  if (pick?.modelUrl) {
    // Through the one door: stage AND persona, never the model alone.
    void switchInft(pick, { origin: 'restore' })
  }
}

function applySession(session: IclonePrivySessionPayload): void {
  sessionEpoch += 1
  $privySignedOutByUpdate.set(session.status === 'out' && session.afterUpdate === true)

  if (session.status === 'in') {
    $privySession.set({
      status: 'in',
      address: session.address ?? undefined,
      label: session.label ?? undefined
    })

    if (session.address && ADDRESS_RE.test(session.address)) {
      rememberIdentity({ address: session.address, label: session.label ?? undefined })
    }

    void rescan({ present: true })
  } else {
    $privySession.set(SIGNED_OUT)
    $privyRestoring.set(false)
    forgetIdentity()
    resetRoster()
  }
}

/** Boot: ask main for the partition's real state. A confirmed 'in' goes
 *  through applySession → rescan → autoSummon (switchInft origin 'restore',
 *  which never steals the stage from a pick made meanwhile). "restoring your
 *  wallet…" shows only when a wallet was remembered, for at most
 *  RESTORE_TIMEOUT_MS; main's answer still applies after that.
 *  @public — the out-of-tree sign-in lab probes (R4) read this declaration. */
export async function restorePrivySession(): Promise<void> {
  if ($privySession.get().status === 'in') {
    return
  }

  const current = iclonePrivyBridge()
  const remembered = recallIdentity() !== null

  if (!remembered && !current?.status) {
    return
  }

  $privyRestoring.set(remembered)

  try {
    await confirmFromPartition(current)
  } finally {
    $privyRestoring.set(false)
  }
}

/** Which line the home stage shows (the words are home-view's, in the display language). */
type WalletPromptKey = 'connect' | 'restoring' | 'restoringWallet' | 'signedOutByUpdate' | 'summon'

/** The home stage's wallet line: while a remembered wallet is restored it
 *  says so instead of offering the connect button. The wallet confirms
 *  before the on-chain scan settles, so a remembered card keeps the line on
 *  "restoring" until the roster is scanned; the island hint is for a settled
 *  roster with nothing summoned (or the owner's Hermes choice). Signed out
 *  by an app update, the connect line says why, still with the button. */
export function walletPrompt(
  status: 'in' | 'out',
  restoring: boolean,
  rosterStatus: InftRosterStatus = 'ready',
  rememberedChoice: null | string = null,
  signedOutByUpdate = false
): { prompt: WalletPromptKey; connect: boolean } {
  if (restoring) {
    return { prompt: 'restoringWallet', connect: false }
  }

  const scanPending = rosterStatus === 'idle' || rosterStatus === 'loading'

  if (status === 'in' && scanPending && rememberedChoice && rememberedChoice !== HERMES_CHOICE) {
    return { prompt: 'restoring', connect: false }
  }

  if (status === 'in') {
    return { prompt: 'summon', connect: false }
  }

  return { prompt: signedOutByUpdate ? 'signedOutByUpdate' : 'connect', connect: true }
}

function isSessionPayload(payload: unknown): payload is IclonePrivySessionPayload {
  const status = (payload as { status?: unknown } | null)?.status

  return status === 'in' || status === 'out'
}

/** Resolves on the first word from main — status() or a session push — or
 *  after RESTORE_TIMEOUT_MS. The status answer itself is applied whenever it
 *  lands, unless the session changed in between. */
function confirmFromPartition(current: IclonePrivyBridge | undefined): Promise<void> {
  const asked = sessionEpoch

  const answer = current?.status?.().then(
    payload => {
      if (sessionEpoch === asked && isSessionPayload(payload)) {
        applySession(payload)
      }
    },
    () => undefined
  )

  return new Promise(resolve => {
    let settled = false
    const stops: Array<() => void> = []

    const finish = () => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        stops.forEach(stop => stop())
        resolve()
      }
    }

    const timer = setTimeout(finish, RESTORE_TIMEOUT_MS)
    stops.push($privySession.listen(finish))
    void answer?.then(finish)
  })
}

const bridge = iclonePrivyBridge()

if (bridge) {
  bridge.onSession(applySession)
  void restorePrivySession()
}

// The collection keeps itself fresh (owner rule: the user never re-scans by
// hand): while signed in, every 3 minutes the roster picks up new arrivals and
// re-proves the checked iNFTs (refreshRoster). The full wallet scan runs on
// sign-in and on the iNFT Book's Rescan only.
const AUTO_REFRESH_MS = 180_000

/**
 * K75: the roster refresh costs indexer and RPC requests, so it runs in ONE
 * window — the primary one (not a session/peer window, the HUD or a popped-out
 * Browser) — only while signed in, and skips a tick while that window is
 * hidden. Sign-out clears the timer instead of letting it tick to no purpose.
 *
 * @public — used here; privy-session.refresh.test.ts reads it to pin the K75 owner rule (K106).
 */
export function isRosterOwnerWindow(): boolean {
  return !isAuxiliaryWindow() && !isPeerInstanceWindow()
}

let rosterTimer: null | ReturnType<typeof setInterval> = null

function rosterTick(): void {
  if (typeof document !== 'undefined' && document.hidden) {
    return
  }

  void refreshRoster()
}

function syncRosterTimer(signedIn: boolean): void {
  if (signedIn && rosterTimer === null) {
    rosterTimer = setInterval(rosterTick, AUTO_REFRESH_MS)
  } else if (!signedIn && rosterTimer !== null) {
    clearInterval(rosterTimer)
    rosterTimer = null
  }
}

if (bridge && typeof window !== 'undefined') {
  if (isRosterOwnerWindow()) {
    $privySession.subscribe(session => syncRosterTimer(session.status === 'in'))
  }

  window.addEventListener('online', onBackOnline)
}

// Dev-only hooks: let the E2E harness exercise the signed-in surfaces
// (scan → roster → auto-summon) and summon an arbitrary model (launch-
// collection GLBs staged into the model cache) without a login round-trip.
// Absent from production bundles.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  const dev = window as unknown as {
    __icloneDevSession?: (payload: IclonePrivySessionPayload) => void
    __icloneDevSummon?: (card: INftCardData) => void
  }

  dev.__icloneDevSession = applySession
  dev.__icloneDevSummon = (card: INftCardData) => void switchInft(card, { origin: 'pill' })
}
