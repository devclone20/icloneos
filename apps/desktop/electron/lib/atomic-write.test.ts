import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough, Readable } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_DIR_MODE,
  DEFAULT_FILE_MODE,
  isAtomicTempName,
  replaceDirAtomicSync,
  writeFileAtomic,
  writeFileAtomicSync,
  writeStreamAtomic
} from './atomic-write'

const POSIX = process.platform !== 'win32'
let root = ''

const modeOf = (file: string) => fs.statSync(file).mode & 0o777
const leftovers = (dir: string) => fs.readdirSync(dir).filter(name => name.endsWith('.tmp'))

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'iclone-atomic-'))
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(root, { force: true, recursive: true })
})

describe.each([
  [
    'sync',
    async (file: string, data: string | Uint8Array, options?: { dirMode?: number; mode?: number }) => {
      writeFileAtomicSync(file, data, options)
    }
  ],
  ['async', writeFileAtomic]
] as const)('writeFileAtomic (%s)', (_name, write) => {
  it('creates missing parents (private) and a private file by default', async () => {
    const file = path.join(root, 'a', 'b', 'state.json')

    await write(file, 'hello')
    expect(fs.readFileSync(file, 'utf8')).toBe('hello')

    if (POSIX) {
      expect(modeOf(file)).toBe(DEFAULT_FILE_MODE)
      expect(modeOf(path.join(root, 'a'))).toBe(DEFAULT_DIR_MODE)
    }

    expect(leftovers(path.dirname(file))).toEqual([])
  })

  it('writes bytes as-is and replaces existing content', async () => {
    const file = path.join(root, 'blob.bin')

    await write(file, 'old content that is longer')
    await write(file, new Uint8Array([0, 255, 10]))
    expect([...fs.readFileSync(file)]).toEqual([0, 255, 10])
  })

  it.runIf(POSIX)('preserves the mode of the file it replaces', async () => {
    const file = path.join(root, 'config.yaml')

    fs.writeFileSync(file, 'x')
    fs.chmodSync(file, 0o644)
    await write(file, 'y')
    expect(modeOf(file)).toBe(0o644)
  })

  it.runIf(POSIX)('applies an explicit mode exactly, whatever the umask or the old mode', async () => {
    const file = path.join(root, 'secret')

    fs.writeFileSync(file, 'x')
    fs.chmodSync(file, 0o666)
    await write(file, 'y', { mode: 0o640 })
    expect(modeOf(file)).toBe(0o640)
  })

  it.runIf(POSIX)('honours dirMode for directories it creates', async () => {
    const file = path.join(root, 'shared', 'x.txt')

    await write(file, 'z', { dirMode: 0o750 })
    expect(modeOf(path.join(root, 'shared'))).toBe(0o750)
  })

  it.runIf(POSIX)('replaces a symlink at the path instead of writing through it', async () => {
    const victim = path.join(root, 'victim.txt')
    const link = path.join(root, 'link.txt')

    fs.writeFileSync(victim, 'untouched')
    fs.chmodSync(victim, 0o644)
    fs.symlinkSync(victim, link)
    await write(link, 'new')
    expect(fs.readFileSync(victim, 'utf8')).toBe('untouched')
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(false)
    expect(modeOf(link)).toBe(DEFAULT_FILE_MODE)
  })

  it('cleans the temp file and keeps the old content when the rename fails', async () => {
    const file = path.join(root, 'keep.txt')

    fs.writeFileSync(file, 'old')
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('rename failed')
    })
    vi.spyOn(fs.promises, 'rename').mockRejectedValue(new Error('rename failed'))
    await expect(write(file, 'new')).rejects.toThrow('rename failed')
    expect(fs.readFileSync(file, 'utf8')).toBe('old')
    expect(leftovers(root)).toEqual([])
  })

  it('surfaces a failed directory fsync as success (best effort)', async () => {
    const file = path.join(root, 'ok.txt')
    const realOpenSync = fs.openSync.bind(fs)
    const realOpen = fs.promises.open.bind(fs.promises)

    vi.spyOn(fs, 'openSync').mockImplementation((target, flags, mode) => {
      if (flags === 'r') {
        throw new Error('EISDIR')
      }

      return realOpenSync(target, flags, mode)
    })
    vi.spyOn(fs.promises, 'open').mockImplementation((target, flags, mode) =>
      flags === 'r' ? Promise.reject(new Error('EISDIR')) : realOpen(target, flags, mode)
    )
    await write(file, 'fine')
    expect(fs.readFileSync(file, 'utf8')).toBe('fine')
  })

  it('refuses to write into a path whose parent is a file', async () => {
    const parent = path.join(root, 'plain')

    fs.writeFileSync(parent, 'x')
    await expect(write(path.join(parent, 'child'), 'y')).rejects.toThrow()
  })
})

