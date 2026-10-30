// Glue for the compat engine (contract §3.1): IPC `iclone:compat:*`, the `iclone:compat:verdict` push, the boot/respawn
// guard, the post-hoc watchers and the verdict store. The cores under ./iclone-compat/ stay pure; this file only wires
// them to Electron. The renderer mirror of these shapes is src/types/iclone-compat.ts.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'

import { recordOrEmpty } from '../src/iclone-shared/guards'
import type { IcloneAgentCompat, IcloneCompatFlag } from '../src/iclone-shared/update-status'

import { backlogPath, ledgerLinks, readLedger, scan } from './iclone-compat/adoption'
import {
  beginOwnerHold,
  bindInstallTarget,
  cancelOwnerHold,
  compatGate,
  gateLevel,
  type GateRefusalRecord,
  gateVerdict,
  HOLD_MS,
  installTarget,
  LAST_REFUSAL_FILE,
  mintOwnerAck,
  publishGateVerdict,
  refreshInstallTarget as refreshTarget,
  targetMatches
} from './iclone-compat/gate'
import { guard, type GuardResult, OPENRPC_PATH } from './iclone-compat/guard'
import { RUNTIME_LOCK } from './iclone-compat/lock.generated'
import { type ProbeCall, type ProbeFrame, type ProbeReport, type ProbeSpec, runProbe } from './iclone-compat/probe'
import { readRuntimeFile, repoGit, runtimeHead, runtimeHome, runtimeInstallTip } from './iclone-compat/runtime-git'
import { appendLine, readStoreJson, storeRoot, writeStoreJson } from './iclone-compat/store'
import { fetchUpstreamFile, type RawFetch } from './iclone-compat/upstream-raw'
import { verify } from './iclone-compat/verify'
import { createWatch } from './iclone-compat/watch'
import { appRuntimeRoot } from './iclone-runtime-location'
import { readJsonFileSync } from './lib/fs-json'

export { compatGate }

const STATE_DB = 'hermes_state_common.py'
const STATE_CFG = 'hermes_cli/config_defaults.py'
// Shown when the runtime has no upstream to read; the gate never accepts a verdict for it (it is not what installs).
const DEFAULT_TARGET = 'upstream/main'
const VERDICT_CHANNEL = 'iclone:compat:verdict'
const FLAG_CHANNEL = 'iclone:compat:flag'
const PROBE_DELAY_MS = 1000
const RPC_TIMEOUT_MS = 5000
const TARGET = /^(?:[0-9a-f]{7,40}|upstream\/[\w.-]+(?:\/[\w.-]+)*)$/
const DECISION = /^(?:adopt|watch|ignore|defer:\d{4}-\d{2}-\d{2})$/
const SHA = /^[0-9a-f]{7,40}$/
const FULL_SHA = /^[0-9a-f]{40}$/
const RAW_SPEC_CACHE = 4

type Json = Record<string, unknown>
type CompatVerdict = ReturnType<typeof verify> & { computedAt: string }

interface BackendConnection {
  baseUrl: string
  wsUrl?: string
}

interface CompatDeps {
  userData: string
  runtimeDir: string
  receiptsDir: string
  repoDir: string | null
  push: (payload: { slot: 'latest' | 'pending'; verdict: CompatVerdict }) => void
  /** U1: a RED verdict of the running runtime is a passive flag (pane banner + nav dot), never an OS notification. */
  flag?: (flag: IcloneCompatFlag) => void
  fetchHealth?: (baseUrl: string) => Promise<string | null>
  connect?: (wsUrl: string) => Promise<{ call: ProbeCall; close: () => void }>
  // The decision-7 raw read (tests inject it); only the install tip is ever fetched.
  fetchRaw?: RawFetch
}

function refName(schema: unknown): unknown {
  const ref = recordOrEmpty(schema).$ref

  return typeof ref === 'string' ? ref.slice(ref.lastIndexOf('/') + 1) : (schema ?? {})
}

