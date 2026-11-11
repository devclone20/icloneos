/**
 * Every unconfined writer of a path the confined runtime can write, against what the runtime can plant there.
 * The helper's own table is lib/no-follow-fs.test.ts; the Seatbelt end of it is iclone-confinement/runtime-home-links.live.test.ts.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ hermesHome: '', userData: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => h.userData, isPackaged: false },
  ipcMain: { handle: vi.fn() }
}))
vi.mock('./main/env', () => ({
  get HERMES_HOME() {
    return h.hermesHome
  },
  IS_PACKAGED: false,
  updatePolicyOverrideFile: () => path.join(h.userData, 'no-override.json')
}))

const ORIGINAL = 'secret-bytes\n'

describe.runIf(process.platform !== 'win32')('unconfined writers against a planted path', () => {
  let base: string
  let home: string
  let outside: string
  let secret: string

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nofollow-sites-')))
    home = path.join(base, 'home')
    outside = path.join(base, 'outside')
    secret = path.join(outside, 'secret')
    h.hermesHome = home
    h.userData = path.join(base, 'userData')
    fs.mkdirSync(home)
    fs.mkdirSync(outside)
    fs.mkdirSync(h.userData)
    fs.writeFileSync(secret, ORIGINAL, { mode: 0o640 })
  })

  afterEach(() => {
    fs.rmSync(base, { force: true, recursive: true })
    vi.resetModules()
  })

  const untouched = () => {
    expect(fs.readFileSync(secret, 'utf8')).toBe(ORIGINAL)
    expect(fs.statSync(secret).mode & 0o777).toBe(0o640)
    expect(fs.readdirSync(outside)).toEqual(['secret'])
  }

  const plants: Record<string, (file: string) => void> = {
    symlink: file => fs.symlinkSync(secret, file),
    'dangling symlink': file => fs.symlinkSync(path.join(outside, 'created'), file),
    FIFO: file => execFileSync('/usr/bin/mkfifo', [file]),
    directory: file => fs.mkdirSync(file)
  }

  for (const [name, plant] of Object.entries(plants)) {
    describe(`a ${name}`, () => {
      it('at desktop.log: the flush returns, nothing leaves, the line stays in memory, one record', async () => {
        const log = await import('./main/log')

        fs.mkdirSync(path.join(home, 'logs'))
        plant(log.DESKTOP_LOG_PATH)
        log.rememberLog('site-line')
        log.flushDesktopLogBufferSync()

        const record = path.join(h.userData, 'desktop-log-refused.json')

        expect(fs.readFileSync(record, 'utf8').trim().split('\n')).toHaveLength(1)
        fs.rmSync(record)
        log.rememberLog('site-line-2')
        log.flushDesktopLogBufferSync()

        untouched()
        expect(log.hermesLog.join('\n')).toContain('site-line-2')
        expect(fs.existsSync(record)).toBe(false)
      })

      it('at desktop.log, async path: the flush settles without leaving', async () => {
        const log = await import('./main/log')

        fs.mkdirSync(path.join(home, 'logs'))
        plant(log.DESKTOP_LOG_PATH)
        vi.useFakeTimers()
        log.rememberLog('async-line')
        await vi.advanceTimersByTimeAsync(200)
        vi.useRealTimers()
        await new Promise(done => setImmediate(done))
        untouched()
      })

      it('at the update marker: read says no update, write leaves the target', async () => {
        const { readLiveUpdateMarker, writeUpdateMarker } = await import('./update-marker')
        const file = path.join(home, '.hermes-update-in-progress')

        plant(file)
        fs.writeFileSync(secret, `${process.pid}\n${Math.floor(Date.now() / 1000)}\n`)
        const links = fs.lstatSync(file).isSymbolicLink() && fs.readlinkSync(file) === secret

        expect(readLiveUpdateMarker(home)).toBeNull()
        fs.writeFileSync(secret, ORIGINAL)
        writeUpdateMarker(home, 42)
        untouched()
        expect(links || !fs.lstatSync(file).isSymbolicLink() || fs.readlinkSync(file) !== secret).toBe(true)
      })

      it('at the hand-off result: nothing comes back through it', async () => {
        const { readAndConsumeHandoffResult } = await import('./handoff-result')

        plant(path.join(home, '.hermes-update-result.json'))
        fs.writeFileSync(secret, JSON.stringify({ status: 'ok', at: Date.now() }))
        expect(readAndConsumeHandoffResult(home)).toBeNull()
        fs.writeFileSync(secret, ORIGINAL)
        untouched()
      })

      it('at a doctor chmod and its backup: the mode and bytes of the target stay', async () => {
        const { applySteps } = await import('./iclone-doctor-fixes')
        const file = path.join(home, 'config.yaml')

        plant(file)

        const outcome = await applySteps(
          { hermesHome: home, now: () => new Date() } as never,
          'test.fix',
          [{ kind: 'chmod', path: file, mode: 0o777 }],
          path.join(h.userData, 'backups')
        )

        expect(outcome.error).toBeTruthy()
        untouched()
      })

      it('in a profile the archive copies: the target never reaches the archive', async () => {
        const { copyTree } = await import('./iclone-ownership')
        const profile = path.join(home, 'profiles', 'p')
        const dest = path.join(base, 'archive')
        const budget = { files: 0, skipped: [] }

        fs.mkdirSync(profile, { recursive: true })
        fs.writeFileSync(path.join(profile, 'real.txt'), 'real')
        plant(path.join(profile, 'planted.txt'))
        copyTree(home, profile, dest, budget)

        expect(fs.readFileSync(path.join(dest, 'real.txt'), 'utf8')).toBe('real')
        expect(fs.existsSync(path.join(dest, 'planted.txt')) && fs.lstatSync(path.join(dest, 'planted.txt')).isFile()).toBe(false)
      })

      it('over an installed skill file: replaced by the bundled bytes, its target untouched, the boot not hung', async () => {
        const { syncSkillTrees } = await import('./iclone-skills')
        const source = path.join(base, 'source')
        const skill = path.join(source, 'alpha')

        fs.mkdirSync(skill, { recursive: true })
        fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: alpha\ndescription: d\n---\nbody\n')
        syncSkillTrees({ sourceDir: source, hermesHome: home, stamp: 'one' })
        const target = path.join(home, 'skills')
        const installed = execFileSync('/usr/bin/find', [target, '-name', 'SKILL.md'], { encoding: 'utf8' }).trim().split('\n')[0]

        fs.rmSync(installed)
        plant(installed)
        syncSkillTrees({ sourceDir: source, hermesHome: home, stamp: 'two' })
        untouched()
      })
    })
  }

  it('a profile folder that is itself a link is not listed: the archive stays empty', async () => {
    const { copyTree } = await import('./iclone-ownership')
    const budget = { files: 0, skipped: [] }

    fs.mkdirSync(path.join(home, 'profiles'))
    fs.symlinkSync(outside, path.join(home, 'profiles', 'p'))
    copyTree(home, path.join(home, 'profiles', 'p'), path.join(base, 'archive'), budget)

    expect(fs.existsSync(path.join(base, 'archive', 'secret'))).toBe(false)
  })

  it('a link in place of the skills category folder receives no bundled file', async () => {
    const { syncSkillTrees } = await import('./iclone-skills')
    const source = path.join(base, 'source', 'alpha')

    fs.mkdirSync(source, { recursive: true })
    fs.writeFileSync(path.join(source, 'SKILL.md'), '---\nname: alpha\ndescription: d\n---\nbody\n')
    fs.mkdirSync(path.join(home, 'skills'))
    syncSkillTrees({ sourceDir: path.dirname(source), hermesHome: home, stamp: 'one' })
    const category = fs.readdirSync(path.join(home, 'skills'))[0]

    fs.rmSync(path.join(home, 'skills', category), { recursive: true })
    fs.symlinkSync(outside, path.join(home, 'skills', category))
    const report = syncSkillTrees({ sourceDir: path.dirname(source), hermesHome: home, stamp: 'two' })

    expect(report.ok).toBe(false)
    untouched()
  })

  it('rotation: a link among the backups is moved or removed as a link, its target stays', async () => {
    const log = await import('./main/log')

    fs.mkdirSync(path.join(home, 'logs'))
    fs.writeFileSync(log.DESKTOP_LOG_PATH, Buffer.alloc(11 * 1024 * 1024))
    fs.symlinkSync(secret, `${log.DESKTOP_LOG_PATH}.1`)
    fs.symlinkSync(secret, `${log.DESKTOP_LOG_PATH}.3`)
    log.rememberLog('after-rotation')
    log.flushDesktopLogBufferSync()

    untouched()
    expect(fs.statSync(log.DESKTOP_LOG_PATH).size).toBeLessThan(1024)
    expect(fs.lstatSync(`${log.DESKTOP_LOG_PATH}.1`).size).toBe(11 * 1024 * 1024)
    expect(fs.lstatSync(`${log.DESKTOP_LOG_PATH}.2`).isSymbolicLink()).toBe(true)
  })

  it('a plain log and a plain marker keep working', async () => {
    const log = await import('./main/log')
    const { readLiveUpdateMarker, writeUpdateMarker } = await import('./update-marker')

    log.rememberLog('plain-line')
    log.flushDesktopLogBufferSync()
    expect(fs.readFileSync(log.DESKTOP_LOG_PATH, 'utf8')).toContain('plain-line')
    expect(fs.existsSync(path.join(h.userData, 'desktop-log-refused.json'))).toBe(false)

    writeUpdateMarker(home, process.pid)
    expect(readLiveUpdateMarker(home)?.pid).toBe(process.pid)
  })
})
