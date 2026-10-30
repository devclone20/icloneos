/**
 * Tests for electron/packaged-env.ts.
 *
 * Run with: npx vitest run --project electron electron/packaged-env.test.ts
 */

import assert from 'node:assert/strict'

import { afterEach, beforeEach, test, vi } from 'vitest'

const electron = vi.hoisted(() => ({ app: { isPackaged: false } }))

vi.mock('electron', () => electron)

import {
  CODE_PATH_ENV,
  codePathEnv,
  decideMediaRequest,
  ENV_POLICY_TAG,
  isAllowedMediaCheck,
  isAllowedMediaRequest,
  loginShell,
  resolveCodePathEnv,
  resolveLoginShell,
  sealChildEnv,
  sealPackagedProcessEnv
} from './packaged-env'

const everyOverride = () => Object.fromEntries(CODE_PATH_ENV.map(name => [name, `/attacker/${name}`]))

let savedEnv: NodeJS.ProcessEnv

beforeEach(() => {
  savedEnv = { ...process.env }
  electron.app.isPackaged = false
})

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) {
      delete process.env[key]
    }
  }

  Object.assign(process.env, savedEnv)
  vi.restoreAllMocks()
})

test('the list is exactly the contract 17 code-path variables', () => {
  assert.deepEqual([...CODE_PATH_ENV].sort(), [
    'HERMES_DESKTOP_BOOT_FAKE',
    'HERMES_DESKTOP_BOOT_FAKE_ERROR',
    'HERMES_DESKTOP_DEV_SERVER',
    'HERMES_DESKTOP_HERMES',
    'HERMES_DESKTOP_HERMES_ROOT',
    'HERMES_DESKTOP_IGNORE_EXISTING',
    'HERMES_DESKTOP_IS_PACKAGED',
    'HERMES_DESKTOP_PYTHON',
    'HERMES_DESKTOP_REMOTE_TOKEN',
    'HERMES_DESKTOP_REMOTE_URL',
    'HERMES_DESKTOP_SHELL',
    'HERMES_DESKTOP_USER_DATA_DIR',
    'HERMES_DESKTOP_WEB_DIST',
    'HERMES_HOME',
    'SHELL'
  ])
})

test('tuning knobs and the CDP port are not code-path variables', () => {
  const names: readonly string[] = CODE_PATH_ENV

  for (const knob of [
    'HERMES_DESKTOP_CDP_PORT',
    'HERMES_DESKTOP_SKIP_QUIT_CONFIRM',
    'HERMES_DESKTOP_APP_NAME',
    'HERMES_DESKTOP_CWD',
    'HERMES_DESKTOP_BOOT_FAKE_STEP_MS',
    'HERMES_DESKTOP_POOL_SIZE'
  ]) {
    assert.equal(names.includes(knob), false, knob)
  }
})

test('a packaged build resolves every code-path variable to undefined', () => {
  const env = everyOverride()

  for (const name of CODE_PATH_ENV) {
    assert.equal(resolveCodePathEnv(name, env, true), undefined, name)
  }
})

test('an unpackaged build honours every code-path variable', () => {
  const env = everyOverride()

  for (const name of CODE_PATH_ENV) {
    assert.equal(resolveCodePathEnv(name, env, false), `/attacker/${name}`, name)
  }
})

test('HERMES_DESKTOP_IS_PACKAGED cannot be used to re-enable overrides', () => {
  assert.equal(resolveCodePathEnv('HERMES_DESKTOP_DEV_SERVER', { HERMES_DESKTOP_IS_PACKAGED: '' }, true), undefined)
})

test('codePathEnv follows app.isPackaged and logs the policy tag once', () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  process.env.HERMES_DESKTOP_DEV_SERVER = 'https://evil.example'

  electron.app.isPackaged = true
  assert.equal(codePathEnv('HERMES_DESKTOP_DEV_SERVER'), undefined)
  assert.equal(codePathEnv('HERMES_DESKTOP_DEV_SERVER'), undefined)

  electron.app.isPackaged = false
  assert.equal(codePathEnv('HERMES_DESKTOP_DEV_SERVER'), 'https://evil.example')

  const tagged = log.mock.calls.filter(call => String(call[0]).startsWith(ENV_POLICY_TAG))
  assert.equal(tagged.length, 1)
})

