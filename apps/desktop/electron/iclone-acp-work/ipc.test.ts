import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { on: () => undefined }, ipcMain: { handle: () => undefined } }))

import type { WorkView } from '../../src/iclone-shared/acp-work'
import type { WatchChild } from '../iclone-acp-watch'
import { createAuditLog, verifyAuditChain } from '../iclone-permissions/audit'

import { createWorkAuditSink, interimAuditKey } from './audit-sink'
import { fakeAccount, fakeAcp, offerJob } from './fake-cli'
import { createAcpWork, EVENT_READ_MS, registerAcpWork } from './ipc'

const SLUG = 'robinhood-1'

let dir = ''

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v3i-ipc-'))
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  fs.rmSync(dir, { recursive: true, force: true })
})

const flush = async () => {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve()
  }
}

function child(): WatchChild & { err: PassThrough; out: PassThrough } {
  const out = new PassThrough()
  const err = new PassThrough()
  let settle: (value: { code: number | null }) => void = () => undefined

  return {
    out,
    err,
    stdout: out,
    stderr: err,
    pid: 1,
    done: new Promise(resolve => (settle = resolve)),
    kill: () => settle({ code: null })
  }
}

function harness(opts: { trusted?: boolean } = {}) {
  const handlers = new Map<string, (event: unknown, input?: unknown) => unknown>()
  const acp = fakeAcp([offerJob('1'), offerJob('2', { status: 'funded' })])
  const children: Array<ReturnType<typeof child>> = []
  const sent: Array<{ channel: string; payload: unknown }> = []
  const auditDir = path.join(dir, 'acp-work', 'audit')
  const owner = fakeAccount()

  const deps = {
    ipcMain: {
      handle: (channel: string, fn: (event: unknown, input?: unknown) => unknown) => handlers.set(channel, fn)
    },
    isTrustedSender: () => opts.trusted ?? true,
    userDataDir: dir,
    cli: {
      listen: () => {
        const next = child()

        children.push(next)

        return Promise.resolve(next)
      },
      read: acp.read,
      yieldWindowWatch: () => undefined,
      stopWindowWatch: () => undefined,
      setWindowAdmission: () => undefined,
      keychainPromptShowing: () => false
    },
    streaming: new Set<string>(),
    account: owner.account,
    gestureOk: (_event: unknown, input: unknown) => (input as { gesture?: unknown } | null)?.gesture === true,
    spendTradeOn: () => false,
    audit: createWorkAuditSink({ dir: auditDir, shared: null }),
    send: (channel: 'iclone:acp-event' | 'iclone:acp-work:changed', payload: unknown) =>
      sent.push({ channel, payload }),
    log: () => undefined
  }

  const work = registerAcpWork(deps)
  const call = (channel: string, input?: unknown) => handlers.get(`iclone:acp-work:${channel}`)?.({ sender: {} }, input)

  const auditTail = () => createAuditLog({ dir: auditDir, ...interimAuditKey(auditDir) }).tail(0)

  return { acp, work, call, children, sent, auditDir, auditTail, deps, handlers, owner }
}

