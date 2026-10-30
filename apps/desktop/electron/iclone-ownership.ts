/**
 * iCLONE OS — the ownership guard (front R9): held / unknown / lost per iNFT,
 * the 7-day automatic deactivation, the owner's choices, Prepare to sell.
 *
 * Laws (R9 §8, §12):
 *  - `lost` only from a proof where indexer + ownerOf + Transfer logs agree
 *    (iclone-ownership-proof.ts); an empty, partial or failed scan is never one.
 *  - The 7-day clock starts at the proof and survives restarts
 *    (ownership.json). It fires only when BOTH the wall clock and the chain's
 *    own head time are 7 days past the proof, and only after a fresh proof
 *    still says `lost` — a clock set forward or a corrupted file cannot fire it.
 *  - Every write to the world (on-chain agentStatus, Virtuals rename, prompt)
 *    goes through ONE door, `applyDeactivation`, injected so tests use a fake.
 *  - Data is deleted only by the owner's explicit choice; never the keychain.
 */
import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import os from 'node:os'
import * as path from 'node:path'

import { app, type BrowserWindow, ipcMain } from 'electron'

import { profileSlugFor, slugForInft } from '../src/iclone-shared/inft-slug'
import { redactSecrets as redactShared } from '../src/iclone-shared/redact'

import { isSafeSlug } from './iclone-acp-store'
import { deactivatedAgentName, doorRenameArgv, setOwnershipGateRoot } from './iclone-ownership-gate'
import { type FetchLike, type ProofResult, verifyOwnership } from './iclone-ownership-proof'
import {
  type ContractRegistry,
  createRegistrySource,
  findEntry,
  type RegistryEntry,
  type RegistrySource
} from './iclone-ownership-registry'
import {
  type DeactivationStep,
  listRecordSlugs,
  type OwnerChoice,
  type OwnershipCycle,
  type OwnershipRecord,
  readRecord,
  writeAtomic,
  writeRecord
} from './iclone-ownership-store'

export {
  deactivatedAgentDescription,
  deactivatedAgentName,
  doorRenameArgv,
  economyRefusal,
  isInftDeactivated
} from './iclone-ownership-gate'

export const DAY_MS = 24 * 60 * 60 * 1000
const DEACTIVATION_DELAY_MS = 7 * DAY_MS
const HELD_RECHECK_MS = 60 * 60 * 1000
const UNKNOWN_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000]
const SUPPORT_URL = 'https://cloneframe.io/#support-form'
const HISTORY_MAX = 40
const CYCLES_MAX = 10

interface OwnershipItem {
  id: string
  chain: string
  contract: string
  tokenId: string
  name: string
  image: string | null
  configured: boolean
}

interface OwnershipView {
  slug: string
  inftId: string
  tokenId: string
  chain: string
  contract: string
  name: string
  image: string | null
  profileSlug: string
  state: OwnershipRecord['state']
  pending: boolean
  checkedAt: number | null
  provenAt: number | null
  deadlineAt: number | null
  /** Whole days until the automatic deactivation; null when no clock runs. */
  daysLeft: number | null
  deactivated: boolean
  /** Every deactivation step is ok — only then is it "everywhere". */
  deactivationComplete: boolean
  /** Steps still pending or failed (retried on the hourly tick). */
  pendingSteps: DeactivationStep['step'][]
  transfer: OwnershipRecord['transfer']
  verifications: OwnershipRecord['verifications']
  choice: OwnershipRecord['choice']
  presale: OwnershipRecord['presale']
  deactivation: OwnershipRecord['deactivation']
  history: OwnershipRecord['history']
  /** The agent's Virtuals name before the door renamed it (null = never renamed or unknown). */
  originalAgentName: string | null
  /** Loss cycles closed by a return of the token. */
  pastCycles: number
  supportUrl: string
}

function toView(r: OwnershipRecord, now: number): OwnershipView {
  const daysLeft =
    r.state === 'lost' && r.deadlineAt !== null && !r.deactivation
      ? Math.max(0, Math.ceil((r.deadlineAt - now) / DAY_MS))
      : null

  return {
    slug: r.slug,
    inftId: r.inft.id,
    tokenId: r.inft.tokenId,
    chain: r.inft.chain,
    contract: r.inft.contract,
    name: r.inft.name,
    image: r.inft.image,
    profileSlug: profileSlugFor(r.inft.contract, r.inft.tokenId),
    state: r.state,
    pending: r.pending,
    checkedAt: r.checkedAt,
    provenAt: r.provenAt,
    deadlineAt: r.deadlineAt,
    daysLeft,
    deactivated: r.state === 'lost',
    deactivationComplete: isComplete(r.deactivation),
    pendingSteps: pendingSteps(r.deactivation),
    transfer: r.transfer,
    verifications: r.verifications,
    choice: r.choice,
    presale: r.presale,
    deactivation: r.deactivation,
    history: r.history.slice(-20),
    originalAgentName: r.originalAgentName ?? null,
    pastCycles: r.cycles?.length ?? 0,
    supportUrl: SUPPORT_URL
  }
}

const DEACTIVATION_STEPS: DeactivationStep['step'][] = ['onchain', 'virtuals', 'prompt']
/** Hourly retries of a failed step before an owner-chosen deletion stops waiting for it. */
export const DELETE_WAIT_ATTEMPTS = 24

function isComplete(d: OwnershipRecord['deactivation']): boolean {
  if (!d) {
    return false
  }

  return d.complete ?? DEACTIVATION_STEPS.every(name => d.steps.some(s => s.step === name && s.ok))
}

function pendingSteps(d: OwnershipRecord['deactivation']): DeactivationStep['step'][] {
  if (!d) {
    return []
  }

  return DEACTIVATION_STEPS.filter(name => !d.steps.some(s => s.step === name && s.ok))
}

export interface DeactivationDoor {
  /** The ONLY path to the world's writes. Never run by tests or the lab.
   *  Runs only the steps in `todo`; steps already ok are never repeated. */
  applyDeactivation: (
    slug: string,
    record: OwnershipRecord,
    entry: RegistryEntry | null,
    todo: DeactivationStep['step'][]
  ) => Promise<DeactivationStep[]>
}

interface ArchiveResult {
  ok: boolean
  dir: string | null
  remote: string | null
  error?: string
}

