import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readJsonFile, readJsonFileSync, writeJsonAtomic, writeJsonAtomicSync } from './fs-json'

let root = ''

const isPoint = (value: unknown): value is { x: number } =>
  typeof value === 'object' && value !== null && typeof (value as { x?: unknown }).x === 'number'

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'iclone-json-'))
})

afterEach(() => {
  fs.rmSync(root, { force: true, recursive: true })
})

describe.each([
  ['sync', (file: string, options?: object) => Promise.resolve(readJsonFileSync(file, options))],
  ['async', (file: string, options?: object) => readJsonFile(file, options)]
] as const)('readJsonFile (%s)', (_name, read) => {
  it('parses a JSON file of any JSON type', async () => {
    fs.writeFileSync(path.join(root, 'a.json'), '{"x":1}')
    fs.writeFileSync(path.join(root, 'b.json'), '[1,2]')
    expect(await read(path.join(root, 'a.json'))).toEqual({ x: 1 })
    expect(await read(path.join(root, 'b.json'))).toEqual([1, 2])
  })

  it('null for missing, unparsable, empty, directory', async () => {
    fs.writeFileSync(path.join(root, 'bad.json'), '{oops')
    fs.writeFileSync(path.join(root, 'empty.json'), '')
    expect(await read(path.join(root, 'missing.json'))).toBeNull()
    expect(await read(path.join(root, 'bad.json'))).toBeNull()
    expect(await read(path.join(root, 'empty.json'))).toBeNull()
    expect(await read(root)).toBeNull()
  })

  it('maxBytes refuses larger files and accepts the exact size', async () => {
    const file = path.join(root, 'sized.json')

    fs.writeFileSync(file, '{"x":12345}')
    expect(await read(file, { maxBytes: 10 })).toBeNull()
    expect(await read(file, { maxBytes: 11 })).toEqual({ x: 12345 })
  })

  it('validate keeps matching shapes and nulls the rest', async () => {
    fs.writeFileSync(path.join(root, 'ok.json'), '{"x":2}')
    fs.writeFileSync(path.join(root, 'no.json'), '{"x":"2"}')
    expect(await read(path.join(root, 'ok.json'), { validate: isPoint })).toEqual({ x: 2 })
    expect(await read(path.join(root, 'no.json'), { validate: isPoint })).toBeNull()
  })

  it.runIf(process.platform !== 'win32')('a FIFO at the path reads as null without blocking', async () => {
    const fifo = path.join(root, 'trap.json')

    execFileSync('mkfifo', [fifo])
    expect(await read(fifo)).toBeNull()
  })
})

describe.each([
  [
    'sync',
    async (file: string, value: unknown, options?: object) => {
      writeJsonAtomicSync(file, value, options)
    }
  ],
  ['async', writeJsonAtomic]
] as const)('writeJsonAtomic (%s)', (_name, write) => {
  it('pretty-prints with a trailing newline by default', async () => {
    const file = path.join(root, 'nested', 'state.json')

    await write(file, { a: [1] })
    expect(fs.readFileSync(file, 'utf8')).toBe('{\n  "a": [\n    1\n  ]\n}\n')
    expect(readJsonFileSync(file)).toEqual({ a: [1] })
  })

  it('compact and without newline on request', async () => {
    const file = path.join(root, 'compact.json')

    await write(file, { a: 1 }, { space: 0, trailingNewline: false })
    expect(fs.readFileSync(file, 'utf8')).toBe('{"a":1}')
  })

  it.runIf(process.platform !== 'win32')('passes the mode through to the atomic writer', async () => {
    const file = path.join(root, 'secret.json')

    await write(file, {}, { mode: 0o640 })
    expect(fs.statSync(file).mode & 0o777).toBe(0o640)
  })

  it('refuses values without a JSON form and leaves no file', async () => {
    const file = path.join(root, 'none.json')

    await expect(write(file, undefined)).rejects.toThrow(TypeError)
    await expect(write(file, () => 1)).rejects.toThrow(TypeError)
    expect(fs.existsSync(file)).toBe(false)
  })

  it('surfaces circular structures as errors', async () => {
    const loop: Record<string, unknown> = {}

    loop.self = loop
    await expect(write(path.join(root, 'loop.json'), loop)).rejects.toThrow()
  })
})
