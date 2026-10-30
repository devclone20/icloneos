/**
 * V3-RT RT-3 + K-RT2: the installed runtime is this release's, byte for byte — verified against the bundled manifest,
 * repaired from the bundled tarball when the app owns it, refused otherwise; a previous release's bundled runtime is
 * replaced before any agent starts. Every case runs on the REAL artifact of the compiled pin (built from git objects in a
 * temp folder, the same bytes the app bundles) and temp trees only: never ~/.hermes, never the network.
 */
import fs from 'node:fs'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { IcloneGateError } from './iclone-hermes-plugins'
import { ICLONE_MANAGED_FILE, managedStampFor, writeManagedStamp } from './iclone-managed-runtime'
import {
  checkRuntimeDependencies,
  distributionFilesChanged,
  excludedDistributionsIn,
  prepareDependencyInstall,
  sealRuntimeDependencies,
  unlistedRuntimeFiles
} from './iclone-runtime-closed'
import {
  extractRuntimeTarball,
  loadBundledManifest,
  parseRuntimeManifest,
  RUNTIME_MANIFEST_FILE,
  RUNTIME_SOURCE_MARKER,
  runtimeCopiesOutsideTree,
  runtimeOwnership,
  verifyRuntimeTree
} from './iclone-runtime-integrity'
import {
  canBuildPinnedArtifact,
  DEPENDENCY_BYTES,
  dependencyLayout,
  fakeDependencies,
  marker,
  type RuntimeFixture,
  runtimeFixture,
  UPSTREAM_PIN,
  UPSTREAM_TARBALL_SHA256
} from './iclone-runtime-integrity.test-helpers'
import { RUNTIME_PIN } from './runtime-pin.generated'

const SUITE = process.platform !== 'win32' && canBuildPinnedArtifact() ? describe : describe.skip

let fx: RuntimeFixture
let tmp: string
let bundleDir: string
let log: string[]
const managedTree = (name: string) => fx.managedTree(name)
const run: RuntimeFixture['run'] = (root, overrides) => fx.run(root, overrides)
const manifest = () => parseRuntimeManifest(fs.readFileSync(path.join(bundleDir, RUNTIME_MANIFEST_FILE), 'utf8'))

beforeAll(async () => {
  if (!canBuildPinnedArtifact()) {
    return
  }

  fx = await runtimeFixture()
  ;({ bundleDir, log, tmp } = fx)
}, 120_000)

// The fixtures hold full runtime trees (~130 MB each); their removal is awaited, or vitest exits before it finishes and
// the trees leak into the temp folder. Gigabytes take longer than the default 10 s hook timeout.
afterAll(async () => {
  if (tmp) {
    await fs.promises.rm(tmp, { force: true, recursive: true })
  }
}, 300_000)

