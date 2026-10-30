// REL-6 — the tarball reader refuses every path that could leave the package, and writes only regular files.
import { gunzipSync, gzipSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import { makeTgz, rawEntry } from './fixture'
import { gunzipAsync, packagePath, readTar, TarError } from './tar'

const tarOf = (...entries: Buffer[]) => Buffer.concat([...entries, Buffer.alloc(1024)])

describe('readTar', () => {
  it('strips the first component and normalises modes the way npm does', () => {
    const files = readTar(gunzipSync(makeTgz({ 'a/b.js': { data: 'x', mode: 0o700 }, 'c.txt': { data: 'y' } })))

    expect(files.map(file => [file.path, file.mode.toString(8), file.data.toString()])).toEqual([
      ['a/b.js', '755', 'x'],
      ['c.txt', '644', 'y']
    ])
  })

  it.each(['package/../../etc/passwd', '/etc/passwd', 'package/a/../../x', 'package\\..\\x'])('refuses %s', name => {
    expect(() => readTar(tarOf(rawEntry(name, 'x')))).toThrow(TarError)
  })

  it('skips symlinks, hard links and devices (type 2, 1, 3)', () => {
    const files = readTar(
      tarOf(rawEntry('package/link', '', '2'), rawEntry('package/hard', '', '1'), rawEntry('package/dev', '', '3'))
    )

    expect(files).toEqual([])
  })

  it('reads a pax path record and a GNU long name', () => {
    const long = `package/${'d/'.repeat(80)}f.js`
    const pax = Buffer.from(`${(`path=${long}`.length + 4 + 1).toString()} path=${long}\n`)
    const files = readTar(tarOf(rawEntry('PaxHeader', pax.toString(), 'x'), rawEntry('package/short', 'body')))

    expect(files[0]?.path).toBe(long.slice('package/'.length))

    const gnu = readTar(tarOf(rawEntry('././@LongLink', `${long}\0`, 'L'), rawEntry('package/short', 'body')))

    expect(gnu[0]?.path).toBe(long.slice('package/'.length))
  })

  it('refuses a corrupt header checksum and an entry that runs past the end', () => {
    const entry = rawEntry('package/a', 'hello')

    entry[0] = 0x71
    expect(() => readTar(tarOf(entry))).toThrow(/checksum/)
    expect(() => readTar(rawEntry('package/a', 'hello').subarray(0, 515))).toThrow(/past the end/)
  })

  it('caps the unpacked size', async () => {
    await expect(gunzipAsync(gzipSync(Buffer.alloc(4096)), 1024)).rejects.toThrow(TarError)
  })

  it('packagePath: the root itself is nothing to write', () => {
    expect(packagePath('package/')).toBeNull()
    expect(packagePath('package/./a//b')).toBe('a/b')
  })
})
