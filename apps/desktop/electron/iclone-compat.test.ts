import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, arg?: unknown) => unknown>(),
  trusted: true,
  userData: ''
}))

vi.mock('electron', () => ({
  app: { getAppPath: () => electron.userData, getPath: () => electron.userData, once: () => undefined },
  BrowserWindow: { fromWebContents: () => (electron.trusted ? {} : null), getAllWindows: () => [] },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, arg?: unknown) => unknown) => electron.handlers.set(channel, fn)
  },
  Notification: { isSupported: () => false }
}))

import { createIcloneCompat, initIcloneCompat, specFromOpenrpc, stateVersions } from './iclone-compat'
import { compatGate, gateVerdict, refreshInstallTarget } from './iclone-compat/gate'
import { OPENRPC_PATH } from './iclone-compat/guard'
import { repoGitEnv, runtimeInstallTip } from './iclone-compat/runtime-git'
import { storeRoot, writeStoreJson } from './iclone-compat/store'
import { fetchUpstreamFile, RAW_PREFIX, type RawFetch } from './iclone-compat/upstream-raw'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iclone-glue-'))

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))
afterEach(() => vi.useRealTimers())

const OPENRPC = JSON.stringify({
  methods: [
    { name: 'prompt.submit', params: [{ schema: { $ref: '#/components/schemas/PromptParams' } }], result: {} },
    { name: 'session.list', params: [], result: { schema: { $ref: '#/components/schemas/SessionList' } } }
  ],
  'x-server-requests': [{ name: 'clarify', params: [{ schema: { $ref: '#/components/schemas/ClarifyParams' } }] }],
  'x-notifications': [{ name: 'message.delta', params: [{ schema: { $ref: '#/components/schemas/Delta' } }] }],
  components: { schemas: { PromptParams: { type: 'object' } } }
})

function write(dir: string, rel: string, text: string) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
  fs.writeFileSync(path.join(dir, rel), text)
}

const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=test', ...args], {
    cwd,
    env: repoGitEnv(),
    encoding: 'utf8'
  }).trim()

// An app repo whose one commit carries a (deliberately tiny) OpenRPC: the preview target, and the runtime's origin.
function targetRepo(name = 'repo'): { repo: string; sha: string } {
  const repo = path.join(tmp, name)

  write(repo, OPENRPC_PATH, OPENRPC)
  gitIn(repo, 'init', '-q', '-b', 'main')
  gitIn(repo, 'add', '.')
  gitIn(repo, 'commit', '-qm', 'target')

  return { repo, sha: gitIn(repo, 'rev-parse', 'HEAD') }
}

function advance(repo: string): string {
  write(repo, 'next.txt', 'next\n')
  gitIn(repo, 'add', '.')
  gitIn(repo, 'commit', '-qm', 'next')

  return gitIn(repo, 'rev-parse', 'HEAD')
}

// The runtime checkout; with `origin`, a clone of it whose last fetch left @{u} at a stale sha (files only).
function runtime(origin?: string, name = origin ? 'runtime-tracking' : 'runtime'): string {
  const rt = path.join(tmp, name)

  if (origin) {
    write(rt, '.git/HEAD', 'ref: refs/heads/main\n')
    write(rt, '.git/refs/heads/main', `${'a'.repeat(40)}\n`)
    write(
      rt,
      '.git/config',
      `[remote "origin"]\n\turl = ${origin}\n[branch "main"]\n\tremote = origin\n\tmerge = refs/heads/main\n`
    )
    write(rt, '.git/packed-refs', `${'c'.repeat(40)} refs/remotes/origin/main\n`)
  } else {
    write(rt, '.git/HEAD', `${'a'.repeat(40)}\n`)
  }

  write(rt, OPENRPC_PATH, OPENRPC)
  write(rt, 'hermes_state_common.py', 'SCHEMA_VERSION = 31\n')
  write(rt, 'hermes_cli/config_defaults.py', '{"_config_version": 50}\n')

  return rt
}

