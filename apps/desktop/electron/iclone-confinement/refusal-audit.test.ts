/**
 * K07: a Seatbelt refusal reaches V3-F's audit chain (src `confinement`), joined to its session, so the
 * Background-tasks panel (which folds `refuse` records per `agent.session_id`) shows it. Three layers: the record's
 * shape and cap, the real authority's chain, and the confinement IPC wiring end to end with a planted denial.
 */
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

import type { RefusalView } from '../../src/iclone-shared/confinement'
import { confinementMembersDir } from '../iclone-permissions/classify-policy'
import { recordConfinement, registerPermissions } from '../iclone-permissions/ipc'

import { registerConfinement, stopConfinement } from './ipc'
import { createRefusalAudit } from './refusal-audit'

const root = mkdtempSync(path.join(os.tmpdir(), 'k07-'))

afterAll(() => rmSync(root, { recursive: true, force: true }))
afterEach(() => vi.useRealTimers())

const refusal = (over: Partial<RefusalView> = {}): RefusalView => ({
  ts: '2026-10-21T10:00:00.000Z',
  pid: 4321,
  process: 'cat',
  operation: 'file-read-data',
  target: '/Users/u/outside/secret.txt',
  sessionId: 'sess-7',
  ...over
})

describe('createRefusalAudit', () => {
  it('a refusal is a `refuse` record with the operation, the process, the target and the session', () => {
    const seen: unknown[] = []
    const audit = createRefusalAudit({ record: entry => seen.push(entry) })

    audit.record(refusal())
    audit.record(refusal({ sessionId: null, target: 'token sk-abcdefghijklmnopqrstuvwxyz123456' }))

    expect(seen[0]).toEqual({
      kind: 'refuse',
      reason: 'confinement: the sandbox refused file-read-data',
      action: { tool: 'cat', target: '/Users/u/outside/secret.txt', project_root: null },
      agent: { inft: null, profile: null, session_id: 'sess-7', subagent_id: null, task_id: null }
    })
    expect(seen[1]).toMatchObject({ agent: null })
    expect(JSON.stringify(seen[1])).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456')
  })

  it('at most N a minute reach the chain; the overflow is one gap record with its count', async () => {
    vi.useFakeTimers()

    const seen: { kind: string; reason: string }[] = []
    const audit = createRefusalAudit({ record: entry => seen.push(entry), perMinute: 3 })

    for (let index = 0; index < 10; index += 1) {
      audit.record(refusal({ pid: index + 2 }))
    }

    expect(seen.map(entry => entry.kind)).toEqual(['refuse', 'refuse', 'refuse'])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(seen.map(entry => entry.kind)).toEqual(['refuse', 'refuse', 'refuse', 'gap'])
    expect(seen[3].reason).toContain('7 more refusals')

    audit.record(refusal())
    expect(seen).toHaveLength(5)
    audit.stop()
  })
})

describe('K07 end to end', () => {
  const userDataDir = path.join(root, 'userData')
  const home = path.join(root, 'home')
  const sealed = new Map<string, string>()

  const authority = registerPermissions({
    ipcMain: { handle: () => undefined },
    isTrustedSender: () => true,
    userDataDir,
    paths: { hermesHome: path.join(home, '.hermes'), home, hermesRoot: null },
    door: null,
    consent: () => null,
    lastInputAt: () => 0,
    sealer: {
      seal: plain => {
        sealed.set('t', plain)

        return 't'
      },
      unseal: token => sealed.get(token) ?? ''
    },
    confirmIgnore: async () => false
  })

  const confinementRecords = () => authority.tail(0, 500).filter(record => record.src === 'confinement')

  it("a refusal lands in V3-F's authenticated chain as src confinement, with its session", () => {
    const audit = createRefusalAudit({ record: recordConfinement })
    const before = confinementRecords().length

    audit.record(refusal())

    const records = confinementRecords()

    expect(records).toHaveLength(before + 1)
    expect(records.at(-1)).toMatchObject({
      src: 'confinement',
      kind: 'refuse',
      agent: { session_id: 'sess-7' },
      action: { tool: 'cat', target: '/Users/u/outside/secret.txt' }
    })
    expect(authority.state().chain.ok).toBe(true)
    audit.stop()
  })

  it.runIf(process.platform === 'darwin')(
    'a planted denial from a confined run goes stream → chain through the registered layer',
    async () => {
      const stdout = new PassThrough()
      const child = Object.assign(new EventEmitter(), { stdout, kill: () => true })
      const broadcasts: string[] = []
      const before = confinementRecords().length

      // A confined run is ALREADY live when the layer is built: its token is in the members folder, so the gate's
      // own start-up scan starts the stream synchronously (refusal-gate.ts) and nothing here races an fs.watch
      // event. That the watch path also starts it is refusal-gate.test.ts's job, with the watch seam.
      mkdirSync(confinementMembersDir(home), { recursive: true })
      writeFileSync(path.join(confinementMembersDir(home), `project+${'a'.repeat(12)}+sess-8+${'c'.repeat(32)}`), '')

      // The token above went to the path this helper computes; if the layer ever derives it differently, say so
      // here rather than as an unexplained empty record list below.
      const layer = registerConfinement({
        userDataDir: path.join(root, 'conf-userData'),
        home,
        hermesHome: path.join(home, '.hermes'),
        hermesRoot: null,
        hermesPids: () => [],
        audit: () => [],
        ps: async () => [],
        ipcMain: { handle: () => undefined },
        isTrustedSender: () => true,
        broadcast: channel => broadcasts.push(channel),
        refusalStream: { spawnLog: () => child as never, spawnShow: () => child as never }
      })

      expect(layer.paths.membersDir).toBe(confinementMembersDir(home))

      try {
        const line = JSON.stringify({
          timestamp: '2026-10-21 10:00:00.000000+0000',
          eventMessage: 'Sandbox: cat(4400) deny(1) file-read-data /planted\niclone-confined:project'
        })

        stdout.write(`${line}\n`)

        // The stream is already running (the token above was there before the layer was built), so what is waited
        // for here is only the line's own trip through the parser and the audit - microtasks, not a watch event.
        for (let waited = 0; confinementRecords().length === before && waited < 2_000; waited += 10) {
          await new Promise(resolve => setTimeout(resolve, 10))
        }

        const records = confinementRecords()

        expect(records.length).toBeGreaterThan(before)
        expect(records.at(-1)).toMatchObject({ src: 'confinement', kind: 'refuse', action: { target: '/planted' } })
        expect(broadcasts.length).toBeGreaterThan(0)
        expect(layer.refusals.recent(10).some(row => row.target === '/planted')).toBe(true)
      } finally {
        stopConfinement()
      }
    }
  )
})