export interface Archiver {
  archive: (record: OwnershipRecord, github: boolean) => Promise<ArchiveResult>
  ghStatus: () => Promise<{ ok: boolean; detail: string }>
}

interface OwnershipDeps {
  root: string
  now: () => number
  registry: () => Promise<ContractRegistry>
  verify: (entry: RegistryEntry, tokenId: string, wallet: string, sinceBlock: number | null) => Promise<ProofResult>
  door: DeactivationDoor
  archiver: Archiver
  emit?: (view: OwnershipView) => void
}

const ADDR = /^0x[0-9a-f]{40}$/

function newRecord(slug: string, item: OwnershipItem, chainId: number, wallet: string, now: number): OwnershipRecord {
  return {
    schema: 1,
    slug,
    inft: {
      id: item.id,
      chain: item.chain,
      chainId,
      contract: item.contract.toLowerCase(),
      tokenId: item.tokenId,
      name: item.name,
      image: item.image
    },
    wallet,
    state: 'unknown',
    checkedAt: null,
    pending: true,
    failures: 0,
    nextCheckAt: now,
    lastHeldBlock: null,
    lastHeldAt: null,
    provenAt: null,
    provenChainTime: null,
    deadlineAt: null,
    verifications: [],
    transfer: null,
    agentStatus: null,
    choice: null,
    presale: null,
    deactivation: null,
    history: [{ at: now, state: 'unknown', note: 'tracking started' }]
  }
}

/** The token came back: the loss cycle closes into `cycles`, so a later loss
 *  starts a fresh 7-day clock, runs the door again with its own tx and asks
 *  the owner again. Closing it also cancels an owner's deletion still waiting. */
function closeCycle(r: OwnershipRecord, now: number): void {
  const cycle: OwnershipCycle = {
    provenAt: r.provenAt,
    returnedAt: now,
    transfer: r.transfer,
    deactivation: r.deactivation,
    promptHeaderAt: r.promptHeaderAt ?? null,
    personaRemovedAt: r.personaRemovedAt ?? null,
    choice: r.choice
  }

  r.cycles = [...(r.cycles ?? []), cycle].slice(-CYCLES_MAX)
  r.provenAt = null
  r.provenChainTime = null
  r.deadlineAt = null
  r.transfer = null
  r.deactivation = null
  r.promptHeaderAt = null
  r.personaRemovedAt = null
  r.choice = null

  const renamed = cycle.deactivation?.steps.some(s => s.step === 'virtuals' && s.ok)
  const name = r.originalAgentName

  note(
    r,
    now,
    `token returned to the wallet — loss cycle closed${
      renamed && name ? `; the Virtuals name before the rename was "${name}"` : ''
    }`
  )
}

function note(r: OwnershipRecord, at: number, text: string): void {
  r.history.push({ at, state: r.state, note: text })

  if (r.history.length > HISTORY_MAX) {
    r.history.splice(0, r.history.length - HISTORY_MAX)
  }
}

/** Removes everything this app keeps for the iNFT EXCEPT its ownership record
 *  (the signal must survive the owner's own deletion). Never the keychain. */
export function deleteLocalInftData(root: string, slug: string): string[] {
  const dir = path.join(root, 'inft', slug)
  const removed: string[] = []

  if (!isSafeSlug(slug)) {
    return removed
  }

  try {
    for (const name of fs.readdirSync(dir)) {
      if (name === 'ownership.json' || name.startsWith('ownership.json.corrupt-')) {
        continue
      }

      fs.rmSync(path.join(dir, name), { recursive: true, force: true })
      removed.push(name)
    }
  } catch {
    // nothing kept for it
  }

  return removed
}

const DELETING = new Set<OwnerChoice>(['delete', 'archive-local', 'archive-github'])

/** The door's result folded over a cycle's earlier steps: steps outside `todo` keep their state. */
function mergeDeactivation(
  prev: OwnershipRecord['deactivation'],
  ran: DeactivationStep[],
  todo: DeactivationStep['step'][],
  by: 'owner' | 'timer',
  at: number
): NonNullable<OwnershipRecord['deactivation']> {
  const kept = (prev?.steps ?? []).filter(s => !todo.includes(s.step))

  const steps = DEACTIVATION_STEPS.map(
    name =>
      ran.find(s => s.step === name) ?? kept.find(s => s.step === name) ?? { step: name, ok: false, detail: 'not run' }
  )

  return {
    appliedAt: at,
    by: prev?.by ?? by,
    steps,
    complete: steps.every(s => s.ok),
    attempts: (prev?.attempts ?? 0) + 1,
    firstAt: prev?.firstAt ?? prev?.appliedAt ?? at
  }
}

function applyProof(r: OwnershipRecord, proof: ProofResult, now: number): void {
  r.checkedAt = now
  r.verifications = proof.verifications.map(v => ({ ...v, at: now }))
  r.agentStatus = proof.agentStatus

  if (proof.verdict === 'held') {
    if (r.state === 'lost') {
      closeCycle(r, now)
    }

    if (r.state !== 'held') {
      r.state = 'held'
      note(r, now, `held (${proof.reason})`)
    }

    r.pending = false
    r.failures = 0
    r.lastHeldBlock = proof.head?.number ?? r.lastHeldBlock
    r.lastHeldAt = now
    r.nextCheckAt = now + HELD_RECHECK_MS
  } else if (proof.verdict === 'lost' && proof.transfer && proof.head) {
    if (r.state !== 'lost') {
      r.state = 'lost'
      r.provenAt = now
      r.provenChainTime = proof.head.timestamp
      r.deadlineAt = now + DEACTIVATION_DELAY_MS
      r.transfer = proof.transfer
      // A new loss cycle owns nothing from an earlier one.
      r.deactivation = null
      r.choice = null
      r.promptHeaderAt = null
      r.personaRemovedAt = null
      note(r, now, `lost — transfer ${proof.transfer.txHash} at block ${proof.transfer.block}`)
    }

    r.pending = false
    r.failures = 0
    r.nextCheckAt = now + HELD_RECHECK_MS
  } else {
    // unknown changes nothing but the retry schedule.
    r.pending = true
    backoffRecord(r, now)
  }
}

function backoffRecord(r: OwnershipRecord, now: number): void {
  r.nextCheckAt = now + UNKNOWN_BACKOFF_MS[Math.min(r.failures, UNKNOWN_BACKOFF_MS.length - 1)]
  r.failures += 1
}

