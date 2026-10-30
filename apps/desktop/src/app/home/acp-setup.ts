/**
 * iclone os — renderer store for the Virtuals ACP per-iNFT setup.
 *
 * Mirrors electron/iclone-acp.ts's shapes by hand (main-process types can't
 * be imported into the renderer bundle; `src/global.d.ts` types the bridge
 * itself) and follows the house store idiom: plain nanostores atoms + thin
 * action functions, every bridge access optional-chained so a build without
 * the bridge degrades instead of throwing.
 *
 * `$acpConfigMap` (slug → status) is what turns the collections cards'
 * "SETUP NEEDED" chip into "ECONOMYOS" — one probe cache shared by the
 * wizard, the cards, and the econ panels.
 */
import { atom } from 'nanostores'

import { noteAskStage } from '@/app/settings/inft-setup-ask-scope'
import type { AcpToolsInstallResult } from '@/iclone-shared/acp-tools'
import { asRecord } from '@/iclone-shared/guards'
import { slugForInft } from '@/iclone-shared/inft-slug'

export interface AcpRunResult {
  ok: boolean
  code: number | null
  stdout: string
  stderr: string
  error?: string
}

export interface InftAcpStatus {
  cli: boolean
  version?: string
  /** Why `cli` is false: missing, or it failed a real command in the self-test. */
  cliError?: string
  signerPolicy?: string
  signerReady?: boolean
  authenticated: boolean
  agentId?: string
  agentName?: string
  walletAddress?: string
  solanaAddress?: string
  email?: string
  cardReady: boolean
  /** `blocked` = the card service answered 403/429: never offer another signup. */
  cardState?: 'none' | 'ready' | 'signin-pending' | 'blocked'
  /** When `card whoami` last answered (main caches it for 10 min). */
  cardCheckedAt?: number
  /** The pending signup's state id + e-mail from the service — the wizard resumes from these. */
  cardReauthState?: string
  cardReauthEmail?: string
  cardHint?: string
  cardHttpStatus?: number
  /** The last card probe could not run; the card fields are the last answer, or absent. */
  cardStale?: boolean
  /** A card was seen ready on this agent (main keeps it through a waiting link, a block or a non-answer; only the
   *  authoritative "not set up" clears it). */
  cardKnown?: boolean
  cardKnownAt?: number
  /** Main holds signups until then: the last signup answered 403/429 (the wizard's or the agent's own). */
  cardHeldUntil?: number
  /** When `email whoami` / `signer-policy` last answered (same TTL as the card). */
  emailCheckedAt?: number
  signerCheckedAt?: number
  /** The last email / signer probe could not answer: the field is the previous answer. */
  emailStale?: boolean
  signerStale?: boolean
  configured: boolean
  checkedAt: number
  slug: string
  /** The last persisted answer, because a probe could not run just now. */
  stale?: boolean
  /** The iNFT's Virtuals session expired; every other field is the last known answer (sign in again, nothing removed). */
  sessionExpired?: boolean
}

export interface AcpInstallResult {
  /** REL-6: the tools installer's coded answer when the install was refused or failed (words: acpTools i18n). */
  tools?: AcpToolsInstallResult
  ok: boolean
  version?: string
  latest?: string
  updateAvailable?: boolean
  error?: string
}

export interface SkillSyncReport {
  ok: boolean
  source: string
  targets: string[]
  skills: string[]
  written: string[]
  retired: string[]
  errors: string[]
  syncedAt: number
}

export const $acpConfigMap = atom<Record<string, InftAcpStatus>>({})

function icloneAcpBridge() {
  return typeof window === 'undefined' ? undefined : window.hermesDesktop?.icloneAcp
}

export async function acpCheck(): Promise<{ ok: boolean; version?: string; error?: string }> {
  const bridge = icloneAcpBridge()

  if (!bridge) {
    return { ok: false, error: 'ACP bridge unavailable in this build.' }
  }

  return bridge.check()
}

export async function acpInstall(): Promise<AcpInstallResult> {
  const bridge = icloneAcpBridge()

  if (!bridge) {
    return { ok: false, error: 'ACP bridge unavailable in this build.' }
  }

  return bridge.install()
}

export async function acpUpdateCheck(): Promise<AcpInstallResult> {
  const bridge = icloneAcpBridge()

  if (!bridge) {
    return { ok: false, error: 'ACP bridge unavailable in this build.' }
  }

  return bridge.updateCheck()
}

export async function runAcp(inftId: string, argv: string[], timeoutMs?: number): Promise<AcpRunResult> {
  const bridge = icloneAcpBridge()

  if (!bridge) {
    return { ok: false, code: null, stdout: '', stderr: '', error: 'ACP bridge unavailable in this build.' }
  }

  return bridge.run(inftId, argv, timeoutMs)
}