export function stateVersions(db: string | null, cfg: string | null): { db: number | null; config: number | null } {
  const m1 = /^SCHEMA_VERSION\s*(?::\s*int\s*)?=\s*(\d+)/m.exec(db ?? '')
  const m2 = /["']_config_version["']\s*:\s*(\d+)/.exec(cfg ?? '')

  return { db: m1 ? Number(m1[1]) : null, config: m2 ? Number(m2[1]) : null }
}

// T1 + state versions only (contract decision 6: the installed app never runs the AST tier). Null when the revision
// has no readable OpenRPC, so the verdict is UNKNOWN (FETCH-FAILED) instead of "every method gone".
export function specFromOpenrpc(raw: string | null, rev: string, db: string | null, cfg: string | null): Json | null {
  let doc: Json

  try {
    doc = recordOrEmpty(JSON.parse(raw ?? ''))
  } catch {
    return null
  }

  const list = (key: string) => (Array.isArray(doc[key]) ? (doc[key] as unknown[]).map(recordOrEmpty) : [])
  const firstParam = (m: Json) => refName(recordOrEmpty(Array.isArray(m.params) ? m.params[0] : null).schema)
  const entry = (m: Json) => ({ params: firstParam(m), result: refName(recordOrEmpty(m.result).schema) })

  const named = (rows: Json[], f: (m: Json) => unknown) =>
    Object.fromEntries(rows.filter(m => typeof m.name === 'string').map(m => [m.name as string, f(m)]))

  if (!list('methods').length) {
    return null
  }

  return {
    spec: 1,
    rev,
    describe: null,
    openrpcSha256: createHash('sha256')
      .update(raw ?? '')
      .digest('hex'),
    specTier: 'openrpc',
    methods: named(list('methods'), entry),
    serverRequests: named(list('x-server-requests'), entry),
    notifications: named(list('x-notifications'), m => ({ payload: firstParam(m) })),
    schemas: recordOrEmpty(recordOrEmpty(doc.components).schemas),
    stateVersions: stateVersions(db, cfg)
  }
}

function lockHash(): string {
  return createHash('sha256').update(JSON.stringify(RUNTIME_LOCK)).digest('hex')
}

async function defaultFetchHealth(baseUrl: string): Promise<string | null> {
  const res = await fetch(new URL('/api/health', baseUrl), { signal: AbortSignal.timeout(RPC_TIMEOUT_MS) })
  const commit = recordOrEmpty(await res.json()).commit

  return typeof commit === 'string' ? commit : null
}

// The probe's own JSON-RPC connection (decision 12): frames that carry a `method` are server pushes, never replies.
function defaultConnect(wsUrl: string): Promise<{ call: ProbeCall; close: () => void }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const waiting = new Map<number, (frame: ProbeFrame) => void>()
    let seq = 0

    const settle = (id: number, frame: ProbeFrame) => {
      const done = waiting.get(id)
      waiting.delete(id)
      done?.(frame)
    }

    ws.onerror = () => reject(new Error('iclone-compat: probe connection failed'))
    ws.onclose = () => [...waiting.keys()].forEach(id => settle(id, { error: { code: -1, message: 'closed' } }))

    ws.onmessage = e => {
      let m: Json

      try {
        m = recordOrEmpty(JSON.parse(String(e.data)))
      } catch {
        return
      }

      if (typeof m.id === 'number' && !('method' in m)) {
        settle(m.id, 'result' in m ? { result: m.result } : { error: recordOrEmpty(m.error) as ProbeFrame['error'] })
      }
    }

    ws.onopen = () =>
      resolve({
        close: () => ws.close(),
        call: (method, params) =>
          new Promise<ProbeFrame>(done => {
            const id = ++seq
            waiting.set(id, done)
            setTimeout(() => settle(id, { error: { code: -2, message: 'timeout' } }), RPC_TIMEOUT_MS).unref?.()
            ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
          })
      })
  })
}

