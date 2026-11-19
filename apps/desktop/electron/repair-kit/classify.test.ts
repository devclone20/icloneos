/**
 * v0.0.9 F3 — the classifier no longer calls a crash "the permission gate is not in place" because the app log main
 * appends to the error holds the gate's own SUCCESS line (14 Nov 2026). Each case below was misread by the old
 * substring test (`error.includes('[iclone-gate]')`).
 */
import { describe, expect, it } from 'vitest'

import { isIcloneGateFailure, isIcloneGateUnmanaged } from '../../src/iclone-shared/iclone-gate'
import { IcloneGateError } from '../iclone-hermes-plugins'

import { causeOf, inferBootCause, repairClassForCause } from './classify'

const RECORD = '/Users/owner/.hermes/installs/f3cca8023c228495'

/** The boot error the owner's card showed on 14 Nov 2026, 09:28:29 UTC (desktop.log 3222-3664, shape kept). */
const FOURTEEN_NOV =
  'Hermes backend exited before it became ready (1). Log: /Users/owner/.hermes/logs/desktop.log\n' +
  '[iclone-runtime] runtime b034d70e verified: 6452 files\n' +
  '[iclone-gate] iclone-confinement: verified\n' +
  '[iclone-gate] loaded by Hermes at /runtime: iclone-permissions, iclone-consent, iclone-confinement (1134 ms)\n' +
  `hermes: install state is not writable by this user (${RECORD}/environments/d2a0574ad8364ad4a87cee896f2a3bea/.leases/` +
  '7f1c); run as the install owner or grant write access\n' +
  'Hermes backend exited (1)'

describe('the gate classifier (14 Nov 2026)', () => {
  it('is NOT a gate refusal: the gate line sits only in the appended log', () => {
    expect(FOURTEEN_NOV.includes('[iclone-gate]')).toBe(true) // what fooled the old test
    expect(isIcloneGateFailure(FOURTEEN_NOV)).toBe(false)
    expect(isIcloneGateUnmanaged(FOURTEEN_NOV)).toBe(false)
  })

  it('a real refusal (an IcloneGateError, as an Error, as its message, prefixed by the IPC) still is one', () => {
    const refusal = new IcloneGateError('did not load iclone-permissions')

    expect(isIcloneGateFailure(refusal)).toBe(true)
    expect(isIcloneGateFailure(refusal.message)).toBe(true)
    expect(isIcloneGateFailure(`Error: ${refusal.message} Log: /x\n[other] line`)).toBe(true)
    expect(isIcloneGateUnmanaged(new IcloneGateError('a checkout', { unmanaged: true }).message)).toBe(true)
  })

  it('a mark in the middle of the sentence or on a later line is not a refusal', () => {
    expect(isIcloneGateFailure('Could not connect to Hermes gateway')).toBe(false)
    expect(isIcloneGateFailure('backend said [iclone-gate] loaded by Hermes')).toBe(false)
    expect(isIcloneGateFailure('Hermes backend exited (1)\n[iclone-gate] The icloneOS permission gate is not in place')).toBe(
      false
    )
  })
})

describe('inferBootCause / causeOf', () => {
  it('14 Nov: install-state-not-writable, from PM\'s own line, never gate', () => {
    const cause = inferBootCause(FOURTEEN_NOV)

    expect(cause.code).toBe('install-state-not-writable')
    expect(cause.line).toContain('install state is not writable by this user (')
    expect(repairClassForCause(cause.code)).toBe('stale-install-record')
  })

  it('a structured bootCause on the error always wins over the text', () => {
    const error = Object.assign(new Error(FOURTEEN_NOV), { bootCause: { code: 'port-in-use', line: 'EADDRINUSE' } })

    expect(causeOf(error)).toEqual({ code: 'port-in-use', line: 'EADDRINUSE' })
  })

  it('reads the boot progress object the renderer holds (its `error` string)', () => {
    expect(causeOf({ error: FOURTEEN_NOV, running: false }).code).toBe('install-state-not-writable')
  })

  it.each([
    [`${new IcloneGateError('not loaded').message}`, 'gate-not-loaded'],
    ['Hermes backend exited before it became ready (1).\nRecent backend output:\nModuleNotFoundError: No module named \'x\'', 'python-import'],
    ['Hermes backend exited before it became ready (1).\nRecent backend output:\nOSError: [Errno 48] Address already in use', 'port-in-use'],
    ['Hermes backend exited before it became ready (1). Log: /x\nsomething else', 'exit-nonzero'],
    ['Hermes backend did not become ready in 45 s', 'timeout'],
    ['', 'unknown'],
    [null, 'unknown']
  ])('%s → %s', (text, code) => {
    expect(inferBootCause(text).code).toBe(code)
  })

  it('an ImportError that sits only in the appended app log is not the cause (log noise)', () => {
    expect(inferBootCause('Hermes backend exited before it became ready (1). Log: /x\nImportError: old line').code).toBe(
      'exit-nonzero'
    )
  })
})
