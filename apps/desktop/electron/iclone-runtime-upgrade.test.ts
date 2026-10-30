/**
 * V3-RT K-RT2 under lead ruling 36: the app's runtime lives in its own folder (`<userData>/hermes-runtime/<sha>`), never
 * at `~/.hermes/hermes-agent`. On the first launch over a previous install, the bundled artifact is installed into the
 * app's folder — the user's folder untouched — with one notice; every file the installer creates (uv, the pinned
 * Python, PM's store and environment) stays inside the app's folder, and nothing is published into the user's PATH.
 * Fixture folders in temp only; the real bundled artifact; the install stages faked (the live run installs for real).
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  installSourceTarball,
  placeStage,
  PRODUCTS_SKIPPED_REASON,
  runBootstrap,
  SOURCE_UPDATE_STAGES
} from './bootstrap-runner'
import type { BootstrapEvent } from './bootstrap-runner'
import { readManagedStamp } from './iclone-managed-runtime'
import {
  parseRuntimeManifest,
  RUNTIME_MANIFEST_FILE,
  runtimeOwnership,
  verifyRuntimeTree
} from './iclone-runtime-integrity'
import {
  canBuildPinnedArtifact,
  marker,
  type RuntimeFixture,
  runtimeFixture,
  UPSTREAM_PIN,
  UPSTREAM_TARBALL_SHA256
} from './iclone-runtime-integrity.test-helpers'
import { managedRuntimeRoot } from './iclone-runtime-location'
import { RUNTIME_PIN } from './runtime-pin.generated'

const SUITE = process.platform !== 'win32' && canBuildPinnedArtifact() ? describe : describe.skip

let fx: RuntimeFixture
let tmp: string
let bundleDir: string

beforeAll(async () => {
  if (!canBuildPinnedArtifact()) {
    return
  }

  fx = await runtimeFixture()
  ;({ bundleDir, tmp } = fx)
}, 120_000)

// The fixtures hold full runtime trees (~130 MB each); their removal is awaited, or vitest exits before it finishes and
// the trees leak into the temp folder. Gigabytes take longer than the default 10 s hook timeout.
afterAll(async () => {
  if (tmp) {
    await fs.promises.rm(tmp, { force: true, recursive: true })
  }
}, 300_000)

/** The tree 0.0.2 left at ~/.hermes/hermes-agent: the upstream tarball (no iclone core) and its codeload marker. */
function legacyRuntime(home: string): string {
  const root = path.join(home, '.hermes', 'hermes-agent')
  fs.mkdirSync(path.join(root, 'hermes_cli'), { recursive: true })
  fs.writeFileSync(path.join(root, 'hermes_cli', 'plugins.py'), '# upstream 1ac3f97, no iclone core\n')
  marker(root, { sha: UPSTREAM_PIN, sha256: UPSTREAM_TARBALL_SHA256, source: 'codeload' })

  return root
}

/** A 0.0.2 install the owner turned into a git checkout (`hermes update` era): a real work tree with one commit. */
function legacyCheckout(home: string): string {
  const root = legacyRuntime(home)

  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      stdio: 'ignore'
    })

  git('init', '-q')
  git('add', '-A')
  git('commit', '-q', '-m', 'legacy checkout')

  return root
}

