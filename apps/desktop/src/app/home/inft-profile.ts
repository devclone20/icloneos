/**
 * iCLONE OS — per-iNFT selection actions (renderer).
 *
 * One iNFT = one Hermes PERSONALITY (its on-chain soul), not a separate
 * profile. Selecting an iNFT is lightweight — like picking a model:
 *   - `summonInft` puts its 3D GLB on the stage (always succeeds),
 *   - the soul is registered under `agent.personalities[<slug>]` and applied
 *     via the gateway `config.set personality` RPC (in-session overlay — no
 *     reload, no wallet re-login, history and prompt-cache preserved),
 *   - the EconomyOS panels key off `$activeInft`'s slug (one ACP config dir
 *     per iNFT).
 *
 * The switch itself (stage + `config.set personality`) is ONE door:
 * `inft-switch.ts`. This module builds and registers souls only.
 *
 * Robustness contract: selecting an iNFT must NEVER crash or leave a raw error
 * on screen. The stage always summons first; the persona is best-effort and
 * returns a typed result with a human-readable reason when it can't apply.
 */
import { getHermesConfigRecord, saveHermesConfig } from '@/api/config'
import { createProfile, deleteProfile, getProfileSoul, updateProfileSoul } from '@/api/profiles'
import { profileSlugFor, slugForInft } from '@/iclone-shared/inft-slug'
import { persistStringArray, storedStringArray } from '@/lib/storage'
import { refreshProfiles } from '@/store/profile'

import type { INftCardData } from './collections'
import type { InftProfileSource, ResolvedInftProfile } from './inft-bootstrap'
import { ICLONE_STORAGE } from './lib/storage-keys'

// Electron enforces these (the request is aborted there): a stuck soul read or
// config write fails the switch in bounded time instead of riding the 30 s
// default once per stage.
const SOUL_READ_TIMEOUT_MS = 15_000
const PROFILE_WRITE_TIMEOUT_MS = 20_000
const CONFIG_WRITE_TIMEOUT_MS = 20_000

// ── pure helpers ─────────────────────────────────────────────────────────────

/** Split a card id (`chain:contract:tokenId`) into contract + tokenId. */
export function sourceFromCard(id: string, name: string, bootstrap: InftProfileSource['bootstrap']): InftProfileSource {
  const [, contract, tokenId] = id.split(':')

  return { contract: contract || '', tokenId: tokenId || '', name, bootstrap }
}

// ── resolution + the durable soul store ─────────────────────────────────────

// The electron-side resolveInftProfile (iclone-profile.ts) does the chain work; this asks it over the bridge.
async function requestInftProfile(source: InftProfileSource): Promise<ResolvedInftProfile> {
  const bridge = window.hermesDesktop?.iclonePrivy

  if (!bridge?.resolveProfile) {
    return {
      slug: '',
      name: source.name,
      soulMd: '',
      identity: null,
      source: 'none',
      identityVerified: false,
      soulVerified: false,
      error: 'Profile bridge unavailable in this window.'
    }
  }

  return bridge.resolveProfile(source)
}

/** Build (or rebuild) one iNFT's soul: resolve it from the chain, persist it to
 *  a Hermes profile (the durable soul store + edit surface), and refresh. */
export async function buildInftProfile(source: InftProfileSource): Promise<ResolvedInftProfile> {
  const resolved = await requestInftProfile(source)

  if (!resolved.soulMd) {
    throw new Error(resolved.error || 'This token has no soul to build a profile from.')
  }

  try {
    // A bare profile: cloning `default` copied its config, its `.env` (live
    // keys) and every skill into each iNFT — all to store one SOUL.md.
    await createProfile({ name: resolved.slug }, PROFILE_WRITE_TIMEOUT_MS)
  } catch (err) {
    // The profile already exists → rebuild the soul in place, don't fail.
    const message = err instanceof Error ? err.message : String(err)

    if (!/already exists|exists/i.test(message)) {
      throw err
    }
  }

  await updateProfileSoul(resolved.slug, resolved.soulMd, undefined, PROFILE_WRITE_TIMEOUT_MS)
  soulCache.set(resolved.slug, resolved.soulMd)
  forgetDeleted(resolved.slug)
  await refreshProfiles()

  return resolved
}