export function createOwnershipService(deps: OwnershipDeps) {
  /** Per slug, every read-modify-write of the record runs one after the other. */
  const tails = new Map<string, Promise<unknown>>()
  const checks = new Map<string, Promise<OwnershipView | null>>()
  const doors = new Map<string, { provenAt: number | null; p: Promise<boolean> }>()

  function serial<T>(slug: string, fn: () => Promise<T>): Promise<T> {
    const run = (tails.get(slug) ?? Promise.resolve()).then(fn, fn)

    const tail = run.then(
      () => undefined,
      () => undefined
    )

    tails.set(slug, tail)
    void tail.then(() => {
      if (tails.get(slug) === tail) {
        tails.delete(slug)
      }
    })

    return run
  }

  const save = (r: OwnershipRecord) => {
    writeRecord(deps.root, r)
    deps.emit?.(toView(r, deps.now()))
  }

  /** Re-read, change, write — synchronously, so only a caller already inside the slug's queue may use it.
   *  Writes (and emits) only when `fn` changed the record. */
  function commit<T>(
    slug: string,
    fn: (r: OwnershipRecord, at: number) => T,
    opts: { create?: () => OwnershipRecord | null; quiet?: boolean } = {}
  ): { r: OwnershipRecord; value: T } | null {
    const at = deps.now()
    const read = readRecord(deps.root, slug, at)
    const r = read ?? opts.create?.() ?? null

    if (!r) {
      return null
    }

    const before = read ? JSON.stringify(read) : ''
    const value = fn(r, at)

    if (JSON.stringify(r) !== before) {
      if (opts.quiet) {
        writeRecord(deps.root, r)
      } else {
        save(r)
      }
    }

    return { r, value }
  }

  /** The one door for every ownership.json writer: inside the slug's queue, read → change → write.
   *  No caller keeps a record across an await and writes it afterwards. */
  function mutate<T>(
    slug: string,
    fn: (r: OwnershipRecord, at: number) => T,
    opts?: { create?: () => OwnershipRecord | null; quiet?: boolean }
  ): Promise<{ r: OwnershipRecord; value: T } | null> {
    return serial(slug, async () => commit(slug, fn, opts))
  }

  const entryFor = async (r: OwnershipRecord) => findEntry(await deps.registry(), r.inft.chain, r.inft.contract)

  /** Runs inside the slug's queue (check): the proof is applied to a copy read after the verify await. */
  async function runCheck(slug: string): Promise<OwnershipView | null> {
    const r = readRecord(deps.root, slug, deps.now())

    if (!r) {
      return null
    }

    const entry = await entryFor(r)

    if (!entry) {
      const res = commit(slug, (cur, at) => {
        cur.pending = true
        cur.checkedAt = at
        backoffRecord(cur, at)
      })

      return res ? toView(res.r, deps.now()) : null
    }

    const proof = await deps.verify(entry, r.inft.tokenId, r.wallet, r.lastHeldBlock)
    const res = commit(slug, (cur, now) => applyProof(cur, proof, now))

    return res ? toView(res.r, deps.now()) : null
  }

  function check(slug: string): Promise<OwnershipView | null> {
    const pending = checks.get(slug)

    if (pending) {
      return pending
    }

    const p = serial(slug, () => runCheck(slug)).finally(() => checks.delete(slug))
    checks.set(slug, p)

    return p
  }

  /** After every wallet scan: track configured iNFTs, re-check what is due,
   *  and re-check AT ONCE any tracked token the scan no longer shows. */
  async function observe(wallet: string, items: OwnershipItem[]): Promise<OwnershipView[]> {
    const w = wallet.toLowerCase()

    if (!ADDR.test(w)) {
      return []
    }

    const now = deps.now()
    const registry = await deps.registry()
    const seen = new Set<string>()
    const due: string[] = []

    await Promise.all(
      items.map(async item => {
        const slug = slugForInft(item.id)
        const entry = findEntry(registry, item.chain, item.contract)
        seen.add(slug)

        const res = await mutate(
          slug,
          cur => {
            if (item.image && cur.inft.image !== item.image) {
              cur.inft.image = item.image
            }
          },
          {
            quiet: true,
            create: () => (item.configured && entry ? newRecord(slug, item, entry.chainId, w, now) : null)
          }
        )

        if (res && res.r.nextCheckAt <= now) {
          due.push(slug)
        }
      })
    )

    for (const slug of listRecordSlugs(deps.root)) {
      if (seen.has(slug)) {
        continue
      }

      const r = readRecord(deps.root, slug, now)

      // Absent from the owner's own scan: the dedicated deep re-check.
      if (r && r.wallet === w && (r.state === 'held' || r.nextCheckAt <= now)) {
        due.push(slug)
      }
    }

    await Promise.all(due.map(slug => check(slug)))
    await tick()

    return list()
  }

  function list(): OwnershipView[] {
    const now = deps.now()

    return listRecordSlugs(deps.root)
      .map(slug => readRecord(deps.root, slug, now))
      .filter((r): r is OwnershipRecord => r !== null)
      .map(r => toView(r, now))
  }

  /** Runs the door of the loss cycle `provenAt` for every step not yet ok and records each step's state.
   *  A caller of the running door's cycle joins it; a caller of another cycle gets its own door after it.
   *  Returns true when this call completed the deactivation. */
  function deactivate(slug: string, by: 'owner' | 'timer', provenAt: number | null): Promise<boolean> {
    const running = doors.get(slug)

    if (running && running.provenAt === provenAt) {
      return running.p
    }

    const start = () => runDeactivate(slug, by, provenAt)

    const p: Promise<boolean> = (running ? running.p.then(start, start) : start()).finally(() => {
      if (doors.get(slug)?.p === p) {
        doors.delete(slug)
      }
    })

    doors.set(slug, { provenAt, p })

    return p
  }

  async function runDeactivate(slug: string, by: 'owner' | 'timer', provenAt: number | null): Promise<boolean> {
    // Read behind any check in flight: the door never starts for a cycle that check is closing.
    const r = await serial(slug, async () => readRecord(deps.root, slug, deps.now()))

    if (!r || r.state !== 'lost' || r.provenAt !== provenAt || isComplete(r.deactivation)) {
      return false
    }

    const todo = r.deactivation ? pendingSteps(r.deactivation) : DEACTIVATION_STEPS
    let ran: DeactivationStep[]

    // The door (two cold CLI starts live) runs outside the queue: a check may see the token come back meanwhile.
    try {
      ran = await deps.door.applyDeactivation(slug, r, await entryFor(r), todo)
    } catch (e) {
      ran = todo.map(step => ({ step, ok: false, detail: e instanceof Error ? e.message : 'door failed' }))
    }

    const res = await mutate(slug, (fresh, at) => {
      const agentName = ran.find(s => s.step === 'virtuals')?.agentName
      const summary = ran.map(s => `${s.step}=${s.ok ? 'ok' : 'failed'}`).join(' ')

      if (agentName && !fresh.originalAgentName) {
        fresh.originalAgentName = agentName
      }

      if (fresh.state !== 'lost' || fresh.provenAt !== r.provenAt) {
        // The loss cycle this door ran for is closed: its steps belong to that cycle, never to the live record.
        const cycle = [...(fresh.cycles ?? [])].reverse().find(c => c.provenAt === r.provenAt)

        if (cycle) {
          cycle.deactivation = mergeDeactivation(cycle.deactivation, ran, todo, by, at)
        }

        note(fresh, at, `door finished after the return (${by}): ${summary} — kept on the closed loss cycle`)

        return false
      }

      fresh.deactivation = mergeDeactivation(fresh.deactivation, ran, todo, by, at)

      const complete = fresh.deactivation.complete === true

      note(fresh, at, `deactivation ${complete ? 'complete' : 'partial'} (${by}): ${summary}`)
      finishDeletion(fresh, at)

      return complete
    })

    return res?.value === true
  }

  /** An owner-chosen deletion runs after the door (the CLI config is needed
   *  for the Virtuals rename) — once complete, or after a day of retries. */
  function finishDeletion(r: OwnershipRecord, at: number): void {
    if (!r.choice?.deletePending) {
      return
    }

    if (!isComplete(r.deactivation) && (r.deactivation?.attempts ?? 0) < DELETE_WAIT_ATTEMPTS) {
      return
    }

    const removed = deleteLocalInftData(deps.root, r.slug)
    r.choice = { ...r.choice, deletePending: false }
    note(r, at, `owner's deletion done (${removed.length} item${removed.length === 1 ? '' : 's'})`)
  }

  /** Retries the failed steps of a started deactivation on a fresh `lost` proof. */
  async function retry(r: OwnershipRecord): Promise<boolean> {
    const entry = await entryFor(r)

    if (!entry) {
      return false
    }

    const proof = await deps.verify(entry, r.inft.tokenId, r.wallet, r.lastHeldBlock)

    if (proof.verdict !== 'lost') {
      if (proof.verdict === 'held') {
        await check(r.slug)
      }

      return false
    }

    return deactivate(r.slug, r.deactivation?.by ?? 'timer', r.provenAt)
  }

  /** The 7-day clock. Wall clock AND chain time AND a fresh proof must agree. */
  async function tick(): Promise<string[]> {
    const fired: string[] = []
    const now = deps.now()

    for (const slug of listRecordSlugs(deps.root)) {
      const r = readRecord(deps.root, slug, now)

      if (r?.state === 'lost' && r.deactivation && !isComplete(r.deactivation)) {
        if (await retry(r)) {
          fired.push(slug)
        }

        continue
      }

      if (
        !r ||
        r.state !== 'lost' ||
        r.deactivation ||
        r.deadlineAt === null ||
        r.provenChainTime === null ||
        now < r.deadlineAt
      ) {
        continue
      }

      const entry = await entryFor(r)

      if (!entry) {
        continue
      }

      const proof = await deps.verify(entry, r.inft.tokenId, r.wallet, r.lastHeldBlock)

      if (proof.verdict === 'held') {
        await check(slug)

        continue
      }

      const chainNow = proof.head?.timestamp ?? null

      if (
        proof.verdict !== 'lost' ||
        chainNow === null ||
        chainNow * 1000 < r.provenChainTime * 1000 + DEACTIVATION_DELAY_MS
      ) {
        const reason = proof.verdict !== 'lost' ? proof.reason : 'chain time not yet 7 days past the proof'

        await mutate(
          slug,
          cur => {
            if (cur.state === 'lost' && cur.provenAt === r.provenAt) {
              note(cur, now, `automatic deactivation deferred (${reason})`)
            }
          },
          { quiet: true }
        )

        continue
      }

      if (await deactivate(slug, 'timer', r.provenAt)) {
        fired.push(slug)
      }
    }

    return fired
  }

  async function choose(
    slug: string,
    choice: OwnerChoice,
    confirm: string
  ): Promise<{ ok: boolean; error?: string; view?: OwnershipView; deleteHermesProfile?: boolean; note?: string }> {
    const r = readRecord(deps.root, slug, deps.now())

    if (!r || r.state !== 'lost') {
      return { ok: false, error: 'This iNFT is not proven transferred.' }
    }

    const deleting = DELETING.has(choice)

    if (deleting && confirm.trim() !== `#${r.inft.tokenId}`) {
      return { ok: false, error: `Type #${r.inft.tokenId} to confirm.` }
    }

    const cycle = r.provenAt
    let archive: string | null = null

    if (choice === 'archive-local' || choice === 'archive-github') {
      const res = await deps.archiver.archive(r, choice === 'archive-github')

      if (!res.ok) {
        return { ok: false, error: res.error ?? 'The copy could not be made — nothing was deleted.' }
      }

      archive = res.remote ?? res.dir
    }

    const chosen = await mutate(slug, (cur, at) => {
      if (cur.state !== 'lost' || cur.provenAt !== cycle) {
        return false
      }

      cur.choice = { kind: choice, at, archive, deletePending: deleting }
      note(cur, at, `owner chose ${choice}${archive ? ` (copy: ${archive})` : ''}`)

      return true
    })

    if (!chosen?.value) {
      return { ok: false, error: 'This iNFT came back to the wallet — nothing was changed.' }
    }

    // The owner answered: the deactivation needs no 7-day wait. "Later" is not an answer.
    // The door runs BEFORE any deletion: the Virtuals rename needs the CLI config.
    if (choice !== 'later') {
      await deactivate(slug, 'owner', cycle)
    }

    // Only a loss cycle still open after the door may delete anything: a return cancelled the owner's deletion,
    // and a later answer for the same cycle (e.g. Keep while this Delete's door ran) replaces this one.
    const done = await mutate(slug, (cur, at): 'returned' | 'replaced' | 'kept' | 'delete' => {
      const open = cur.state === 'lost' && cur.provenAt === cycle

      if (!open) {
        if (deleting) {
          note(cur, at, `owner's ${choice} not applied: the iNFT came back to the wallet during the deactivation`)
        }

        return 'returned'
      }

      if (cur.choice?.deletePending) {
        finishDeletion(cur, at)
      }

      const recorded = cur.choice?.kind

      if (!deleting) {
        return 'kept'
      }

      if (recorded && DELETING.has(recorded)) {
        // Only here is the persona deletion asked for (deleteHermesProfile): no prompt is left to carry
        // the header, so the prompt step is satisfied — decided after the door, never by a superseded answer.
        if (!cur.promptHeaderAt && !cur.personaRemovedAt) {
          cur.personaRemovedAt = at
        }

        settlePrompt(cur, at)
        finishDeletion(cur, at)

        return 'delete'
      }

      note(cur, at, `owner's ${choice} not applied: replaced by the later answer ${recorded ?? 'none'}`)

      return 'replaced'
    })

    const view = toView(done?.r ?? chosen.r, deps.now())
    const outcome = done?.value ?? 'returned'

    if (outcome === 'returned') {
      return {
        ok: true,
        view,
        deleteHermesProfile: false,
        note: 'This iNFT came back to the wallet during the deactivation — nothing was deleted.'
      }
    }

    if (outcome === 'replaced') {
      return {
        ok: true,
        view,
        deleteHermesProfile: false,
        note: `A later answer (${view.choice?.kind ?? 'none'}) replaced this one — the agent was not deleted.`
      }
    }

    return { ok: true, view, deleteHermesProfile: outcome === 'delete' }
  }

  async function prepareSell(
    slug: string,
    github: boolean
  ): Promise<{ ok: boolean; error?: string; view?: OwnershipView }> {
    const r = readRecord(deps.root, slug, deps.now())

    if (!r) {
      return { ok: false, error: 'This iNFT is not tracked yet — open it once while signed in.' }
    }

    if (r.state === 'lost') {
      return { ok: false, error: 'This iNFT has already left the wallet.' }
    }

    const res = await deps.archiver.archive(r, github)

    if (!res.ok) {
      return { ok: false, error: res.error ?? 'The copy could not be made.' }
    }

    const archive = res.remote ?? res.dir

    const done = await mutate(slug, (cur, at) => {
      cur.presale = { at, archive }
      note(cur, at, `prepared to sell (copy: ${archive})`)
    })

    return done ? { ok: true, view: toView(done.r, deps.now()) } : { ok: false, error: 'This iNFT is not tracked.' }
  }

  /** Prepare to sell, step 2: the renderer ran R6's Detach door after the copy. */
  async function presaleDetached(slug: string, removed: number): Promise<OwnershipView | null> {
    const res = await mutate(slug, (cur, at) => {
      if (!cur.presale) {
        return false
      }

      cur.presale = { ...cur.presale, detachedAt: at }
      note(cur, at, `prepare to sell: agent detached (${removed} local item${removed === 1 ? '' : 's'} removed)`)

      return true
    })

    return res?.value ? toView(res.r, deps.now()) : null
  }

  /** A renderer report settles the prompt step at once — no hourly wait — and
   *  lets an owner-chosen deletion that waited for it run. */
  function settlePrompt(r: OwnershipRecord, at: number): void {
    const d = r.deactivation
    const step = promptStep(r)

    if (!d || isComplete(d) || !step.ok) {
      return
    }

    const steps = DEACTIVATION_STEPS.map(name =>
      name === 'prompt' ? step : (d.steps.find(s => s.step === name) ?? { step: name, ok: false, detail: 'not run' })
    )

    const complete = steps.every(s => s.ok)

    r.deactivation = { ...d, steps, complete }

    if (complete) {
      note(r, at, 'deactivation complete (prompt step settled)')
    }

    finishDeletion(r, at)
  }

  /** The renderer wrote the deactivation header into this persona's prompt. */
  async function promptHeaderWritten(profileSlug: string): Promise<number> {
    const matches = (r: OwnershipRecord) =>
      r.state === 'lost' && profileSlugFor(r.inft.contract, r.inft.tokenId) === profileSlug && !r.promptHeaderAt

    const marks = await Promise.all(
      listRecordSlugs(deps.root)
        .filter(slug => {
          const r = readRecord(deps.root, slug, deps.now())

          return r !== null && matches(r)
        })
        .map(slug =>
          mutate(slug, (cur, at) => {
            if (!matches(cur)) {
              return false
            }

            cur.promptHeaderAt = at
            note(cur, at, 'persona prompt carries the deactivation header')
            settlePrompt(cur, at)

            return true
          })
        )
    )

    return marks.filter(m => m?.value).length
  }

  return { observe, check, list, tick, choose, prepareSell, presaleDetached, promptHeaderWritten }
}

