import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { IcloneAgentUpdateCheck } from '../src/iclone-shared/update-status'

import {
  AGENT_NET_TIMEOUT_MS,
  checkAgentLatest,
  createGestureStore,
  ensureFullPreUpdateBackup,
  gestureAllowed,
  lsRemoteArgv,
  lsRemoteCwd,
  parseCompare,
  parseContains,
  parseLsRemote,
  readLastAgentUpdate,
  readPreUpdateBackupMode,
  readRuntimeChoice,
  repairCommit,
  validateAgentApply
} from './agent-update'
import { createConfirmTracker } from './agent-update-confirm'
import { readMainProcessSource } from './main/main-process-source'
import { BUNDLED_RUNTIME_PIN } from './update-policy'
import { OFFICIAL_REPO_HTTPS_URL } from './update-remote'
import { gateUpdateApply } from './update-runtime-align'

const HEAD = 'a'.repeat(40)
const TIP = 'b'.repeat(40)
const PIN = BUNDLED_RUNTIME_PIN.sha

const LS_REMOTE = [
  `${TIP}\trefs/heads/main`,
  `${'1'.repeat(40)}\trefs/tags/v0.21.5`,
  `${'2'.repeat(40)}\trefs/tags/v0.22.0`,
  `${'3'.repeat(40)}\trefs/tags/v0.22.0^{}`,
  `${'4'.repeat(40)}\trefs/tags/v0.22.1-rc1`,
  `${'5'.repeat(40)}\trefs/tags/v2026.9.24`
].join('\n')

const tmpDirs: string[] = []

function tmp(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)

  return dir
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true })
  }
})

type CheckDeps = Parameters<typeof checkAgentLatest>[0]

/** The peeled sha of the annotated `v0.22.0` in LS_REMOTE: the newest STABLE tag, so the version source. */
const STABLE_TAG_SHA = '3'.repeat(40)

/** A read that never answers: only the check's own budget can end it. */
const pending = <T>() => new Promise<T>(() => {})

function deps(over: Partial<CheckDeps> = {}) {
  const signals: AbortSignal[] = []
  const writes: IcloneAgentUpdateCheck[] = []

  const d = {
    fetchCompare: vi.fn(async (_base: string, _head: string, signal: AbortSignal) => {
      signals.push(signal)

      return { aheadBy: 12, date: '2026-10-18T10:00:00Z', tipSha: TIP }
    }),
    fetchContains: vi.fn(async (_tagSha: string, _tipSha: string, signal: AbortSignal) => {
      signals.push(signal)

      return true
    }),
    lsRemote: vi.fn(async (_timeoutMs: number) => ({ code: 0, stdout: LS_REMOTE, timedOut: false })),
    now: () => new Date('2026-10-19T01:00:00Z'),
    pin: { sha: PIN },
    readInstalled: vi.fn(async () => ({
      branch: 'main',
      date: '2026-10-06T00:00:00Z',
      dirty: false,
      sha: HEAD,
      version: '0.21.5'
    })),
    writeLastCheck: (check: IcloneAgentUpdateCheck) => void writes.push(check),
    ...over
  }

  return { d, signals, writes }
}

