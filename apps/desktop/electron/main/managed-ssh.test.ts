import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { readManagedSshRecoveryRecords } from './managed-ssh'
import { DESKTOP_MANAGED_SSH_RECOVERY_PATH } from './paths'

const userData = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  return mkdtempSync(join(tmpdir(), 'managed-ssh-test-'))
})

vi.mock('electron', () => ({
  app: {
    commandLine: { appendSwitch: () => undefined },
    getAppPath: () => userData,
    getPath: () => userData,
    isPackaged: false,
    isReady: () => false
  },
  BrowserWindow: { getAllWindows: () => [] }
}))

const CORRELATION_ID = '123e4567-e89b-42d3-a456-426614174000'

function journalWith(correlationId: unknown) {
  return {
    version: 1,
    records: [
      {
        connectionId: 'ssh-1',
        correlationId,
        phase: 'prepared',
        scopes: [{ key: '', kind: 'primary', profile: 'default' }],
        source: { id: 'ssh-1', kind: 'ssh' }
      }
    ]
  }
}

function writeJournal(payload: unknown) {
  fs.writeFileSync(DESKTOP_MANAGED_SSH_RECOVERY_PATH, JSON.stringify(payload), { mode: 0o600 })
}

describe('readManagedSshRecoveryRecords', () => {
  beforeEach(() => {
    fs.rmSync(DESKTOP_MANAGED_SSH_RECOVERY_PATH, { force: true })
  })

  afterAll(() => {
    fs.rmSync(userData, { force: true, recursive: true })
  })

  it('reads the journal from the userData directory', () => {
    expect(path.dirname(DESKTOP_MANAGED_SSH_RECOVERY_PATH)).toBe(userData)
    expect(userData.startsWith(os.tmpdir())).toBe(true)
  })

  it('returns no records when the journal does not exist', () => {
    expect(readManagedSshRecoveryRecords()).toEqual([])
  })

  it('accepts a record whose correlationId is a UUID string', () => {
    writeJournal(journalWith(CORRELATION_ID))

    expect(readManagedSshRecoveryRecords()).toEqual(journalWith(CORRELATION_ID).records)
  })

  it.each([
    ['a number', 123],
    ['an array that stringifies to a UUID', [CORRELATION_ID]]
  ])('refuses a record whose correlationId is %s', (_label, correlationId) => {
    writeJournal(journalWith(correlationId))

    expect(() => readManagedSshRecoveryRecords()).toThrow(
      expect.objectContaining({ code: 'managed-update-recovery-unavailable' })
    )
  })
})