describe('iclone-compat glue', () => {
  it('builds a T1 spec from an OpenRPC document, and none from an unreadable one', () => {
    const spec = specFromOpenrpc(OPENRPC, 'abc', 'SCHEMA_VERSION: int = 31', "'_config_version': 50")
    expect(spec).toMatchObject({
      spec: 1,
      rev: 'abc',
      specTier: 'openrpc',
      methods: { 'prompt.submit': { params: 'PromptParams' }, 'session.list': { result: 'SessionList' } },
      serverRequests: { clarify: { params: 'ClarifyParams' } },
      notifications: { 'message.delta': { payload: 'Delta' } },
      stateVersions: { db: 31, config: 50 }
    })
    expect(specFromOpenrpc(null, 'abc', null, null)).toBeNull()
    expect(specFromOpenrpc('{"methods": []}', 'abc', null, null)).toBeNull()
    expect(stateVersions(null, null)).toEqual({ db: null, config: null })
  })

  it('P4a.gate.apply: preview produces the pending verdict the gate reads; only a hold timed by main opens it', async () => {
    const userData = path.join(tmp, 'ud-preview')
    const pushed: string[] = []
    const { repo, sha } = targetRepo()
    const rt = runtime(repo)

    const compat = createIcloneCompat({
      userData,
      runtimeDir: rt,
      receiptsDir: path.join(tmp, 'receipts'),
      repoDir: repo,
      push: p => pushed.push(`${p.slot}:${p.verdict.level}`)
    })

    const v = await compat.preview()
    expect(v.runtime.to).toBe(sha.slice(0, 11))
    expect(v.level).toBe('RED')
    expect(pushed).toEqual(['pending:RED'])
    expect(JSON.parse(fs.readFileSync(path.join(storeRoot(userData), 'pending.json'), 'utf8')).id).toBe(v.id)
    expect(compatGate(userData)).toMatchObject({ ok: false, level: 'RED', reason: 'owner-ack-required' })

    const names = [...new Set(v.cards.filter(c => c.level === 'RED').flatMap(c => c.names))]
    writeStoreJson(storeRoot(userData), 'ack.json', { verdictId: v.id, by: 'owner', heldMs: 9000, names, at: '' })
    expect(compatGate(userData)).toMatchObject({ ok: false, reason: 'owner-ack-required' })

    vi.useFakeTimers({ now: Date.now() })
    expect(compat.ack({ phase: 'begin', verdictId: 'v-stale' })).toEqual({ ok: false, reason: 'verdict-changed' })
    const begun = compat.ack({ phase: 'begin', verdictId: v.id }) as { nonce: string; holdMs: number }
    expect(begun.holdMs).toBe(3000)
    vi.advanceTimersByTime(3000)
    expect(compat.ack({ phase: 'mint', verdictId: v.id, nonce: begun.nonce, names })).toMatchObject({
      ok: true,
      heldMs: 3000
    })
    expect(compatGate(userData)).toBeNull()
    expect(
      fs
        .readFileSync(path.join(storeRoot(userData), 'audit.jsonl'), 'utf8')
        .trim()
        .split('\n')
    ).toHaveLength(1)

    // P4a.x.r6.install_tip: once origin moves, re-resolved before apply, the verdict no longer describes what installs.
    vi.useRealTimers()
    const next = advance(repo)
    await expect(refreshInstallTarget()).resolves.toBe(next)
    expect(compatGate(userData)).toMatchObject({ ok: false, level: 'UNKNOWN', reason: 'target-unbound' })
  })

  it('P4a.x.r6.install_tip: the install target is the remote tip, never the stale @{u}; anything uncertain is null', async () => {
    // The origin path has a space, like the project root.
    const { repo, sha } = targetRepo('origin tip')
    const rt = runtime(repo, 'runtime-tip')
    const before = fs.readFileSync(path.join(rt, '.git', 'packed-refs'), 'utf8')

    await expect(runtimeInstallTip(rt)).resolves.toBe(sha)
    const next = advance(repo)
    await expect(runtimeInstallTip(rt)).resolves.toBe(next)
    // Read-only: nothing was fetched into the runtime.
    expect(fs.readFileSync(path.join(rt, '.git', 'packed-refs'), 'utf8')).toBe(before)
    expect(fs.readdirSync(path.join(rt, '.git')).sort()).toEqual(['HEAD', 'config', 'packed-refs', 'refs'])

    const home = path.join(tmp, 'home-stable')
    write(home, 'config.yaml', 'model: x\nupdate:\n  installs:\n    0123abcd:\n      channel: stable\n')
    await expect(runtimeInstallTip(rt, { hermesHome: home })).resolves.toBeNull()
    write(home, 'config.yaml', 'update:\n  installs:\n    0123abcd:\n      channel: main\n')
    await expect(runtimeInstallTip(rt, { hermesHome: home })).resolves.toBe(next)

    write(rt, 'install-stamp.json', JSON.stringify({ updateMechanism: 'electron-updater' }))
    await expect(runtimeInstallTip(rt)).resolves.toBeNull()
    fs.rmSync(path.join(rt, 'install-stamp.json'))

    expect(await runtimeInstallTip(runtime(path.join(tmp, 'missing.git'), 'runtime-gone'))).toBeNull()
    expect(await runtimeInstallTip(runtime('ext::sh -c touch% /tmp/x', 'runtime-ext'))).toBeNull()
    expect(await runtimeInstallTip(runtime('--upload-pack=touch', 'runtime-opt'))).toBeNull()
    expect(await runtimeInstallTip(runtime(path.join(tmp, 'runtime-self'), 'runtime-self'))).toBeNull()
  })

  it('P4a.x.r7.tip_selfref: a file:// origin inside the runtime or the Hermes home is refused like the path', async () => {
    const { repo, sha } = targetRepo('origin-file')
    await expect(runtimeInstallTip(runtime(`file://${repo}`, 'runtime-file'))).resolves.toBe(sha)

    const self = path.join(tmp, 'runtime-file-self')
    const encoded = `file://${self.replace(/e/g, '%65')}`

    for (const url of [`file://${self}`, `file://${self}/`, `file://${self}/.git`, encoded, `file://host${self}`]) {
      expect(await runtimeInstallTip(runtime(url, 'runtime-file-self'))).toBeNull()
    }

    const home = path.dirname(repo)
    await expect(runtimeInstallTip(runtime(`file://${repo}`, 'runtime-file'), { hermesHome: home })).resolves.toBeNull()
  })

  it('P4a.x.r8.tip_case: another spelling of a protected directory is refused where the filesystem folds case', async () => {
    const self = path.join(tmp, 'runtime-case-self')
    const upper = self.toUpperCase()

    for (const url of [upper, `${upper}/.GIT`, `file://${upper}`, `file://${upper.replace(/E/g, '%45')}`]) {
      expect(await runtimeInstallTip(runtime(url, 'runtime-case-self'))).toBeNull()
    }

    const { repo } = targetRepo('origin-case')
    const rt = runtime(repo, 'runtime-case')
    await expect(runtimeInstallTip(rt, { hermesHome: path.dirname(repo).toUpperCase() })).resolves.toBeNull()
  })

  it('P4a.x.r7.target_spec: a tip the repo cannot resolve is read from the raw prefix, at the full sha only', async () => {
    const { repo: origin, sha } = targetRepo('origin-raw')
    const rt = runtime(origin, 'runtime-raw')
    const calls: string[] = []

    const files: Record<string, string> = {
      [OPENRPC_PATH]: OPENRPC,
      'hermes_state_common.py': 'SCHEMA_VERSION = 31\n',
      'hermes_cli/config_defaults.py': '{"_config_version": 50}\n'
    }

    const fetchRaw: RawFetch = async (url, init) => {
      calls.push(url)
      expect(init).toMatchObject({ redirect: 'error', credentials: 'omit' })
      const rel = url.startsWith(`${RAW_PREFIX}${sha}/`) ? url.slice(RAW_PREFIX.length + 41) : ''

      return rel in files ? new Response(files[rel]) : new Response('missing', { status: 404 })
    }

    // Installed (no repo) and dev (a repo that has not fetched the tip) both compute the verdict at the tip.
    const dev = path.join(tmp, 'dev-lacks-tip')
    write(dev, 'other.txt', 'other\n')
    gitIn(dev, 'init', '-q', '-b', 'main')
    gitIn(dev, 'add', '.')
    gitIn(dev, 'commit', '-qm', 'unrelated')

    for (const [name, repoDir] of [
      ['installed', null],
      ['dev', dev]
    ] as const) {
      calls.length = 0

      const compat = createIcloneCompat({
        userData: path.join(tmp, `ud-raw-${name}`),
        runtimeDir: rt,
        receiptsDir: path.join(tmp, 'receipts'),
        repoDir,
        push: () => undefined,
        fetchRaw
      })

      const v = await compat.preview()
      expect(v.runtime.to).toBe(sha.slice(0, 11))
      expect(v.level).not.toBe('UNKNOWN')
      expect(v.findings.map(f => f.rule)).not.toContain('FETCH-FAILED')
      expect(calls.sort()).toEqual(
        Object.keys(files)
          .map(rel => `${RAW_PREFIX}${sha}/${rel}`)
          .sort()
      )

      // Immutable at a full sha: the second preview reuses the spec; a what-if target is never fetched.
      await compat.preview()
      expect((await compat.preview('upstream/main')).level).toBe('UNKNOWN')
      expect(calls).toHaveLength(3)
    }

    // A failed read is UNKNOWN (FETCH-FAILED), never GREEN.
    const down = createIcloneCompat({
      userData: path.join(tmp, 'ud-raw-down'),
      runtimeDir: rt,
      receiptsDir: path.join(tmp, 'receipts'),
      repoDir: null,
      push: () => undefined,
      fetchRaw: () => Promise.reject(new Error('offline'))
    })

    const v = await down.preview()
    expect(v.level).toBe('UNKNOWN')
    expect(v.findings.map(f => f.rule)).toContain('FETCH-FAILED')
  })

  it('P4a.x.r8.raw_partial: one unreadable raw file is FETCH-FAILED and not cached; the next preview refetches', async () => {
    const { repo: origin, sha } = targetRepo('origin-partial')
    const rt = runtime(origin, 'runtime-partial')
    let failures = 1

    const files: Record<string, string> = {
      [OPENRPC_PATH]: OPENRPC,
      'hermes_state_common.py': 'SCHEMA_VERSION = 31\n',
      'hermes_cli/config_defaults.py': '{"_config_version": 50}\n'
    }

    const fetchRaw: RawFetch = async url => {
      const rel = url.slice(RAW_PREFIX.length + 41)

      if (rel === 'hermes_state_common.py' && failures-- > 0) {
        throw new Error('transient')
      }

      return new Response(files[rel])
    }

    const compat = createIcloneCompat({
      userData: path.join(tmp, 'ud-raw-partial'),
      runtimeDir: rt,
      receiptsDir: path.join(tmp, 'receipts'),
      repoDir: null,
      push: () => undefined,
      fetchRaw
    })

    const first = await compat.preview()
    const rules = (v: typeof first) => [...v.findings.map(f => f.rule), ...v.cards.flatMap(c => c.rules)]
    expect(first.level).toBe('UNKNOWN')
    expect(rules(first)).toContain('FETCH-FAILED')
    expect(rules(first)).not.toContain('ENGINE-DEP-GONE')

    const second = await compat.preview()
    expect(second.runtime.to).toBe(sha.slice(0, 11))
    expect(second.level).not.toBe('UNKNOWN')
    expect(second.state).toMatchObject({ targetDb: 31 })
    expect(rules(second)).not.toContain('ENGINE-DEP-GONE')
    expect(rules(second)).not.toContain('FETCH-FAILED')
  })

  it('P4a.x.r7.target_spec: the raw read refuses redirects, other hosts, oversize bodies and non-sha revisions', async () => {
    const sha = 'b'.repeat(40)
    const ok: RawFetch = async () => new Response('{}')

    await expect(fetchUpstreamFile(sha, 'a/b.json', { fetch: ok })).resolves.toBe('{}')
    await expect(fetchUpstreamFile('b'.repeat(12), 'a/b.json', { fetch: ok })).resolves.toBeNull()
    await expect(fetchUpstreamFile(sha, '../b.json', { fetch: ok })).resolves.toBeNull()
    await expect(fetchUpstreamFile(sha, 'a//b.json', { fetch: ok })).resolves.toBeNull()

    const moved = async () => Object.defineProperty(new Response('{}'), 'url', { value: 'https://example.invalid/x' })
    await expect(fetchUpstreamFile(sha, 'a/b.json', { fetch: moved })).resolves.toBeNull()

    const redirect: RawFetch = async (_url, init) =>
      init.redirect === 'error' ? Promise.reject(new TypeError('redirect')) : new Response('{}')

    await expect(fetchUpstreamFile(sha, 'a/b.json', { fetch: redirect })).resolves.toBeNull()

    const big: RawFetch = async () => new Response('x'.repeat(64))
    await expect(fetchUpstreamFile(sha, 'a/b.json', { fetch: big, maxBytes: 63 })).resolves.toBeNull()
    await expect(fetchUpstreamFile(sha, 'a/b.json', { fetch: big, maxBytes: 64 })).resolves.toHaveLength(64)

    const slow: RawFetch = (_url, init) =>
      new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))))

    await expect(fetchUpstreamFile(sha, 'a/b.json', { fetch: slow, timeoutMs: 20 })).resolves.toBeNull()
  })

  it('recomputes in-process right before apply when the install tip moved since the last preview', async () => {
    const { repo, sha } = targetRepo('origin-recheck')
    const rt = runtime(repo, 'runtime-recheck')

    const compat = createIcloneCompat({
      userData: path.join(tmp, 'ud-recheck'),
      runtimeDir: rt,
      receiptsDir: path.join(tmp, 'receipts'),
      repoDir: repo,
      push: () => undefined
    })

    expect((await compat.preview()).runtime.to).toBe(sha.slice(0, 11))
    const next = advance(repo)
    await expect(compat.recheck()).resolves.toBe(next)
    expect(gateVerdict()?.runtime?.to).toBe(next.slice(0, 11))
  })

  it('an unreadable target is UNKNOWN, never GREEN', async () => {
    const compat = createIcloneCompat({
      userData: path.join(tmp, 'ud-unknown'),
      runtimeDir: runtime(),
      receiptsDir: path.join(tmp, 'receipts'),
      repoDir: null,
      push: () => undefined
    })

    expect((await compat.preview('upstream/main')).level).toBe('UNKNOWN')
    expect((await compat.preview('--output=/tmp/x')).runtime.to).toBe('')
  })

  it('registers the eight iclone:compat channels (U1 adds the passive RED flag), refuses foreign senders and validates decisions', async () => {
    electron.userData = path.join(tmp, 'ud-ipc')
    initIcloneCompat()

    expect([...electron.handlers.keys()].sort()).toEqual(
      ['ack', 'backlog', 'decide', 'flag', 'preview', 'probe', 'status', 'summarise'].map(c => `iclone:compat:${c}`)
    )

    const frame = {}
    const event = { sender: { mainFrame: frame }, senderFrame: frame }
    const call = (channel: string, arg?: unknown) => electron.handlers.get(`iclone:compat:${channel}`)?.(event, arg)
    expect(call('status')).toMatchObject({ latest: null, pending: null, holdMs: { RED: 3000, UNKNOWN: 1500 } })
    expect(call('decide', { cs: 'CS-9f7f2f28c0', upstream: ['9f7f2f28c0'], decision: 'merge' })).toEqual({
      ok: false,
      reason: 'bad-decision'
    })
    expect(call('decide', { cs: 'CS-9f7f2f28c0', upstream: ['9f7f2f28c0', 'x'], decision: 'watch' })).toMatchObject({
      ok: true,
      line: { by: 'owner', upstream: ['9f7f2f28c0'], decision: 'watch' }
    })
    await expect(call('probe')).resolves.toEqual({ ok: false, reason: 'no-backend' })

    electron.trusted = false
    expect(call('ack', { phase: 'cancel' })).toEqual({ ok: false, reason: 'untrusted' })
    electron.trusted = true
  })
})
