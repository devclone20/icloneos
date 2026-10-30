import { spawnSync } from 'node:child_process'
/**
 * V3-RT test fixtures: the REAL artifact of the compiled pin, built from git objects into a temp "Resources/hermes-runtime"
 * (the same bytes the app bundles), and installed trees in temp folders. Never ~/.hermes, never the network.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { managedStampFor, writeManagedStamp } from './iclone-managed-runtime'
import { prepareDependencyInstall, sealRuntimeDependencies } from './iclone-runtime-closed'
import {
  ensureRuntimeIntegrity,
  extractRuntimeTarball,
  RUNTIME_MANIFEST_FILE,
  RUNTIME_SOURCE_MARKER
} from './iclone-runtime-integrity'
import { RUNTIME_PIN } from './runtime-pin.generated'

export const UPSTREAM_PIN = '1ac3f97fbe0958aa2743c0c26202b20b3b4e760e'

const PIN_RECORD = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../iclone/RUNTIME_PIN.json'), 'utf8')) as {
  python?: string
  python_build?: { executable_sha256?: string }
}

/** The CPython the pinned bytecode is compiled by (iclone/RUNTIME_PIN.json `python`), or null when none is shipped. */
export const PIN_PYTHON: null | string = PIN_RECORD.python ?? null

/** The sha256 of that CPython's interpreter binary (python_build.executable_sha256), or null when the pin names none. */
export const PIN_PYTHON_SHA256: null | string = PIN_RECORD.python_build?.executable_sha256 ?? null

/** The sha256 of the real file behind `python`, or null when it cannot be read. */
function interpreterSha256(python: string): null | string {
  try {
    return createHash('sha256')
      .update(fs.readFileSync(fs.realpathSync(python)))
      .digest('hex')
  } catch {
    return null
  }
}

/**
 * True when this machine can rebuild the pinned artifact (the suites that need it skip otherwise; the gate requires
 * them). The version string alone is not the pin (critics' panel, minor 4): uv's 3.14.7 is another build, so the
 * interpreter's sha256 must be the pin's too.
 */
export function canBuildPinnedArtifact(): boolean {
  if (!PIN_PYTHON) {
    return true
  }

  const candidate = process.env.ICLONE_RUNTIME_PY

  return Boolean(
    candidate &&
    spawnSync(candidate, ['-I', '-c', 'import platform;print(platform.python_version())'], {
      encoding: 'utf8'
    }).stdout?.trim() === PIN_PYTHON &&
    (!PIN_PYTHON_SHA256 || interpreterSha256(candidate) === PIN_PYTHON_SHA256)
  )
}

export const UPSTREAM_TARBALL_SHA256 = '6bd895564200888f22b14403d956bd15dcf2d69273c242a35dcc2f2eb758d047'

interface Artifact {
  installSh: Buffer
  manifestBytes: Buffer
  tarball: Buffer
  tarballSha256: string
}

// The artifact builder is plain JS without a declaration file (as runtime-pin.test.ts loads gen-types.mjs).
const BUILDER = pathToFileURL(path.resolve(__dirname, '../scripts/runtime-artifact.mjs')).href

/**
 * A dependency environment the way PM lays it out under the app's runtime (M1): `.iclone-deps/hermes/installs/<key>/
 * facts.json` naming a venv whose `pyvenv.cfg` points at a Python installation under `.iclone-deps/hermes/tools`.
 */
/** The bytes the fake `pyyaml` wheel installs as `yaml.py`. */
export const DEPENDENCY_BYTES = '# a dependency\n'

/** Where `fakeDependencies` puts each part, without writing anything. */
export function dependencyLayout(root: string) {
  const hermes = path.join(root, '.iclone-deps', 'hermes')
  const key = createHash('sha256').update(fs.realpathSync(root), 'utf8').digest('hex').slice(0, 16)
  const venv = path.join(hermes, 'installs', key, 'environments', 'gen1', 'venv')

  return {
    hermes,
    key,
    pmSite: path.join(hermes, 'installs', key, 'pm-runtime', 'generations', 'g1', 'lib', 'python3.14', 'site-packages'),
    python: path.join(hermes, 'tools', 'python-3.14.7'),
    site: path.join(venv, 'lib', 'python3.14', 'site-packages'),
    venv
  }
}