describe('writeFileAtomicSync — write failure', () => {
  it('closes the descriptor and removes the temp file when the write throws', () => {
    const file = path.join(root, 'w.txt')
    const close = vi.spyOn(fs, 'closeSync')

    vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => {
      throw new Error('EIO')
    })
    expect(() => writeFileAtomicSync(file, 'data')).toThrow('EIO')
    expect(close).toHaveBeenCalled()
    expect(fs.existsSync(file)).toBe(false)
    expect(leftovers(root)).toEqual([])
  })
})

describe('writeStreamAtomic', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-stream-'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(dir, { force: true, recursive: true })
  })

  const leftovers = () => fs.readdirSync(dir).filter(name => name.endsWith('.tmp'))

  it('streams every chunk into a private new file and creates missing parents', async () => {
    const file = path.join(dir, 'nested', 'out.bin')
    await writeStreamAtomic(file, Readable.from([Buffer.from('ab'), 'cd']))
    expect(fs.readFileSync(file, 'utf8')).toBe('abcd')
    expect(fs.statSync(file).mode & 0o777).toBe(DEFAULT_FILE_MODE)
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(DEFAULT_DIR_MODE)
  })

  it('keeps the replaced file mode unless one is named', async () => {
    const file = path.join(dir, 'out.sh')
    fs.writeFileSync(file, 'old', { mode: 0o640 })
    fs.chmodSync(file, 0o640)
    await writeStreamAtomic(file, Readable.from(['new']))
    expect(fs.statSync(file).mode & 0o777).toBe(0o640)
    await writeStreamAtomic(file, Readable.from(['newer']), { mode: 0o644 })
    expect(fs.readFileSync(file, 'utf8')).toBe('newer')
    expect(fs.statSync(file).mode & 0o777).toBe(0o644)
    expect(leftovers()).toEqual([])
  })

  it('removes the temp file and keeps the old content when the source fails', async () => {
    const file = path.join(dir, 'out.txt')
    fs.writeFileSync(file, 'old')

    async function* broken() {
      yield 'partial'
      throw new Error('socket reset')
    }

    await expect(writeStreamAtomic(file, broken())).rejects.toThrow('socket reset')
    expect(fs.readFileSync(file, 'utf8')).toBe('old')
    expect(leftovers()).toEqual([])
  })

  it('removes the temp file when the rename fails', async () => {
    const file = path.join(dir, 'out.txt')
    vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('EXDEV'))
    await expect(writeStreamAtomic(file, Readable.from(['x']))).rejects.toThrow('EXDEV')
    expect(fs.existsSync(file)).toBe(false)
    expect(leftovers()).toEqual([])
  })
})

describe('writeStreamAtomic source contract', () => {
  it('writes every byte of a source that was fully buffered before the call; a wrapping generator sees the same bytes', async () => {
    const file = path.join(root, 'blob.bin')
    const body = Buffer.alloc(3 * 1024 * 1024, 7)

    body.writeUInt32BE(0xdeadbeef, body.length - 4)

    const source = new PassThrough()

    source.end(body)

    const hash = createHash('sha256')

    const seen = (async function* () {
      for await (const chunk of source as AsyncIterable<Buffer>) {
        hash.update(chunk)
        yield chunk
      }
    })()

    await writeStreamAtomic(file, seen)

    const onDisk = fs.readFileSync(file)

    expect(onDisk.equals(body)).toBe(true)
    expect(hash.digest('hex')).toBe(createHash('sha256').update(body).digest('hex'))
  })
})