export async function deleteInftProfile(slug: string): Promise<void> {
  await deleteProfile(slug)
  await unregisterPersonality(slug)
  soulCache.delete(slug)
  registeredCache.delete(slug)
  rememberDeleted(slug)
  await refreshProfiles()
}

// A deleted profile must stay deleted. The scan sweep rebuilt every iNFT's
// profile within three minutes of the owner removing one, so the choice is
// recorded here and the sweep skips it; an explicit Build lifts it again.
const DELETED_KEY = ICLONE_STORAGE.inftDeletedProfiles.key

function readDeleted(): Set<string> {
  return new Set(storedStringArray(DELETED_KEY))
}

function writeDeleted(set: Set<string>): void {
  persistStringArray(DELETED_KEY, [...set])
}

function rememberDeleted(slug: string): void {
  const set = readDeleted()

  set.add(slug)
  writeDeleted(set)
}

function forgetDeleted(slug: string): void {
  const set = readDeleted()

  if (set.delete(slug)) {
    writeDeleted(set)
  }
}

// ── personality registration (agent.personalities) ──────────────────────────

// The resolved soul, cached per slug so re-selecting an iNFT (or auto-create
// followed by select) never re-fetches Irys/GitHub.
const soulCache = new Map<string, string>()

// The soul text last written to config, per slug — skips redundant config
// round-trips when nothing changed.
const registeredCache = new Map<string, string>()

// The config read-modify-write is not atomic, so concurrent builds (the
// auto-create sweep on scan) would clobber each other's agent.personalities
// entries. A single-flight chain keeps the writes ordered. A straggler holds
// the chain for at most one write timeout: past that, the next write starts a
// new head instead of queueing behind it forever.
let personalityWrite: Promise<unknown> = Promise.resolve()

function serializeWrite<T>(fn: () => Promise<T>): Promise<T> {
  const ahead = Promise.race([personalityWrite, new Promise(resolve => setTimeout(resolve, CONFIG_WRITE_TIMEOUT_MS))])
  const next = ahead.then(fn, fn)

  personalityWrite = next.catch(() => undefined)

  return next
}

/** The current `agent.personalities` map (read-only view). */
async function readPersonalities(): Promise<Record<string, unknown>> {
  const cfg = await getHermesConfigRecord(undefined, CONFIG_WRITE_TIMEOUT_MS)
  const agent = (cfg.agent ?? {}) as Record<string, unknown>
  const existing = agent.personalities

  return existing && typeof existing === 'object' && !Array.isArray(existing)
    ? (existing as Record<string, unknown>)
    : {}
}

// The ACP slug (the per-iNFT config dir, `chain-contract-token`) per
// personality slug — remembered by ensurePersona so a later soul edit
// (syncProfileSoul) re-registers with the same runtime block.
const acpSlugBySlug = new Map<string, string>()

/**
 * What the app appends to every iNFT persona: which token it is, and the ONE
 * way to run the Virtuals CLI for that token (the wrapper installed by
 * electron/iclone-acp.ts). Without this, "send an email" from the Message
 * window had no route to the token's own inbox — the agent's shell only saw
 * the owner's personal `acp`. The soul text itself is never changed.
 */
function runtimeBlock(acpSlug: string, tokenId: string, name: string): string {
  const cli = '~/.iclone-os/bin/acp'

  return [
    '',
    '## iclone os runtime (written by the app on every selection — not part of the soul)',
    `- You are iNFT #${tokenId} (${name}) inside the iclone os desktop app. Your EconomyOS — wallet, email inbox, bank card, Hyperliquid account, ACP marketplace seat — lives in an isolated Virtuals ACP config that belongs to this token only.`,
    `- To act on it, run the Virtuals CLI ONLY as \`${cli} --inft ${acpSlug} <command…> --json\` in your terminal (\`--inft ${tokenId}\` is the short form). Never a plain \`acp\`, never another token's slug: that would act as someone else.`,
    '- Before any email, wallet, card, trading or marketplace task, load your `economyos` skill: it holds the playbook, the command shapes and the law — you operate, the owner spends; URLs are relayed raw; card numbers never enter the chat.',
    '- Skills: the <available_skills> index lists them; open one with skill_view only when the task matches its line; do not browse skills. Before a step that needs a permission the owner may have off, load `consent`.',
    '- The Dock apps of iclone os (Email · Wallet · Bank Card · Hyperliquid · ACP Market) show the owner the same economy read-only; after you act, say where they can see it.',
    ''
  ].join('\n')
}