export interface AcpStatusOptions {
  /** The manual re-probe: every probe runs. */
  force?: boolean
  /** A card step finished: `card whoami` runs inside its 10-min TTL. */
  card?: boolean
  /** An agent step finished (signer, email): `email whoami` and `signer-policy` run inside their TTL. */
  agent?: boolean
}

export type InftKvKey = 'notes' | 'card-signup'

/** The owner's own AgentCard account (the `agentcard` CLI, separate from the iNFT's `acp card`). */
export type AgentcardAccountState = 'kyc-required' | 'ready' | 'signed-out'

const AGENTCARD_STATES: readonly AgentcardAccountState[] = ['kyc-required', 'ready', 'signed-out']

/** Main's read-only answer, validated; null when there is no bridge, no CLI or no clear answer. */
export async function agentcardAccountState(): Promise<AgentcardAccountState | null> {
  const read = icloneAcpBridge()?.agentcardStatus

  if (!read) {
    return null
  }

  const state = asRecord(await read().catch(() => null))?.state

  return AGENTCARD_STATES.find(known => known === state) ?? null
}

export type InftKvResult =
  { ok: true; value: Record<string, unknown> | null; masked?: boolean } | { ok: false; error: string }

export interface InftDetachResult {
  ok: boolean
  error?: string
  removed: string[]
  kept: string[]
  agentId?: string
}

/** Live probe of one iNFT's CLI state; updates the shared map. */
export async function refreshAcpStatus(inftId: string, opts?: AcpStatusOptions): Promise<InftAcpStatus | null> {
  const bridge = icloneAcpBridge()

  if (!bridge) {
    return null
  }

  try {
    const status = await (opts ? bridge.status(inftId, opts) : bridge.status(inftId))

    $acpConfigMap.set({ ...$acpConfigMap.get(), [status.slug]: status })

    return status
  } catch {
    return null
  }
}

const NO_BRIDGE: InftKvResult = { ok: false, error: 'ACP bridge unavailable in this build.' }

/** One iNFT's small per-key file (notes, card-signup); main redacts on write. */
export async function inftKvGet(inftId: string, key: InftKvKey): Promise<InftKvResult> {
  const bridge = icloneAcpBridge()

  return bridge ? bridge.kvGet(inftId, key).catch(error => ({ ok: false, error: String(error) })) : NO_BRIDGE
}

export async function inftKvSet(inftId: string, key: InftKvKey, value: Record<string, unknown>): Promise<InftKvResult> {
  const bridge = icloneAcpBridge()

  return bridge ? bridge.kvSet(inftId, key, value).catch(error => ({ ok: false, error: String(error) })) : NO_BRIDGE
}

export async function inftKvDelete(inftId: string, key: InftKvKey): Promise<InftKvResult> {
  const bridge = icloneAcpBridge()

  return bridge ? bridge.kvDelete(inftId, key).catch(error => ({ ok: false, error: String(error) })) : NO_BRIDGE
}

/** Forget one iNFT's local agent setup (main keeps the keychain) and drop it from the map. */
export async function detachInftAcp(inftId: string): Promise<InftDetachResult> {
  const bridge = icloneAcpBridge()

  if (!bridge) {
    return { ok: false, error: 'ACP bridge unavailable in this build.', removed: [], kept: [] }
  }

  const result = await bridge.detach(inftId)

  if (result.ok) {
    const { [slugForInft(inftId)]: _gone, ...rest } = $acpConfigMap.get()

    $acpConfigMap.set(rest)
  }

  return result
}

/** Cached statuses from disk — instant badges at boot, no CLI spawns. */
export async function refreshAcpConfigMap(): Promise<void> {
  const bridge = icloneAcpBridge()

  if (!bridge) {
    return
  }

  try {
    $acpConfigMap.set(await bridge.configMap())
  } catch {
    // Badges keep their previous state.
  }
}

/** Tell the main process which iNFT is on the stage (the agent's `acp`
 *  without `--inft` follows it). Fire-and-forget. */
export function publishStage(inftId: string | null): void {
  noteAskStage(inftId)
  void icloneAcpBridge()
    ?.setStage(inftId ? slugForInft(inftId) : null)
    .catch(() => undefined)
}

function icloneSkillsBridge() {
  return typeof window === 'undefined' ? undefined : window.hermesDesktop?.icloneSkills
}

/** Re-teach the agent now: copy the app's bundled skills into every skills
 *  tree. Runs on every launch by itself; this is the button. */
export async function syncAgentSkills(): Promise<SkillSyncReport | null> {
  const bridge = icloneSkillsBridge()

  if (!bridge) {
    return null
  }

  try {
    return await bridge.sync()
  } catch {
    return null
  }
}

export async function lastSkillSync(): Promise<SkillSyncReport | null> {
  const bridge = icloneSkillsBridge()

  if (!bridge) {
    return null
  }

  try {
    return await bridge.last()
  } catch {
    return null
  }
}
