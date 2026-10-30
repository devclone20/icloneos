/**
 * V3-S r4b (lead ruling 38, revised): no keychain dialog may ever come from the gate. A full launch sequence through
 * the REAL prepareHermesSpawn → gate → managed check — a foreign git checkout refused, the app's managed runtime for a
 * primary and a pool backend, a dev checkout run unmanaged — with every Electron safeStorage method a spy: none is ever
 * called. Temp dirs only; the plugin load check is answered as Hermes would (a fake execFile), nothing is spawned.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it, vi } from 'vitest'

const LOCK = 'c'.repeat(64)
const MANIFEST = '{"files":{"hermes_cli/main.py":"0123"}}\n'

const h = vi.hoisted(() => {
  const spy = () =>
    vi.fn(() => {
      throw new Error('the gate touched the keychain')
    })

  return {
    hermesHome: '',
    override: undefined as string | undefined,
    safeStorage: {
      decryptString: spy(),
      encryptString: spy(),
      getSelectedStorageBackend: spy(),
      isEncryptionAvailable: spy(),
      setUsePlainTextEncryption: spy()
    },
    userData: ''
  }
})

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3s-keychain-'))
h.userData = path.join(root, 'userData')
h.hermesHome = path.join(root, 'home', '.hermes')

afterAll(() => fs.rmSync(root, { force: true, recursive: true }))

vi.mock('electron', () => ({
  app: { getPath: () => h.userData, getVersion: () => '0.0.3', isPackaged: false },
  safeStorage: h.safeStorage
}))
vi.mock('../runtime-pin.generated', () => ({
  RUNTIME_PIN: {
    manifestSha256: createHash('sha256').update('{"files":{"hermes_cli/main.py":"0123"}}\n').digest('hex'),
    sha: '1'.repeat(40),
    tarballSha256: 'c'.repeat(64)
  }
}))
vi.mock('../packaged-env', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  codePathEnv: (name: string) => (name === 'HERMES_DESKTOP_HERMES_ROOT' ? h.override : undefined)
}))
vi.mock('./env', () => ({
  HERMES_HOME: h.hermesHome,
  IS_PACKAGED: false,
  isHermesSourceRoot: (dir: string) => fs.existsSync(path.join(dir, 'hermes_cli', 'main.py')),
  SOURCE_REPO_ROOT: path.resolve(import.meta.dirname, '../../../..')
}))
vi.mock('./log', () => ({ rememberLog: vi.fn() }))
vi.mock('../iclone-confinement/ipc', () => ({ confinementSpawnEnv: () => ({}) }))
vi.mock('../iclone-permissions/ipc', () => ({
  permissionsSpawn: () => ({ attach: vi.fn(), env: { ICLONE_POLICY_LOCK: '1' }, keyLine: 'v1 k1 abcd\n' })
}))

// The plugin load check, answered as Hermes would: the bundled folder is HERMES_BUNDLED_PLUGINS, else <root>/plugins.
vi.mock('node:child_process', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  execFile: (
    _command: string,
    _args: string[],
    options: { env: NodeJS.ProcessEnv },
    done: (error: Error | null, stdout: string, stderr: string) => void
  ) => {
    const dir = options.env.HERMES_BUNDLED_PLUGINS ?? path.join(String(options.env.PYTHONPATH), 'plugins')
    const rows: Record<string, unknown> = {}
    const hooks: string[] = []

    // FX-4b: the consent gate arms an import finder from its own code (meta_path), the others a tool hook.
    for (const name of ['iclone-confinement', 'iclone-consent', 'iclone-permissions']) {
      if (fs.existsSync(path.join(dir, name, '__init__.py'))) {
        rows[name] = { enabled: true, error: null, path: path.join(dir, name), source: 'bundled' }
        hooks.push(path.join(dir, name, '__init__.py'))
      }
    }

    queueMicrotask(() =>
      done(
        null,
        `ICLONE-GATE-PROBE${JSON.stringify({ plugins: rows, pre_tool_call: hooks, meta_path: hooks.map(file => path.join(path.dirname(file), 'micgate.py')) })}\n`,
        ''
      )
    )

    return {}
  }
}))

const { prepareHermesSpawn } = await import('./iclone-gate')
const { managedHermesRuntimeRoot } = await import('./managed-hermes-runtime')
const { managedStampFor, RUNTIME_MANIFEST_FILE, writeManagedStamp } = await import('../iclone-managed-runtime')

const backend = (dir: string) => ({ command: '/venv/bin/python', env: { PYTHONPATH: dir }, root: dir })

describe('ruling 38 (revised): the gate never calls safeStorage', () => {
  it('foreign checkout refused, managed primary + pool, dev checkout unmanaged — not one keychain call', async () => {
    // The owner's own git checkout at ~/.hermes/hermes-agent.
    const checkout = path.join(h.hermesHome, 'hermes-agent')
    fs.mkdirSync(path.join(checkout, '.git'), { recursive: true })
    fs.mkdirSync(path.join(checkout, 'hermes_cli'), { recursive: true })
    fs.writeFileSync(path.join(checkout, 'hermes_cli', 'main.py'), '# checkout\n')

    // The app's managed runtime, as V3-RT installs it: the release's manifest and the app's stamp.
    const managed = managedHermesRuntimeRoot()
    expect(managed).toBe(path.join(h.userData, 'hermes-runtime', LOCK))
    fs.mkdirSync(managed, { recursive: true })
    fs.writeFileSync(path.join(managed, RUNTIME_MANIFEST_FILE), MANIFEST)
    writeManagedStamp(managed, managedStampFor({ appVersion: '0.0.3', lockHash: LOCK, runtimeSha: '1'.repeat(40) }))

    await expect(
      prepareHermesSpawn({ backend: backend(checkout), cwd: root, profile: null, role: 'primary' })
    ).rejects.toThrow(/\[iclone-gate\].*git checkout.*\[iclone-gate:unmanaged-runtime\]/)

    for (const [profile, role] of [
      [null, 'primary'],
      ['work', 'pool']
    ] as const) {
      const gated = await prepareHermesSpawn({ backend: backend(managed), cwd: root, profile, role })

      expect(gated.report.mode).toBe('managed')
    }

    expect(fs.existsSync(path.join(managed, 'plugins', 'iclone-permissions', '__init__.py'))).toBe(true)

    h.override = checkout
    const dev = await prepareHermesSpawn({ backend: backend(checkout), cwd: root, profile: null, role: 'primary' })

    expect(dev.report.mode).toBe('unmanaged-dev')
    expect(dev.seal({}).HERMES_BUNDLED_PLUGINS).toBe(path.join(h.userData, 'hermes-dev-plugins', 'plugins'))
    expect(fs.existsSync(path.join(checkout, 'plugins'))).toBe(false)

    for (const [name, method] of Object.entries(h.safeStorage)) {
      expect({ name, calls: method.mock.calls.length }).toEqual({ name, calls: 0 })
    }
  })
})
