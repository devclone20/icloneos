import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createLauncherPolicyMirror,
  gitRootOf,
  LAUNCHER_PASS_FILE,
  LAUNCHER_PASS_TTL_MS,
  LAUNCHER_POLICY_FILE,
  type LauncherPolicyBody,
  listedProjects,
  readPassRows
} from './launcher-policy'

let root: string
let ledger: string
let lines: string[]

const body = (over: Partial<LauncherPolicyBody> = {}): LauncherPolicyBody =>
  ({ v: 1, standing: 'manual', projects: {}, sessions: {}, grants: [], fnGrants: [], ...over }) as LauncherPolicyBody

describe('fx20 — lens5 H2: an allowed ask spelled through a link', () => {
  it('T1: lists nothing and passes no folder, though the sheet said it showed it', () => {
    const decoy = path.join(root, 'decoy')
    const tax = path.join(root, 'tax-documents')
    const shown = path.join(root, 'open-project-vendor')

    mkdirSync(decoy)
    mkdirSync(tax)
    symlinkSync(decoy, shown)
    const mirror = createLauncherPolicyMirror(ledger, () => {})

    mirror.publish(body())
    unlinkSync(shown)
    symlinkSync(tax, shown)
    mirror.noteAllowedAsk({ project: shown, cls: 'X', scope: 'once', shown: true, grantId: null })
    expect(readPolicy().projects).toEqual([])
    expect(readPolicy().asked).toEqual([])
    expect(readPassRows(mirror.passFile).map(row => row.project)).toEqual([null])
  })

  it('its own spelling: listed and passed as before', () => {
    const real = path.join(root, 'real')

    mkdirSync(real)
    const mirror = createLauncherPolicyMirror(ledger, () => {})

    mirror.publish(body())
    mirror.noteAllowedAsk({ project: real, cls: 'X', scope: 'once', shown: true, grantId: null })
    expect(readPolicy().projects).toEqual([real])
    expect(readPassRows(mirror.passFile).map(row => row.project)).toEqual([real])
  })
})

const readPolicy = () => JSON.parse(readFileSync(path.join(ledger, LAUNCHER_POLICY_FILE), 'utf8')) as {
  v: number
  body: LauncherPolicyBody
  projects: string[]
  asked: string[]
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'iclone-lp-')))
  ledger = path.join(root, 'ledger')
  lines = []
})

afterEach(() => {
  chmodSync(root, 0o700)

  if (existsSync(ledger)) {
    chmodSync(ledger, 0o700)
  }

  rmSync(root, { recursive: true, force: true })
})

