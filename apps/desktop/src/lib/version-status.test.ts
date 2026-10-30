import { describe, expect, it } from 'vitest'

import { en } from '@/i18n/en'

import { resolveVersionStatus } from './version-status'

const copy = en.shell.statusbar

const client = (over: Partial<Parameters<typeof resolveVersionStatus>[0]> = {}) =>
  resolveVersionStatus({ applying: false, copy, remote: false, restarting: false, target: 'client', ...over })

const backend = (over: Partial<Parameters<typeof resolveVersionStatus>[0]> = {}) =>
  resolveVersionStatus({ applying: false, copy, remote: true, restarting: false, target: 'backend', ...over })

describe('resolveVersionStatus', () => {
  it('labels a current local client with its version and sha detail', () => {
    const status = client({ sha: 'abc1234', version: '0.4.2' })

    expect(status.label).toBe('v0.4.2')
    expect(status.detail).toBe('abc1234')
    expect(status.hasUpdate).toBe(false)
    expect(status.unknown).toBe(false)
  })

  it('appends the commit diff when the client is behind', () => {
    const status = client({ behind: 12, branch: 'main', version: '0.4.2' })

    expect(status.label).toBe('v0.4.2 (+12)')
    expect(status.hasUpdate).toBe(true)
    expect(status.tooltip).toContain('12 commits behind main')
  })

  // FAIL-BEFORE (#84591 class): a shallow install reports behind:null +
  // updateAvailable. The client target ignored updateAvailable entirely, so
  // the statusbar showed no update at all — and further back, the fabricated
  // behind:1 rendered a frozen "(+1)" while the real distance grew to 61.
  it('shows a count-free update hint when the client count is unknown', () => {
    const status = client({ behind: 0, updateAvailable: true, version: '0.4.2' })

    expect(status.label).toBe(`v0.4.2 (${copy.update})`)
    expect(status.label).not.toContain('+1')
    expect(status.hasUpdate).toBe(true)
  })

  it('names a local client by its one version line, label and tooltip alike', () => {
    const versionLine = 'iclone os 1.0.0 · Hermes runtime 0.17.0'
    const status = client({ sha: 'abc1234', version: '1.0.0', versionLine })

    expect(status.label).toBe(versionLine)
    expect(status.tooltip).toContain(versionLine)
    expect(status.tooltip).not.toContain('Hermes Desktop')
    expect(client({ behind: 3, branch: 'main', version: '1.0.0', versionLine }).label).toBe(`${versionLine} (+3)`)
    expect(client({ applying: true, version: '1.0.0', versionLine }).label).toBe(`${versionLine} · ${copy.update}`)
  })

  it('keeps the short client label in remote mode and ignores a line without a version', () => {
    const versionLine = 'iclone os 1.0.0 · Hermes runtime 0.17.0'

    expect(client({ remote: true, version: '1.0.0', versionLine }).label).toBe(copy.clientLabel('1.0.0'))
    expect(client({ remote: true, version: '1.0.0', versionLine }).tooltip).toContain(versionLine)
    expect(client({ sha: 'abc1234', versionLine }).label).toBe('abc1234')
    expect(backend({ version: '0.4.2', versionLine }).label).toBe(copy.backendLabel('0.4.2'))
  })

  it('names the client as one of two versions in remote mode', () => {
    expect(client({ remote: true, version: '0.4.2' }).label).toBe('client v0.4.2')
  })

  it('falls back to the sha, then to unknown, when there is no version', () => {
    expect(client({ sha: 'abc1234' }).label).toBe('abc1234')
    expect(client({ sha: 'abc1234' }).unknown).toBe(false)
    expect(client().label).toBe(copy.unknown)
    expect(client().unknown).toBe(true)
  })

  it('drops the diff and the sha detail while an apply is in flight', () => {
    const applying = client({ applying: true, behind: 3, sha: 'abc1234', version: '0.4.2' })

    expect(applying.label).toBe('v0.4.2 · update')
    expect(applying.detail).toBeUndefined()
    expect(applying.hasUpdate).toBe(false)

    expect(client({ applying: true, restarting: true, version: '0.4.2' }).label).toBe('v0.4.2 · restart')
  })

  it('leads the tooltip with the apply message while applying', () => {
    expect(client({ applyMessage: 'Pulling…', applying: true, version: '0.4.2' }).tooltip).toBe(
      'Pulling… · iclone os v0.4.2'
    )
    expect(client({ applying: true, version: '0.4.2' }).tooltip).toBe(`${copy.updateInProgress} · iclone os v0.4.2`)
  })

  it('labels the backend target distinctly and never claims a client sha', () => {
    const status = backend({ sha: 'abc1234', version: '0.4.2' })

    expect(status.label).toBe('backend v0.4.2')
    expect(status.detail).toBeUndefined()
    expect(status.tooltip).toBe('Backend v0.4.2')
  })

  it('falls back to (update) for a backend that cannot count commits', () => {
    const status = backend({ updateAvailable: true, version: '0.4.2' })

    expect(status.label).toBe('backend v0.4.2 (update)')
    expect(status.hasUpdate).toBe(true)
  })

  it('prefers the exact commit diff over the generic (update) hint', () => {
    expect(backend({ behind: 4, updateAvailable: true, version: '0.4.2' }).label).toBe('backend v0.4.2 (+4)')
  })

  it('hides a backend row that has no version at all', () => {
    expect(backend().unknown).toBe(true)
  })
})

describe('R1 pinned client', () => {
  const base = {
    applying: false,
    copy: {
      backendLabel: (v: string) => `backend v${v}`,
      backendVersion: (v: string) => `backend ${v}`,
      branch: (b: string) => `branch ${b}`,
      clientLabel: (v: string) => `client v${v}`,
      commit: (s: string) => `commit ${s}`,
      commitsBehind: (n: number, b: string) => `${n} behind ${b}`,
      desktopVersion: (v: string) => `desktop ${v}`,
      restart: 'restart',
      unknown: 'unknown',
      update: 'update',
      updateInProgress: 'updating'
    },
    remote: false,
    restarting: false,
    target: 'client' as const,
    version: '1.0.0'
  }

  it('names the pin, never an update, even when a stale count says behind', () => {
    const result = resolveVersionStatus({
      ...base,
      behind: 7,
      updateAvailable: true,
      pin: { aligned: true, sha: '1ac3f97fbe0958aa2743c0c26202b20b3b4e760e' }
    })

    expect(result.hasUpdate).toBe(false)
    expect(result.label).toBe('v1.0.0 · runtime 1ac3f97')
    expect(result.tooltip).toContain('Runtime pinned by this release')
    expect(result.warn).toBe(false)
  })

  it('an unaligned runtime is amber and points at the Updates pane', () => {
    const result = resolveVersionStatus({ ...base, pin: { aligned: false, sha: '1ac3f97fbe0958aa' } })

    expect(result.warn).toBe(true)
    expect(result.tooltip).toContain('Runtime not aligned — open Updates')
  })
})
