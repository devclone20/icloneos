import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  appendFileInRoot,
  appendFileInRootAsync,
  chmodFileInRoot,
  chmodFolderInRoot,
  copyFileFromRoot,
  copyFileFromRootAsync,
  isRefusedPath,
  lstatInRoot,
  mkdirsInRoot,
  pinRoot,
  readdirInRoot,
  readFileInRoot,
  readHeaderInRoot,
  renameInRoot,
  resolveInRoot,
  unlinkInRoot,
  writeFileInRoot
} from './no-follow-fs'

const posix = process.platform !== 'win32'

describe.runIf(posix)('no-follow-fs', () => {
  let base: string
  let root: string
  let outside: string
  let secret: string
  const ORIGINAL = 'secret-bytes\n'

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nofollow-')))
    root = path.join(base, 'root')
    outside = path.join(base, 'outside')
    secret = path.join(outside, 'secret')
    fs.mkdirSync(root)
    fs.mkdirSync(outside)
    fs.writeFileSync(secret, ORIGINAL, { mode: 0o640 })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(base, { force: true, recursive: true })
  })

  const at = (...parts: string[]) => path.join(root, ...parts)

  const secretUntouched = () => {
    expect(fs.readFileSync(secret, 'utf8')).toBe(ORIGINAL)
    expect(fs.statSync(secret).mode & 0o777).toBe(0o640)
  }

  const refuses = (run: () => unknown) => {
    let thrown: unknown

    try {
      run()
    } catch (error) {
      thrown = error
    }

    expect(isRefusedPath(thrown), String(thrown)).toBe(true)
  }

  const plants: Record<string, (file: string) => void> = {
    link: file => fs.symlinkSync(secret, file),
    'dangling link': file => fs.symlinkSync(path.join(outside, 'created-by-main'), file),
    FIFO: file => execFileSync('/usr/bin/mkfifo', [file]),
    directory: file => fs.mkdirSync(file),
    'hard link': file => fs.linkSync(secret, file)
  }

  const fileOps: Record<string, (file: string) => unknown> = {
    read: file => readFileInRoot(root, file),
    header: file => readHeaderInRoot(root, file, 4),
    append: file => appendFileInRoot(root, file, 'x'),
    write: file => writeFileInRoot(root, file, 'x'),
    chmod: file => chmodFileInRoot(root, file, 0o777),
    'copy from': file => copyFileFromRoot(root, file, at('copied'))
  }

  for (const [plantName, plant] of Object.entries(plants)) {
    for (const [opName, op] of Object.entries(fileOps)) {
      // Opening a dangling link to read answers ELOOP as well: every cell of the table is a refusal.
      it(`${opName} refuses a ${plantName}, and its target is untouched`, () => {
        plant(at('planted'))
        refuses(() => op(at('planted')))
        secretUntouched()
        expect(fs.existsSync(path.join(outside, 'created-by-main'))).toBe(false)
        expect(fs.existsSync(at('copied'))).toBe(false)
      })
    }

    it(`async append refuses a ${plantName}`, async () => {
      plant(at('planted'))
      await expect(appendFileInRootAsync(root, at('planted'), 'x')).rejects.toSatisfy(isRefusedPath)
      secretUntouched()
    })

    it(`async copy refuses a ${plantName}`, async () => {
      plant(at('planted'))
      await expect(copyFileFromRootAsync(root, at('planted'), path.join(base, 'copy'))).rejects.toSatisfy(isRefusedPath)
      expect(fs.existsSync(path.join(base, 'copy'))).toBe(false)
    })
  }

  it('a copy never lands on a planted destination', () => {
    fs.writeFileSync(at('source'), 'ok')
    fs.symlinkSync(secret, at('dest'))
    expect(() => copyFileFromRoot(root, at('source'), at('dest'))).toThrow()
    secretUntouched()
  })

  it('a link as a parent is refused by every operation', () => {
    fs.symlinkSync(outside, at('logs'))
    const through = at('logs', 'secret')

    for (const op of Object.values(fileOps)) {
      refuses(() => op(through))
    }

    refuses(() => unlinkInRoot(root, through))
    refuses(() => renameInRoot(root, through, at('moved')))
    refuses(() => renameInRoot(root, at('nothing'), through))
    refuses(() => mkdirsInRoot(root, at('logs', 'deeper')))
    refuses(() => lstatInRoot(root, through))
    refuses(() => readdirInRoot(root, at('logs')))
    secretUntouched()
    expect(fs.existsSync(path.join(outside, 'deeper'))).toBe(false)
  })

  it('the kernel refuses a parent swapped after the check: the guarantee is the descriptor, not the lstat', () => {
    fs.symlinkSync(outside, at('logs'))
    const real = fs.lstatSync
    // Exactly the window of a swap: every check saw a real folder, the link is there at open.
    vi.spyOn(fs, 'lstatSync').mockImplementation(((file: fs.PathLike) =>
      String(file) === at('logs') ? real(outside) : real(file)) as typeof fs.lstatSync)

    refuses(() => appendFileInRoot(root, at('logs', 'secret'), 'x'))
    refuses(() => writeFileInRoot(root, at('logs', 'secret'), 'x'))
    refuses(() => readFileInRoot(root, at('logs', 'secret')))
    secretUntouched()
  })

  it('a root replaced by a link after the pin is refused; the first real path stands', () => {
    pinRoot(root)
    fs.renameSync(root, `${root}.aside`)
    fs.symlinkSync(outside, root)

    refuses(() => appendFileInRoot(root, at('secret'), 'x'))
    secretUntouched()
    fs.unlinkSync(root)
    fs.renameSync(`${root}.aside`, root)
  })

  it('refuses what lies outside the root, and the root itself', () => {
    refuses(() => readFileInRoot(root, secret))
    refuses(() => appendFileInRoot(root, at('..', 'outside', 'secret'), 'x'))
    refuses(() => resolveInRoot(root, root))
    secretUntouched()
  })

  it('a dangling link or a file in the way of mkdirs is refused, and nothing is created at its target', () => {
    fs.symlinkSync(path.join(outside, 'made'), at('logs'))
    refuses(() => mkdirsInRoot(root, at('logs')))
    expect(fs.existsSync(path.join(outside, 'made'))).toBe(false)
    fs.writeFileSync(at('file'), '')
    refuses(() => mkdirsInRoot(root, at('file', 'below')))
  })

  it('removes and renames the entry itself when it is a link: its target stays', () => {
    fs.symlinkSync(secret, at('a'))
    renameInRoot(root, at('a'), at('b'))
    expect(fs.lstatSync(at('b')).isSymbolicLink()).toBe(true)
    unlinkInRoot(root, at('b'))
    expect(fs.existsSync(at('b'))).toBe(false)
    unlinkInRoot(root, at('b'))
    secretUntouched()
  })

  it('plain files work, end to end, sync and async', async () => {
    mkdirsInRoot(root, at('logs', 'deep'))
    mkdirsInRoot(root, at('logs', 'deep'))
    const file = at('logs', 'deep', 'f')

    appendFileInRoot(root, file, 'one\n')
    await appendFileInRootAsync(root, file, 'two\n')
    expect(readFileInRoot(root, file).toString()).toBe('one\ntwo\n')
    expect(readHeaderInRoot(root, file, 3).toString()).toBe('one')
    expect(readHeaderInRoot(root, file, 99).toString()).toBe('one\ntwo\n')
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)

    writeFileInRoot(root, file, 'new')
    expect(readFileInRoot(root, file).toString()).toBe('new')
    expect(lstatInRoot(root, file)?.size).toBe(3)
    expect(lstatInRoot(root, at('none'))).toBeNull()
    expect(readdirInRoot(root, at('logs', 'deep')).map(e => e.name)).toEqual(['f'])
    expect(readdirInRoot(root, at('absent'))).toEqual([])

    copyFileFromRoot(root, file, at('c1'))
    await copyFileFromRootAsync(root, file, path.join(base, 'c2'))
    expect(fs.readFileSync(at('c1'), 'utf8')).toBe('new')
    expect(fs.readFileSync(path.join(base, 'c2'), 'utf8')).toBe('new')

    chmodFileInRoot(root, file, 0o640)
    expect(fs.statSync(file).mode & 0o777).toBe(0o640)
    chmodFolderInRoot(root, at('logs'), 0o750)
    expect(fs.statSync(at('logs')).mode & 0o777).toBe(0o750)
  })

  it('chmod of a folder refuses a link to a folder', () => {
    fs.symlinkSync(outside, at('tmp'))
    const before = fs.statSync(outside).mode

    refuses(() => chmodFolderInRoot(root, at('tmp'), 0o700))
    expect(fs.statSync(outside).mode).toBe(before)
  })

  it('a refusal says what it found and the way out, in words', () => {
    plants.link(at('planted'))
    expect(() => readFileInRoot(root, at('planted'))).toThrow(
      /a symbolic link \(the app never follows links or special files in the agent's home; replace it with a plain file\)/
    )
    plants.FIFO(at('fifo'))
    expect(() => appendFileInRoot(root, at('fifo'), 'x')).toThrow(/a pipe with no reader/)
    expect(() => readFileInRoot(root, at('fifo'))).toThrow(/not a regular file \(a pipe/)
    plants['hard link'](at('hard'))
    expect(() => readFileInRoot(root, at('hard'))).toThrow(/a hard link \(the app never follows/)
    expect(() => readFileInRoot(root, outside)).toThrow(/outside .*root$/)
  })

  it('a file larger than the copy chunk comes across whole', () => {
    const big = Buffer.alloc(2.5 * 1024 * 1024, 7)

    fs.writeFileSync(at('big'), big)
    copyFileFromRoot(root, at('big'), at('big2'))
    expect(fs.readFileSync(at('big2')).equals(big)).toBe(true)
  })
})