describe('fx12 — the launcher policy mirror', () => {
  it('a stale policy and stale passes from the last launch are gone when the mirror is made', () => {
    mkdirSync(ledger, { recursive: true })
    writeFileSync(path.join(ledger, LAUNCHER_POLICY_FILE), '{"v":1,"body":{"standing":"ignore"}}\n')
    writeFileSync(path.join(ledger, LAUNCHER_PASS_FILE), '{"v":1}\n')

    const mirror = createLauncherPolicyMirror(ledger, line => lines.push(line))

    expect(existsSync(mirror.file)).toBe(false)
    expect(existsSync(mirror.passFile)).toBe(false)
    expect(mirror.rewrite()).toBe(false)
  })

  it('a failed write leaves no readable policy behind (mutant: the old, wider file stays)', () => {
    const mirror = createLauncherPolicyMirror(ledger, line => lines.push(line))

    mirror.publish(body({ standing: 'ignore' }))
    expect(readPolicy().body.standing).toBe('ignore')

    chmodSync(ledger, 0o500)
    mirror.publish(body({ standing: 'plan' }))

    const stat = existsSync(mirror.file) ? statSync(mirror.file) : null

    expect(stat === null || stat.size === 0).toBe(true)
    expect(lines.at(-1)).toContain('confined commands are refused until it is')
  })

  it("writes main's project list: the window's folders, every project mode and grant, by real path, once", () => {
    const proj = path.join(root, 'proj')
    const other = path.join(root, 'other')
    const link = path.join(root, 'proj-link')

    mkdirSync(proj)
    mkdirSync(other)
    symlinkSync(proj, link)

    const mirror = createLauncherPolicyMirror(ledger, line => lines.push(line))

    mirror.noteProject(link)
    mirror.publish(
      body({
        projects: { [proj]: 'plan' },
        grants: [{ cls: 'Wp', id: 'g1', project: other, scope: 'project', sessionId: null }],
        fnGrants: [{ fn: 'shell', id: 'f1', project: path.join(root, 'gone'), scope: 'project', sessionId: null }]
      })
    )

    expect(readPolicy().projects).toEqual([other, proj])
    expect(listedProjects(body(), ['relative/path', '/nonexistent/folder'])).toEqual([])

    const third = path.join(root, 'third')

    mkdirSync(third)
    mirror.noteProject(third)
    expect(readPolicy().projects).toEqual([other, proj, third])
  })

  it('fx13: a window folder is listed with its repository root, never home or above (lens3-normal M1)', () => {
    const repo = path.join(root, 'repo')
    const sub = path.join(repo, 'packages', 'web')

    mkdirSync(path.join(repo, '.git'), { recursive: true })
    mkdirSync(sub, { recursive: true })
    expect(gitRootOf(sub, root)).toBe(repo)
    expect(gitRootOf(repo, root)).toBe(repo)
    expect(gitRootOf(path.join(root, 'loose'), root)).toBe(null)
    // A home that is itself a repository names nothing: not home, not a folder above it, not `/`.
    mkdirSync(path.join(root, '.git'))
    expect(gitRootOf(path.join(root, 'loose'), root)).toBe(null)
    expect(gitRootOf(root, root)).toBe(null)
    expect(gitRootOf(path.dirname(root), root)).toBe(null)
    expect(gitRootOf('/', null)).toBe(null)

    const mirror = createLauncherPolicyMirror(ledger, line => lines.push(line), Date.now, root)

    mirror.publish(body())
    mirror.noteProject(sub)
    expect(readPolicy().projects).toEqual([repo, sub])
  })

  it('fx13: a pass row is the folder by real path, the answer and two minutes; expired rows go at the next write', () => {
    const proj = path.join(root, 'proj')

    mkdirSync(proj)

    let at = Date.parse('2026-11-04T12:00:00.000Z')
    const mirror = createLauncherPolicyMirror(ledger, line => lines.push(line), () => at)

    expect(mirror.pass({ project: path.join(root, '.', 'proj'), cls: 'X', scope: 'once' })).toBe(true)
    expect(mirror.pass({ project: null, cls: 'X', scope: 'session' })).toBe(true)

    const rows = () =>
      readFileSync(mirror.passFile, 'utf8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line) as Record<string, unknown>)

    expect(rows()[0]).toMatchObject({
      v: 1,
      project: proj,
      scope: 'once',
      ts: at / 1000,
      exp: (at + LAUNCHER_PASS_TTL_MS) / 1000
    })
    expect(rows()[0]).not.toHaveProperty('cmd')
    expect(rows()[0]).not.toHaveProperty('command')
    expect(typeof rows()[0]?.id).toBe('string')
    expect(rows()[1]).toMatchObject({ project: null, cls: 'X', scope: 'session' })
    expect(rows()[0]?.id).not.toBe(rows()[1]?.id)
    expect(statSync(mirror.passFile).mode & 0o777).toBe(0o600)

    at += LAUNCHER_PASS_TTL_MS + 1
    expect(mirror.pass({ project: proj, cls: 'X', scope: 'once' })).toBe(true)
    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toMatchObject({ project: proj, ts: at / 1000 })
  })

  it('a pass that cannot be written says so and returns false (the command stays narrowed)', () => {
    mkdirSync(ledger, { recursive: true })
    chmodSync(ledger, 0o500)

    const mirror = createLauncherPolicyMirror(ledger, line => lines.push(line))

    expect(mirror.pass({ project: null, cls: 'X', scope: 'once' })).toBe(false)
    expect(lines.at(-1)).toContain('pass could not be written')
  })
})

describe('fx17 — lens4-pass M1/M2: a pass has a class; an asked folder is listed only while a pass or a grant names it', () => {
  it('M1: the pass row carries the class the user allowed', () => {
    const mirror = createLauncherPolicyMirror(ledger, line => lines.push(line))

    expect(mirror.pass({ project: null, cls: 'Wp', scope: 'once' })).toBe(true)

    const row = JSON.parse(readFileSync(mirror.passFile, 'utf8').trim()) as Record<string, unknown>

    expect(row.cls).toBe('Wp')
  })

  it('M2: an asked folder is listed as asked, drops at the prune once no pass or grant names it; an opened folder stays', () => {
    const proj = path.join(root, 'proj')
    const opened = path.join(root, 'opened')

    mkdirSync(proj)
    mkdirSync(opened)

    let at = Date.parse('2026-11-04T12:00:00.000Z')
    const mirror = createLauncherPolicyMirror(ledger, line => lines.push(line), () => at)

    mirror.publish(body())
    mirror.noteProject(opened)
    mirror.noteAskedProject(proj)
    expect(mirror.pass({ project: proj, cls: 'Wp', scope: 'once' })).toBe(true)
    expect(readPolicy().projects).toEqual([opened, proj])
    expect(readPolicy().asked).toEqual([proj])

    mirror.prune()
    expect(readPolicy().projects).toEqual([opened, proj])

    at += LAUNCHER_PASS_TTL_MS + 1
    mirror.prune()
    expect(readPolicy().projects).toEqual([opened])
    expect(readPolicy().asked).toEqual([])
    expect(readFileSync(mirror.passFile, 'utf8')).toBe('')

    // A grant for the folder keeps it after its pass is gone; the grant's removal drops it.
    const grants = [
      { id: 'g', cls: 'X', scope: 'project', sessionId: null, project: proj, source: 'prompt' }
    ] as unknown as LauncherPolicyBody['grants']

    mirror.publish(body({ grants }))
    mirror.noteAskedProject(proj)
    expect(mirror.pass({ project: proj, cls: 'X', scope: 'project' })).toBe(true)
    at += LAUNCHER_PASS_TTL_MS + 1
    mirror.prune()
    expect(readPolicy().asked).toEqual([proj])
    expect(readPolicy().projects).toEqual([opened, proj])
    mirror.publish(body())
    mirror.prune()
    expect(readPolicy().asked).toEqual([])
    expect(readPolicy().projects).toEqual([opened])

    // An opened folder is never dropped, and asking for it changes nothing.
    mirror.noteAskedProject(opened)
    mirror.prune()
    expect(readPolicy().asked).toEqual([])
    expect(readPolicy().projects).toEqual([opened])
  })

  it('M2: the prune arms itself at the expiry, so the drop needs no later ask', () => {
    vi.useFakeTimers()

    try {
      const proj = path.join(root, 'proj')

      mkdirSync(proj)

      let at = Date.parse('2026-11-04T12:00:00.000Z')
      const mirror = createLauncherPolicyMirror(ledger, line => lines.push(line), () => at)

      mirror.publish(body())
      mirror.noteAskedProject(proj)
      expect(mirror.pass({ project: proj, cls: 'Wp', scope: 'once' })).toBe(true)
      expect(readPolicy().projects).toEqual([proj])

      at += LAUNCHER_PASS_TTL_MS + 2
      vi.advanceTimersByTime(LAUNCHER_PASS_TTL_MS + 2)
      expect(readPolicy().projects).toEqual([])
      expect(readPolicy().asked).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('fx19: the folder list follows the store and the grant that kept a folder', () => {
  const fresh = (name: string) => {
    const folder = path.join(root, name)

    mkdirSync(folder, { recursive: true })

    return realpathSync(folder)
  }

  it('Allow this folder in an unsealed run: top-level list has it, the clamped modes stay {}', () => {
    const proj = fresh('allowed')
    const mirror = createLauncherPolicyMirror(ledger, () => undefined)

    mirror.publish(body({ projects: {}, folders: [proj] }))

    expect(readPolicy().projects).toContain(proj)
    expect(readPolicy().body.projects).toEqual({})
    expect(readPolicy().asked).toEqual([])
  })

  it('a folder the store lists is not an asked folder: the prune never drops it', () => {
    const proj = fresh('both')
    const mirror = createLauncherPolicyMirror(ledger, () => undefined)

    mirror.publish(body({ folders: [proj] }))
    mirror.noteAskedProject(proj)
    expect(readPolicy().asked).toEqual([])
    mirror.prune()
    expect(readPolicy().projects).toContain(proj)
  })

  it('an allow for this session lists its folder while its grant lives, past the pass, and not after', () => {
    const proj = fresh('session')
    let at = 1_000_000
    const mirror = createLauncherPolicyMirror(ledger, () => undefined, () => at)
    const grant = { id: 'g-session', cls: 'X', project: null, scope: 'session', sessionId: 's1' }

    mirror.publish(body({ grants: [grant] as never }))
    mirror.noteAskedProject(proj, 'g-session')
    mirror.pass({ project: proj, cls: 'X', scope: 'session' })

    at += LAUNCHER_PASS_TTL_MS + 1000
    mirror.prune()
    expect(readPolicy().projects).toContain(proj)
    expect(readPolicy().asked).toEqual([proj])

    // The user removes the grant: the same publish takes the folder away.
    mirror.publish(body({ grants: [] }))
    expect(readPolicy().projects).not.toContain(proj)
    expect(readPolicy().asked).toEqual([])
  })

  it('the answer as the authority reports it: the session grant travels with the folder; a sheet not shown lists nothing', () => {
    const shownFolder = fresh('answer-shown')
    const hidden = fresh('answer-hidden')
    let at = 1_000_000
    const mirror = createLauncherPolicyMirror(ledger, () => undefined, () => at)
    const grant = { id: 'g-answer', cls: 'X', project: null, scope: 'session', sessionId: 's1' }

    mirror.publish(body({ grants: [grant] as never }))
    mirror.noteAllowedAsk({ project: shownFolder, cls: 'X', scope: 'session', shown: true, grantId: 'g-answer' })
    mirror.noteAllowedAsk({ project: hidden, cls: 'X', scope: 'once', shown: false, grantId: null })
    expect(readPolicy().asked).toEqual([shownFolder])

    at += LAUNCHER_PASS_TTL_MS + 1000
    mirror.prune()
    expect(readPolicy().asked).toEqual([shownFolder])
  })

  it('a one-time allow still drops after its pass, whatever other grants live', () => {
    const proj = fresh('once')
    let at = 1_000_000
    const mirror = createLauncherPolicyMirror(ledger, () => undefined, () => at)
    const other = { id: 'g-other', cls: 'X', project: null, scope: 'session', sessionId: 's1' }

    mirror.publish(body({ grants: [other] as never }))
    mirror.noteAskedProject(proj, null)
    mirror.pass({ project: proj, cls: 'X', scope: 'once' })
    at += LAUNCHER_PASS_TTL_MS + 1000
    mirror.prune()
    expect(readPolicy().projects).not.toContain(proj)
  })
})