describe('the WORK door', () => {
  it('registers its channels behind the app sender guard', async () => {
    const h = harness({ trusted: false })

    expect([...h.handlers.keys()].sort()).toEqual(
      ['approve', 'decline', 'offline', 'online', 'reboot', 'refresh', 'repair', 'set-level', 'state'].map(
        name => `iclone:acp-work:${name}`
      )
    )
    expect(await h.call('online', { slug: SLUG, gesture: true })).toBeNull()
  })

  it('rejects malformed input', async () => {
    const h = harness()

    expect(await h.call('state', { slug: '../etc' })).toBeNull()
    expect(await h.call('approve', { slug: SLUG, jobId: '1; rm' })).toEqual({ ok: false, error: 'invalid' })
    expect(await h.call('set-level', { slug: SLUG, level: 'L3', gesture: true })).toEqual({
      ok: false,
      error: 'invalid'
    })
  })

  it('L2 cannot be turned on without the gesture; a refused attempt lands in the V3-F audit chain', async () => {
    const h = harness()

    expect(await h.call('set-level', { slug: SLUG, level: 'L2' })).toEqual({ ok: false, error: 'gesture' })
    expect(((await h.call('state', { slug: SLUG })) as WorkView).level).toBe('L1')

    const chain = verifyAuditChain(h.auditDir)
    const records = h.auditTail()

    expect(chain.ok).toBe(true)
    expect(records.at(-1)).toMatchObject({
      kind: 'mode_refused',
      src: 'main',
      gesture: false,
      action: { tool: 'acp-work.level', target: SLUG }
    })
  })

  it('going online needs the gesture; going offline and reboot never do', async () => {
    const h = harness()

    expect(await h.call('online', { slug: SLUG })).toEqual({ ok: false, error: 'gesture' })
    expect(h.children).toHaveLength(0)
    expect(await h.call('online', { slug: SLUG, gesture: true })).toEqual({ ok: true })
    await flush()
    expect(h.children).toHaveLength(1)
    expect(await h.call('reboot', { slug: SLUG })).toEqual({ ok: true })

    const report = await h.call('offline', { slug: SLUG })

    expect(report).toMatchObject({ ok: true, open: [{ jobId: '1' }, { jobId: '2' }], escrowMicros: 5_000_000 })
    expect(((await h.call('state', { slug: SLUG })) as WorkView).state).toBe('draining')
  })

  it('stays online with no window at all, and a job event is read within 3 s (I7)', async () => {
    const h = harness()

    await h.call('online', { slug: SLUG, gesture: true })
    await flush()
    h.children[0].err.write('Listening for events... connected.\n')
    await flush()

    const reads = h.acp.reads.length

    h.acp.state.jobs.push(offerJob('3'))
    h.children[0].out.write(
      `${JSON.stringify({ jobId: 3, status: 'open', entry: { event: { type: 'job.created' } } })}\n`
    )
    await vi.advanceTimersByTimeAsync(EVENT_READ_MS + 50)
    await flush()
    expect(EVENT_READ_MS).toBeLessThan(3000)
    expect(h.acp.reads.length).toBeGreaterThan(reads)
    expect(h.work.view(SLUG).offers.map(offer => offer.jobId)).toContain('3')
    expect(h.sent.some(item => item.channel === 'iclone:acp-event')).toBe(true)

    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(h.work.view(SLUG).state).toBe('online')
    expect(h.work.supervisor.live()).toEqual([SLUG])
  })

  it('approve and decline need the gesture and are audited', async () => {
    const h = harness()

    await h.call('refresh', { slug: SLUG })
    expect(await h.call('approve', { slug: SLUG, jobId: '1' })).toEqual({ ok: false, error: 'gesture' })
    expect(await h.call('decline', { slug: SLUG, jobId: '1', gesture: true })).toEqual({ ok: true })
    expect(await h.call('approve', { slug: SLUG, jobId: '1', gesture: true })).toMatchObject({
      ok: false,
      error: 'state'
    })

    const answers = h.auditTail().filter(record => record.action?.tool === 'acp-work.decline')

    expect(answers).toMatchObject([{ kind: 'use', answer: 'deny', gesture: true }])
    expect(verifyAuditChain(h.auditDir).ok).toBe(true)
  })

  it('a restarted main brings back every iNFT the owner left online, and none he took offline', async () => {
    const h = harness()

    await h.call('online', { slug: SLUG, gesture: true })
    await h.call('online', { slug: 'robinhood-2', gesture: true })
    await flush()
    h.work.stopAll()
    // robinhood-2 was taken offline before the restart.
    h.work.supervisor.stopListener('robinhood-2', 'offline')
    await h.call('offline', { slug: 'robinhood-2' })

    const again = createAcpWork({ ...h.deps, ipcMain: { handle: () => undefined } })

    expect(await again.resume()).toEqual([SLUG])
  })
})

describe('K28 n5: an owner offline on a slug WORK never held is recorded', () => {
  it('the ledger gets the offline, WORK takes custody and the window listener is told to let go', async () => {
    const h = harness()
    const yielded: string[] = []

    h.deps.cli.yieldWindowWatch = ((slug: string) => void yielded.push(slug)) as () => undefined

    const ledgerFile = path.join(dir, 'acp-work', 'never-held-1', 'ledger.jsonl')

    expect(fs.existsSync(ledgerFile)).toBe(false)
    await h.call('offline', { slug: 'never-held-1' })

    const lines = fs.readFileSync(ledgerFile, 'utf8').trim().split('\n')

    expect(lines.map(line => (JSON.parse(line) as { kind: string }).kind)).toEqual(['offline'])
    expect(yielded).toEqual(['never-held-1'])

    // A second press adds nothing: the owner's last word is already offline.
    await h.call('offline', { slug: 'never-held-1' })
    expect(fs.readFileSync(ledgerFile, 'utf8').trim().split('\n')).toHaveLength(1)
  })
})