SUITE('RT-3: the installed runtime against the bundled manifest', { timeout: 180_000 }, () => {
  it('a managed install of this release verifies (every manifest file hashed; the venv and caches are not the runtime)', async () => {
    const root = await managedTree('intact')
    fs.mkdirSync(path.join(root, 'hermes_cli', '__pycache__'), { recursive: true })
    fs.writeFileSync(path.join(root, 'hermes_cli', '__pycache__', 'x.pyc'), 'cache')

    const report = await run(root)

    expect(report.action).toBe('verified')
    expect(report.files).toBe(RUNTIME_PIN.files)
    expect(fs.existsSync(path.join(root, 'hermes_cli', 'iclone_policy_env.py'))).toBe(true)
    expect(log.at(-1)).toMatch(/\[iclone-runtime\] runtime [0-9a-f]{12} verified: \d+ files \(\d+ ms\)/)
    // Ruling 37 / M1: the tree runs on its shipped bytecode, so a .pyc the manifest does not list is removed.
    expect(fs.existsSync(path.join(root, 'hermes_cli', '__pycache__', 'x.pyc'))).toBe(false)
    expect(log.some(line => line.includes('removed 1 file(s) the manifest does not list'))).toBe(true)
  })

  it('M1: every file of the tree the manifest does not list is removed before Python starts; shipped ones stay', async () => {
    const root = await managedTree('closed-tree')

    const planted = [
      'sitecustomize.py',
      'json.py',
      'hermes_cli/main.cpython-314-darwin.so',
      'plugins/iclone-permissions/__pycache__/classify.cpython-314.pyc',
      'tools/usercustomize.py'
    ]

    for (const rel of planted) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
      fs.writeFileSync(path.join(root, rel), 'planted')
    }

    const m = parseRuntimeManifest(fs.readFileSync(path.join(root, RUNTIME_MANIFEST_FILE), 'utf8'))
    const shipped = m.entries.find(row => row[0].endsWith('.pyc'))?.[0] as string

    expect(unlistedRuntimeFiles(root, new Set(m.entries.map(row => row[0])))).toEqual([...planted].sort())
    expect((await run(root)).action).toBe('verified')

    for (const rel of planted) {
      expect(fs.existsSync(path.join(root, rel))).toBe(false)
    }

    expect(fs.existsSync(path.join(root, shipped))).toBe(true)
    expect(fs.existsSync(path.join(root, 'ICLONE_MANAGED.json'))).toBe(true)
    expect(fs.existsSync(path.join(root, 'ICLONE_DEPS_MANIFEST.json'))).toBe(true)
  })

  it('M1: a .pth or a sitecustomize added to the Python environment is removed; an edited dependency refuses', async () => {
    const root = await managedTree('closed-deps')

    const site = fs
      .readdirSync(path.join(root, '.iclone-deps'), { recursive: true })
      .map(rel => path.join(root, '.iclone-deps', String(rel)))
      .find(p => p.endsWith('site-packages')) as string

    fs.writeFileSync(path.join(site, 'zz_planted.pth'), 'import os\n')
    fs.writeFileSync(path.join(site, 'sitecustomize.py'), 'planted\n')
    expect((await run(root)).action).toBe('verified')
    expect(fs.existsSync(path.join(site, 'zz_planted.pth'))).toBe(false)
    expect(fs.existsSync(path.join(site, 'sitecustomize.py'))).toBe(false)
    expect(log.some(line => line.includes("file(s) the Python environment's record does not list"))).toBe(true)

    fs.appendFileSync(path.join(site, 'yaml.py'), '# edited\n')
    await expect(run(root)).rejects.toThrow(/Python environment changed or are missing .*yaml\.py.*Repair install/)
  })

  it('ruling 57.2: a telemetry distribution in the environment refuses (never recorded, never run)', async () => {
    const root = await managedTree('telemetry')

    const site = fs
      .readdirSync(path.join(root, '.iclone-deps'), { recursive: true })
      .map(rel => path.join(root, '.iclone-deps', String(rel)))
      .find(p => p.endsWith('site-packages')) as string

    expect(fs.readFileSync(path.join(root, 'pm', 'runtime-venv-exclusions.txt'), 'utf8')).toContain('nemo-relay')
    fs.mkdirSync(path.join(site, 'nemo_relay-0.9.3.dist-info'))
    expect(excludedDistributionsIn(root, path.dirname(path.dirname(path.dirname(site))))).toEqual([
      'nemo_relay-0.9.3.dist-info'
    ])
    await expect(run(root)).rejects.toThrow(/excluded telemetry distributions \(nemo_relay-0\.9\.3\.dist-info\)/)

    const fresh = prepareDependencyInstall(root)
    const again = fakeDependencies(root)

    fs.mkdirSync(path.join(again.site, 'nemo_relay-0.9.3.dist-info'))
    expect(() => sealRuntimeDependencies(root, fresh)).toThrow(/excluded telemetry distributions: nemo_relay/)
  })

  it('critic r2 m4: a missing telemetry exclusion list refuses (fail closed), at the spawn and at the seal', async () => {
    const root = await managedTree('telemetry-list-missing')

    const list = path.join(root, 'pm', 'runtime-venv-exclusions.txt')
    const bytes = fs.readFileSync(list)

    fs.rmSync(list)
    // The list is a manifest file, so integrity restores it from the bundle before the environment is judged; the
    // environment check itself refuses without it.
    expect(String(checkRuntimeDependencies(root).problem)).toMatch(
      /telemetry exclusion list \(pm\/runtime-venv-exclusions\.txt\) is missing/
    )

    const fresh = prepareDependencyInstall(root)
    fakeDependencies(root)
    expect(() => sealRuntimeDependencies(root, fresh)).toThrow(/exclusion list .* is missing/)
    fs.writeFileSync(list, bytes)
  })

  it('critic r2 M1: Repair never records an edited dependency; it is gone before the installer runs, the shipped bytes come back', async () => {
    const root = await managedTree('repair-edited-dep')

    const { site } = dependencyLayout(root)
    const record = path.join(root, 'ICLONE_DEPS_MANIFEST.json')
    const approved = fs.readFileSync(record, 'utf8')

    fs.appendFileSync(path.join(site, 'yaml.py'), 'open("/tmp/dep_after_repair", "w")\n')
    await expect(run(root)).rejects.toThrow(/Python environment changed or are missing .*yaml\.py.*Repair install/)

    // Repair install: the whole dependency folder, the launchers and the record go before the installer runs.
    const fresh = prepareDependencyInstall(root)

    expect(fs.existsSync(path.join(root, '.iclone-deps'))).toBe(false)
    expect(fs.existsSync(record)).toBe(false)

    // The installer makes the environment again from the pinned packages; the record covers exactly those bytes.
    fakeDependencies(root)
    sealRuntimeDependencies(root, fresh)
    expect(fs.readFileSync(path.join(site, 'yaml.py'), 'utf8')).toBe(DEPENDENCY_BYTES)
    expect(fs.readFileSync(record, 'utf8')).not.toContain('dep_after_repair')
    expect(JSON.parse(fs.readFileSync(record, 'utf8')).roots).toEqual(JSON.parse(approved).roots)
    expect((await run(root)).action).toBe('verified')
  })

  it('critic r2 M1: bytes the installer found already in place that differ from their wheel are never recorded', async () => {
    const root = await managedTree('repair-in-place')

    const fresh = prepareDependencyInstall(root)
    const { site } = fakeDependencies(root)

    // An installer that leaves an edited file "already in place" (what the critic reproduced live).
    fs.appendFileSync(path.join(site, 'yaml.py'), '# edited\n')
    expect(distributionFilesChanged(site)).toEqual(['pyyaml-6.0.2: yaml.py'])
    expect(() => sealRuntimeDependencies(root, fresh)).toThrow(
      /1 installed package file\(s\) differ .*pyyaml-6\.0\.2: yaml\.py/
    )
    expect(fs.existsSync(path.join(root, 'ICLONE_DEPS_MANIFEST.json'))).toBe(false)
    await expect(run(root)).rejects.toThrow(/never recorded by the installer/)
  })

  it('critic r2 M1: nothing is recorded without a fresh install: no capability, a used one, or another root', async () => {
    const root = await managedTree('seal-capability')
    const other = await managedTree('seal-capability-other')

    expect(() => sealRuntimeDependencies(root, null)).toThrow(/not made by an install from nothing/)

    const fresh = prepareDependencyInstall(root)
    fakeDependencies(root)
    expect(() => sealRuntimeDependencies(other, fresh)).toThrow(/not made by an install from nothing/)
    sealRuntimeDependencies(root, fresh)
    expect(() => sealRuntimeDependencies(root, fresh)).toThrow(/not made by an install from nothing/)
    expect(() => sealRuntimeDependencies(root, { root: path.resolve(root) })).toThrow(
      /not made by an install from nothing/
    )
  })

  it("critic r2 m1: a file planted in PM's own runtime is removed before a spawn, like any other", async () => {
    const root = await managedTree('pm-runtime-planted')

    const { pmSite } = dependencyLayout(root)

    fs.writeFileSync(path.join(pmSite, 'zz_planted.pth'), 'import os\n')
    fs.writeFileSync(path.join(pmSite, 'sitecustomize.py'), 'planted\n')
    expect((await run(root)).action).toBe('verified')
    expect(fs.existsSync(path.join(pmSite, 'zz_planted.pth'))).toBe(false)
    expect(fs.existsSync(path.join(pmSite, 'sitecustomize.py'))).toBe(false)
    fs.appendFileSync(path.join(pmSite, 'pm_tool.py'), '# edited\n')
    await expect(run(root)).rejects.toThrow(/Python environment changed or are missing .*pm-runtime.*pm_tool\.py/)
  })

  it('M1: an environment the installer never recorded, or one replaced outside the app, refuses', async () => {
    const root = await managedTree('closed-unrecorded')

    fs.rmSync(path.join(root, 'ICLONE_DEPS_MANIFEST.json'))
    await expect(run(root)).rejects.toThrow(/never recorded by the installer/)

    const fresh = prepareDependencyInstall(root)
    fakeDependencies(root)
    sealRuntimeDependencies(root, fresh)

    const facts = fs
      .readdirSync(path.join(root, '.iclone-deps'), { recursive: true })
      .map(rel => path.join(root, '.iclone-deps', String(rel)))
      .find(p => p.endsWith('facts.json')) as string

    const record = JSON.parse(fs.readFileSync(facts, 'utf8'))
    const other = path.join(path.dirname(path.dirname(record.packages.venv.environment)), 'gen2', 'venv')

    fs.cpSync(record.packages.venv.environment, other, { recursive: true, verbatimSymlinks: true })
    fs.writeFileSync(facts, JSON.stringify({ packages: { venv: { environment: other } } }))
    await expect(run(root)).rejects.toThrow(/replaced outside the app/)
  })
  it('K-RT15b: an importable copy of the runtime package under the app folder is found and removed at verify', async () => {
    const root = await managedTree('copies')

    const copy = path.join(
      root,
      '.iclone-deps',
      'hermes',
      'installs',
      'a',
      'environments',
      'b',
      'workspace',
      'hermes_cli'
    )

    fs.mkdirSync(copy, { recursive: true })
    fs.writeFileSync(path.join(copy, '__init__.py'), '# a copy\n')
    fs.writeFileSync(path.join(copy, '..', 'pyproject.toml'), '[project]\n')

    expect(runtimeCopiesOutsideTree(root)).toEqual([copy])
    expect((await run(root)).action).toBe('verified')
    expect(runtimeCopiesOutsideTree(root)).toEqual([])
    expect(fs.existsSync(path.join(copy, '..', 'pyproject.toml'))).toBe(true)
    expect(fs.existsSync(path.join(root, 'hermes_cli', '__init__.py'))).toBe(true)
    expect(log.some(line => line.includes('removed an unverified copy of the runtime package'))).toBe(true)
  })

  it('an app update with the same runtime keeps the tree: the stamp is brought to this version, the manifest copy restored', async () => {
    const root = await managedTree('app-update')
    const stampFile = path.join(root, ICLONE_MANAGED_FILE)
    const stamp = JSON.parse(fs.readFileSync(stampFile, 'utf8'))
    fs.writeFileSync(stampFile, JSON.stringify({ ...stamp, appVersion: '0.0.1' }))
    fs.rmSync(path.join(root, RUNTIME_MANIFEST_FILE))

    const report = await run(root, { appVersion: '0.0.9' })

    expect(report.action).toBe('verified')
    expect(JSON.parse(fs.readFileSync(stampFile, 'utf8'))).toMatchObject({
      appVersion: '0.0.9',
      installId: stamp.installId
    })
    expect(fs.readFileSync(path.join(root, RUNTIME_MANIFEST_FILE))).toEqual(
      fs.readFileSync(path.join(bundleDir, RUNTIME_MANIFEST_FILE))
    )
  })

  it('a tree outside the app runtime folder is never managed, whatever it holds (ruling 36)', async () => {
    const root = await managedTree('elsewhere')

    await expect(run(root, { managedRoot: path.join(tmp, 'the-app-folder') })).rejects.toThrow(
      /was not installed by icloneOS/
    )
  })

  it('a tampered managed runtime is detected and repaired from the bundle: content, mode, missing, link, folder', async () => {
    const root = await managedTree('tampered')
    const policy = path.join(root, 'hermes_cli', 'iclone_policy_env.py')
    fs.appendFileSync(policy, '\nKEY = None  # trojan\n')
    fs.rmSync(path.join(root, 'tools', 'approval.py'))
    fs.chmodSync(path.join(root, 'scripts', 'install.sh'), 0o644)
    fs.rmSync(path.join(root, 'model_tools.py'))
    fs.symlinkSync(path.join(tmp, 'elsewhere.py'), path.join(root, 'model_tools.py'))
    fs.rmSync(path.join(root, 'hermes_bootstrap.py'))
    fs.mkdirSync(path.join(root, 'hermes_bootstrap.py'))

    const before = verifyRuntimeTree(root, manifest())
    expect(before.ok).toBe(false)
    expect(before.missing).toEqual(['tools/approval.py'])
    expect([...before.changed].sort()).toEqual([
      'hermes_bootstrap.py',
      'hermes_cli/iclone_policy_env.py',
      'model_tools.py',
      'scripts/install.sh'
    ])

    const report = await run(root)

    expect(report.action).toBe('repaired')
    expect([...(report.repaired ?? [])].sort()).toEqual([
      'hermes_bootstrap.py',
      'hermes_cli/iclone_policy_env.py',
      'model_tools.py',
      'scripts/install.sh',
      'tools/approval.py'
    ])
    expect(verifyRuntimeTree(root, manifest()).ok).toBe(true)
    expect(fs.readFileSync(policy, 'utf8')).not.toContain('trojan')
    expect(fs.statSync(path.join(root, 'scripts', 'install.sh')).mode & 0o111).not.toBe(0)
    // The dependency environment is not the runtime's to repair: left as the installer recorded it.
    expect(fs.existsSync(path.join(root, 'ICLONE_DEPS_MANIFEST.json'))).toBe(true)
    expect(fs.readdirSync(path.dirname(root)).filter(name => name.startsWith('.iclone-runtime-repair-'))).toEqual([])
  })

  it('a repair never writes through a linked folder', async () => {
    const root = await managedTree('linked-dir')
    const real = path.join(tmp, 'linked-dir', 'agent-real')
    fs.renameSync(path.join(root, 'agent'), real)
    fs.symlinkSync(real, path.join(root, 'agent'))
    fs.appendFileSync(path.join(real, 'tool_executor.py'), '\n# changed\n')

    await expect(run(root)).rejects.toThrow(/could not be repaired \(agent is a link inside the runtime\)/)
    expect(fs.readFileSync(path.join(real, 'tool_executor.py'), 'utf8')).toContain('# changed')
  })

  it('each file a repair takes from the bundle is checked against the manifest first (the unpacked copy can change)', async () => {
    const root = await managedTree('stage-checked')
    fs.appendFileSync(path.join(root, 'hermes_cli', 'plugins.py'), '\n# changed\n')

    // The tarball passes its sha256; the copy unpacked from it is then altered before it is used.
    const extract = async (archive: string, dest: string) => {
      await extractRuntimeTarball(archive, dest)
      fs.appendFileSync(path.join(dest, 'hermes_cli', 'plugins.py'), '\n# swapped after the sha256 check\n')
    }

    await expect(run(root, { extract })).rejects.toThrow(
      /the bundled copy of hermes_cli\/plugins\.py does not match the manifest/
    )
    expect(fs.readFileSync(path.join(root, 'hermes_cli', 'plugins.py'), 'utf8')).toContain('# changed')
    expect(fs.readFileSync(path.join(root, 'hermes_cli', 'plugins.py'), 'utf8')).not.toContain('swapped')
  })

  it('a repair refuses a bundled tarball that is not the pinned one, and writes nothing', async () => {
    const root = await managedTree('bad-bundle')
    const badBundle = path.join(tmp, 'bad-bundle', 'Resources')
    fs.cpSync(bundleDir, badBundle, { recursive: true })
    const tarball = path.join(badBundle, `hermes-agent-${RUNTIME_PIN.sha}.tar.gz`)
    const bytes = fs.readFileSync(tarball)
    bytes[bytes.length - 100] ^= 0xff
    fs.writeFileSync(tarball, bytes)
    fs.appendFileSync(path.join(root, 'hermes_cli', 'plugins.py'), '\n# changed\n')

    await expect(run(root, { bundleDir: badBundle })).rejects.toThrow(/missing or damaged; reinstall icloneOS/)
    expect(fs.readFileSync(path.join(root, 'hermes_cli', 'plugins.py'), 'utf8')).toContain('# changed')
  })

  it('a bundled manifest that is not the pinned one refuses before anything is read', async () => {
    const root = await managedTree('bad-manifest')
    const badBundle = path.join(tmp, 'bad-manifest', 'Resources')
    fs.cpSync(bundleDir, badBundle, { recursive: true })
    fs.appendFileSync(path.join(badBundle, RUNTIME_MANIFEST_FILE), ' ')

    expect(loadBundledManifest(badBundle, RUNTIME_PIN)).toEqual({
      error: `the app bundle's ${RUNTIME_MANIFEST_FILE} is not the one this release pins; reinstall icloneOS`
    })
    await expect(run(root, { bundleDir: badBundle })).rejects.toBeInstanceOf(IcloneGateError)
  })

  it('a .git checkout is verify-only: an intact one passes, a changed one is refused and never written', async () => {
    const root = await managedTree('checkout')
    fs.rmSync(path.join(root, RUNTIME_SOURCE_MARKER))
    fs.mkdirSync(path.join(root, '.git'))

    expect(runtimeOwnership(root, RUNTIME_PIN)).toEqual({ kind: 'checkout' })
    expect((await run(root)).action).toBe('verified-checkout')

    fs.appendFileSync(path.join(root, 'tools', 'approval.py'), '\n# local change\n')
    await expect(run(root)).rejects.toThrow(/git checkout that differs .*1 changed, 0 missing: tools\/approval\.py/)
    expect(fs.readFileSync(path.join(root, 'tools', 'approval.py'), 'utf8')).toContain('# local change')
  })

  it('a previous release, a foreign runtime and no runtime are refused (Repair install), never verified', async () => {
    // 0.0.2: the upstream tarball's codeload marker and no ICLONE_MANAGED.json stamp.
    const previous = await managedTree('previous')
    fs.rmSync(path.join(previous, ICLONE_MANAGED_FILE))
    marker(previous, { sha: UPSTREAM_PIN, sha256: UPSTREAM_TARBALL_SHA256, source: 'codeload' })
    expect(runtimeOwnership(previous, RUNTIME_PIN)).toEqual({
      kind: 'previous-bundle',
      sha: UPSTREAM_PIN,
      source: 'codeload'
    })
    await expect(run(previous)).rejects.toThrow(/a previous release's \(1ac3f97fbe09\)/)

    // A stamp of another pin (a later release's runtime left behind by a downgrade) is not this release's either.
    const otherStamp = await managedTree('other-stamp')
    writeManagedStamp(
      otherStamp,
      managedStampFor({ appVersion: '0.0.4', lockHash: 'e'.repeat(64), runtimeSha: 'd'.repeat(40) })
    )
    expect(runtimeOwnership(otherStamp, RUNTIME_PIN)).toMatchObject({ kind: 'previous-bundle', sha: 'd'.repeat(40) })
    await expect(run(otherStamp)).rejects.toBeInstanceOf(IcloneGateError)

    const foreign = await managedTree('foreign')
    fs.rmSync(path.join(foreign, RUNTIME_SOURCE_MARKER))
    fs.rmSync(path.join(foreign, ICLONE_MANAGED_FILE))
    expect(runtimeOwnership(foreign, RUNTIME_PIN)).toEqual({ kind: 'foreign' })
    await expect(run(foreign)).rejects.toThrow(/was not installed by icloneOS/)

    await expect(run(path.join(tmp, 'nothing-here'))).rejects.toThrow(/no agent runtime is installed/)
  })

  it('a dev run (not packaged) is skipped: its runtime is the repository itself', async () => {
    expect(await run(path.join(tmp, 'nothing-here'), { packaged: false })).toEqual({
      action: 'skipped',
      files: 0,
      ms: 0
    })
  })

  it('the manifest parser refuses paths that leave the runtime', () => {
    const text = (rel: string) =>
      JSON.stringify({
        schema: 1,
        source: 'repo',
        sha: 'a'.repeat(40),
        files: 1,
        entries: [[rel, '644', 1, 'b'.repeat(64)]]
      })

    for (const bad of ['../x', '/etc/passwd', 'a/../../b', 'a\\b', 'a//b']) {
      expect(() => parseRuntimeManifest(text(bad))).toThrow(/bad manifest row/)
    }

    expect(parseRuntimeManifest(text('a/b.py')).files).toBe(1)
  })
})