// ─────────────────────────────────────────────────────────────────────────
// Production collaborators: the archive (git / the owner's gh) and the door.
// ─────────────────────────────────────────────────────────────────────────

export type CommandRunner = (
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs: number; env?: NodeJS.ProcessEnv }
) => Promise<{ code: number; stdout: string; stderr: string }>

/** Exit code a runner reports when the binary does not exist. */
export const NOT_FOUND = 127

const execRunner: CommandRunner = (cmd, args, opts) =>
  new Promise(resolve => {
    execFile(
      cmd,
      args,
      { cwd: opts.cwd, env: opts.env, timeout: opts.timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : error.code === 'ENOENT' ? NOT_FOUND : 1) : 0
        resolve({ code, stdout: String(stdout), stderr: String(stderr) })
      }
    )
  })

const SECRET_NAME = /(^\.env)|auth|credential|secret|keychain|token|\.pem$|\.key$|\.p12$|^id_/i
const TEXT_FILE = /\.(md|markdown|txt|json|jsonl|ya?ml|log|toml|csv|tsv|ini|cfg|conf|xml|html?|py|ts|js|sh)$/i
/** Databases are never copied raw: a key or a seed inside them cannot be redacted. */
const DATABASE_FILE = /\.(db|sqlite3?|db3|ldb|mdb|realm)$|-(wal|shm|journal)$/i
/** Binary files copied as they are: media only. Any other binary is left out. */
const MEDIA_FILE = /\.(png|jpe?g|gif|webp|avif|heic|mp3|m4a|wav|ogg|mp4|mov|webm|glb|gltf|pdf)$/i
const MAX_FILE_BYTES = 5 * 1024 * 1024
const MAX_FILES = 5000