/** Register the soul under `agent.personalities[<slug>]` — the definition the
 *  `config.set personality` RPC resolves. Serialized + best-effort.
 *
 *  A PARTIAL write, on purpose: the server deep-merges what it receives over
 *  what is on disk, so sending only this one key can never undo a setting the
 *  gateway or the Settings page saved a moment earlier — the old full-record
 *  write-back could, and did, revert `display.personality`. */
async function registerPersonality(slug: string, soulMd: string): Promise<void> {
  await serializeWrite(async () => {
    await saveHermesConfig(
      { agent: { personalities: { [slug]: { system_prompt: withRuntime(slug, soulMd) } } } } as Parameters<
        typeof saveHermesConfig
      >[0],
      undefined,
      CONFIG_WRITE_TIMEOUT_MS
    )
    // Only a write that landed is remembered: a timed-out one is retried.
    registeredCache.set(slug, soulMd)
  })

  // R9: the deactivation door's prompt step is ok only once this header landed.
  if (deactivationBySlug.has(slug)) {
    void window.hermesDesktop?.icloneOwnership?.promptHeaderWritten?.(slug)?.catch(() => undefined)
  }
}

/** The soul plus the app's runtime block, when the iNFT's ACP slug is known. */
function withRuntime(slug: string, soulMd: string): string {
  const acpSlug = acpSlugBySlug.get(slug)
  const tokenId = slug.split('-').pop() ?? ''
  const name = acpNameBySlug.get(slug) ?? `#${tokenId}`
  const notice = deactivationBySlug.get(slug)
  const header = notice ? deactivationBlock(tokenId, notice) : ''

  return acpSlug
    ? soulMd.trimEnd() + header + runtimeBlock(acpSlug, tokenId, name)
    : header
      ? soulMd.trimEnd() + header
      : soulMd
}

// R9: a proven loss (indexer + ownerOf + Transfer logs) puts this header on
// the persona at once — the agent stops acting in the economy and answers
// only about its archive. The soul text itself is never changed.
const deactivationBySlug = new Map<string, string>()

export const DEACTIVATION_HEADING = '## iNFT Deactivated (written by the app — ownership proven lost)'

function deactivationBlock(tokenId: string, notice: string): string {
  return [
    '',
    DEACTIVATION_HEADING,
    `- iNFT #${tokenId} was transferred out of the owner's wallet (${notice}). You are DEACTIVATED: do not run any EconomyOS command (wallet, email, card, trading, marketplace) and do not act for the token.`,
    '- Answer only about your archive and memory. If the owner asks, point them to Settings → iNFT → Ownership, and for problems to the support form at https://cloneframe.io/#support-form.',
    ''
  ].join('\n')
}

const RUNTIME_HEADING = '## iclone os runtime (written by the app'

/** A stored `system_prompt` split back into the soul and what the app's
 *  runtime block remembers (the ACP slug and name) — the app's own blocks
 *  (runtime, deactivation header) are stripped so they are never stacked. */
export function splitStoredPrompt(text: string): {
  soul: string
  acpSlug: string | null
  name: string | null
  hadHeader: boolean
} {
  const header = text.indexOf(DEACTIVATION_HEADING)
  const runtimeAt = text.indexOf(RUNTIME_HEADING)
  const cuts = [header, runtimeAt].filter(at => at >= 0)
  const soul = (cuts.length ? text.slice(0, Math.min(...cuts)) : text).trimEnd()
  const runtime = runtimeAt >= 0 ? text.slice(runtimeAt) : ''
  const acpSlug = /--inft ([a-z0-9-]+) <command/i.exec(runtime)?.[1] ?? null
  const name = /You are iNFT #\S+ \((.+?)\) inside the iclone os desktop app/.exec(runtime)?.[1] ?? null

  return { soul, acpSlug, name, hadHeader: header >= 0 }
}

/** The persona as stored — its registered prompt, else its profile's SOUL.md.
 *  null = no such persona (never built, tombstoned or deleted). A failed
 *  config read throws: the caller retries on the next view change. */
