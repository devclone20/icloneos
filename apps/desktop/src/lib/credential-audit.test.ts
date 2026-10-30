import { beforeEach, describe, expect, it } from 'vitest'

import {
  appendCredentialAudit,
  auditSafeId,
  CREDENTIAL_AUDIT_KEY,
  CREDENTIAL_AUDIT_MAX,
  readCredentialAudit
} from './credential-audit'

describe('credential audit ring buffer', () => {
  beforeEach(() => window.localStorage.clear())

  it('keeps the newest 50 entries, newest first', () => {
    for (let i = 0; i < CREDENTIAL_AUDIT_MAX + 7; i += 1) {
      appendCredentialAudit({ id: `KEY_${i}`, kind: 'api_key', result: 'removed', surface: 'keys', ts: i })
    }

    const entries = readCredentialAudit()
    expect(entries).toHaveLength(CREDENTIAL_AUDIT_MAX)
    expect(entries[0].id).toBe(`KEY_${CREDENTIAL_AUDIT_MAX + 6}`)
    expect(entries.at(-1)?.id).toBe('KEY_7')
  })

  it('never stores values, previews or tokens (property over random rows)', () => {
    const secretish = ['value', 'redacted_value', 'token_preview', 'token', 'secret']

    for (let i = 0; i < 200; i += 1) {
      const secret = `sk-${Math.random().toString(36).slice(2)}${i}`

      const row: Record<string, unknown> = {
        id: `ENV_${i}`,
        kind: i % 2 ? 'oauth' : 'api_key',
        result: 'removed',
        surface: 'keys'
      }

      row[secretish[i % secretish.length]] = secret
      appendCredentialAudit(row as unknown as Parameters<typeof appendCredentialAudit>[0])

      const stored = window.localStorage.getItem(CREDENTIAL_AUDIT_KEY) ?? ''
      expect(stored).not.toContain(secret)
    }

    for (const entry of readCredentialAudit()) {
      expect(Object.keys(entry).sort()).toEqual(['id', 'kind', 'result', 'surface', 'ts'])
    }
  })

  it('reduces ids to printable names and drops malformed rows', () => {
    expect(auditSafeId('my endpoint "x"')).toBe('my_endpoint__x_')
    expect(auditSafeId('')).toBe('unknown')
    expect(auditSafeId('a'.repeat(300))).toHaveLength(96)

    window.localStorage.setItem(CREDENTIAL_AUDIT_KEY, JSON.stringify([{ id: 1 }, { foo: 'bar' }]))
    expect(readCredentialAudit()).toEqual([])
  })
})