/** The shared scrubber (secrets, card numbers, bare mnemonics) plus the raw
 *  key shapes an agent's own files carry (hex private keys, sk-/ghp_ tokens). */
/** Ownership logs also carry raw 32-byte hex keys and signatures. */
export const redactOwnershipLog = (text: string): string => redactShared(text, { hex64: true })

function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0)
}

interface CopyBudget {
  files: number
  skipped: string[]
}

function copyTree(src: string, dest: string, budget: CopyBudget, rel = ''): void {
  let entries: fs.Dirent[]

  try {
    entries = fs.readdirSync(src, { withFileTypes: true })
  } catch {
    return
  }

  fs.mkdirSync(dest, { recursive: true })

  for (const e of entries) {
    if (budget.files >= MAX_FILES || SECRET_NAME.test(e.name) || e.name === '.git' || e.name === 'node_modules') {
      continue
    }

    const from = path.join(src, e.name)
    const to = path.join(dest, e.name)
    const relName = rel ? `${rel}/${e.name}` : e.name

    if (e.isDirectory()) {
      if (e.name !== 'acp') {
        copyTree(from, to, budget, relName)
      }

      continue
    }

    if (!e.isFile()) {
      continue
    }

    try {
      if (fs.statSync(from).size > MAX_FILE_BYTES || DATABASE_FILE.test(e.name)) {
        budget.skipped.push(relName)

        continue
      }

      if (MEDIA_FILE.test(e.name)) {
        fs.copyFileSync(from, to)
      } else {
        const buf = fs.readFileSync(from)

        if (!TEXT_FILE.test(e.name) && looksBinary(buf)) {
          budget.skipped.push(relName)

          continue
        }

        fs.writeFileSync(to, redactOwnershipLog(buf.toString('utf8')))
      }

      budget.files += 1
    } catch {
      // an unreadable file is left out of the copy, never a crash
    }
  }
}

