import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { clearCachesOnVersionChange, lastSeenVersion, VERSION_MARKER } from './iclone-version-caches'

let dir: string

function fakeSession() {
  return {
    clearCache: vi.fn(async () => {}),
    clearCodeCaches: vi.fn(async () => {}),
    clearStorageData: vi.fn(async () => {})
  }
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'iclone-version-caches-'))
})

afterEach(() => {
  rmSync(dir, { force: true, recursive: true })
})

describe('clearCachesOnVersionChange', () => {
  it('clears once on a new version (or an install over a version that kept no marker), then never again', async () => {
    const session = fakeSession()
    const log = vi.fn()

    expect(await clearCachesOnVersionChange({ log, session, userData: dir, version: '0.0.1' })).toBe('cleared')
    expect(session.clearCache).toHaveBeenCalledTimes(1)
    expect(session.clearCodeCaches).toHaveBeenCalledWith({})
    // Only caches: never Local Storage, cookies or IndexedDB (settings, sign-ins).
    expect(session.clearStorageData).toHaveBeenCalledWith({ storages: ['cachestorage', 'shadercache'] })
    expect(lastSeenVersion(dir)).toBe('0.0.1')
    expect(await clearCachesOnVersionChange({ log, session, userData: dir, version: '0.0.1' })).toBe('same')
    expect(session.clearCache).toHaveBeenCalledTimes(1)
    expect(await clearCachesOnVersionChange({ log, session, userData: dir, version: '0.0.2' })).toBe('cleared')
    expect(session.clearCache).toHaveBeenCalledTimes(2)
    expect(log.mock.calls.at(-1)?.[0]).toContain('0.0.1 -> 0.0.2')
  })

  it('a failure leaves the marker unwritten so the next launch retries', async () => {
    writeFileSync(path.join(dir, VERSION_MARKER), JSON.stringify({ version: '0.0.1' }))
    const session = { ...fakeSession(), clearCodeCaches: vi.fn(async () => Promise.reject(new Error('busy'))) }

    expect(await clearCachesOnVersionChange({ log: vi.fn(), session, userData: dir, version: '0.0.2' })).toBe('failed')
    expect(JSON.parse(readFileSync(path.join(dir, VERSION_MARKER), 'utf8')).version).toBe('0.0.1')
  })

  it('an unreadable marker counts as unknown', () => {
    writeFileSync(path.join(dir, VERSION_MARKER), '{not json')
    expect(lastSeenVersion(dir)).toBeNull()
  })
})
