/** M2: first install and Repair over a dotfiles home, through the real runBootstrap: the owner reads the reason, not an exit code. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { diagnoseInstallFailure } from '../src/iclone-shared/install-diagnosis'

vi.mock('./iclone-confinement/ipc', () => ({ confinementSpawnEnv: () => ({ ICLONE_RUNTIME_CONFINED: '1' }) }))

const { runBootstrap } = await import('./bootstrap-runner')

describe('the config stage over a dotfiles home', () => {
  let base: string
  let hermesHome: string

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bsr-')))
    hermesHome = path.join(base, 'hh')
    fs.mkdirSync(hermesHome)
  })
  afterEach(() => fs.rmSync(base, { force: true, recursive: true }))

  it('fails with the same refusal, in the install words, and the diagnosis offers Retry', async () => {
    fs.writeFileSync(path.join(base, 'dot'), 'A=1\n')
    fs.symlinkSync(path.join(base, 'dot'), path.join(hermesHome, '.env'))

    const root = path.join(base, 'rt')
    const script = path.join(base, 'install.sh')

    fs.mkdirSync(root)
    fs.writeFileSync(script, '#!/bin/bash\nexit 0\n')

    const options: Parameters<typeof runBootstrap>[0] = {
      activeRoot: root,
      emit: () => undefined,
      force: true,
      hermesHome,
      policy: 'developer',
      _fetchManifest: async () => ({ protocol_version: 1, stages: [{ name: 'config' }] }),
      _resolveInstallScript: async () => ({ kind: 'posix', path: script })
    } as Parameters<typeof runBootstrap>[0]

    const result = (await runBootstrap(options)) as { error: string; failedStage: string; ok: boolean }

    expect(result.ok).toBe(false)
    expect(result.failedStage).toBe('config')
    expect(result.error).toContain("Your .env is a link to a file outside the agent's home")
    expect(result.error).toContain('so the install did not finish.')
    expect(result.error).not.toContain('no JSON result frame')
    expect(result.error).not.toContain('runtime update')
    expect(diagnoseInstallFailure({ error: result.error, stage: 'config' })).toMatchObject({
      class: 'homeSettings',
      fix: 'retry'
    })
  })
})