test('login shell: $SHELL in dev, the account shell when packaged', () => {
  const env = { SHELL: '/tmp/evil-sh' }

  assert.equal(
    resolveLoginShell(env, false, () => '/bin/zsh'),
    '/tmp/evil-sh'
  )
  assert.equal(
    resolveLoginShell(env, true, () => '/bin/zsh'),
    '/bin/zsh'
  )
  assert.equal(
    resolveLoginShell({}, true, () => {
      throw new Error('no passwd entry')
    }),
    undefined
  )

  electron.app.isPackaged = true
  process.env.SHELL = '/tmp/evil-sh'
  assert.notEqual(loginShell(), '/tmp/evil-sh')
})

test('sealChildEnv leaves an unpackaged env untouched', () => {
  const env = everyOverride()
  const before = { ...env }

  assert.deepEqual(sealChildEnv(env, false, { HERMES_HOME: '/home/u/.hermes' }), [])
  assert.deepEqual(env, before)
})

test('sealChildEnv strips raw values and keeps only resolved ones when packaged', () => {
  const env: Record<string, string | undefined> = { ...everyOverride(), PATH: '/usr/bin', HERMES_DESKTOP_CDP_PORT: '1' }
  const discarded = sealChildEnv(env, true, { HERMES_HOME: '/Users/u/.hermes', SHELL: '/bin/zsh' })

  assert.deepEqual(discarded.sort(), [...CODE_PATH_ENV].sort())
  assert.equal(env.HERMES_HOME, '/Users/u/.hermes')
  assert.equal(env.SHELL, '/bin/zsh')
  assert.equal(env.PATH, '/usr/bin')
  assert.equal(env.HERMES_DESKTOP_CDP_PORT, '1')

  for (const name of CODE_PATH_ENV) {
    if (name !== 'HERMES_HOME' && name !== 'SHELL') {
      assert.equal(name in env, false, name)
    }
  }
})

test('sealChildEnv does not report a value that already equals the resolved one', () => {
  const env = { HERMES_HOME: '/Users/u/.hermes' }

  assert.deepEqual(sealChildEnv(env, true, { HERMES_HOME: '/Users/u/.hermes' }), [])
})

test('sealPackagedProcessEnv seals process.env only when packaged and never logs values', () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  process.env.HERMES_DESKTOP_REMOTE_TOKEN = 'secret-token-value'

  assert.deepEqual(sealPackagedProcessEnv({ HERMES_HOME: '/Users/u/.hermes' }), [])
  assert.equal(process.env.HERMES_DESKTOP_REMOTE_TOKEN, 'secret-token-value')

  electron.app.isPackaged = true
  const discarded = sealPackagedProcessEnv({ HERMES_HOME: '/Users/u/.hermes' })

  assert.ok(discarded.includes('HERMES_DESKTOP_REMOTE_TOKEN'))
  assert.equal(process.env.HERMES_DESKTOP_REMOTE_TOKEN, undefined)
  assert.equal(process.env.HERMES_HOME, '/Users/u/.hermes')
  assert.ok(log.mock.calls.every(call => !String(call[0]).includes('secret-token-value')))
})

test('media requests: audio allowed, any video refused', () => {
  assert.equal(isAllowedMediaRequest('audioCapture'), true)
  assert.equal(isAllowedMediaRequest('videoCapture'), false)
  assert.equal(isAllowedMediaRequest('media', { mediaTypes: ['audio'] }), true)
  assert.equal(isAllowedMediaRequest('media', { mediaTypes: ['video'] }), false)
  assert.equal(isAllowedMediaRequest('media', { mediaTypes: ['audio', 'video'] }), false)
  assert.equal(isAllowedMediaRequest('media', { mediaTypes: [] }), true)
  assert.equal(isAllowedMediaRequest('media', {}), true)
  assert.equal(isAllowedMediaRequest('notifications'), false)
  assert.equal(isAllowedMediaRequest('geolocation'), false)
})

test('media checks never grant videoCapture', () => {
  assert.equal(isAllowedMediaCheck('media'), true)
  assert.equal(isAllowedMediaCheck('audioCapture'), true)
  assert.equal(isAllowedMediaCheck('videoCapture'), false)
  assert.equal(isAllowedMediaCheck('geolocation'), false)
})

test('decideMediaRequest tags video refusals', () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})

  assert.equal(decideMediaRequest('media', { mediaTypes: ['video'] }), false)
  assert.equal(decideMediaRequest('notifications'), false)
  assert.equal(decideMediaRequest('media', { mediaTypes: ['audio'] }), true)
  assert.equal(log.mock.calls.length, 1)
  assert.match(String(log.mock.calls[0][0]), /^\[iclone-media-policy\] videoCapture denied$/)
})
