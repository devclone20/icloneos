import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtb-status-'))
const sent: unknown[] = []
afterAll(() => fs.rmSync(dir, { force: true, recursive: true })) // r2c3 H

vi.mock('electron', () => ({
  app: { getPath: () => dir },
  shell: { openExternal: vi.fn(async () => undefined), showItemInFolder: vi.fn() }
}))
vi.mock('./log', () => ({ rememberLog: () => undefined }))
vi.mock('./state', () => ({
  windowsState: {
    mainWindow: {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: (...args: unknown[]) => sent.push(args) }
    }
  }
}))

const status = await import('./agent-runtime-status')
const { AGENT_INSTALL_SKIPPED_TAG } = await import('../../src/iclone-shared/agent-runtime-status')
const electron = await import('electron')

describe('main agent runtime status (RTB-6, V3-ON status/repair API)', () => {
  beforeEach(() => {
    fs.rmSync(path.join(dir, status.AGENT_RUNTIME_STATUS_FILE), { force: true })
    status._resetAgentRuntimeStatusForTests()
    sent.length = 0
  })

  afterEach(() => vi.clearAllMocks())

  it('records a run from bootstrap events, persists it 0600 and broadcasts it', () => {
    status.recordBootstrapEventForStatus({ type: 'manifest' })
    status.recordBootstrapEventForStatus({ type: 'log', stage: 'python-deps', line: '✓ ffmpeg' })
    status.recordBootstrapEventForStatus({ type: 'stage', name: 'python-deps', state: 'succeeded', durationMs: 5 })
    status.recordBootstrapEventForStatus({ type: 'complete' })

    const file = path.join(dir, status.AGENT_RUNTIME_STATUS_FILE)
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))

    expect(saved.state).toBe('installed')
    expect(saved.packages.find((line: { name: string }) => line.name === 'ffmpeg').state).toBe('done')
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(sent.length).toBeGreaterThan(0)
    expect(status.getAgentRuntimeStatus().state).toBe('installed')
  })

  it('skip refuses the install for this run with the tagged error; Install again lifts it', () => {
    expect(() => status.assertAgentInstallAllowed()).not.toThrow()
    status.skipAgentInstall()
    expect(() => status.assertAgentInstallAllowed()).toThrow(AGENT_INSTALL_SKIPPED_TAG)
    status.clearAgentInstallSkip()
    expect(() => status.assertAgentInstallAllowed()).not.toThrow()
  })

  it('the next launch offers the install once after a skip; a second skip leaves it to Settings', () => {
    status.skipAgentInstall()
    status._resetAgentRuntimeStatusForTests() // a new launch reads the persisted record
    expect(() => status.assertAgentInstallAllowed()).not.toThrow()
    status.skipAgentInstall()
    status._resetAgentRuntimeStatusForTests()
    expect(() => status.assertAgentInstallAllowed()).toThrow(AGENT_INSTALL_SKIPPED_TAG)
  })

  it('a backend that comes up marks a runtime with no record installed (an upgrade)', () => {
    status.markAgentRuntimeRunning()
    expect(status.getAgentRuntimeStatus().state).toBe('installed')
  })

  it('the fixes open only fixed panes or the app folder, never a caller URL', async () => {
    expect(await status.openAgentRuntimeFix('https://evil.example')).toEqual({ ok: false })
    expect(await status.openAgentRuntimeFix('reveal-folder')).toEqual({ ok: true })
    expect(electron.shell.showItemInFolder).toHaveBeenCalledTimes(1)

    if (process.platform === 'darwin') {
      expect(await status.openAgentRuntimeFix('open-storage-settings')).toEqual({ ok: true })
      expect(electron.shell.openExternal).toHaveBeenCalledWith('x-apple.systempreferences:com.apple.settings.Storage')
    }
  })

  it('both places that would start or offer the install ask first: the bootstrap branch and the first-run choice', () => {
    const read = (file: string) => fs.readFileSync(path.join(import.meta.dirname, file), 'utf8')
    const progress = read('boot-progress.ts')
    const choice = progress.slice(progress.indexOf('export async function waitForFirstRunSetupChoice'))

    expect(choice.indexOf('assertAgentInstallAllowed()')).toBeGreaterThan(-1)
    expect(choice.indexOf('assertAgentInstallAllowed()')).toBeLessThan(choice.indexOf('updateBootProgress('))
    expect(read('backend-pool.ts')).toMatch(/kind === 'bootstrap-needed'\) \{\n\s+assertAgentInstallAllowed\(\)/)
  })
})
