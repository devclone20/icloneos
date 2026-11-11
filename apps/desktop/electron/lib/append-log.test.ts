import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { appendLineSync, AppendMismatchError, createDeferredSync, expectationOf, stampOf, stampOfAsync } from './append-log'

let dir = ''

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'append-log-'))
})

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('appendLineSync', () => {
  it('creates the file 0600 and only ever adds whole lines after the ones before', () => {
    const file = path.join(dir, 'sub', 'ledger.jsonl')

    expect(appendLineSync(file, 'a\n', { durable: true })).toEqual({ before: 0, after: 2 })
    expect(appendLineSync(file, 'bb\n', { durable: false })).toEqual({ before: 2, after: 5 })
    expect(fs.readFileSync(file, 'utf8')).toBe('a\nbb\n')
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })

  it('writes nothing when the file is not the one the caller verified (size or inode moved)', () => {
    const file = path.join(dir, 'ledger.jsonl')

    appendLineSync(file, 'a\n', { durable: false })

    const verified = expectationOf(stampOf([file]))

    fs.appendFileSync(file, 'x\n')
    expect(() => appendLineSync(file, 'b\n', { durable: false, expect: verified })).toThrow(AppendMismatchError)

    fs.rmSync(file)
    fs.writeFileSync(file, 'a\n')
    expect(() => appendLineSync(file, 'b\n', { durable: false, expect: verified })).toThrow(AppendMismatchError)
    expect(fs.readFileSync(file, 'utf8')).toBe('a\n')
  })

  it('never follows a symlink at the path', () => {
    const target = path.join(dir, 'target')
    const file = path.join(dir, 'ledger.jsonl')

    fs.writeFileSync(target, '')
    fs.symlinkSync(target, file)
    expect(() => appendLineSync(file, 'a\n', { durable: true })).toThrow()
    expect(fs.readFileSync(target, 'utf8')).toBe('')
  })
})

describe('stamps', () => {
  it('sync and async agree; any write moves the stamp, even one that keeps the size', async () => {
    const file = path.join(dir, 'f')

    fs.writeFileSync(file, 'abc')

    const first = stampOf([file, path.join(dir, 'missing')])

    expect(await stampOfAsync([file, path.join(dir, 'missing')])).toBe(first)
    expect(first.endsWith('|-')).toBe(true)
    fs.writeFileSync(file, 'abd')
    expect(stampOf([file, path.join(dir, 'missing')])).not.toBe(first)
    expect(expectationOf(first)).toEqual({ ino: fs.statSync(file).ino, size: 3 })
    expect(expectationOf('-|-')).toEqual({ ino: null, size: 0 })
  })
})

describe('createDeferredSync', () => {
  it('syncs every marked file once, in the order first marked, off the calling turn; flush waits for it', async () => {
    const synced: string[] = []

    const deferred = createDeferredSync(async file => {
      synced.push(file)
    })

    deferred.mark('ledger')
    deferred.mark('head')
    deferred.mark('ledger')
    expect(synced).toEqual([])
    expect(deferred.pending()).toBe(2)
    await deferred.flush()
    expect(synced).toEqual(['ledger', 'head'])
    expect(deferred.pending()).toBe(0)
  })

  it('a file marked while a flush runs is synced too; a failing sync never stops the rest', async () => {
    const synced: string[] = []

    const deferred = createDeferredSync(async file => {
      if (file === 'bad') {
        throw new Error('EIO')
      }

      synced.push(file)

      if (file === 'a') {
        deferred.mark('b')
      }
    })

    deferred.mark('bad')
    deferred.mark('a')
    await deferred.flush()
    expect(synced).toEqual(['a', 'b'])
  })

  it('flushSync takes what is still queued (the way out of the app cannot wait)', () => {
    const file = path.join(dir, 'f')

    fs.writeFileSync(file, 'x')

    const deferred = createDeferredSync(async () => {
      throw new Error('never reached in this turn')
    })

    deferred.mark(file)
    deferred.flushSync()
    expect(deferred.pending()).toBe(0)
  })
})