/** Every entry under `dir` (files, links, folders) with its mode, size, mtime and bytes: "untouched" means all of it. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}

  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const file = path.join(entry.parentPath, entry.name)
    const st = fs.lstatSync(file)

    const body = entry.isFile()
      ? fs.readFileSync(file).toString('base64')
      : entry.isSymbolicLink()
        ? `-> ${fs.readlinkSync(file)}`
        : ''

    out[path.relative(dir, file)] = `${st.mode.toString(8)} ${st.size} ${st.mtimeMs} ${body}`
  }

  return out
}

SUITE('K-RT2 (ruling 36): the app installs its own runtime in its own folder', { timeout: 60_000 }, () => {
  async function upgradeOver(name: string, makeLegacy: (home: string) => string) {
    const home = path.join(tmp, name)
    const hermesHome = path.join(home, '.hermes')
    const legacy = makeLegacy(home)
    const before = snapshot(legacy)
    const userData = path.join(home, 'Library', 'Application Support', 'iclone os')
    const managed = managedRuntimeRoot(userData, RUNTIME_PIN.tarballSha256)

    const deps = {
      hermesHome: path.join(managed, '.iclone-deps', 'hermes'),
      home: path.join(managed, '.iclone-deps', 'home')
    }

    const events: BootstrapEvent[] = []
    const ran: { home?: string; hermesHome: string; name: string }[] = []
    const stage = (name: string) => ({ name, title: name, category: 'runtime', needs_user_input: false })

    const result = await runBootstrap({
      activeRoot: managed,
      appVersion: '0.0.3',
      hermesHome,
      installStamp: { commit: 'a'.repeat(40) },
      logRoot: path.join(hermesHome, 'logs'),
      onEvent: ev => events.push(ev),
      policy: 'curated',
      privateDependencies: deps,
      purpose: 'runtime-upgrade',
      _resolveInstallScript: async () => ({ kind: 'posix', path: path.join(bundleDir, 'install.sh') }),
      _fetchManifest: async () => ({
        protocol_version: 1,
        stages: ['prerequisites', 'repository', 'venv', 'python-deps', 'config', 'products', 'complete'].map(stage)
      }),
      _installSource: opts => installSourceTarball({ ...opts, bundleDir }),
      _runStage: async ({ stage: s, hermesHome: stageHome, home: stageUserHome }) => {
        ran.push({ name: s.name, hermesHome: stageHome, ...(stageUserHome ? { home: stageUserHome } : {}) })

        return { name: s.name, state: 'succeeded', type: 'stage' }
      }
    })

    expect(result.ok).toBe(true)

    // One notice: the manifest says why.
    const manifests = events.filter(ev => ev.type === 'manifest')
    expect(manifests).toHaveLength(1)
    expect(manifests[0]).toMatchObject({ purpose: 'runtime-upgrade' })

    // The installer's outputs stay in the app folder; config still seeds the user's HERMES_HOME; nothing is published.
    expect(ran).toEqual([
      { name: 'venv', hermesHome: deps.hermesHome, home: deps.home },
      { name: 'python-deps', hermesHome: deps.hermesHome, home: deps.home },
      { name: 'config', hermesHome },
      { name: 'complete', hermesHome }
    ])
    expect(events).toContainEqual(expect.objectContaining({ type: 'stage', name: 'products', state: 'skipped' }))

    // The app's copy is this release's runtime, stamped and manifest-exact; the user's folder is byte-for-byte as it was.
    expect(runtimeOwnership(managed, RUNTIME_PIN)).toEqual({ kind: 'managed', sha: RUNTIME_PIN.sha })
    const manifest = parseRuntimeManifest(fs.readFileSync(path.join(bundleDir, RUNTIME_MANIFEST_FILE), 'utf8'))
    expect(verifyRuntimeTree(managed, manifest).ok).toBe(true)
    // The installer copied the bundle's manifest into the tree and wrote the plain stamp (sha + app version, no key).
    // Asserted first, so a missing copy fails here on an assertion (ruling 53), not on the read below.
    expect(fs.existsSync(path.join(managed, RUNTIME_MANIFEST_FILE)), 'manifest copy missing').toBe(true)
    expect(fs.readFileSync(path.join(managed, RUNTIME_MANIFEST_FILE))).toEqual(
      fs.readFileSync(path.join(bundleDir, RUNTIME_MANIFEST_FILE))
    )
    expect(readManagedStamp(managed)).toMatchObject({
      appVersion: '0.0.3',
      lockHash: RUNTIME_PIN.tarballSha256,
      runtimeSha: RUNTIME_PIN.sha
    })
    expect(Object.keys(readManagedStamp(managed) ?? {}).sort()).toEqual([
      'appVersion',
      'installId',
      'installedAt',
      'lockHash',
      'runtimeSha',
      'schema'
    ])
    expect(snapshot(legacy)).toEqual(before)
    expect(fs.existsSync(path.join(legacy, 'hermes_cli', 'iclone_policy_env.py'))).toBe(false)

    return legacy
  }

  it('first launch over a 0.0.2 install: installed into the app folder, legacy folder untouched, one notice', async () => {
    await upgradeOver('krt2-home', legacyRuntime)
  })

  it('first launch over a 0.0.2 install that is a git checkout: the checkout (and its .git) is left byte-for-byte', async () => {
    const legacy = await upgradeOver('krt2-checkout-home', legacyCheckout)

    expect(fs.existsSync(path.join(legacy, '.git', 'HEAD'))).toBe(true)
  })

  it('a repo pin is never fetched from a download source: no bundle, nothing installed', async () => {
    const target = path.join(tmp, 'no-bundle', 'hermes-runtime', RUNTIME_PIN.tarballSha256)
    const urls: string[] = []

    await expect(
      installSourceTarball({
        bundleDir: path.join(tmp, 'no-bundle', 'empty'),
        cacheDir: path.join(tmp, 'no-bundle', 'cache'),
        emit: () => undefined,
        sha: RUNTIME_PIN.sha,
        sha256: RUNTIME_PIN.tarballSha256,
        targetDir: target,
        _download: async url => {
          urls.push(url)

          return ''
        }
      })
    ).rejects.toThrow(/ships inside icloneOS is missing or damaged; reinstall icloneOS/)
    expect(urls).toEqual([])
    expect(fs.existsSync(target)).toBe(false)
  })
})

describe('K-RT2: the stage placement of the app runtime', () => {
  it('venv and python-deps in the private home, config in the user HERMES_HOME, products skipped; dev unchanged', () => {
    const priv = { hermesHome: '/rt/.iclone-deps/hermes', home: '/rt/.iclone-deps/home' }

    expect(placeStage('venv', '/h', priv)).toEqual({ hermesHome: priv.hermesHome, home: priv.home })
    expect(placeStage('python-deps', '/h', priv)).toEqual({ hermesHome: priv.hermesHome, home: priv.home })
    expect(placeStage('config', '/h', priv)).toEqual({ hermesHome: '/h' })
    expect(placeStage('products', '/h', priv)).toEqual({ hermesHome: '/h', skip: PRODUCTS_SKIPPED_REASON })
    expect(placeStage('products', '/h', null)).toEqual({ hermesHome: '/h' })
    expect(SOURCE_UPDATE_STAGES).toEqual(['python-deps', 'config', 'products'])
  })
})

describe('K-RT2: where main runs it (ruling 36)', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, rel), 'utf8')

  it('a packaged app runs its runtime from the app folder; the user folder is the LEGACY root, never the active one', () => {
    const env = read('main/env.ts')

    expect(env).toContain("export const LEGACY_HERMES_ROOT = path.join(HERMES_HOME, 'hermes-agent')")
    expect(env).toMatch(
      /export const ACTIVE_HERMES_ROOT = IS_PACKAGED\s+\? managedRuntimeRoot\(app\.getPath\('userData'\), RUNTIME_PIN\.tarballSha256\)\s+: LEGACY_HERMES_ROOT/
    )
  })

  it('the first install passes the private home and the notice; an upgrader is not asked how to set up', () => {
    const pool = read('main/backend-pool.ts')
    const boot = read('main/boot-progress.ts')

    expect(pool).toContain('privateDependencies: runtimePrivateDependencies(),')
    expect(pool).toContain("...(isRuntimeUpgradeFromLegacy() ? { purpose: 'runtime-upgrade' as const } : {}),")
    expect(boot).toMatch(/if \(isRuntimeUpgradeFromLegacy\(\)\) \{\s+gate\.continueLocal\(\)/)
  })

  it('M1: the installer outputs are recorded right after each install; nothing goes ahead of the standard library', () => {
    const pool = read('main/backend-pool.ts')
    const updates = read('main/updates.ts')

    // Critic r2 M1: the install starts from nothing (prepare BEFORE the installer runs), the record is written after
    // it with that one capability, and a record that cannot be written is the install's failure (never swallowed).
    const prepare = pool.indexOf(
      'const freshDependencies = IS_PACKAGED ? prepareDependencyInstall(ACTIVE_HERMES_ROOT) : null'
    )

    const install = pool.indexOf('const bootstrapResult = await runBootstrap({')
    const seal = pool.indexOf('sealInstalledDependencies(ACTIVE_HERMES_ROOT, freshDependencies)')

    expect(prepare).toBeGreaterThan(-1)
    expect(install).toBeGreaterThan(prepare)
    expect(seal).toBeGreaterThan(
      pool.indexOf("rememberLog('[bootstrap] bootstrap complete; marker written. Re-resolving backend.')")
    )
    expect(pool.slice(seal, seal + 400)).toMatch(
      /catch \(error\) \{[\s\S]*bootState\.bootstrapFailure = sealError\s+throw sealError/
    )
    // The update path never records: an environment it found "already in place" keeps the last record from nothing.
    expect(updates).not.toMatch(/sealInstalledDependencies\(updateRoot/)
    expect(updates).toMatch(/throw new Error\(\s+`The agent's Python environment was reinstalled but does not match/)
    expect(read('main/runtime.ts')).toContain(
      'pythonPathEntries: IS_PACKAGED ? [] : [ACTIVE_HERMES_ROOT, ...getVenvSitePackagesEntries(venvRoot)],'
    )
  })

  it('a packaged resolver never takes a Hermes on PATH or a system Python (they are foreign to the gate)', () => {
    const updates = read('main/updates.ts')

    expect(updates).toContain(
      "if (!repairRequested && !IS_PACKAGED && codePathEnv('HERMES_DESKTOP_IGNORE_EXISTING') !== '1') {"
    )
    expect(updates).toContain('const python = repairRequested || IS_PACKAGED ? null : findSystemPython()')
    expect(updates).toContain('privateDependencies: runtimePrivateDependencies()')
  })
})