export function fakeDependencies(root: string): { pmSite: string; python: string; site: string; venv: string } {
  const { hermes, key, pmSite, python, site, venv } = dependencyLayout(root)

  fs.mkdirSync(path.join(python, 'bin'), { recursive: true })
  fs.mkdirSync(path.join(python, 'lib', 'python3.14'), { recursive: true })
  fs.writeFileSync(path.join(python, 'bin', 'python3.14'), '#!/bin/sh\n', { mode: 0o755 })
  fs.writeFileSync(path.join(python, 'lib', 'python3.14', 'os.py'), '# stdlib\n')
  fs.mkdirSync(path.join(venv, 'bin'), { recursive: true })
  fs.mkdirSync(site, { recursive: true })
  fs.symlinkSync(path.join(python, 'bin', 'python3.14'), path.join(venv, 'bin', 'python'))
  fs.writeFileSync(path.join(venv, 'pyvenv.cfg'), `home = ${path.join(python, 'bin')}\n`)
  fs.writeFileSync(path.join(site, 'iclone-runtime.pth'), `${root}\n`)
  fs.writeFileSync(path.join(site, 'yaml.py'), DEPENDENCY_BYTES)
  // The wheel's own record of what it installed (critic r2 M1: a seal checks every file against it).
  fs.mkdirSync(path.join(site, 'pyyaml-6.0.2.dist-info'))
  fs.writeFileSync(
    path.join(site, 'pyyaml-6.0.2.dist-info', 'RECORD'),
    `yaml.py,sha256=${createHash('sha256').update(DEPENDENCY_BYTES).digest('base64url')},${DEPENDENCY_BYTES.length}\n` +
      'pyyaml-6.0.2.dist-info/RECORD,,\n'
  )
  // PM's own runtime (critic r2 m1): one generation of the `pm` tool's environment.
  fs.mkdirSync(pmSite, { recursive: true })
  fs.writeFileSync(path.join(pmSite, 'pm_tool.py'), '# the pm tool\n')
  fs.writeFileSync(
    path.join(hermes, 'installs', key, 'facts.json'),
    JSON.stringify({ packages: { venv: { environment: venv } } })
  )

  return { pmSite, python, site, venv }
}

export interface RuntimeFixture {
  bundleDir: string
  log: string[]
  /** A managed install of this release's runtime, exactly as installSourceTarball leaves it (plus a venv). */
  managedTree: (name: string) => Promise<string>
  run: (
    root: string,
    overrides?: Partial<Parameters<typeof ensureRuntimeIntegrity>[0]>
  ) => ReturnType<typeof ensureRuntimeIntegrity>
  tmp: string
}

export function marker(root: string, value: Record<string, unknown>) {
  fs.writeFileSync(path.join(root, RUNTIME_SOURCE_MARKER), JSON.stringify(value))
}

export async function runtimeFixture(): Promise<RuntimeFixture> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v3rt-runtime-'))
  const bundleDir = path.join(tmp, 'Resources', 'hermes-runtime')
  fs.mkdirSync(bundleDir, { recursive: true })

  const { buildRuntimeArtifact, tryRuntimePython } = (await import(BUILDER)) as {
    buildRuntimeArtifact: (o: { python: null | string; rev: string }) => Artifact
    tryRuntimePython: (version: string, executableSha256?: null | string) => null | string
  }

  const python = PIN_PYTHON ? tryRuntimePython(PIN_PYTHON, PIN_PYTHON_SHA256) : null

  if (PIN_PYTHON && !python) {
    throw new Error(`the pin ships Python ${PIN_PYTHON} bytecode: set ICLONE_RUNTIME_PY to that interpreter`)
  }

  const artifact = buildRuntimeArtifact({ python, rev: RUNTIME_PIN.sha })

  if (artifact.tarballSha256 !== RUNTIME_PIN.tarballSha256) {
    throw new Error(`the artifact of ${RUNTIME_PIN.sha} is not the pinned one`)
  }

  fs.writeFileSync(path.join(bundleDir, `hermes-agent-${RUNTIME_PIN.sha}.tar.gz`), artifact.tarball)
  fs.writeFileSync(path.join(bundleDir, RUNTIME_MANIFEST_FILE), artifact.manifestBytes)
  fs.writeFileSync(path.join(bundleDir, 'install.sh'), artifact.installSh, { mode: 0o755 })

  const log: string[] = []

  const managedTree = async (name: string) => {
    const root = path.join(tmp, name, 'hermes-agent')
    fs.mkdirSync(root, { recursive: true })
    await extractRuntimeTarball(path.join(bundleDir, `hermes-agent-${RUNTIME_PIN.sha}.tar.gz`), root)
    marker(root, {
      installedAt: '2026-10-22T00:00:00.000Z',
      manifestSha256: RUNTIME_PIN.manifestSha256,
      sha: RUNTIME_PIN.sha,
      sha256: RUNTIME_PIN.tarballSha256,
      source: 'repo'
    })
    fs.copyFileSync(path.join(bundleDir, RUNTIME_MANIFEST_FILE), path.join(root, RUNTIME_MANIFEST_FILE))
    writeManagedStamp(
      root,
      managedStampFor({ appVersion: '0.0.3', lockHash: RUNTIME_PIN.tarballSha256, runtimeSha: RUNTIME_PIN.sha })
    )
    const fresh = prepareDependencyInstall(root)
    fakeDependencies(root)
    sealRuntimeDependencies(root, fresh)

    return root
  }

  const run: RuntimeFixture['run'] = (root, overrides = {}) =>
    ensureRuntimeIntegrity({
      bundleDir,
      log: line => log.push(line),
      packaged: true,
      pin: RUNTIME_PIN,
      root,
      ...overrides
    })

  return { bundleDir, log, managedTree, run, tmp }
}
