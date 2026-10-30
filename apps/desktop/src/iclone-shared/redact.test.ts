import { describe, expect, it } from 'vitest'

import { hasSecrets, redactDeep, redactSecrets } from './redact'

const HEX = `0x${'ab'.repeat(32)}`

describe('redactSecrets — labels at any length', () => {
  it.each([
    ['password=hunter2', 'password=[redacted]'],
    ['Password: "my pass phrase"', 'Password: [redacted]'],
    ["passwd = 'x'", 'passwd = [redacted]'],
    ['secret: s3', 'secret: [redacted]'],
    ['api-key=abc', 'api-key=[redacted]'],
    ['{"password": 1234}', '{"password": [redacted]}'],
    ['{"api-key":"k"}', '{"api-key":"[redacted]"}'],
    ['{"session_token":"t"}', '{"session_token":"[redacted]"}']
  ])('%s', (input, expected) => {
    expect(redactSecrets(input)).toBe(expected)
  })

  it('never double-redacts and leaves label-only prose alone', () => {
    expect(redactSecrets('{"password":"x"}')).toBe('{"password":"[redacted]"}')
    expect(redactSecrets('Forgot your password?')).toBe('Forgot your password?')
    expect(redactSecrets('the client_secret is required')).toBe('the client_secret is required')
  })

  it('long-value labels (8+): session tokens and client secrets', () => {
    expect(redactSecrets('session_token: abcdefgh12')).toBe('session_token: [redacted]')
    expect(redactSecrets('client_secret=abcdefghij')).toBe('client_secret=[redacted]')
    expect(redactSecrets('session_token: short')).toBe('session_token: short')
  })
})

describe('redactSecrets — env, headers and provider keys', () => {
  it('env assignments', () => {
    expect(redactSecrets('HERMES_DASHBOARD_SESSION_TOKEN=abc123 next')).toBe(
      'HERMES_DASHBOARD_SESSION_TOKEN=[redacted] next'
    )
    expect(redactSecrets('OPENAI_API_KEY=x')).toBe('OPENAI_API_KEY=[redacted]')
    expect(redactSecrets('HOME=/Users/me')).toBe('HOME=/Users/me')
  })

  it('credential headers of any length', () => {
    expect(redactSecrets('X-Hermes-Session-Token: abc')).toBe('X-Hermes-Session-Token: [redacted]')
    expect(redactSecrets('"X-Api-Key":"k1"')).toBe('"X-Api-Key":"[redacted]"')
    expect(redactSecrets('Authorization: Bearer short')).toBe('Authorization: Bearer [redacted]')
    expect(redactSecrets('Authorization: Basic dXNlcjpwYXNz')).toBe('Authorization: Basic [redacted]')
    expect(redactSecrets('Authorization: Bearer abcdefghijklmnopqrstu')).toBe('Authorization: Bearer [redacted]')
    expect(redactSecrets('X-Request-Id: 42')).toBe('X-Request-Id: 42')
  })

  it('provider key formats', () => {
    for (const key of [
      'sk-ant-api03-abcdefghijklmnop',
      ['sk', 'live', 'abcdefghijklmnop'].join('_') /* built at runtime: no secret-shaped literal in source */,
      'ghp_abcdefghijklmnopqrst',
      'github_pat_11ABCDEFG0123456789',
      'xoxb-1234567890-abcdef'
    ]) {
      expect(redactSecrets(`key ${key} end`)).toBe('key [redacted] end')
    }

    expect(redactSecrets('task-runner-identifier-long')).toBe('task-runner-identifier-long')
    expect(redactSecrets('sk-short')).toBe('sk-short')
  })
})

describe('redactSecrets — opt-in shapes', () => {
  it('hex64 only on request (transaction hashes look the same)', () => {
    expect(redactSecrets(`tx ${HEX}`)).toBe(`tx ${HEX}`)
    expect(redactSecrets(`key ${HEX}`, { hex64: true })).toBe('key [redacted-hex]')
    expect(redactSecrets(`${HEX}ff`, { hex64: true })).toBe(`${HEX}ff`)
  })

  it('sshTargets only on request (git remotes look the same)', () => {
    expect(redactSecrets('git@github.com:org/repo.git')).toBe('git@github.com:org/repo.git')
    expect(redactSecrets('root@10.0.0.1:hunter2', { sshTargets: true })).toBe('root@10.0.0.1:[redacted]')
    expect(redactSecrets('root@10.0.0.1:hunter2:22', { sshTargets: true })).toBe('root@10.0.0.1:[redacted]:22')
    expect(redactSecrets('root@10.0.0.1:22', { sshTargets: true })).toBe('root@10.0.0.1:22')
  })
})

describe('redactSecrets — input tolerance', () => {
  it('nullish reads as empty, other values as text', () => {
    expect(redactSecrets(null)).toBe('')
    expect(redactSecrets(undefined)).toBe('')
    expect(redactSecrets(42)).toBe('42')
    expect(redactSecrets({ toString: () => 'password=abc' })).toBe('password=[redacted]')
  })

  it('hasSecrets and redactDeep see the new shapes', () => {
    expect(hasSecrets('OPENAI_API_KEY=x')).toBe(true)
    expect(hasSecrets('nothing here')).toBe(false)
    expect(redactDeep({ headers: ['X-Hermes-Session-Token: abc'] })).toEqual({
      masked: true,
      value: { headers: ['X-Hermes-Session-Token: [redacted]'] }
    })
  })
})