describe('beforeRename seam', () => {
  it('a throw there (sync) leaves the complete temp file, named as isAtomicTempName knows, and the target untouched', () => {
    const file = path.join(root, 'state.json')
    let temp = ''

    fs.writeFileSync(file, 'old')
    expect(() =>
      writeFileAtomicSync(file, 'new', {
        beforeRename: t => {
          temp = t
          throw new Error('killed')
        }
      })
    ).toThrow('killed')
    expect(fs.readFileSync(file, 'utf8')).toBe('old')
    expect(fs.readFileSync(temp, 'utf8')).toBe('new')
    expect(path.dirname(temp)).toBe(root)
    expect(isAtomicTempName(path.basename(temp))).toBe(true)
  })

  it('a throw there (async) behaves the same', async () => {
    const file = path.join(root, 'state.json')
    let temp = ''

    await expect(
      writeFileAtomic(file, 'new', {
        beforeRename: t => {
          temp = t
          throw new Error('killed')
        }
      })
    ).rejects.toThrow('killed')
    expect(fs.existsSync(file)).toBe(false)
    expect(fs.readFileSync(temp, 'utf8')).toBe('new')
  })
})

describe('isAtomicTempName', () => {
  it('matches only the temp names this module writes', () => {
    expect(isAtomicTempName('.state.json.123.0123456789ab.tmp')).toBe(true)

    for (const name of [
      'state.json',
      '.state.json.tmp',
      '.SKILL.md.iclone-tmp-1',
      '.state.json.123.0123456789AB.tmp',
      '.x.12.abc.tmp'
    ]) {
      expect(isAtomicTempName(name)).toBe(false)
    }
  })
})

describe('replaceDirAtomicSync', () => {
  const tree = (dir: string, files: Record<string, string>) => {
    fs.mkdirSync(dir, { recursive: true })

    for (const [name, text] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), text)
    }

    return dir
  }

  const read = (dir: string) =>
    Object.fromEntries(fs.readdirSync(dir).map(n => [n, fs.readFileSync(path.join(dir, n), 'utf8')]))

  it('moves the stage in when there is no target', () => {
    const target = path.join(root, 'plugin')

    expect(replaceDirAtomicSync(tree(path.join(root, '.stage'), { a: '1' }), target)).toBeNull()
    expect(read(target)).toEqual({ a: '1' })
    expect(fs.readdirSync(root)).toEqual(['plugin'])
  })

  it('replaces the target and removes the old tree by default', () => {
    const target = tree(path.join(root, 'plugin'), { old: 'x' })

    expect(replaceDirAtomicSync(tree(path.join(root, '.stage'), { a: '2' }), target)).toBeNull()
    expect(read(target)).toEqual({ a: '2' })
    expect(fs.readdirSync(root)).toEqual(['plugin'])
  })

  it('keepPrevious keeps the old tree there, replacing whatever was there, and returns it', () => {
    const target = tree(path.join(root, 'src'), { v: 'current' })
    const keep = tree(path.join(root, 'src.previous'), { v: 'older' })

    expect(replaceDirAtomicSync(tree(path.join(root, '.stage'), { v: 'next' }), target, { keepPrevious: keep })).toBe(
      keep
    )
    expect(read(target)).toEqual({ v: 'next' })
    expect(read(keep)).toEqual({ v: 'current' })
  })

  it('puts the old tree back when the second rename fails', () => {
    const target = tree(path.join(root, 'plugin'), { old: 'x' })
    const stage = tree(path.join(root, '.stage'), { a: '2' })
    const realRename = fs.renameSync

    const spy = vi
      .spyOn(fs, 'renameSync')
      .mockImplementationOnce((from, to) => realRename(from, to))
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('EXDEV: simulated'), { code: 'EXDEV' })
      })

    try {
      expect(() => replaceDirAtomicSync(stage, target)).toThrow('EXDEV')
    } finally {
      spy.mockRestore()
    }

    expect(read(target)).toEqual({ old: 'x' })
    expect(read(stage)).toEqual({ a: '2' })
    expect(fs.readdirSync(root).sort()).toEqual(['.stage', 'plugin'])
  })

  it('leaves both trees in place when the first rename fails', () => {
    const target = tree(path.join(root, 'plugin'), { old: 'x' })
    const stage = tree(path.join(root, '.stage'), { a: '2' })

    const spy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('EBUSY: simulated'), { code: 'EBUSY' })
    })

    try {
      expect(() => replaceDirAtomicSync(stage, target)).toThrow('EBUSY')
    } finally {
      spy.mockRestore()
    }

    expect(read(target)).toEqual({ old: 'x' })
    expect(fs.readdirSync(root).sort()).toEqual(['.stage', 'plugin'])
  })
})