export function createIcloneCompat(deps: CompatDeps) {
  const root = storeRoot(deps.userData)
  const fetchHealth = deps.fetchHealth ?? defaultFetchHealth
  const connect = deps.connect ?? defaultConnect
  let connection: BackendConnection | null = null
  let lastGuard: GuardResult | null = null
  let lastProbe: ProbeReport | null = null
  let watcher: { close: () => void } | null = null
  let backlog: unknown = null
  // Files at a full sha never change: a fetched spec is reused, a failed read is retried next time.
  const rawSpecs = new Map<string, Json>()

  // `hermes update` fetches origin and installs the tip its fetch writes to refs/remotes/origin/main, not the checkout's
  // stale @{u}: the tip is read from the remote (ls-remote outside the runtime) at every preview and right before apply.
  // U1: the agent check already read the tip with its one ls-remote of NousResearch; that rev is verified without a
  // second network read (consumed once, within seconds).
  let hintedTip: null | { at: number; sha: string } = null
  bindInstallTarget(() => {
    const hint = hintedTip
    hintedTip = null

    return hint && Date.now() - hint.at < 10_000 ? hint.sha : runtimeInstallTip(deps.runtimeDir)
  })
  // This producer has computed nothing yet: the gate starts at UNKNOWN, whatever an earlier process left on disk.
  publishGateVerdict(null)

  const tickets = () => (deps.repoDir ? ledgerLinks(readLedger(adoptionLedger(deps.repoDir))) : [])

  function installedSpec(): Json | null {
    const read = (rel: string) => readRuntimeFile(deps.runtimeDir, rel)

    return specFromOpenrpc(read(OPENRPC_PATH), runtimeHead(deps.runtimeDir) ?? '', read(STATE_DB), read(STATE_CFG))
  }

  // undefined when there is no repo or it cannot resolve the target; null when the revision has no readable spec.
  function repoSpec(target: string): Json | null | undefined {
    if (!deps.repoDir || !TARGET.test(target)) {
      return undefined
    }

    const repo = deps.repoDir
    let rev: string

    try {
      rev = repoGit(repo, ['rev-parse', '--verify', '--quiet', `${target}^{commit}`]).trim()
    } catch {
      return undefined
    }

    const show = (rel: string) => {
      try {
        return repoGit(repo, ['show', `${rev}:${rel}`], { maxBuffer: 16 * 1024 * 1024 })
      } catch {
        return null
      }
    }

    return specFromOpenrpc(show(OPENRPC_PATH), rev, show(STATE_DB), show(STATE_CFG))
  }

  async function rawSpec(sha: string): Promise<Json | null> {
    const hit = rawSpecs.get(sha)

    if (hit) {
      return hit
    }

    const read = (rel: string) => fetchUpstreamFile(sha, rel, { fetch: deps.fetchRaw })
    const [raw, db, cfg] = await Promise.all([read(OPENRPC_PATH), read(STATE_DB), read(STATE_CFG)])

    // A partial read would look like a state downgrade (ENGINE-DEP-GONE): any missing file is FETCH-FAILED, retried.
    if (raw === null || db === null || cfg === null) {
      return null
    }

    const spec = specFromOpenrpc(raw, sha, db, cfg)

    if (spec) {
      rawSpecs.set(sha, spec)

      for (const old of [...rawSpecs.keys()].slice(0, -RAW_SPEC_CACHE)) {
        rawSpecs.delete(old)
      }
    }

    return spec
  }

  // The repo's own `upstream` objects first; the raw read only for the install tip the repo cannot resolve.
  async function targetSpec(rev: string): Promise<Json | null> {
    const local = repoSpec(rev)

    if (local !== undefined) {
      return local
    }

    const tip = installTarget()

    return tip && rev === tip && FULL_SHA.test(tip) ? rawSpec(tip) : null
  }

  // `target === undefined` verifies the running runtime alone; a null target (unreadable) is UNKNOWN, never GREEN.
  function computeVerdict(kind: string, installed: Json | null, target?: Json | null): CompatVerdict {
    const specs = target === undefined ? [installed] : [installed, target]
    const usable = specs.every(Boolean) ? (specs as Json[]) : []

    return { ...verify(RUNTIME_LOCK, usable, { kind, tickets: tickets() }), computedAt: new Date().toISOString() }
  }

  function publish(slot: 'latest' | 'pending', verdict: CompatVerdict): CompatVerdict {
    if (slot === 'pending') {
      publishGateVerdict(verdict)
    }

    // pending.json is the renderer's copy only: the gate reads the verdict published above, never this file.
    writeStoreJson(root, slot === 'pending' ? 'pending.json' : 'latest.json', verdict)
    const sha = String(verdict.runtime.to)

    if (SHA.test(sha)) {
      writeStoreJson(root, `verdicts/${sha}.json`, verdict)
    }

    deps.push({ slot, verdict })

    if (slot === 'latest') {
      flagRed(verdict)
    }

    return verdict
  }

  function flagRed(verdict: CompatVerdict): void {
    deps.flag?.(compatFlagOf(verdict))
  }

  // The gate's producer: the verdict at the install target, recomputed on every preview and after every runtime move.
  // An explicit other target is a what-if for the pane; the gate treats its verdict as UNKNOWN.
  async function preview(target?: string): Promise<CompatVerdict> {
    await refreshTarget()

    return previewResolved(target)
  }

  async function previewTip(sha: string): Promise<CompatVerdict> {
    hintedTip = { at: Date.now(), sha }

    return preview()
  }

  async function previewResolved(target?: string): Promise<CompatVerdict> {
    const rev = target && TARGET.test(target) ? target : (installTarget() ?? DEFAULT_TARGET)
    let spec: Json | null = null

    try {
      spec = await targetSpec(rev)
    } catch {
      spec = null
    }

    return publish('pending', computeVerdict('preview', installedSpec(), spec))
  }

  // Right before apply: re-read the tip, and when it moved since the verdict the gate holds, recompute in-process so
  // the gate decides on the rev that installs now (an ack for the old verdict no longer matches its id).
  async function recheck(): Promise<string | null> {
    const tip = await refreshTarget()

    if (tip && !targetMatches(gateVerdict(), tip)) {
      await previewResolved()
    }

    return installTarget()
  }

  async function probe(): Promise<ProbeReport | { ok: false; reason: string }> {
    if (!connection?.wsUrl) {
      return { ok: false, reason: 'no-backend' }
    }

    // A backend that does not serve the runtime HEAD may run code without contracts, where a handler runs unvalidated:
    // the probe only ever talks to a backend the guard matched to the files it plans from.
    if (lastGuard?.status !== 'verify' && lastGuard?.status !== 'cached') {
      return { ok: false, reason: lastGuard?.status ?? 'no-guard' }
    }

    const spec = installedSpec()

    if (!spec) {
      return { ok: false, reason: 'no-openrpc' }
    }

    const link = await connect(connection.wsUrl)

    try {
      lastProbe = await runProbe({
        lock: RUNTIME_LOCK,
        spec: spec as ProbeSpec,
        call: link.call,
        capabilities: caps => link.call('client.capabilities', caps)
      })
    } finally {
      link.close()
    }

    writeStoreJson(root, 'probe.json', { ...lastProbe, at: new Date().toISOString() })

    return lastProbe
  }

  function ensureWatch(): void {
    if (watcher) {
      return
    }

    watcher = createWatch({
      runtimeDir: deps.runtimeDir,
      receiptsDir: deps.receiptsDir,
      healthCommit: () => (connection ? fetchHealth(connection.baseUrl).catch(() => null) : Promise.resolve(null)),
      verdictFor: async t => {
        const latest = publish('latest', computeVerdict(t.kind, installedSpec()))
        await preview()

        return latest
      },
      onVerdict: () => undefined
    })
  }

  // Boot/respawn (decision 11). Main does not await this: the health read and verify run off the boot path.
  async function onBackendReady(conn: BackendConnection): Promise<GuardResult> {
    connection = conn
    const health = await fetchHealth(conn.baseUrl).catch(() => null)
    const cacheKey = (key: string) => `cache/${key}.json`

    lastGuard = guard({
      runtimeDir: deps.runtimeDir,
      healthCommit: health,
      lockHash: lockHash(),
      cached: key => fs.existsSync(path.join(root, cacheKey(key)))
    })

    const g = lastGuard

    if (g.status === 'cached') {
      const v = readStoreJson<CompatVerdict>(root, cacheKey(g.key))

      if (v) {
        deps.push({ slot: 'latest', verdict: v })
      }
    } else {
      const v = computeVerdict('boot', installedSpec())

      // A stale backend serves code older than the runtime on disk: nothing about it is known, whatever the files say.
      if (g.status === 'stale-backend') {
        v.cards.unshift(g.card as unknown as (typeof v.cards)[number])
        v.level = v.level === 'RED' ? 'RED' : 'UNKNOWN'
      }

      publish('latest', v)

      if (g.status === 'verify') {
        writeStoreJson(root, cacheKey(g.key), v)
      }
    }

    ensureWatch()

    if (g.status === 'verify' || g.status === 'cached') {
      setTimeout(() => void probe().catch(() => undefined), PROBE_DELAY_MS).unref?.()
    }

    return g
  }

  function status() {
    return {
      latest: readStoreJson<CompatVerdict>(root, 'latest.json'),
      pending: gateVerdict() as CompatVerdict | null,
      installTarget: installTarget(),
      guard: lastGuard && { status: lastGuard.status, head: lastGuard.head },
      probe: lastProbe ?? readStoreJson<ProbeReport>(root, 'probe.json'),
      lastRefusal: readStoreJson<GateRefusalRecord>(root, LAST_REFUSAL_FILE),
      holdMs: HOLD_MS
    }
  }

  // The owner's hold, timed here (gate.ts): begin on press, mint on release. Only for the verdict the gate will read.
  function ack(req: unknown) {
    const r = recordOrEmpty(req)
    const verdictId = typeof r.verdictId === 'string' ? r.verdictId : ''

    if (r.phase === 'cancel') {
      cancelOwnerHold()

      return { ok: true, phase: 'cancel' }
    }

    const pending = gateVerdict()

    if (!pending || pending.id !== verdictId) {
      cancelOwnerHold()

      return { ok: false, reason: 'verdict-changed' }
    }

    if (r.phase === 'begin') {
      const hold = beginOwnerHold(verdictId)

      return { ok: true, phase: 'begin', ...hold, holdMs: HOLD_MS[gateLevel()] }
    }

    if (r.phase === 'mint' && typeof r.nonce === 'string') {
      const names = Array.isArray(r.names) ? r.names.filter((n): n is string => typeof n === 'string') : []
      const minted = mintOwnerAck({ verdictId, nonce: r.nonce, names })

      return minted.ok ? { ...minted, phase: 'mint' } : minted
    }

    return { ok: false, reason: 'bad-request' }
  }

  function readBacklog(req: unknown) {
    if (!deps.repoDir) {
      return null
    }

    if (recordOrEmpty(req).refresh === true || backlog === null) {
      try {
        backlog =
          recordOrEmpty(req).refresh === true ? scan(deps.repoDir, false) : readJsonFileSync(backlogPath(deps.repoDir))
      } catch {
        backlog = null
      }
    }

    return backlog
  }

  // Pane decisions never touch the repo (decision 14): `adoption.ts import` moves them into the committed ledger.
  function decide(req: unknown) {
    const r = recordOrEmpty(req)
    const upstream = Array.isArray(r.upstream) ? r.upstream.filter(s => typeof s === 'string' && SHA.test(s)) : []

    if (typeof r.cs !== 'string' || !/^CS-[0-9a-f]{7,40}$/.test(r.cs) || typeof r.decision !== 'string') {
      return { ok: false, reason: 'bad-request' }
    }

    if (!DECISION.test(r.decision)) {
      return { ok: false, reason: 'bad-decision' }
    }

    const line = {
      v: 1,
      at: new Date().toISOString(),
      by: 'owner',
      cs: r.cs,
      upstream,
      decision: r.decision,
      lane: 'adopt'
    }

    appendLine(root, 'decisions.jsonl', line)

    return { ok: true, line }
  }

  // Optional and labelled (contract §3.3): subjects only go to the runtime's `llm.oneshot`; never used for scoring.
  async function summarise(req: unknown) {
    const subjects = (Array.isArray(recordOrEmpty(req).subjects) ? (recordOrEmpty(req).subjects as unknown[]) : [])
      .filter((s): s is string => typeof s === 'string')
      .slice(0, 40)
      .map(s => s.slice(0, 200))

    if (!connection?.wsUrl || !subjects.length) {
      return { ok: false, reason: subjects.length ? 'no-backend' : 'nothing-to-summarise' }
    }

    const link = await connect(connection.wsUrl)

    try {
      const frame = await link.call('llm.oneshot', {
        instructions: 'Summarise these upstream commit subjects for the app owner in at most five short lines.',
        input: subjects.join('\n')
      })

      const text = recordOrEmpty(frame.result).text

      return typeof text === 'string'
        ? { ok: true, label: 'Summary by the runtime model (llm.oneshot), not used for scoring', text }
        : { ok: false, reason: frame.error?.message ?? 'no-text' }
    } finally {
      link.close()
    }
  }

  return {
    ack,
    close: () => watcher?.close(),
    decide,
    onBackendReady,
    preview,
    previewTip,
    probe,
    readBacklog,
    recheck,
    status,
    summarise
  }
}

