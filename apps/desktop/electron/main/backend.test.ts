import { ChildProcess } from 'node:child_process'
import fs from 'node:fs'

import { afterAll, describe, expect, it, vi } from 'vitest'

import type * as BackendClaim from '../backend-claim'
import { createBackendOutputTail } from '../backend-claim'

import { claimBackendChild } from './backend'
import type { OwnedBackendChild } from './backend-ownership'

const claim = vi.hoisted(() => ({ probeStartMarker: vi.fn() }))

// connection-config stamps an installation id under userData at import time.
const userData = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  return mkdtempSync(join(tmpdir(), 'backend-test-'))
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

vi.mock('../backend-claim', async importOriginal => ({
  ...(await importOriginal<typeof BackendClaim>()),
  probeStartMarker: claim.probeStartMarker
}))

describe('claimBackendChild', () => {
  afterAll(() => {
    fs.rmSync(userData, { force: true, recursive: true })
  })

  it('refuses a child that never spawned (no PID) without probing or claiming an identity', async () => {
    // A ChildProcess that was never spawned has no pid, exactly like a spawn() that failed before exec.
    const child: OwnedBackendChild = new ChildProcess()
    const outputTail = createBackendOutputTail()

    outputTail.append('ModuleNotFoundError: hermes_cli')

    await expect(claimBackendChild(child, 'hermes serve', 'default', 'nonce', outputTail)).rejects.toThrow(
      /^Hermes backend did not spawn \(no PID\).*ModuleNotFoundError: hermes_cli/s
    )
    expect(claim.probeStartMarker).not.toHaveBeenCalled()
    expect(child.hermesBackendIdentity).toBeUndefined()
  })
})
