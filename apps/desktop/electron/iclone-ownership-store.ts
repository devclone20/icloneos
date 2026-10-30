/**
 * iCLONE OS — `<userData>/inft/<slug>/ownership.json`, the one record of an
 * iNFT's ownership on this machine (R9 §7, §12). Atomic write (tmp + rename,
 * 0600), schema-validated read. A record that fails validation is moved
 * aside as `ownership.json.corrupt-<ts>` and read as ABSENT: a corrupted file
 * can only make the guard start over from "unknown" — it can never carry a
 * loss, a clock or a deactivation that was not proven.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

import { isFiniteNumber, isRecord } from '../src/iclone-shared/guards'

import { isSafeSlug } from './iclone-acp-store'
import type { TransferProof, Verification } from './iclone-ownership-proof'
import { writeFileAtomicSync } from './lib/atomic-write'

type OwnershipState = 'held' | 'unknown' | 'lost'
export type OwnerChoice = 'delete' | 'archive-local' | 'archive-github' | 'keep' | 'later'

export interface DeactivationStep {
  step: 'onchain' | 'virtuals' | 'prompt'
  ok: boolean
  detail: string
  /** virtuals: the agent's name just before the door renamed it. */
  agentName?: string
}

/** A closed loss cycle: the token came back, so a new loss starts from zero. */
export interface OwnershipCycle {
  provenAt: number | null
  returnedAt: number
  transfer: TransferProof | null
  deactivation: OwnershipRecord['deactivation']
  promptHeaderAt: number | null
  personaRemovedAt: number | null
  choice: OwnershipRecord['choice']
}

export interface OwnershipRecord {
  schema: 1
  slug: string
  inft: {
    id: string
    chain: string
    chainId: number
    contract: string
    tokenId: string
    name: string
    image: string | null
  }
  /** The owner's wallet — every verification is against THIS address. */
  wallet: string
  state: OwnershipState
  checkedAt: number | null
  /** The last check could not confirm (network, indexer, partial). */
  pending: boolean
  failures: number
  nextCheckAt: number
  lastHeldBlock: number | null
  lastHeldAt: number | null
  /** The 7-day clock — set once, at the proof. */
  provenAt: number | null
  /** Chain head time (s) at the proof: the clock is also checked on-chain. */
  provenChainTime: number | null
  deadlineAt: number | null
  verifications: (Verification & { at: number })[]
  transfer: TransferProof | null
  agentStatus: number | null
  /** The renderer wrote the persona's deactivation header (the prompt step's proof). */
  promptHeaderAt?: number | null
  /** The owner's choice deletes the persona: no prompt is left to carry the header. */
  personaRemovedAt?: number | null
  choice: { kind: OwnerChoice; at: number; archive: string | null; deletePending?: boolean } | null
  presale: { at: number; archive: string | null; detachedAt?: number | null } | null
  /** The agent's Virtuals name before the first door rename — offered back on return (§3.3). */
  originalAgentName?: string | null
  /** Past cycles, oldest first (bounded). */
  cycles?: OwnershipCycle[]
  /** Per-step state: a failed step is retried on the hourly tick; complete only when every step is ok. */
  deactivation: {
    appliedAt: number
    by: 'owner' | 'timer'
    steps: DeactivationStep[]
    complete?: boolean
    attempts?: number
    firstAt?: number
  } | null
  history: { at: number; state: OwnershipState; note: string }[]
}

const FILE = 'ownership.json'
/** A second copy outside `inft/<slug>`: R6's Detach removes that whole dir,
 *  and the signal must survive it. Read when the primary is missing or corrupt. */
const MIRROR_DIR = 'inft-ownership'

export function mirrorFile(root: string, slug: string): string {
  return path.join(root, MIRROR_DIR, `${slug}.json`)
}

const STATES = new Set(['held', 'unknown', 'lost'])
const CHOICES = new Set(['delete', 'archive-local', 'archive-github', 'keep', 'later'])
const ADDR = /^0x[0-9a-f]{40}$/
const TX = /^0x[0-9a-f]{64}$/

const numOrNull = (v: unknown) => v === null || isFiniteNumber(v)

export function ownershipFile(root: string, slug: string): string {
  return path.join(root, 'inft', slug, FILE)
}

function validTransfer(v: unknown): boolean {
  return (
    v === null ||
    (isRecord(v) &&
      typeof v.txHash === 'string' &&
      TX.test(v.txHash) &&
      isFiniteNumber(v.block) &&
      typeof v.from === 'string' &&
      ADDR.test(v.from) &&
      typeof v.to === 'string' &&
      ADDR.test(v.to) &&
      isFiniteNumber(v.timestamp) &&
      typeof v.explorerUrl === 'string')
  )
}

