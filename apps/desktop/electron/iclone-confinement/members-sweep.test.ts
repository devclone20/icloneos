import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { sweepTokens } from './members'

describe('sweepTokens (fx28): a token ages from its birth', () => {
  const dirs: string[] = []
  const TOKEN = `project+${'a'.repeat(12)}+-+${'b'.repeat(32)}`
  const ELEVEN_MINUTES = 11 * 60_000

  afterEach(() => {
    dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }))
  })

  const folderWithToken = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'v006-sweep-'))

    dirs.push(dir)
    writeFileSync(path.join(dir, TOKEN), '', { mode: 0o600 })

    return { dir, file: path.join(dir, TOKEN) }
  }

  it('a token past its grace goes though something wrote to it a moment ago', () => {
    const { dir, file } = folderWithToken()
    const old = new Date(Date.now() - ELEVEN_MINUTES)

    // An mtime set earlier than the birth moves the birth back (APFS). The later write is what a held descriptor can do.
    utimesSync(file, old, old)
    writeFileSync(file, 'x')

    const stat = statSync(file)

    expect(Date.now() - stat.birthtimeMs).toBeGreaterThan(10 * 60_000)
    expect(Date.now() - stat.mtimeMs).toBeLessThan(60_000)
    expect(sweepTokens(dir, new Map(), Date.now())).toBe(1)
  })

  it('a young token stays, and one a live process holds stays however old', () => {
    const { dir, file } = folderWithToken()

    expect(sweepTokens(dir, new Map(), Date.now())).toBe(0)

    const old = new Date(Date.now() - ELEVEN_MINUTES)

    utimesSync(file, old, old)
    expect(sweepTokens(dir, new Map([[4_242, TOKEN]]), Date.now())).toBe(0)
    expect(sweepTokens(dir, new Map([[4_242, null]]), Date.now())).toBe(1)
  })
})