function adoptionLedger(repo: string): string {
  return path.join(repo, 'iclone', 'upstream', 'adoption', 'ledger.jsonl')
}

// Only our own windows' top frames reach the engine; the owner's ack additionally refuses subframes.
function trusted(event: IpcMainInvokeEvent): boolean {
  return BrowserWindow.fromWebContents(event.sender) !== null && event.senderFrame === event.sender.mainFrame
}

let instance: ReturnType<typeof createIcloneCompat> | null = null

let currentFlag: IcloneCompatFlag | null = null

const VERDICT_LEVELS = new Set(['AMBER', 'GREEN', 'RED', 'UNKNOWN'])

function levelOf(verdict: CompatVerdict | null | undefined): IcloneAgentCompat['verdict'] {
  const level = String(verdict?.level ?? 'UNKNOWN')

  return (VERDICT_LEVELS.has(level) ? level : 'UNKNOWN') as IcloneAgentCompat['verdict']
}

function compatFlagOf(verdict: CompatVerdict | null | undefined): IcloneCompatFlag {
  const level = levelOf(verdict)

  return { at: String(verdict?.computedAt ?? new Date(0).toISOString()), red: level === 'RED', verdict: level }
}

/** The verdict of the agent check's target tip, reduced to what the pane shows (null: engine not started). */
export async function previewAgentTip(sha: string): Promise<IcloneAgentCompat | null> {
  if (!instance) {
    return null
  }

  const verdict = await instance.previewTip(sha)

  const findings = (verdict.cards ?? [])
    .filter(card => card.level !== 'GREEN' && card.level !== 'INFO')
    .flatMap(card => card.names)
    .slice(0, 20)

  return { findings, verdict: levelOf(verdict) }
}