async function storedPersona(slug: string): Promise<{ soul: string; hadHeader: boolean } | null> {
  if (readDeleted().has(slug)) {
    return null
  }

  const entry = (await readPersonalities())[slug]
  const prompt = entry && typeof entry === 'object' ? (entry as { system_prompt?: unknown }).system_prompt : undefined

  if (typeof prompt === 'string') {
    const parts = splitStoredPrompt(prompt)

    if (parts.acpSlug && !acpSlugBySlug.has(slug)) {
      acpSlugBySlug.set(slug, parts.acpSlug)
    }

    if (parts.name && !acpNameBySlug.has(slug)) {
      acpNameBySlug.set(slug, parts.name)
    }

    return parts.soul ? { soul: parts.soul, hadHeader: parts.hadHeader } : null
  }

  try {
    const soul = (await getProfileSoul(slug, undefined, SOUL_READ_TIMEOUT_MS)).content?.trim()

    return soul ? { soul, hadHeader: false } : null
  } catch {
    return null
  }
}

// slug → the notice whose header is settled (written, or nothing to write).
const headerSettled = new Map<string, string | null>()
const headerFlight = new Map<string, Promise<void>>()

async function applyPersonaDeactivation(slug: string, notice: string | null): Promise<void> {
  if (headerSettled.has(slug) && headerSettled.get(slug) === notice) {
    return
  }

  const had = deactivationBySlug.has(slug)

  if (notice) {
    deactivationBySlug.set(slug, notice)
  } else {
    deactivationBySlug.delete(slug)
  }

  const cached = registeredCache.get(slug)

  // Registered this session without a header, and none is wanted: no write.
  if (!notice && !had && cached !== undefined) {
    headerSettled.set(slug, notice)

    return
  }

  let soul = cached ?? soulCache.get(slug) ?? null

  // No soul this session (after a restart, or a ghost card): the stored one.
  if (soul === null) {
    let stored: Awaited<ReturnType<typeof storedPersona>>

    try {
      stored = await storedPersona(slug)
    } catch {
      return
    }

    // A persona that does not exist has no header to carry — and reports nothing.
    if (!stored || (!notice && !stored.hadHeader)) {
      headerSettled.set(slug, notice)

      return
    }

    soul = stored.soul
  }

  registeredCache.delete(slug)

  try {
    await registerPersonality(slug, soul)
    headerSettled.set(slug, notice)
  } catch {
    // retried on the next view change or selection
  }
}

/** Sets or clears the deactivation header of one persona and re-registers it —
 *  from this session's soul, else from the stored prompt or SOUL.md. One
 *  flight per slug, so the view updates never race their own writes. */
export function setPersonaDeactivation(slug: string, notice: string | null): Promise<void> {
  const run = (headerFlight.get(slug) ?? Promise.resolve()).then(() => applyPersonaDeactivation(slug, notice))
  const tail = run.catch(() => undefined)

  headerFlight.set(slug, tail)
  void tail.then(() => {
    if (headerFlight.get(slug) === tail) {
      headerFlight.delete(slug)
    }
  })

  return run
}

const acpNameBySlug = new Map<string, string>()

/** The deep-merge that makes registration safe also means a deleted key
 *  survives a write. The entry is emptied instead — an empty prompt is the
 *  tombstone the readers below and the dropdown filter treat as absent. */
async function unregisterPersonality(slug: string): Promise<void> {
  await serializeWrite(async () => {
    const personalities = await readPersonalities()

    if (!(slug in personalities)) {
      return
    }

    await saveHermesConfig(
      { agent: { personalities: { [slug]: { system_prompt: '' } } } } as Parameters<typeof saveHermesConfig>[0],
      undefined,
      CONFIG_WRITE_TIMEOUT_MS
    )
    registeredCache.delete(slug)
  })
}

/** Resolve the soul (cached) and register it as a personality — idempotent, and
 *  shared by auto-create and selection so the cache pays off everywhere. */