/** Structural AND semantic validation: a `lost` record must carry its proof. */
export function validateRecord(v: unknown, slug: string): OwnershipRecord | null {
  if (!isRecord(v) || v.schema !== 1 || v.slug !== slug || !isRecord(v.inft)) {
    return null
  }

  const i = v.inft

  if (
    typeof i.id !== 'string' ||
    typeof i.chain !== 'string' ||
    !isFiniteNumber(i.chainId) ||
    typeof i.contract !== 'string' ||
    !ADDR.test(i.contract) ||
    typeof i.tokenId !== 'string' ||
    typeof i.name !== 'string' ||
    !(i.image === null || typeof i.image === 'string') ||
    typeof v.wallet !== 'string' ||
    !ADDR.test(v.wallet) ||
    !STATES.has(v.state as string) ||
    !numOrNull(v.checkedAt) ||
    typeof v.pending !== 'boolean' ||
    !isFiniteNumber(v.failures) ||
    !isFiniteNumber(v.nextCheckAt) ||
    !numOrNull(v.lastHeldBlock) ||
    !numOrNull(v.lastHeldAt) ||
    !numOrNull(v.provenAt) ||
    !numOrNull(v.provenChainTime) ||
    !numOrNull(v.deadlineAt) ||
    !Array.isArray(v.verifications) ||
    !validTransfer(v.transfer) ||
    !numOrNull(v.agentStatus) ||
    !Array.isArray(v.history)
  ) {
    return null
  }

  if (
    v.choice !== null &&
    !(isRecord(v.choice) && CHOICES.has(v.choice.kind as string) && isFiniteNumber(v.choice.at))
  ) {
    return null
  }

  if (v.presale !== null && !(isRecord(v.presale) && isFiniteNumber(v.presale.at))) {
    return null
  }

  if (
    !(v.originalAgentName === undefined || v.originalAgentName === null || typeof v.originalAgentName === 'string') ||
    !(v.cycles === undefined || Array.isArray(v.cycles))
  ) {
    return null
  }

  if (
    v.deactivation !== null &&
    !(
      isRecord(v.deactivation) &&
      isFiniteNumber(v.deactivation.appliedAt) &&
      Array.isArray(v.deactivation.steps) &&
      (v.deactivation.complete === undefined || typeof v.deactivation.complete === 'boolean')
    )
  ) {
    return null
  }

  // A loss without its proof, its clock or its chain anchor is not a loss.
  if (
    v.state === 'lost' &&
    (v.transfer === null ||
      !isFiniteNumber(v.provenAt) ||
      !isFiniteNumber(v.provenChainTime) ||
      !isFiniteNumber(v.deadlineAt))
  ) {
    return null
  }

  if (v.deadlineAt !== null && isFiniteNumber(v.provenAt) && (v.deadlineAt as number) < (v.provenAt as number)) {
    return null
  }

  return v as unknown as OwnershipRecord
}

function parseRecord(file: string, slug: string, now: number): { record: OwnershipRecord | null; missing: boolean } {
  let text: string

  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return { record: null, missing: true }
  }

  let parsed: unknown = null

  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = null
  }

  const record = validateRecord(parsed, slug)

  if (!record) {
    // Self-heal: keep the bytes for a human, start over from a fresh proof.
    try {
      fs.renameSync(file, `${file}.corrupt-${now}`)
    } catch {
      // unreadable twice is still absent
    }
  }

  return { record, missing: false }
}

export function readRecord(root: string, slug: string, now = Date.now()): OwnershipRecord | null {
  if (!isSafeSlug(slug)) {
    return null
  }

  const primary = parseRecord(ownershipFile(root, slug), slug, now).record

  if (primary) {
    return primary
  }

  // Missing OR corrupt primary: fail closed on the mirror, so a lost iNFT stays
  // refused on the very first gate call after the primary went bad.
  const mirror = parseRecord(mirrorFile(root, slug), slug, now).record

  if (mirror) {
    writeRecord(root, mirror)
  }

  return mirror
}

export function writeAtomic(file: string, text: string): boolean {
  try {
    writeFileAtomicSync(file, text, { mode: 0o600 })

    return true
  } catch {
    return false
  }
}

export function writeRecord(root: string, record: OwnershipRecord): boolean {
  if (!isSafeSlug(record.slug) || !validateRecord(record, record.slug)) {
    return false
  }

  const text = `${JSON.stringify(record, null, 2)}\n`
  const ok = writeAtomic(ownershipFile(root, record.slug), text)
  writeAtomic(mirrorFile(root, record.slug), text)

  return ok
}

/** Every slug with an ownership record on this machine (primary or mirror). */
export function listRecordSlugs(root: string): string[] {
  const slugs = new Set<string>()

  try {
    for (const d of fs.readdirSync(path.join(root, 'inft'), { withFileTypes: true })) {
      if (d.isDirectory() && isSafeSlug(d.name) && fs.existsSync(path.join(root, 'inft', d.name, FILE))) {
        slugs.add(d.name)
      }
    }
  } catch {
    // no primary records
  }

  try {
    for (const name of fs.readdirSync(path.join(root, MIRROR_DIR))) {
      const slug = name.endsWith('.json') ? name.slice(0, -5) : ''

      if (isSafeSlug(slug)) {
        slugs.add(slug)
      }
    }
  } catch {
    // no mirror
  }

  return [...slugs].sort()
}