/** The owner's `gh`: GUI-launched apps on macOS get a minimal PATH, so the
 *  usual install dirs are searched too (as git-review-ops.ts does). */
export function resolveGh(
  envPath = process.env.PATH ?? '',
  exists: (file: string) => boolean = f => {
    try {
      fs.accessSync(f, fs.constants.X_OK)

      return true
    } catch {
      return false
    }
  }
): string | null {
  const dirs = ['/opt/homebrew/bin', '/usr/local/bin', ...envPath.split(path.delimiter), '/usr/bin'].filter(
    d => d && path.isAbsolute(d)
  )

  for (const dir of dirs) {
    const file = path.join(dir, 'gh')

    if (exists(file)) {
      return file
    }
  }

  return null
}

function ghEnv(ghBin: string): NodeJS.ProcessEnv {
  const extra = [path.dirname(ghBin), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']

  return { ...process.env, PATH: [...extra, process.env.PATH].filter(Boolean).join(path.delimiter) }
}

export const GH_NOT_INSTALLED =
  'GitHub CLI not installed — install it from https://cli.github.com, sign in with `gh auth login`, then try again.'

export function createArchiver(opts: {
  root: string
  home: string
  hermesHome: string
  run: CommandRunner
  now: () => number
  gh?: () => string | null
}): Archiver {
  const gitId = ['-c', 'user.name=iclone os archive', '-c', 'user.email=archive@iclone-os.invalid']
  const findGh = opts.gh ?? (() => resolveGh())

  const runGh = async (args: string[], cwd: string | undefined, timeoutMs: number) => {
    const bin = findGh()

    if (!bin) {
      return { code: NOT_FOUND, stdout: '', stderr: 'gh: not found' }
    }

    return opts.run(bin, args, { cwd, timeoutMs, env: ghEnv(bin) })
  }

  return {
    ghStatus: async () => {
      const r = await runGh(['auth', 'status'], undefined, 15_000)

      if (r.code === NOT_FOUND) {
        return { ok: false, detail: GH_NOT_INSTALLED }
      }

      return {
        ok: r.code === 0,
        detail:
          (r.stdout + r.stderr)
            .split('\n')
            .find(l => /Logged in|not logged/i.test(l))
            ?.trim() ?? ''
      }
    },
    archive: async (record, github) => {
      const dir = path.join(opts.home, 'iclone-os-archive', record.slug)
      const profile = profileSlugFor(record.inft.contract, record.inft.tokenId)
      const budget: CopyBudget = { files: 0, skipped: [] }

      try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
        copyTree(path.join(opts.hermesHome, 'profiles', profile), path.join(dir, 'hermes-profile'), budget)
        copyTree(path.join(opts.root, 'inft', record.slug), path.join(dir, 'app-data'), budget)
        fs.writeFileSync(
          path.join(dir, 'README.md'),
          [
            `# ${record.inft.name} — archive (NO iNFT — agent deactivated)`,
            '',
            `This is a copy of the agent's memory, profile and notes made by iclone os on ${new Date(opts.now()).toISOString()}.`,
            `It carries no iNFT: the token #${record.inft.tokenId} (${record.inft.chain} ${record.inft.contract}) is the only proof of ownership.`,
            'Secrets were removed (keychain sign-ins never leave the Mac).',
            ''
          ].join('\n')
        )
        fs.writeFileSync(
          path.join(dir, 'MANIFEST.json'),
          `${JSON.stringify({ inft: record.inft, wallet: record.wallet, state: record.state, transfer: record.transfer, files: budget.files, leftOut: budget.skipped.slice(0, 200), createdAt: opts.now() }, null, 2)}\n`
        )
      } catch (e) {
        return { ok: false, dir: null, remote: null, error: e instanceof Error ? e.message : 'copy failed' }
      }

      const steps: [string, string[]][] = [
        ['git', ['init', '-q']],
        ['git', ['add', '-A']],
        ['git', [...gitId, 'commit', '-q', '--allow-empty', '-m', `archive of iNFT #${record.inft.tokenId}`]]
      ]

      for (const [cmd, args] of steps) {
        const r = await opts.run(cmd, args, { cwd: dir, timeoutMs: 60_000 })

        if (r.code !== 0) {
          return { ok: false, dir, remote: null, error: `${cmd} ${args[0]} failed: ${r.stderr.trim().slice(0, 200)}` }
        }
      }

      if (!github) {
        return { ok: true, dir, remote: null }
      }

      const status = await runGh(['auth', 'status'], undefined, 15_000)

      if (status.code === NOT_FOUND) {
        return { ok: false, dir, remote: null, error: GH_NOT_INSTALLED }
      }

      if (status.code !== 0) {
        return {
          ok: false,
          dir,
          remote: null,
          error: 'GitHub CLI is not signed in — run `gh auth login`, then try again.'
        }
      }

      const name = `iclone-os-archive-${record.slug}`.slice(0, 100)

      const created = await runGh(
        ['repo', 'create', name, '--private', '--source', dir, '--remote', 'origin', '--push'],
        dir,
        180_000
      )

      if (created.code !== 0) {
        return { ok: false, dir, remote: null, error: `gh repo create failed: ${created.stderr.trim().slice(0, 200)}` }
      }

      return { ok: true, dir, remote: created.stdout.trim().split('\n').pop() || name }
    }
  }
}

