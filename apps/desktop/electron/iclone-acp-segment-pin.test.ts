/**
 * Ruling 63.5 (V3-FX r7, FX_sink_audit A5): the shipped acp-cli carries @segment/analytics-next under
 * @account-kit/logging, which is INERT only at the reviewed pin: 4.88.5's createLogger hard-wires noopLogger.
 * Any other version or tarball turns this red, so a bump is re-reviewed before it ships. The acp-cli child env loses
 * SEGMENT_WRITE_KEY in the seal (iclone-telemetry-seal.ts DESTINATION_ENV_KEYS).
 */
import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { isDestinationKey } from './iclone-telemetry-seal'

const DESKTOP = path.join(__dirname, '..')

const REVIEWED = {
  version: '4.88.5',
  integrity: 'sha512-ZCgPWp5QbJ0zrjlAQxIZLEJ9+UzJNTp1VJAfVMS1c0sBy3r5YTXEh4SHAh+At4y1r7rVmgKSAGFTdEp0go+aDg=='
}

describe('ruling 63.5: acp-cli Segment stays inert', () => {
  it('the acp-cli lock pins @account-kit/logging to the reviewed no-op tarball', () => {
    const lock = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'acp-cli-lock', 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { version?: string; integrity?: string }>
    }

    const entries = Object.entries(lock.packages).filter(([key]) => key.endsWith('node_modules/@account-kit/logging'))

    expect(entries.length).toBeGreaterThan(0)

    for (const [, entry] of entries) {
      expect({ version: entry.version, integrity: entry.integrity }).toEqual(REVIEWED)
    }
  })

  it('when the tree is staged, its createLogger still hard-wires the no-op logger', () => {
    const staged = path.join(DESKTOP, 'build', 'acp-cli', 'runtime', 'node_modules', '@account-kit', 'logging')
    const index = path.join(staged, 'dist', 'esm', 'index.js')

    if (!fs.existsSync(index)) {
      return // not staged in this checkout: the lock pin above is the guard
    }

    expect(JSON.parse(fs.readFileSync(path.join(staged, 'package.json'), 'utf8')).version).toBe(REVIEWED.version)
    expect(fs.readFileSync(index, 'utf8')).toMatch(/const innerLogger = noopLogger;/)
  })

  it('the acp-cli child env never carries a Segment write key', () => {
    expect(isDestinationKey('SEGMENT_WRITE_KEY')).toBe(true)
  })
})
