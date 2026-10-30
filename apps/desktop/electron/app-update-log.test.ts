import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  APP_UPDATE_LOG_CAP,
  appendAppUpdateLog,
  appUpdateLogPath,
  readAppUpdateLog,
  settleAppUpdateLog
} from './app-update-log'

let dir = ''

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-update-log-'))
})

afterEach(() => {
  fs.rmSync(dir, { force: true, recursive: true })
})

describe('app-update-log', () => {
  it('starts empty; a missing or malformed file reads as no history', () => {
    expect(readAppUpdateLog(dir)).toEqual([])
    fs.writeFileSync(appUpdateLogPath(dir), '{not json')
    expect(readAppUpdateLog(dir)).toEqual([])
    fs.writeFileSync(
      appUpdateLogPath(dir),
      JSON.stringify({ entries: [{ from: 1 }, { at: 1, from: 'a', result: 'installed', to: 'b' }], v: 1 })
    )
    expect(readAppUpdateLog(dir)).toEqual([{ at: 1, from: 'a', result: 'installed', to: 'b' }])
  })

  it('appends atomically with owner-only mode and keeps the newest 50 rows', () => {
    for (let i = 0; i < APP_UPDATE_LOG_CAP + 5; i += 1) {
      appendAppUpdateLog(dir, { at: i, from: '0.0.1', result: 'installed', to: '0.0.2' })
    }

    const rows = readAppUpdateLog(dir)
    expect(rows).toHaveLength(APP_UPDATE_LOG_CAP)
    expect(rows[0].at).toBe(5)
    expect(fs.statSync(appUpdateLogPath(dir)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(fs.readFileSync(appUpdateLogPath(dir), 'utf8')).v).toBe(1)
  })

  it('the next launch settles the installing row: installed when running the new version, failed otherwise', () => {
    appendAppUpdateLog(dir, { at: 7, from: '0.0.2', result: 'installing', to: '0.0.3' })
    expect(settleAppUpdateLog(dir, '0.0.3')).toEqual({ at: 7, from: '0.0.2', result: 'installed', to: '0.0.3' })
    expect(settleAppUpdateLog(dir, '0.0.3')).toBeNull()

    appendAppUpdateLog(dir, { at: 8, from: '0.0.3', result: 'installing', to: '0.0.4' })
    expect(settleAppUpdateLog(dir, '0.0.3')).toMatchObject({
      error: 'still running 0.0.3',
      result: 'failed',
      to: '0.0.4'
    })
    expect(readAppUpdateLog(dir).map(row => row.result)).toEqual(['installed', 'failed'])
  })

  it('an install that fails while the app runs on turns its installing row into one failed row', () => {
    appendAppUpdateLog(dir, { at: 7, from: '0.0.2', result: 'installing', to: '0.0.3' })
    appendAppUpdateLog(dir, {
      at: 99,
      error: 'Code signature did not pass',
      from: '0.0.2',
      result: 'failed',
      to: '0.0.3'
    })
    expect(readAppUpdateLog(dir)).toEqual([
      { at: 7, error: 'Code signature did not pass', from: '0.0.2', result: 'failed', to: '0.0.3' }
    ])
    expect(settleAppUpdateLog(dir, '0.0.2')).toBeNull()
    expect(settleAppUpdateLog(dir, '0.0.2')).toBeNull()

    // A failed row for another release never rewrites a pending one.
    appendAppUpdateLog(dir, { at: 100, from: '0.0.2', result: 'installing', to: '0.0.4' })
    appendAppUpdateLog(dir, { at: 101, from: '0.0.2', result: 'failed', to: '0.0.3' })
    expect(readAppUpdateLog(dir).map(row => `${row.to} ${row.result}`)).toEqual([
      '0.0.3 failed',
      '0.0.4 installing',
      '0.0.3 failed'
    ])
  })

  it('a failed row whose release runs now installed after all (Squirrel finished after the watchdog)', () => {
    appendAppUpdateLog(dir, { at: 7, from: '0.0.2', result: 'installing', to: '0.0.3' })
    appendAppUpdateLog(dir, {
      at: 99,
      error: 'still running 90 s after quitAndInstall',
      from: '0.0.2',
      result: 'failed',
      to: '0.0.3'
    })
    expect(settleAppUpdateLog(dir, '0.0.3')).toEqual({ at: 7, from: '0.0.2', result: 'installed', to: '0.0.3' })
    expect(settleAppUpdateLog(dir, '0.0.3')).toBeNull()
    expect(readAppUpdateLog(dir)).toEqual([{ at: 7, from: '0.0.2', result: 'installed', to: '0.0.3' }])
  })
})