/** The prompt step is the renderer's report: the header landed, or the persona is gone. */
export function promptStep(record: OwnershipRecord): DeactivationStep {
  if (record.promptHeaderAt) {
    return { step: 'prompt', ok: true, detail: 'persona prompt carries the deactivation header' }
  }

  if (record.personaRemovedAt) {
    return { step: 'prompt', ok: true, detail: 'persona deleted' }
  }

  return { step: 'prompt', ok: false, detail: 'persona header not written yet — retried hourly' }
}

/** The agent's Virtuals name now (`agent whoami`, read-only); null when unknown or already the door's. */
async function currentAgentName(
  opts: { acpBin: string; run: CommandRunner },
  slug: string,
  tokenId: string
): Promise<string | null> {
  try {
    const r = await opts.run(opts.acpBin, ['--inft', slug, 'agent', 'whoami', '--json'], { timeoutMs: 30_000 })
    const o = r.code === 0 ? (JSON.parse(r.stdout) as Record<string, unknown>) : null

    const nested = (k: string) =>
      typeof o?.[k] === 'object' && o[k] !== null ? (o[k] as Record<string, unknown>) : null

    const name = [o, nested('data'), nested('agent')].map(x => x?.name).find(v => typeof v === 'string')

    return typeof name === 'string' && name.trim() && name !== deactivatedAgentName(tokenId) ? name.slice(0, 120) : null
  } catch {
    return null
  }
}