describe('the check (U.readonly_check)', () => {
  it('is one ls-remote of the official NousResearch URL — never a fetch or pull — from a temp cwd', () => {
    const argv = lsRemoteArgv()

    expect(argv).toContain('ls-remote')
    expect(argv[argv.indexOf('--') + 1]).toBe(OFFICIAL_REPO_HTTPS_URL)
    expect(argv.some(a => /^(fetch|pull|clone|checkout|reset)$/.test(a))).toBe(false)

    const { cwd, env } = lsRemoteCwd()
    expect(cwd).toBe(fs.realpathSync(os.tmpdir()))
    expect(env.GIT_CEILING_DIRECTORIES).toBe(path.dirname(cwd))
    expect(env.GIT_NO_LAZY_FETCH).toBe('1')
  })

  it('main wires the check to that ls-remote only (no git in the runtime, no resolveUpdateRoot)', () => {
    const src = fs.readFileSync(path.join(__dirname, 'main', 'agent-update.ts'), 'utf8')

    expect(src).toMatch(/runGit\(lsRemoteArgv\(\), \{ cwd, env/)
    expect(src).not.toMatch(/resolveUpdateRoot|runResolvedGit|'fetch'|'pull'/)
    expect(src).toContain('ACTIVE_HERMES_ROOT')
  })

  it('the compat verdict has ONE surface: the check itself, never a second door nobody reads', () => {
    const ipc = fs.readFileSync(path.join(__dirname, 'main', 'updates-ipc.ts'), 'utf8')
    const preload = fs.readFileSync(path.join(__dirname, 'preload.ts'), 'utf8')
    const main = fs.readFileSync(path.join(__dirname, 'main', 'agent-update.ts'), 'utf8')

    expect(ipc).not.toContain('hermes:agent-update:compat')
    expect(preload).not.toContain('hermes:agent-update:compat')
    expect(main).toContain('previewCompat: previewAgentTip')
  })

  it('the preload namespace carries its web decision, and the shim has it', () => {
    const preload = fs.readFileSync(path.join(__dirname, 'preload.ts'), 'utf8')
    const shim = fs.readFileSync(path.join(__dirname, '..', 'src', 'web-shim', 'bridge.ts'), 'utf8')

    expect(preload).toMatch(/Web decision: ABSENT in the web shim[^]*?agentUpdate: \{/)
    expect(preload).toContain('src/web-shim/bridge.test.ts')
    expect(shim).toMatch(/'agentUpdate'/)
  })

  it('the compat verdict of the tip comes back in the check, and is persisted with it', async () => {
    const previewCompat = vi.fn(async (_sha: string) => ({ findings: [], verdict: 'GREEN' as const }))
    const { d, writes } = deps({ previewCompat })

    const check = await checkAgentLatest(d)

    expect(previewCompat).toHaveBeenCalledWith(TIP)
    expect(check.compat).toEqual({ findings: [], verdict: 'GREEN' })
    expect(writes).toEqual([check])
  })

  it('no preview unless there is a tip worth updating to', async () => {
    const previewCompat = vi.fn(async (_sha: string) => ({ findings: [], verdict: 'GREEN' as const }))

    for (const over of [
      // the tip IS HEAD
      { lsRemote: vi.fn(async () => ({ code: 0, stdout: `${HEAD}\trefs/heads/main`, timedOut: false })) },
      // no tip at all
      { lsRemote: vi.fn(async () => ({ code: 1, stdout: '', timedOut: false })) },
      // a tip the compare says HEAD is ahead of
      { fetchCompare: vi.fn(async () => ({ aheadBy: 0, date: null, tipSha: TIP })) }
    ]) {
      const check = await checkAgentLatest(deps({ previewCompat, ...over }).d)

      expect(check.updateAvailable).toBe(false)
      expect(check.compat).toBeNull()
    }

    expect(previewCompat).not.toHaveBeenCalled()
  })

  it('a compat preview that refuses, throws or hangs is null — never an error for the pane', async () => {
    for (const previewCompat of [
      vi.fn(async (_sha: string) => null),
      vi.fn((_sha: string) => Promise.reject(new Error('compat gate down'))),
      vi.fn((_sha: string) => pending<null>())
    ]) {
      const started = Date.now()
      const check = await checkAgentLatest(deps({ budgetMs: 25, previewCompat }).d)

      expect(check).toMatchObject({ compat: null, error: null, updateAvailable: true })
      expect(Date.now() - started).toBeLessThan(2000)
    }
  })

  it('latest = the main tip; the newest release tag is information only', async () => {
    const { d, signals, writes } = deps()
    const check = await checkAgentLatest(d)

    expect(AGENT_NET_TIMEOUT_MS).toBe(8000)
    expect(d.lsRemote).toHaveBeenCalledTimes(1)
    expect(d.lsRemote).toHaveBeenCalledWith(AGENT_NET_TIMEOUT_MS)
    expect(check).toMatchObject({
      checkedAt: '2026-10-19T01:00:00.000Z',
      compat: null,
      error: null,
      installed: { sha: HEAD, version: '0.21.5', verifiedWithRelease: false },
      latest: {
        commitsNewer: 12,
        date: '2026-10-18T10:00:00Z',
        releaseTag: 'v2026.9.24',
        sha: TIP,
        version: '0.22.0',
        // the tip carries v0.22.0 and is ahead of it: "0.22.0+", never "0.22.0" (lead, r5)
        versionBasis: 'newer'
      },
      updateAvailable: true
    })
    // the compare reads `main` (not the ls-remote sha), the version pairs the newest stable tag with that tip
    expect(d.fetchCompare).toHaveBeenCalledWith(HEAD, 'main', expect.any(AbortSignal))
    expect(d.fetchContains).toHaveBeenCalledWith(STABLE_TAG_SHA, TIP, expect.any(AbortSignal))
    // ONE budget for every read, and it is cancelled once the answer is in
    expect(new Set(signals).size).toBe(1)
    expect(signals[0].aborted).toBe(true)
    expect(writes).toEqual([check])
  })

  it('the reads run together: the compare never waits for ls-remote', async () => {
    const fetchCompare = vi.fn(async () => ({ aheadBy: 12, date: null, tipSha: TIP }))
    const compareStarted: boolean[] = []

    const lsRemote = vi.fn(async () => {
      compareStarted.push(fetchCompare.mock.calls.length > 0)

      return { code: 0, stdout: LS_REMOTE, timedOut: false }
    })

    await checkAgentLatest(deps({ fetchCompare, lsRemote }).d)

    expect(compareStarted).toEqual([true])
  })

  it('a tip that differs from HEAD but is 0 commits ahead of it (HEAD ahead or diverged) is not an update', async () => {
    const { d } = deps({ fetchCompare: vi.fn(async () => ({ aheadBy: 0, date: null, tipSha: TIP })) })
    const check = await checkAgentLatest(d)

    expect(check.latest).toMatchObject({ commitsNewer: 0, sha: TIP })
    expect(check.updateAvailable).toBe(false)
  })

  it('a compare of another tip (a push between the two reads) counts nothing', async () => {
    const { d } = deps({ fetchCompare: vi.fn(async () => ({ aheadBy: 7, date: 'D', tipSha: 'c'.repeat(40) })) })

    expect((await checkAgentLatest(d)).latest).toMatchObject({ commitsNewer: null, date: null, sha: TIP })
  })

  it('a truncated compare page counts its commits but carries no date', async () => {
    const { d } = deps({ fetchCompare: vi.fn(async () => ({ aheadBy: 300, date: null, tipSha: null })) })

    expect((await checkAgentLatest(d)).latest).toMatchObject({ commitsNewer: 300, date: null, sha: TIP })
  })

  it('up to date: the answer is HEAD itself, whatever the compare says or does', async () => {
    const atHead = async () => ({ code: 0, stdout: `${HEAD}\trefs/heads/main`, timedOut: false })

    const sound = deps({
      fetchCompare: vi.fn(async () => ({ aheadBy: 99, date: '2026-01-01T00:00:00Z', tipSha: HEAD })),
      lsRemote: vi.fn(atHead)
    })

    const broken = deps({
      fetchCompare: vi.fn(() => Promise.reject(new Error('rate limited'))),
      fetchContains: vi.fn(() => Promise.reject(new Error('rate limited'))),
      lsRemote: vi.fn(atHead)
    })

    for (const { d } of [sound, broken]) {
      const check = await checkAgentLatest(d)

      expect(check.error).toBeNull()
      expect(check.updateAvailable).toBe(false)
      expect(check.latest).toMatchObject({
        commitsNewer: 0,
        date: '2026-10-06T00:00:00Z',
        releaseTag: null,
        sha: HEAD,
        version: '0.21.5'
      })
    }

    // no release tag in that answer, so the version read never happens
    expect(sound.d.fetchContains).not.toHaveBeenCalled()
  })

  it('offline, a timeout, a spawn rejection or no runtime are values for the pane, never a throw', async () => {
    for (const lsRemote of [
      vi.fn(async () => ({ code: 128, stdout: '', timedOut: false })),
      vi.fn(async () => ({ code: null, stdout: '', timedOut: true })),
      vi.fn(() => Promise.reject(new Error('spawn git ENOENT')))
    ]) {
      expect(await checkAgentLatest(deps({ lsRemote }).d)).toMatchObject({
        error: 'offline',
        latest: null,
        updateAvailable: false
      })
    }

    const none = deps({ readInstalled: vi.fn(async () => null) })
    expect(await checkAgentLatest(none.d)).toMatchObject({ error: 'no-runtime', latest: null })
    expect(none.d.lsRemote).not.toHaveBeenCalled()
  })

  it('a successful ls-remote is never reported as offline: an answer without the tip is "unavailable"', async () => {
    const { d } = deps({
      lsRemote: vi.fn(async () => ({ code: 0, stdout: `${TIP}\trefs/tags/v0.22.0`, timedOut: false }))
    })

    expect(await checkAgentLatest(d)).toMatchObject({ error: 'unavailable', latest: null, updateAvailable: false })
  })

  it('the compare and the version read degrade to null ("unavailable" in the pane)', async () => {
    for (const over of [
      { fetchCompare: vi.fn(async () => null), fetchContains: vi.fn(async () => null) },
      {
        fetchCompare: vi.fn(() => Promise.reject(new Error('403'))),
        fetchContains: vi.fn(() => Promise.reject(new Error('403')))
      }
    ]) {
      const check = await checkAgentLatest(deps(over).d)

      expect(check.error).toBeNull()
      expect(check.latest).toMatchObject({ commitsNewer: null, date: null, sha: TIP, version: null })
    }
  })

  it('the release-tag version is reported only when the tag is merged into the tip', async () => {
    const notMerged = deps({ fetchContains: vi.fn(async () => false) })
    const refused = await checkAgentLatest(notMerged.d)

    expect(refused.latest).toMatchObject({ sha: TIP, version: null })
    expect(refused.latest?.versionBasis).toBeUndefined()
    expect(notMerged.d.fetchContains).toHaveBeenCalledWith(STABLE_TAG_SHA, TIP, expect.any(AbortSignal))
  })

  it('a containment the API PROVED is stored, and believed again when the next read cannot answer', async () => {
    const proofs: Array<{ tagSha: string; tipSha: string }> = []
    const proven = deps({ writeContainsProof: proof => void proofs.push(proof) })

    expect((await checkAgentLatest(proven.d)).latest).toMatchObject({ version: '0.22.0', versionBasis: 'newer' })
    expect(proofs).toEqual([{ tagSha: STABLE_TAG_SHA, tipSha: TIP }])

    // the API is rate-limited (null): the proven pair answers instead of blanking the row
    const cached = deps({
      fetchContains: vi.fn(async () => null),
      readContainsProof: () => ({ tagSha: STABLE_TAG_SHA, tipSha: TIP }),
      writeContainsProof: proof => void proofs.push(proof)
    })

    expect((await checkAgentLatest(cached.d)).latest).toMatchObject({ version: '0.22.0', versionBasis: 'newer' })
    expect(proofs).toHaveLength(1)

    // a proof for another pair, a store that throws, and a PROVEN `false` are never a version
    for (const over of [
      { readContainsProof: () => ({ tagSha: STABLE_TAG_SHA, tipSha: 'c'.repeat(40) }) },
      {
        readContainsProof: () => {
          throw new Error('unreadable')
        }
      },
      { fetchContains: vi.fn(async () => false), readContainsProof: () => ({ tagSha: STABLE_TAG_SHA, tipSha: TIP }) }
    ]) {
      const { d } = deps({ fetchContains: vi.fn(async () => null), ...over })

      expect((await checkAgentLatest(d)).latest).toMatchObject({ sha: TIP, version: null })
    }

    // a write that throws is not an error either: the row is still right
    const unwritable = deps({
      writeContainsProof: () => {
        throw new Error('disk full')
      }
    })

    expect((await checkAgentLatest(unwritable.d)).latest).toMatchObject({ version: '0.22.0', versionBasis: 'newer' })
  })

  it('a release tag that IS the tip needs no second read, and is the plain release', async () => {
    const stdout = [
      `${STABLE_TAG_SHA}\trefs/heads/main`,
      `${'2'.repeat(40)}\trefs/tags/v0.22.0`,
      `${STABLE_TAG_SHA}\trefs/tags/v0.22.0^{}`
    ].join('\n')

    const { d } = deps({ lsRemote: vi.fn(async () => ({ code: 0, stdout, timedOut: false })) })

    expect((await checkAgentLatest(d)).latest).toMatchObject({
      sha: STABLE_TAG_SHA,
      version: '0.22.0',
      versionBasis: 'exact'
    })
    expect(d.fetchContains).not.toHaveBeenCalled()
  })

  it('HEAD = pin is "verified with this release", and then the verified version is known', async () => {
    const { d } = deps({
      readInstalled: vi.fn(async () => ({ branch: 'main', date: null, dirty: false, sha: PIN, version: '0.21.5' }))
    })

    const check = await checkAgentLatest(d)

    expect(check.installed.verifiedWithRelease).toBe(true)
    expect(check.verified).toEqual({ sha: PIN, version: '0.21.5' })
  })

  it('one budget covers every read: what has not answered by then is null, never an error', async () => {
    const seen: AbortSignal[] = []

    const { d } = deps({
      budgetMs: 25,
      fetchCompare: vi.fn((_base: string, _head: string, signal: AbortSignal) => {
        seen.push(signal)

        return pending<null>()
      }),
      fetchContains: vi.fn((_tagSha: string, _tipSha: string, signal: AbortSignal) => {
        seen.push(signal)

        return pending<boolean>()
      })
    })

    const started = Date.now()
    const check = await checkAgentLatest(d)

    expect(Date.now() - started).toBeLessThan(2000)
    expect(d.lsRemote).toHaveBeenCalledWith(25)
    expect(check.error).toBeNull()
    expect(check.latest).toMatchObject({ commitsNewer: null, date: null, sha: TIP, version: null })
    // both hanging reads were cancelled by that one budget
    expect(seen).toHaveLength(2)
    expect(new Set(seen).size).toBe(1)
    expect(seen.every(signal => signal.aborted)).toBe(true)
  })

  it('an ls-remote that never answers is "offline" inside the budget, not a hang', async () => {
    const { d } = deps({
      budgetMs: 25,
      lsRemote: vi.fn(() => pending<{ code: number; stdout: string; timedOut: boolean }>())
    })

    const started = Date.now()

    expect(await checkAgentLatest(d)).toMatchObject({ error: 'offline', latest: null, updateAvailable: false })
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('a runtime read that never answers is "unavailable", and nothing reaches the network', async () => {
    const { d } = deps({ budgetMs: 25, readInstalled: vi.fn(() => pending<null>()) })

    expect(await checkAgentLatest(d)).toMatchObject({ error: 'unavailable', latest: null })
    expect(d.lsRemote).not.toHaveBeenCalled()
    expect(d.fetchCompare).not.toHaveBeenCalled()
    expect(d.fetchContains).not.toHaveBeenCalled()
  })

  it('parses ls-remote: the main tip, the newest release tag, the newest stable tag (peeled)', () => {
    expect(parseLsRemote('garbage\n')).toEqual({ mainSha: null, releaseTag: null, stableTag: null })
    expect(parseLsRemote(LS_REMOTE)).toEqual({
      mainSha: TIP,
      releaseTag: 'v2026.9.24',
      stableTag: { name: 'v0.22.0', sha: STABLE_TAG_SHA }
    })
    expect(parseLsRemote(`${'2'.repeat(40)}\trefs/tags/v0.22.0\n${'3'.repeat(40)}\trefs/tags/v0.21.9`).releaseTag).toBe(
      'v0.22.0'
    )
  })

  it('the version tag is stable only: not CalVer, not a canary, not a pre-release', () => {
    const unstable = [
      `${TIP}\trefs/heads/main`,
      `${'5'.repeat(40)}\trefs/tags/v2026.9.24`,
      `${'6'.repeat(40)}\trefs/tags/v0.21.4+canary.20261018`,
      `${'7'.repeat(40)}\trefs/tags/v0.22.1-rc1`
    ].join('\n')

    expect(parseLsRemote(unstable)).toMatchObject({ mainSha: TIP, releaseTag: 'v2026.9.24', stableTag: null })
    expect(parseLsRemote(`${'1'.repeat(40)}\trefs/tags/v0.21.5`).stableTag).toEqual({
      name: 'v0.21.5',
      sha: '1'.repeat(40)
    })
  })

  it('parses the compare payload: a date and a tip sha only when the page lists every commit', () => {
    const commit = (sha: string) => ({ commit: { committer: { date: 'D' } }, sha })

    expect(parseCompare({ ahead_by: 2, commits: [commit('f'.repeat(40)), commit(TIP)] })).toEqual({
      aheadBy: 2,
      date: 'D',
      tipSha: TIP
    })
    expect(parseCompare({ ahead_by: 300, commits: [commit(TIP)] })).toEqual({
      aheadBy: 300,
      date: null,
      tipSha: null
    })
    expect(parseCompare({ ahead_by: 0, commits: [] })).toEqual({ aheadBy: 0, date: null, tipSha: null })
    expect(parseCompare({ ahead_by: -1 })).toBeNull()
    expect(parseCompare({ message: 'rate limited' })).toBeNull()
    expect(parseCompare([])).toBeNull()
  })

  it('parses the contains verdict: ahead or identical is merged, behind or diverged is not', () => {
    expect(parseContains({ status: 'ahead' })).toBe(true)
    expect(parseContains({ status: 'identical' })).toBe(true)
    expect(parseContains({ status: 'behind' })).toBe(false)
    expect(parseContains({ status: 'diverged' })).toBe(false)
    expect(parseContains({ message: 'rate limited' })).toBeNull()
    expect(parseContains(null)).toBeNull()
  })
})

describe('nothing runs on its own (U.no_auto)', () => {
  const electronDir = __dirname

  it('checkAgentLatestNow has exactly one caller: the IPC handler', () => {
    const src = readMainProcessSource(electronDir)
    const calls = src.match(/checkAgentLatestNow\(\)(?!:)/g) ?? []
    const ipc = fs.readFileSync(path.join(electronDir, 'main', 'updates-ipc.ts'), 'utf8')

    expect(calls).toHaveLength(1)
    expect(ipc).toContain("ipcMain.handle('hermes:agent-update:check', async () => checkAgentLatestNow())")
  })

  it('checkAgentLatest is called only by checkAgentLatestNow; no timer, focus, resume or boot path reaches it', () => {
    const main = fs.readFileSync(path.join(electronDir, 'main', 'agent-update.ts'), 'utf8')
    const src = readMainProcessSource(electronDir)

    expect(main.match(/checkAgentLatest\(/g)).toHaveLength(1)
    expect(main).not.toMatch(/setInterval|powerMonitor|'focus'|'resume'|whenReady/)
    expect(src).not.toMatch(/(setInterval|setTimeout|on\('(focus|resume)')[^\n]*checkAgentLatest/)
  })

  it('the boot alignment dialog and the RED OS notification are gone', () => {
    const src = readMainProcessSource(electronDir)
    const compat = fs.readFileSync(path.join(electronDir, 'iclone-compat.ts'), 'utf8')

    expect(src).not.toMatch(/alignRuntimeAtBoot|prepareCuratedRuntime|alignDialogText/)
    expect(compat).not.toMatch(/new Notification\(|Runtime contract broken/)
    expect(compat).toContain("'iclone:compat:flag'")
  })
})

describe('the apply door (U.gesture, U.target_root)', () => {
  const lastCheck = (over: Partial<IcloneAgentUpdateCheck> = {}): IcloneAgentUpdateCheck => ({
    checkedAt: '2026-10-19T01:00:00Z',
    compat: null,
    error: null,
    installed: { branch: 'main', date: null, dirty: false, sha: HEAD, version: '0.21.5', verifiedWithRelease: false },
    latest: { commitsNewer: 3, date: null, releaseTag: null, sha: TIP, version: '0.22.3' },
    updateAvailable: true,
    verified: { sha: PIN, version: null },
    ...over
  })

  const base = {
    appUpdatePending: false,
    gestureOk: true,
    lastCheck: lastCheck(),
    platform: 'darwin' as NodeJS.Platform,
    request: { gestureToken: 't', targetSha: TIP },
    updaterRunning: false
  }

  it('refuses without a fresh gesture, a check, the checked sha, or when another update owns the runtime', () => {
    expect(validateAgentApply(base)).toEqual({ ok: true, targetSha: TIP })
    expect(validateAgentApply({ ...base, gestureOk: false })).toMatchObject({ error: 'gesture', ok: false })
    expect(validateAgentApply({ ...base, lastCheck: null })).toMatchObject({ error: 'no-check' })
    expect(validateAgentApply({ ...base, request: { targetSha: HEAD } })).toMatchObject({ error: 'stale-check' })
    expect(validateAgentApply({ ...base, request: null })).toMatchObject({ error: 'stale-check' })
    expect(validateAgentApply({ ...base, lastCheck: lastCheck({ updateAvailable: false }) })).toMatchObject({
      error: 'stale-check'
    })
    expect(validateAgentApply({ ...base, appUpdatePending: true })).toMatchObject({ error: 'app-update-pending' })
    expect(validateAgentApply({ ...base, updaterRunning: true })).toMatchObject({ error: 'updater-running' })
    expect(validateAgentApply({ ...base, platform: 'win32' })).toMatchObject({ error: 'unsupported-platform' })
  })

  it('a gesture token is single-use, expires after 60 s, and a wrong token burns it', () => {
    let now = 1000
    const store = createGestureStore({ now: () => now, random: () => 'tok' })

    expect(store.consume('tok')).toBe(false)
    store.mint()
    expect(store.consume('tok')).toBe(true)
    expect(store.consume('tok')).toBe(false)

    store.mint()
    expect(store.consume('nope')).toBe(false)
    expect(store.consume('tok')).toBe(false)

    store.mint()
    now += 60_001
    expect(store.consume('tok')).toBe(false)
  })

  it('the default token is 32 random bytes (base64url), never Math.random', () => {
    const store = createGestureStore()
    const a = store.mint().token
    const b = store.mint().token
    const src = fs.readFileSync(path.join(__dirname, 'agent-update.ts'), 'utf8')

    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(a).not.toBe(b)
    expect(src).not.toContain('Math.random')
  })

  it('main mints a token only with activation, a trusted confirm on the button, and real input to that window', () => {
    const at = 10_000
    const ok = { activation: true, confirm: true }

    const allowed = (payload: unknown, lastInputAt = at - 200) =>
      gestureAllowed({ lastInputAt, now: at, payload, windowMs: 1500 })

    expect(allowed(ok)).toBe(true)
    expect(allowed({ ...ok, confirm: false })).toBe(false)
    expect(allowed({ activation: true })).toBe(false)
    expect(allowed({ ...ok, activation: false })).toBe(false)
    expect(allowed({ activation: 'true', confirm: 'true' })).toBe(false)
    expect(allowed(null)).toBe(false)
    expect(allowed(ok, at - 1501)).toBe(false)
    expect(allowed(ok, 0)).toBe(false)

    const main = fs.readFileSync(path.join(__dirname, 'main', 'agent-update.ts'), 'utf8')
    const preload = fs.readFileSync(path.join(__dirname, 'preload.ts'), 'utf8')

    expect(main).toMatch(/contents\.on\('input-event'/)
    expect(main).toMatch(/gestureAllowed\(\{/)
    expect(main).toMatch(/gestureOk: gestures\.consume\(token\)/)
    expect(preload).toMatch(/activation: navigator\.userActivation\?\.isActive === true/)
    expect(preload).toMatch(/confirm: agentUpdateConfirm\.take\(\)/)
    expect(preload).toMatch(/isTrusted: event\.isTrusted/)
    expect(preload).toMatch(/\{ capture: true \}/)
    expect(preload).toMatch(/target instanceof Element && target\.closest\('\[data-agent-update-confirm\]'\) !== null/)
  })

  describe('the confirm is bound to a trusted event on the marked control (contract 2.8)', () => {
    // The preload's predicate, run against stand-ins for Element.closest().
    const button = { closest: (sel: string) => (sel === '[data-agent-update-confirm]' ? button : null) }
    const label = { closest: (sel: string) => button.closest(sel) }
    const composer = { closest: () => null }

    const isConfirmTarget = (target: unknown) => {
      const el = target as null | { closest?: unknown }

      return typeof el?.closest === 'function' && el.closest('[data-agent-update-confirm]') !== null
    }

    function tracker() {
      let now = 5000

      return { clock: (ms: number) => void (now += ms), t: createConfirmTracker({ isConfirmTarget, now: () => now }) }
    }

    it('a programmatic .click() on the marked button after a trusted keydown elsewhere is refused', () => {
      const { t } = tracker()

      t.observe({ isTrusted: true, key: 'a', target: composer, type: 'keydown' })
      t.observe({ isTrusted: true, key: 'Enter', target: composer, type: 'keydown' })
      t.observe({ isTrusted: false, target: button, type: 'click' })

      const confirm = t.take()

      expect(confirm).toBe(false)
      expect(
        gestureAllowed({ lastInputAt: 4900, now: 5000, payload: { activation: true, confirm }, windowMs: 1500 })
      ).toBe(false)
    })

    it('a real click (also on a child of the button) or Enter/Space on it counts once, inside 1.5 s', () => {
      const { clock, t } = tracker()

      t.observe({ isTrusted: true, target: label, type: 'click' })
      expect(t.take()).toBe(true)
      expect(t.take()).toBe(false)

      for (const key of ['Enter', ' ']) {
        t.observe({ isTrusted: true, key, target: button, type: 'keydown' })
        expect(t.take()).toBe(true)
      }

      t.observe({ isTrusted: true, key: 'Tab', target: button, type: 'keydown' })
      t.observe({ isTrusted: false, key: 'Enter', target: button, type: 'keydown' })
      t.observe({ isTrusted: true, target: { closest: 'not a function' }, type: 'click' })
      t.observe({ isTrusted: true, target: null, type: 'click' })
      expect(t.take()).toBe(false)

      t.observe({ isTrusted: true, target: button, type: 'click' })
      clock(1500)
      expect(t.take()).toBe(false)
    })
  })

  it('check and apply target ACTIVE_HERMES_ROOT even where resolveUpdateRoot() is the fork (dev)', () => {
    const main = fs.readFileSync(path.join(__dirname, 'main', 'agent-update.ts'), 'utf8')

    expect(main).toMatch(/'--install-root',\s*ACTIVE_HERMES_ROOT/)
    // V3-RT M2: a packaged app reads its own runtime (managedRoot); a dev run still reads HERMES_HOME's checkout.
    expect(main).toMatch(
      /readRuntimeStatus\(\{\s+home: HERMES_HOME,\s+\.\.\.\(IS_PACKAGED \? \{ managedRoot: appRuntimeRoot\(app\.getPath\('userData'\)\) \} : \{\}\),/
    )
    expect(main).not.toContain('resolveUpdateRoot')
  })

  it('apply refuses before any backup or hand-off when the runtime CLI is missing or origin is not NousResearch', () => {
    const main = fs.readFileSync(path.join(__dirname, 'main', 'agent-update.ts'), 'utf8')
    const body = main.slice(main.indexOf('export async function applyAgentUpdate'))
    const at = (needle: string) => body.indexOf(needle)

    expect(body).toMatch(/!fs\.existsSync\(hermesBin\)/)
    expect(body).toMatch(/const originUrl = await getOriginUrl\(ACTIVE_HERMES_ROOT\)/)
    expect(body).toMatch(/if \(!isOfficialRemote\(originUrl\)\) \{[\s\S]{0,200}error: 'origin-mismatch'/)

    for (const later of ['gateUpdateApply(', 'ensureFullPreUpdateBackup(', 'spawnUpdaterProcess(']) {
      expect(at('existsSync(hermesBin)')).toBeLessThan(at(later))
      expect(at("error: 'origin-mismatch'")).toBeLessThan(at(later))
    }
  })

  it('the agent-latest door skips the curated pin short-circuit and lets the compat gate hold RED/UNKNOWN', async () => {
    const audits: Record<string, unknown>[] = []
    const refreshTarget = vi.fn(async () => TIP)

    const gate = (refusal: null | { message: string }) =>
      gateUpdateApply({
        audit: entry => void audits.push(entry),
        compatGate: () => refusal,
        door: 'agent-latest',
        isWindows: false,
        pin: BUNDLED_RUNTIME_PIN,
        policy: 'curated',
        refreshTarget
      })

    expect(await gate(null)).toEqual({ door: 'agent-latest', refusal: null })
    expect(await gate({ message: 'held' })).toEqual({ door: null, refusal: { message: 'held' } })
    expect(refreshTarget).toHaveBeenCalledTimes(2)
    expect(audits.map(a => a.door)).toEqual(['agent-latest', 'agent-latest'])
  })
})

describe('runtime choice (U.repair_no_downgrade)', () => {
  it('Repair keeps the chosen sha only while HEAD is it', () => {
    const dir = tmp('u1-choice-')
    const file = path.join(dir, 'runtime-choice.json')
    fs.writeFileSync(file, JSON.stringify({ at: 'now', door: 'agent-latest', sha: TIP, version: '0.22.3' }))
    const choice = readRuntimeChoice(file)

    expect(choice).toEqual({ at: 'now', door: 'agent-latest', sha: TIP, version: '0.22.3' })
    expect(repairCommit({ choice, head: TIP, pinSha: PIN })).toBe(TIP)
    expect(repairCommit({ choice, head: HEAD, pinSha: PIN })).toBe(PIN)
    expect(repairCommit({ choice: null, head: TIP, pinSha: PIN })).toBe(PIN)

    fs.writeFileSync(file, JSON.stringify({ door: 'developer', sha: TIP }))
    expect(readRuntimeChoice(file)).toBeNull()
    expect(readRuntimeChoice(path.join(dir, 'missing.json'))).toBeNull()
  })
})

describe('the last update receipt (U.receipt)', () => {
  function home(receipts: Record<string, unknown>) {
    const h = tmp('u1-receipt-')
    const dir = path.join(h, 'logs', 'update_receipts')
    fs.mkdirSync(dir, { recursive: true })

    for (const [name, body] of Object.entries(receipts)) {
      fs.writeFileSync(path.join(dir, name), typeof body === 'string' ? body : JSON.stringify(body))
    }

    return h
  }

  const receipt = {
    finished_at: '2026-10-19T01:01:30+00:00',
    outcome: 'success',
    post_update: { sha: TIP, version: '0.22.3' },
    pre_update: { sha: HEAD, version: '0.21.5' },
    schema: 1,
    started_at: '2026-10-19T01:00:00+00:00',
    steps: [{ detail: 'zip=/h/backups/pre-update-20261019.zip size=12', name: 'pre_update_backup', ok: true }]
  }

  it('maps latest.json: from → to, backup zip, duration, outcome', () => {
    expect(readLastAgentUpdate(home({ 'latest.json': receipt }))).toEqual({
      at: '2026-10-19T01:01:30+00:00',
      backupZip: '/h/backups/pre-update-20261019.zip',
      durationMs: 90_000,
      from: { sha: HEAD, version: '0.21.5' },
      outcome: 'success',
      to: { sha: TIP, version: '0.22.3' }
    })
  })

  it('falls back to the newest update_*.json when latest.json is another kind, and finds the zip on disk', () => {
    const h = home({
      'latest.json': { kind: 'refusal', schema: 1 },
      'update_20261001_000000_1_x.json': { ...receipt, outcome: 'failed' },
      'update_20261019_010000_2_y.json': {
        ...receipt,
        steps: [{ detail: 'snapshot=abc', name: 'pre_update_backup', ok: true }]
      }
    })

    fs.mkdirSync(path.join(h, 'backups'))
    fs.writeFileSync(path.join(h, 'backups', 'pre-update-x.zip'), 'zip')
    const at = new Date('2026-10-19T01:00:30Z')
    fs.utimesSync(path.join(h, 'backups', 'pre-update-x.zip'), at, at)

    expect(readLastAgentUpdate(h)).toMatchObject({
      backupZip: path.join(h, 'backups', 'pre-update-x.zip'),
      outcome: 'success'
    })
  })

  it('no receipts, unreadable JSON or a receipt without dates → null', () => {
    expect(readLastAgentUpdate(tmp('u1-none-'))).toBeNull()
    expect(readLastAgentUpdate(home({ 'latest.json': '{oops' }))).toBeNull()
    expect(readLastAgentUpdate(home({ 'latest.json': { post_update: {}, pre_update: {} } }))).toBeNull()
  })
})

describe('a full backup before every agent update', () => {
  it('reads updates.pre_update_backup from config.yaml', () => {
    expect(readPreUpdateBackupMode('updates:\n  check: false\n  pre_update_backup: full\n')).toBe('full')
    expect(readPreUpdateBackupMode("updates:\n  pre_update_backup: 'quick' # default\nother: 1\n")).toBe('quick')
    expect(readPreUpdateBackupMode('model: x\n')).toBeNull()
    expect(readPreUpdateBackupMode(null)).toBeNull()
  })

  it('sets full only when it is not already, with HERMES_HOME in env, and logs the previous value', async () => {
    const logs: string[] = []
    const run = vi.fn(async () => ({ code: 0 }))

    const ensure = (config: null | string) =>
      ensureFullPreUpdateBackup({
        hermesBin: '/h/hermes-agent/venv/bin/hermes',
        hermesHome: '/h',
        log: line => void logs.push(line),
        readConfig: () => config,
        run
      })

    expect(await ensure('updates:\n  pre_update_backup: full\n')).toEqual({ changed: false, previous: 'full' })
    expect(run).not.toHaveBeenCalled()

    expect(await ensure('updates:\n  pre_update_backup: quick\n')).toEqual({ changed: true, previous: 'quick' })
    const [cmd, args, opts] = run.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }]
    expect([cmd, args]).toEqual([
      '/h/hermes-agent/venv/bin/hermes',
      ['config', 'set', 'updates.pre_update_backup', 'full']
    ])
    expect(opts.env.HERMES_HOME).toBe('/h')
    expect(logs[0]).toMatch(/quick → full: set/)
  })
})
