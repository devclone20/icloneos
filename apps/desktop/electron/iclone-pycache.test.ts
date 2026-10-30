/**
 * V3-S r4 (m-a′, ruling 37 interim): every gated Python's PYTHONPYCACHEPREFIX lies under a non-directory, so no
 * bytecode can be read from it or written to it, by the app or anyone; round 3's folder is removed. Temp dirs only.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { freshPycachePrefix, NO_BYTECODE_PREFIX, pycacheEnv, releasePycachePrefix } from './iclone-pycache'

const temps: string[] = []

function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v3s-pyc-'))
  temps.push(dir)

  return dir
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true })
  }
})

describe.runIf(process.platform !== 'win32')('the bytecode prefix', () => {
  it('is the same impossible path for every probe and spawn: under a node that is not a directory', () => {
    const root = path.join(temp(), 'pycache')

    expect(freshPycachePrefix(root, 'spawn')).toBe(NO_BYTECODE_PREFIX)
    expect(freshPycachePrefix(root, 'probe')).toBe(NO_BYTECODE_PREFIX)
    expect(fs.lstatSync(path.dirname(NO_BYTECODE_PREFIX)).isDirectory()).toBe(false)
    expect(fs.existsSync(root)).toBe(false)
  })

  it('nothing can be created there — not the folder Python would cache a runtime module in, not a planted pyc', () => {
    const cfile = path.join(NO_BYTECODE_PREFIX, 'rt', 'hermes_cli', 'plugins.cpython-311.pyc')

    expect(() => fs.mkdirSync(path.dirname(cfile), { recursive: true })).toThrow(/ENOTDIR|EEXIST|ENOENT/)
    expect(() => fs.writeFileSync(cfile, 'trojan')).toThrow()
    expect(fs.existsSync(cfile)).toBe(false)
  })

  it('round 3’s folder (live-looking or dead prefixes, a planted pyc) is removed; a linked root is unlinked, its target kept', () => {
    const root = path.join(temp(), 'pycache')
    fs.mkdirSync(path.join(root, 'spawn-1-abcdef', 'Users', 'u', 'hermes_cli'), { recursive: true })
    fs.writeFileSync(path.join(root, 'spawn-1-abcdef', 'Users', 'u', 'hermes_cli', 'plugins.cpython-311.pyc'), 'x')
    fs.mkdirSync(path.join(root, `probe-${process.pid}-zzzzzz`))

    freshPycachePrefix(root, 'spawn')
    expect(fs.existsSync(root)).toBe(false)

    const elsewhere = temp()
    fs.writeFileSync(path.join(elsewhere, 'keep'), 'x')
    const link = path.join(temp(), 'pycache')
    fs.symlinkSync(elsewhere, link)

    expect(freshPycachePrefix(link, 'spawn')).toBe(NO_BYTECODE_PREFIX)
    expect(fs.existsSync(link)).toBe(false)
    expect(fs.readdirSync(elsewhere)).toEqual(['keep'])
  })

  it('release removes nothing (there is nothing), and never throws', () => {
    const dir = temp()
    fs.writeFileSync(path.join(dir, 'keep'), 'x')

    expect(() => releasePycachePrefix(NO_BYTECODE_PREFIX)).not.toThrow()
    expect(() => releasePycachePrefix(dir)).not.toThrow()
    expect(fs.readdirSync(dir)).toEqual(['keep'])
  })

  it('the env: that prefix, and no bytecode written', () => {
    expect(pycacheEnv(NO_BYTECODE_PREFIX)).toEqual({
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONPYCACHEPREFIX: '/dev/null/icloneos-no-bytecode'
    })
  })
})