export function createDeactivationDoor(opts: { root: string; acpBin: string; run: CommandRunner }): DeactivationDoor {
  return {
    applyDeactivation: async (slug, record, entry, todo) => {
      const steps: DeactivationStep[] = []
      const n = record.inft.tokenId

      if (!todo.includes('onchain')) {
        // already ok
      } else if (entry?.agentStatus) {
        if (record.agentStatus === entry.agentStatus.deactivated) {
          steps.push({ step: 'onchain', ok: true, detail: 'agentStatus already reads deactivated' })
        } else {
          // The app holds no contract key: the request is prepared for the administrator.
          const request = path.join(opts.root, 'inft', slug, 'agent-status-request.json')

          const written = writeAtomic(
            request,
            `${JSON.stringify({ chainId: entry.chainId, contract: entry.contract, tokenId: n, value: entry.agentStatus.deactivated, transfer: record.transfer }, null, 2)}\n`
          )

          steps.push({
            step: 'onchain',
            ok: false,
            detail: written
              ? `prepared ${request} — needs the contract administrator`
              : `could not write ${request} — retried hourly`
          })
        }
      } else {
        steps.push({
          step: 'onchain',
          ok: true,
          detail: 'contract exposes no agentStatus — the ownerOf/Transfer proof stands'
        })
      }

      if (todo.includes('prompt')) {
        steps.push(promptStep(record))
      }

      if (!todo.includes('virtuals')) {
        return steps
      }

      // The name it had before the rename, so a return can offer it back (§3.3).
      const agentName = record.originalAgentName ?? (await currentAgentName(opts, slug, n))
      const r = await opts.run(opts.acpBin, ['--inft', slug, ...doorRenameArgv(record)], { timeoutMs: 90_000 })

      steps.push({
        step: 'virtuals',
        ok: r.code === 0,
        detail: r.code === 0 ? 'agent renamed' : (r.stderr || r.stdout).trim().slice(0, 300),
        ...(agentName ? { agentName } : {})
      })

      return steps
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// IPC
// ─────────────────────────────────────────────────────────────────────────

const CHOICES = new Set<OwnerChoice>(['delete', 'archive-local', 'archive-github', 'keep', 'later'])

function asItems(v: unknown): OwnershipItem[] | null {
  if (!Array.isArray(v) || v.length > 200) {
    return null
  }

  const out: OwnershipItem[] = []

  for (const it of v) {
    if (typeof it !== 'object' || it === null) {
      return null
    }

    const o = it as Record<string, unknown>

    if (
      typeof o.id !== 'string' ||
      typeof o.chain !== 'string' ||
      typeof o.contract !== 'string' ||
      !/^0x[0-9a-fA-F]{40}$/.test(o.contract) ||
      typeof o.tokenId !== 'string' ||
      !/^\d{1,78}$/.test(o.tokenId)
    ) {
      return null
    }

    out.push({
      id: o.id.slice(0, 200),
      chain: o.chain.slice(0, 40),
      contract: o.contract,
      tokenId: o.tokenId,
      name: typeof o.name === 'string' ? o.name.slice(0, 120) : `#${o.tokenId}`,
      image: typeof o.image === 'string' && /^https?:\/\//.test(o.image) ? o.image.slice(0, 2000) : null,
      configured: o.configured === true
    })
  }

  return out
}

let initialized = false

/**
 * The answer WORK may act on: 'held' only for a decisive proof made at or after `startedAt` (never a pending or older
 * one), 'lost' whenever the guard says lost, otherwise 'unknown'.
 */
export function freshOwnershipAnswer(
  view: Pick<OwnershipView, 'checkedAt' | 'pending' | 'state'> | null,
  startedAt: number
): OwnershipRecord['state'] | 'unknown' {
  if (!view) {
    return 'unknown'
  }

  if (view.state === 'lost') {
    return 'lost'
  }

  return view.state === 'held' && !view.pending && (view.checkedAt ?? 0) >= startedAt ? 'held' : 'unknown'
}

/**
 * What a guard save tells WORK. A decisive 'held' only for a NEW proof made since this launch; a pending proof, or a
 * save that is not a proof (same checkedAt as the last emit: presale, prepare-sell, door notes), reads 'unknown'.
 * 'lost' is always 'lost' (V3-I r3 M-F, r4 m-H).
 */
export function emittedOwnershipState(
  view: Pick<OwnershipView, 'checkedAt' | 'pending' | 'state'>,
  launchedAt: number,
  lastEmittedCheckedAt: number | undefined
): OwnershipRecord['state'] | 'unknown' {
  if (view.state === 'lost') {
    return 'lost'
  }

  const fresh = view.checkedAt !== null && view.checkedAt >= launchedAt && view.checkedAt !== lastEmittedCheckedAt

  return view.state === 'held' && !view.pending && fresh ? 'held' : 'unknown'
}

/** What main's ACP WORK supervisor reads from the guard: a fresh proof, the tracked wallet, and every change. */
interface OwnershipWatch {
  check(slug: string): Promise<OwnershipRecord['state'] | 'unknown'>
  walletOf(slug: string): string | null
  onChange(listener: (slug: string, state: OwnershipRecord['state'] | 'unknown') => void): () => void
}

export function initIcloneOwnership({
  getMainWindow
}: {
  getMainWindow: () => BrowserWindow | null
}): OwnershipWatch | null {
  if (initialized) {
    return null
  }

  initialized = true
  const listeners = new Set<(slug: string, state: OwnershipRecord['state']) => void>()

  const root = app.getPath('userData')
  setOwnershipGateRoot(root)
  const now = () => Date.now()
  const fetchImpl: FetchLike = (url, init) => fetch(url, init)

  const source: RegistrySource = createRegistrySource({
    fetch: fetchImpl as typeof fetch,
    now,
    cacheFile: path.join(root, 'inft', 'registry-remote.json')
  })

  const home = os.homedir()

  // A proof from a previous launch is never news to WORK: only checks made since this launch can emit 'held'.
  const launchedAt = now()
  const lastEmittedCheck = new Map<string, number>()

  const service = createOwnershipService({
    root,
    now,
    registry: () => source.get(),
    verify: (entry, tokenId, wallet, sinceBlock) =>
      verifyOwnership({ entry, tokenId, wallet, sinceBlock, fetch: fetchImpl }),
    door: createDeactivationDoor({ root, acpBin: path.join(home, '.iclone-os', 'bin', 'acp'), run: execRunner }),
    archiver: createArchiver({ root, home, hermesHome: path.join(home, '.hermes'), run: execRunner, now }),
    emit: view => {
      const state = emittedOwnershipState(view, launchedAt, lastEmittedCheck.get(view.slug))

      if (view.checkedAt !== null) {
        lastEmittedCheck.set(view.slug, view.checkedAt)
      }

      for (const listener of listeners) {
        listener(view.slug, state)
      }

      const win = getMainWindow()

      if (win && !win.isDestroyed()) {
        win.webContents.send('iclone:ownership-changed', view)
      }
    }
  })

  ipcMain.handle('iclone:ownership-observe', (_e, wallet: unknown, items: unknown) => {
    const list = asItems(items)

    return typeof wallet === 'string' && list ? service.observe(wallet, list) : Promise.resolve([])
  })
  ipcMain.handle('iclone:ownership-list', () => service.list())
  ipcMain.handle('iclone:ownership-recheck', (_e, slug: unknown) =>
    isSafeSlug(slug) ? service.check(slug) : Promise.resolve(null)
  )
  ipcMain.handle('iclone:ownership-choose', (_e, slug: unknown, choice: unknown, confirm: unknown) =>
    isSafeSlug(slug) && CHOICES.has(choice as OwnerChoice)
      ? service.choose(slug, choice as OwnerChoice, typeof confirm === 'string' ? confirm : '')
      : Promise.resolve({ ok: false, error: 'bad request' })
  )
  ipcMain.handle('iclone:ownership-prepare-sell', (_e, slug: unknown, github: unknown) =>
    isSafeSlug(slug) ? service.prepareSell(slug, github === true) : Promise.resolve({ ok: false, error: 'bad request' })
  )
  ipcMain.handle('iclone:ownership-presale-detached', (_e, slug: unknown, removed: unknown) =>
    isSafeSlug(slug) ? service.presaleDetached(slug, typeof removed === 'number' ? removed : 0) : null
  )
  ipcMain.handle('iclone:ownership-prompt-header', (_e, profileSlug: unknown) =>
    typeof profileSlug === 'string' && profileSlug.length < 200 ? service.promptHeaderWritten(profileSlug) : 0
  )
  ipcMain.handle('iclone:ownership-gh-status', () =>
    createArchiver({ root, home, hermesHome: path.join(home, '.hermes'), run: execRunner, now }).ghStatus()
  )
  ipcMain.handle('iclone:ownership-registry', async () => {
    const r = await source.get()

    return { version: r.version, origin: source.origin(), contracts: r.entries.length }
  })

  // The 7-day clock also runs with no scan at all (signed out, offline wallet).
  const timer = setInterval(() => void service.tick(), HELD_RECHECK_MS)
  timer.unref?.()
  setTimeout(() => void service.tick(), 30_000).unref?.()

  return {
    // WORK may only act on a proof made during THIS call: a stale 'held' (pending, or checked before the call began)
    // is 'unknown', so a sale while the app was closed never resumes a listener on a failed verify (V3-I r2 M-E).
    check: slug => {
      const startedAt = now()

      return (isSafeSlug(slug) ? service.check(slug) : Promise.resolve(null)).then(view =>
        freshOwnershipAnswer(view, startedAt)
      )
    },
    walletOf: slug => (isSafeSlug(slug) ? (readRecord(root, slug, now())?.wallet ?? null) : null),
    onChange: listener => {
      listeners.add(listener)

      return () => listeners.delete(listener)
    }
  }
}