export async function ensurePersona(source: InftProfileSource, slug: string, acpSlug?: string): Promise<string> {
  // A newly known ACP slug changes the registered text even when the soul
  // did not — drop the "already registered" memory so it is written again.
  if (acpSlug && acpSlugBySlug.get(slug) !== acpSlug) {
    acpSlugBySlug.set(slug, acpSlug)
    registeredCache.delete(slug)
  }

  if (source.name && acpNameBySlug.get(slug) !== source.name) {
    acpNameBySlug.set(slug, source.name)
    registeredCache.delete(slug)
  }

  let soul = soulCache.get(slug)

  // An existing profile's SOUL.md is the owner's — edits live there. Only a
  // profile that does not exist yet is built from the chain; rebuilding on
  // every launch used to overwrite the owner's edits with the on-chain text.
  if (!soul) {
    try {
      soul = (await getProfileSoul(slug, undefined, SOUL_READ_TIMEOUT_MS)).content?.trim() || undefined
    } catch {
      soul = undefined
    }
  }

  if (!soul) {
    const resolved = await buildInftProfile(source)

    soul = resolved.soulMd
  }

  soulCache.set(slug, soul)

  if (registeredCache.get(slug) !== soul) {
    await registerPersonality(slug, soul)
  }

  return soul
}

/** Re-sync the personality after the owner edits the soul — refresh the cache
 *  and re-register so the next select (or the live overlay) uses the edit. */
export async function syncProfileSoul(slug: string, soulMd: string): Promise<void> {
  soulCache.set(slug, soulMd)

  await registerPersonality(slug, soulMd)
}

// ── the sweep yields to a click ─────────────────────────────────────────────

// While a switch resolves, the auto-create sweep parks between tokens so the
// owner's click never queues behind N background registrations.
let sweepHolds = 0
let sweepWaiters: Array<() => void> = []

/** Park the sweep until the returned release is called (idempotent). */
export function holdSweep(): () => void {
  let released = false

  sweepHolds += 1

  return () => {
    if (released) {
      return
    }

    released = true
    sweepHolds -= 1

    if (sweepHolds === 0) {
      const waiters = sweepWaiters

      sweepWaiters = []
      waiters.forEach(wake => wake())
    }
  }
}

function sweepTurn(): Promise<void> {
  return sweepHolds === 0 ? Promise.resolve() : new Promise(resolve => sweepWaiters.push(resolve))
}

// ── auto-create ──────────────────────────────────────────────────────────────

/** Auto-create every iNFT's profile + personality on scan. The owner rule:
 *  one profile per iNFT in the wallet, built automatically — the owner edits
 *  later if they want. Sequential (the config write is serialized) and
 *  best-effort: a dead repo or slow gateway skips that token without blocking
 *  the roster or the others. */
// Only the collections the owner ships get a persona installed WITHOUT being
// asked. The ERC-8004 registry is permissionless: anyone can mint a token,
// point its metadata at a SOUL.md of their choosing and transfer it into the
// owner's wallet — and a sweep that trusted it would install that text as a
// system prompt for an agent that holds terminal and ACP tools. Those tokens
// still appear in the collection; the owner selects them on purpose.
const AUTO_PERSONA_CONTRACTS = new Set([
  '0x4dfb27e4e6ade6afc8a21ab14751ee8b7ac75631', // icloneOS i01 (Robinhood Chain)
  '0x3d9f35e08c41a80155353862f883f2b70119809f' // ATLAS (Base)
])

let sweep: Promise<void> = Promise.resolve()

export function buildAllProfiles(cards: INftCardData[]): Promise<void> {
  // Two scans (the 3-minute timer, the island opening) must not sweep at once.
  sweep = sweep.catch(() => undefined).then(() => sweepProfiles(cards))

  return sweep
}

async function sweepProfiles(cards: INftCardData[]): Promise<void> {
  const deleted = readDeleted()

  for (const card of cards) {
    if (!card.bootstrap) {
      continue
    }

    const source = sourceFromCard(card.id, card.name, card.bootstrap)
    const slug = profileSlugFor(source.contract, source.tokenId)

    if (
      !source.contract ||
      !source.tokenId ||
      deleted.has(slug) ||
      !AUTO_PERSONA_CONTRACTS.has(source.contract.toLowerCase())
    ) {
      continue
    }

    await sweepTurn()

    try {
      await ensurePersona(source, slug, slugForInft(card.id))
    } catch {
      // Auto-build is best-effort; the profile can still be built on demand.
    }
  }
}