export function initIcloneCompat(): void {
  if (instance) {
    return
  }

  const forkRoot = path.resolve(app.getAppPath(), '..', '..')

  const compat = createIcloneCompat({
    userData: app.getPath('userData'),
    // V3-RT (M2, ruling 36): a packaged app watches its own runtime, never the user's ~/.hermes/hermes-agent.
    runtimeDir: app.isPackaged ? appRuntimeRoot(app.getPath('userData')) : path.join(runtimeHome(), 'hermes-agent'),
    receiptsDir: path.join(runtimeHome(), 'logs', 'update_receipts'),
    repoDir: fs.existsSync(path.join(forkRoot, '.git')) ? forkRoot : null,
    push: payload => BrowserWindow.getAllWindows().forEach(w => w.webContents.send(VERDICT_CHANNEL, payload)),
    flag: flag => {
      currentFlag = flag
      BrowserWindow.getAllWindows().forEach(w => w.webContents.send(FLAG_CHANNEL, flag))
    }
  })

  currentFlag = compatFlagOf(readStoreJson<CompatVerdict>(storeRoot(app.getPath('userData')), 'latest.json'))

  instance = compat

  const guarded = (fn: (arg: unknown) => unknown) => (event: IpcMainInvokeEvent, arg: unknown) =>
    trusted(event) ? fn(arg) : { ok: false, reason: 'untrusted' }

  ipcMain.handle(
    'iclone:compat:status',
    guarded(() => compat.status())
  )
  ipcMain.handle(
    'iclone:compat:preview',
    guarded(arg => {
      const target = recordOrEmpty(arg).target

      return compat.preview(typeof target === 'string' ? target : undefined)
    })
  )
  ipcMain.handle(
    'iclone:compat:flag',
    guarded(() => currentFlag)
  )
  ipcMain.handle(
    'iclone:compat:probe',
    guarded(() => compat.probe())
  )
  ipcMain.handle(
    'iclone:compat:ack',
    guarded(arg => compat.ack(arg))
  )
  ipcMain.handle(
    'iclone:compat:backlog',
    guarded(arg => compat.readBacklog(arg))
  )
  ipcMain.handle(
    'iclone:compat:decide',
    guarded(arg => compat.decide(arg))
  )
  ipcMain.handle(
    'iclone:compat:summarise',
    guarded(arg => compat.summarise(arg))
  )
  app.once('will-quit', () => compat.close())
}

// main.ts `p4a-gate` seam, right before compatGate in applyUpdates. Without an instance it only refreshes the target.
export function refreshInstallTarget(): Promise<string | null> {
  return instance ? instance.recheck() : refreshTarget()
}

// main.ts `p4a-guard` seam, after `backend.ready` on boot and on every respawn. Never blocks or throws into the boot.
export function icloneCompatGuard(conn: BackendConnection): void {
  void instance?.onBackendReady(conn).catch(() => undefined)
}
