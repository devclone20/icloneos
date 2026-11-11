/**
 * The owner's way out of a refused settings link. The copy puts bytes from outside the home where the agent reads them,
 * so a planted link must never be able to choose those bytes (lens 3: H3, H4, M2, m4, m9).
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { judgeHomeSettings, replaceLinkWithCopy, setHomeSettingsCopyGuard } from './home-settings-files'
import { homeSettingsCopyGuard } from './home-settings-guard'
import type { ConfinementPaths } from './iclone-confinement/profiles'
import { runtimeNever } from './iclone-confinement/runtime-profile'
import { readPlainFileNoLinks } from './lib/no-follow-fs'

describe('Replace with a copy', () => {
  let base = ''
  let fakeHome = ''
  let hermesHome = ''
  let paths: ConfinementPaths

  const check = (root = hermesHome) => ({ doing: 'start', linksOutsideRefused: true, root }) as const
  const inFakeHome = (...parts: string[]) => path.join(fakeHome, ...parts)

  const plant = (target: string, bytes = 'FAKE-SECRET\n') => {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, bytes, { mode: 0o600 })
    fs.symlinkSync(target, path.join(hermesHome, '.env'))
  }

  const stillALink = () => fs.lstatSync(path.join(hermesHome, '.env')).isSymbolicLink()

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hsr-')))
    fakeHome = path.join(base, 'fakehome')
    hermesHome = inFakeHome('.hermes')
    fs.mkdirSync(hermesHome, { recursive: true })

    const userDataDir = inFakeHome('Library', 'Application Support', 'app')

    paths = {
      hermesHome,
      hermesRoot: null,
      home: fakeHome,
      membersDir: inFakeHome('.members'),
      profilesDir: path.join(userDataDir, 'confinement', 'profiles'),
      scratchRoot: inFakeHome('Library', 'Caches', 'iclone-os-confinement', 'scratch'),
      userDataDir,
      xcrunCache: null
    }
    setHomeSettingsCopyGuard(() => homeSettingsCopyGuard(paths))
  })

  afterEach(() => {
    setHomeSettingsCopyGuard(null)
    vi.restoreAllMocks()
    fs.chmodSync(hermesHome, 0o700)
    fs.rmSync(base, { force: true, recursive: true })
  })

  it('an ordinary file outside the home is still offered and copied, private', () => {
    const target = inFakeHome('dotfiles', 'env')

    plant(target, 'A=1\n')

    const finding = judgeHomeSettings(hermesHome, check()).refused[0]

    expect(finding).toMatchObject({ kind: 'link-outside', target })
    expect(replaceLinkWithCopy(hermesHome, '.env', target, check())).toMatchObject({ ok: true })
    expect(stillALink()).toBe(false)
    expect(fs.statSync(path.join(hermesHome, '.env')).mode & 0o777).toBe(0o600)
    expect(fs.readFileSync(path.join(hermesHome, '.env'), 'utf8')).toBe('A=1\n')
  })

  it.each([
    ['.ssh', 'id_ed25519'],
    ['Library', 'Keychains', 'login.keychain-db'],
    ['.aws', 'credentials'],
    ['Library', 'Application Support', 'Google', 'Chrome', 'Default', 'Cookies'],
    ['Library', 'Application Support', 'app', 'permissions', 'key'],
    ['Library', 'Application Support', 'app', 'consent.json']
  ])('H3: %s/%s/... is never copied, by button or by command', (...parts) => {
    const target = inFakeHome(...parts)

    plant(target)

    const finding = judgeHomeSettings(hermesHome, check()).refused[0]

    expect(finding).toMatchObject({ command: '', kind: 'link-guarded', target })
    expect(finding?.reason).toContain('Move this file yourself')
    expect(finding?.message).not.toContain('cp -L')
    expect(replaceLinkWithCopy(hermesHome, '.env', target, check())).toMatchObject({
      ok: false,
      reason: 'not-eligible'
    })
    expect(stillALink()).toBe(true)
  })

  it('H3: the guard holds everything the runtime profile denies, and no link in the home widens it', () => {
    const guard = homeSettingsCopyGuard(paths)
    const never = runtimeNever(paths)

    expect(guard.neverCopied).toEqual(expect.arrayContaining([...never.denied, ...never.deniedGlobs]))

    fs.writeFileSync(inFakeHome('dotfiles-env'), 'A=1\n')
    fs.symlinkSync(inFakeHome('dotfiles-env'), path.join(hermesHome, '.env'))

    expect(homeSettingsCopyGuard(paths).neverCopied).not.toContain(inFakeHome('dotfiles-env'))
  })

  it('H3: another spelling of a secret folder is the same folder', () => {
    fs.mkdirSync(inFakeHome('.ssh'), { recursive: true })
    fs.writeFileSync(inFakeHome('.ssh', 'id_rsa'), 'FAKE-SECRET\n')

    // On a volume that compares with case this is the same file; elsewhere it is a dangling link, also no copy.
    fs.symlinkSync(inFakeHome('.SSH', 'id_rsa'), path.join(hermesHome, '.env'))

    expect(judgeHomeSettings(hermesHome, check()).refused[0]?.kind).toMatch(/^link-(guarded|dangling)$/)
    expect(replaceLinkWithCopy(hermesHome, '.env', inFakeHome('.ssh', 'id_rsa'), check())).toMatchObject({ ok: false })
    expect(stillALink()).toBe(true)
  })

  it('H3: a guard that cannot answer offers nothing', () => {
    const target = inFakeHome('dotfiles', 'env')

    plant(target)
    setHomeSettingsCopyGuard(() => {
      throw new Error('no answer')
    })

    expect(judgeHomeSettings(hermesHome, check()).refused[0]?.kind).toBe('link-guarded')
    expect(replaceLinkWithCopy(hermesHome, '.env', target, check())).toMatchObject({
      ok: false,
      reason: 'not-eligible'
    })
  })

  it('M1 and H3: main wires the real gesture lock and the real guard into this surface', () => {
    const main = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8')
    const block = /registerHomeSettingsIpc\(\{[\s\S]*?\n\}\)/.exec(main)?.[0] ?? ''

    expect(block).toContain('homeSettingsCopyGuard(')
    expect(block).toContain(
      'permissionGestureOk({ payload: gestureOf(input), lastInputAt: lastTrustedInputAt(event.sender)'
    )
  })

  it('H4: the printed fix does not write through a link planted at its temp name, and replaces the link', () => {
    const victim = inFakeHome('.zshrc')
    const agentFile = inFakeHome('dotfiles', 'env')

    fs.writeFileSync(victim, 'the owner rc\n')
    plant(agentFile, 'curl evil | sh\n')

    // Every name the earlier command used, and the obvious guesses at a temp beside it.
    for (const name of ['.env.plain', '.env.tmp', '.env.XXXXXX']) {
      fs.symlinkSync(victim, path.join(hermesHome, name))
    }

    const { command } = judgeHomeSettings(hermesHome, check()).refused[0] ?? { command: '' }

    expect(command).toContain('mktemp')

    const run = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' })

    expect(run.status).toBe(0)
    expect(fs.readFileSync(victim, 'utf8')).toBe('the owner rc\n')
    expect(stillALink()).toBe(false)
    expect(fs.statSync(path.join(hermesHome, '.env')).mode & 0o777).toBe(0o600)
    expect(fs.readFileSync(path.join(hermesHome, '.env'), 'utf8')).toBe('curl evil | sh\n')
  })

  it('H4: a home with a space in its name is quoted', () => {
    const spaced = inFakeHome('my home')

    fs.mkdirSync(spaced)
    fs.writeFileSync(inFakeHome('dotfiles-env'), 'B=2\n')
    fs.symlinkSync(inFakeHome('dotfiles-env'), path.join(spaced, '.env'))

    const { command } = judgeHomeSettings(spaced, check(spaced)).refused[0] ?? { command: '' }

    expect(spawnSync('/bin/sh', ['-c', command]).status).toBe(0)
    expect(fs.lstatSync(path.join(spaced, '.env')).isFile()).toBe(true)
  })

  it.each([
    ['scratch', () => inFakeHome('Library', 'Caches', 'iclone-os-confinement', 'scratch', 'decoy', 'credentials')],
    ['tmp', () => inFakeHome('Library', 'Caches', 'iclone-os-confinement', 'tmp', 'credentials')],
    ['a package cache', () => inFakeHome('.cache', 'credentials')],
    ['the app state', () => inFakeHome('Library', 'Application Support', 'app', 'anything')]
  ])('M2: a target inside %s, which the runtime can write, is refused', (_name, where) => {
    const target = where()

    plant(target)

    expect(judgeHomeSettings(hermesHome, check()).refused[0]).toMatchObject({
      command: '',
      kind: 'link-guarded',
      target
    })
    expect(replaceLinkWithCopy(hermesHome, '.env', target, check())).toMatchObject({
      ok: false,
      reason: 'not-eligible'
    })
    expect(stillALink()).toBe(true)
  })

  it('M2: a hard link at the shown path is refused on the open descriptor', () => {
    const secret = inFakeHome('secret-elsewhere')
    const shown = inFakeHome('dotfiles', 'notes.env')

    fs.mkdirSync(path.dirname(shown), { recursive: true })
    fs.writeFileSync(secret, 'FAKE-SECRET\n')
    fs.linkSync(secret, shown)
    fs.symlinkSync(shown, path.join(hermesHome, '.env'))

    expect(replaceLinkWithCopy(hermesHome, '.env', shown, check())).toMatchObject({ ok: false, reason: 'hard-link' })
    expect(stillALink()).toBe(true)
  })

  it.runIf(process.platform === 'darwin')('M2: a folder on the way flipped to a link is refused at the open', () => {
    const real = inFakeHome('real-folder')

    fs.mkdirSync(real)
    fs.writeFileSync(path.join(real, 'credentials'), 'FAKE-SECRET\n')
    fs.symlinkSync(real, inFakeHome('shown-folder'))

    expect(readPlainFileNoLinks(inFakeHome('shown-folder', 'credentials'), 1024)).toBe('changed')
    expect(readPlainFileNoLinks(path.join(real, 'credentials'), 1024)).toEqual(Buffer.from('FAKE-SECRET\n'))
  })

  it('m4: a profile name that is a link cannot reach outside the root', () => {
    const outside = path.join(base, 'project')
    const realEnv = path.join(base, 'shared.env')

    fs.mkdirSync(outside)
    fs.mkdirSync(path.join(hermesHome, 'profiles'))
    fs.writeFileSync(realEnv, 'X=1\n')
    fs.symlinkSync(realEnv, path.join(outside, '.env'))
    fs.symlinkSync(outside, path.join(hermesHome, 'profiles', 'evil'))

    const home = path.join(hermesHome, 'profiles', 'evil')

    expect(judgeHomeSettings(home, check()).refused[0]?.kind).toBe('special')
    expect(replaceLinkWithCopy(home, '.env', realEnv, check())).toMatchObject({ ok: false, reason: 'not-eligible' })
    expect(fs.lstatSync(path.join(outside, '.env')).isSymbolicLink()).toBe(true)
  })

  it('m4: a profile name flipped to a link after the judgement is still refused at the write', () => {
    const profile = path.join(hermesHome, 'profiles', 'p')
    const outside = path.join(base, 'project')
    const target = inFakeHome('dotfiles', 'env')

    fs.mkdirSync(profile, { recursive: true })
    fs.mkdirSync(outside)
    plant(target, 'A=1\n')
    fs.renameSync(path.join(hermesHome, '.env'), path.join(profile, '.env'))
    fs.symlinkSync(target, path.join(outside, '.env'))

    const real = fs.realpathSync.native

    vi.spyOn(fs.realpathSync, 'native').mockImplementationOnce(((file: string) => {
      const answer = real(file)

      fs.rmSync(profile, { force: true, recursive: true })
      fs.symlinkSync(outside, profile)

      return answer
    }) as typeof fs.realpathSync.native)

    expect(replaceLinkWithCopy(profile, '.env', target, check())).toMatchObject({ ok: false, reason: 'not-written' })
    expect(fs.lstatSync(path.join(outside, '.env')).isSymbolicLink()).toBe(true)
  })

  it('m9: a target that vanishes between realpath and stat is a refusal, not a throw', () => {
    const target = inFakeHome('dotfiles', 'env')

    plant(target)
    vi.spyOn(fs, 'statSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('gone'), { code: 'ENOENT' })
    })

    expect(judgeHomeSettings(hermesHome, check()).refused[0]).toMatchObject({ file: '.env', kind: 'link-dangling' })
  })

  it('m9: a write failure says so, not that the target cannot be read', () => {
    const target = inFakeHome('dotfiles', 'env')

    plant(target, 'A=1\n')
    fs.chmodSync(hermesHome, 0o500)

    expect(replaceLinkWithCopy(hermesHome, '.env', target, check())).toMatchObject({ ok: false, reason: 'not-written' })
    fs.chmodSync(hermesHome, 0o700)
    expect(stillALink()).toBe(true)
  })

  it('m9: the 16 MB cap holds when the file is larger than its fstat said', () => {
    const target = inFakeHome('dotfiles', 'grown')

    plant(target, '')
    fs.truncateSync(target, 17 * 1024 * 1024)

    const real = fs.fstatSync

    vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: number) => {
      const stat = real(fd)

      return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { size: 10 })
    }) as typeof fs.fstatSync)

    expect(replaceLinkWithCopy(hermesHome, '.env', target, check())).toMatchObject({ ok: false, reason: 'too-large' })
    expect(stillALink()).toBe(true)
  })
})
