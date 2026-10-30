#!/usr/bin/env node
// Bundles the pinned Hermes runtime source (iclone/RUNTIME_PIN.json) into build/hermes-runtime/, which
// electron-builder ships as Resources/hermes-runtime: the packaged app's first run installs from it and never
// contacts Nous. Build time only.
//
// A `source: "repo"` pin (V3-RT, K153) is BUILT here from this repository's git objects at the pin's commit
// (scripts/runtime-artifact.mjs): offline, deterministic, and refused unless the tarball, the manifest and the installer
// hash to the pin's values. Any other pin is the legacy upstream tarball: downloaded once, refused unless its sha256 is
// the pin's, offline whenever the bundle is already in place (the release refuses it, RT-5).
//
//   node scripts/fetch-runtime-pin.mjs [--offline] [--out <dir>]
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import https from 'node:https'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

import { buildRuntimeArtifact, findRuntimePython, gzipIdentity, RUNTIME_MANIFEST_FILE } from './runtime-artifact.mjs'
import { isMain } from './utils.mjs'

const here = dirname(fileURLToPath(import.meta.url))

export const DESKTOP_DIR = resolve(here, '..')
export const BUNDLE_DIR = join(DESKTOP_DIR, 'build', 'hermes-runtime')
export const PIN_PATH = resolve(DESKTOP_DIR, '..', '..', 'iclone', 'RUNTIME_PIN.json')
export const RUNTIME_REPO = 'NousResearch/hermes-agent'
export const BUNDLE_MANIFEST = 'BUNDLE.json'
/** Per-user cache of verified runtime tarballs (one file per sha; a copy is used only after its sha256 matches). */
export const CACHE_DIR =
  process.env.ICLONE_RUNTIME_CACHE ||
  (process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Caches', 'iclone-os', 'hermes-runtime')
    : join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'iclone-os', 'hermes-runtime'))
export const BUNDLED_INSTALL_SH = 'install.sh'

const SHA40_RE = /^[0-9a-f]{40}$/
const SHA256_RE = /^[0-9a-f]{64}$/
const REDIRECT_HOSTS = new Set(['codeload.github.com', 'github.com'])

export function readPin(text) {
  const pin = JSON.parse(text)

  if (!SHA40_RE.test(pin.sha) || !SHA256_RE.test(pin.tarball_sha256) || !SHA256_RE.test(pin.install_sh_sha256)) {
    throw new Error('RUNTIME_PIN.json needs sha (40 hex), tarball_sha256 and install_sh_sha256 (64 hex)')
  }

  const base = { sha: pin.sha, tarballSha256: pin.tarball_sha256, installShSha256: pin.install_sh_sha256 }

  if (pin.source === undefined) {
    return { ...base, source: 'upstream' }
  }

  if (pin.source !== 'repo' || !SHA256_RE.test(pin.manifest_sha256 ?? '') || !Number.isInteger(pin.files)) {
    throw new Error('RUNTIME_PIN.json: a source "repo" pin needs manifest_sha256 (64 hex) and files')
  }

  return {
    ...base,
    source: 'repo',
    manifestSha256: pin.manifest_sha256,
    files: pin.files,
    // Ruling 37: the CPython version the shipped bytecode is compiled by (absent = no bytecode shipped).
    python: typeof pin.python === 'string' ? pin.python : null,
    // K-RT10: the zlib build the tarball was compressed with.
    gzip: typeof pin.gzip === 'string' ? pin.gzip : null,
    pythonBuild: pin.python_build && typeof pin.python_build === 'object' ? pin.python_build : null
  }
}

// Must match bundledRuntimeTarballName() in electron/bootstrap-runner.ts.
export const tarballName = sha => `hermes-agent-${sha}.tar.gz`
export const tarballUrl = sha => `https://codeload.github.com/${RUNTIME_REPO}/tar.gz/${sha}`

export async function sha256File(path) {
  const hash = createHash('sha256')

  for await (const chunk of createReadStream(path)) {
    hash.update(chunk)
  }

  return hash.digest('hex')
}

/** Streams an https URL to `dest` (at most 3 redirects, GitHub hosts only). */
export function downloadTo(url, dest, redirects = 0) {
  return new Promise((resolvePromise, reject) => {
    https
      .get(url, res => {
        const location = res.headers.location

        if (res.statusCode >= 300 && res.statusCode < 400 && location) {
          res.resume()
          const next = new URL(location, url)

          if (redirects >= 3 || next.protocol !== 'https:' || !REDIRECT_HOSTS.has(next.hostname)) {
            reject(new Error(`refusing a redirect to ${next.origin}`))

            return
          }

          downloadTo(next.href, dest, redirects + 1).then(resolvePromise, reject)

          return
        }

        if (res.statusCode !== 200) {
          res.resume()
          reject(new Error(`GET ${url} -> HTTP ${res.statusCode}`))

          return
        }

        pipeline(res, createWriteStream(dest)).then(resolvePromise, reject)
      })
      .on('error', reject)
  })
}

function readInstallSh(archive, sha) {
  const member = `hermes-agent-${sha}/scripts/install.sh`
  const out = spawnSync('tar', ['-xzOf', archive, member], { maxBuffer: 16 * 1024 * 1024 })

  if (out.status !== 0) {
    throw new Error(`the runtime tarball has no ${member}`)
  }

  return out.stdout
}

/** Every reason the bundle at `dir` is not exactly the pin (empty = ready to ship). */
export async function verifyRuntimeBundle(dir, pin) {
  const problems = []
  const tarball = join(dir, tarballName(pin.sha))

  if (!existsSync(tarball)) {
    problems.push(`missing ${tarballName(pin.sha)}`)
  } else if ((await sha256File(tarball)) !== pin.tarballSha256) {
    problems.push(`${tarballName(pin.sha)} does not match the pinned sha256`)
  }

  const installSh = join(dir, BUNDLED_INSTALL_SH)

  if (!existsSync(installSh)) {
    problems.push(`missing ${BUNDLED_INSTALL_SH}`)
  } else if ((await sha256File(installSh)) !== pin.installShSha256) {
    problems.push(`${BUNDLED_INSTALL_SH} does not match the pinned sha256`)
  }

  if (pin.source === 'repo') {
    const manifest = join(dir, RUNTIME_MANIFEST_FILE)

    if (!existsSync(manifest)) {
      problems.push(`missing ${RUNTIME_MANIFEST_FILE}`)
    } else if ((await sha256File(manifest)) !== pin.manifestSha256) {
      problems.push(`${RUNTIME_MANIFEST_FILE} does not match the pinned manifest_sha256`)
    }
  }

  const stale = existsSync(dir)
    ? readdirSync(dir).filter(name => /^hermes-agent-.*\.tar\.gz/.test(name) && name !== tarballName(pin.sha))
    : []

  if (stale.length > 0) {
    problems.push(`stale runtime tarball(s): ${stale.join(', ')}`)
  }

  return problems
}

/**
 * V3-RT: the runtime folder as PACKED (Resources/hermes-runtime): the bundle checks, and exactly the files the app reads
 * (a repo pin needs its manifest there: the spawn gate verifies the installed runtime against it). Empty = shippable.
 */
export async function verifyPackedRuntime(dir, pin) {
  const problems = await verifyRuntimeBundle(dir, pin)
  const want = [
    tarballName(pin.sha),
    BUNDLED_INSTALL_SH,
    BUNDLE_MANIFEST,
    ...(pin.source === 'repo' ? [RUNTIME_MANIFEST_FILE] : [])
  ]
  const have = existsSync(dir) ? readdirSync(dir) : []

  for (const name of want) {
    if (!have.includes(name) && !problems.some(problem => problem.includes(name))) {
      problems.push(`missing ${name}`)
    }
  }

  const extra = have.filter(name => !want.includes(name))

  if (extra.length > 0) {
    problems.push(`unexpected ${extra.join(', ')}`)
  }

  return problems
}

/** Writes `name` into `dir` through a sibling temp file and a rename (a crash never leaves half a file). */
function writeAtomic(dir, name, data, mode = 0o644) {
  const tmp = join(dir, `.${name}.partial`)
  writeFileSync(tmp, data, { mode })
  chmodSync(tmp, mode)
  renameSync(tmp, join(dir, name))
}

/**
 * V3-RT: builds the runtime of a `source: "repo"` pin from git objects at `pin.sha` and writes the bundle. Refuses (and
 * writes nothing) unless the tarball, manifest and installer hash to the pin's values: the bundle is exactly the
 * runtime the pin names, byte for byte.
 */
export function bundleRepoRuntime({ pin, outDir = BUNDLE_DIR, repo, python, log = () => {} }) {
  if (pin.gzip && pin.gzip !== gzipIdentity()) {
    throw new Error(
      `the pinned tarball was compressed by ${pin.gzip}; this Node has ${gzipIdentity()}: build with the Node the pin names, or re-pin`
    )
  }

  const artifact = buildRuntimeArtifact({
    rev: pin.sha,
    python: python ?? (pin.python ? findRuntimePython(pin.python) : null),
    ...(repo ? { cwd: repo } : {})
  })
  if (pin.pythonBuild && artifact.pythonBuild?.executable_sha256 !== pin.pythonBuild.executable_sha256) {
    throw new Error(
      `the pinned bytecode was compiled by CPython ${pin.pythonBuild.version} (interpreter sha256 ${String(pin.pythonBuild.executable_sha256).slice(0, 12)}); ` +
        `this build has ${artifact.pythonBuild?.version ?? 'none'} (${String(artifact.pythonBuild?.executable_sha256 ?? '').slice(0, 12)}): build with the CPython the pin names, or re-pin`
    )
  }

  const wrong = [
    ['tarball', artifact.tarballSha256, pin.tarballSha256],
    ['manifest', artifact.manifestSha256, pin.manifestSha256],
    ['install.sh', artifact.installShSha256, pin.installShSha256]
  ].filter(([, got, want]) => got !== want)

  if (wrong.length || artifact.files !== pin.files || artifact.sha !== pin.sha) {
    throw new Error(
      `the runtime built from ${pin.sha.slice(0, 12)} is not the pinned one (${
        wrong.map(([what, got, want]) => `${what} ${got.slice(0, 12)} != ${want.slice(0, 12)}`).join(', ') ||
        `files ${artifact.files} != ${pin.files}`
      }); rebuild the pin: node scripts/runtime-artifact.mjs pin`
    )
  }

  mkdirSync(outDir, { recursive: true })

  for (const name of readdirSync(outDir)) {
    if (name !== tarballName(pin.sha) && /^hermes-agent-/.test(name)) {
      rmSync(join(outDir, name), { force: true, recursive: true })
      log(`removed ${name} (not the current pin)`)
    }
  }

  writeAtomic(outDir, tarballName(pin.sha), artifact.tarball)
  writeAtomic(outDir, BUNDLED_INSTALL_SH, artifact.installSh, 0o755)
  writeAtomic(outDir, RUNTIME_MANIFEST_FILE, artifact.manifestBytes)
  writeAtomic(
    outDir,
    BUNDLE_MANIFEST,
    `${JSON.stringify(
      {
        sha: pin.sha,
        source: 'repo',
        tarball: tarballName(pin.sha),
        tarball_sha256: pin.tarballSha256,
        install_sh_sha256: pin.installShSha256,
        manifest: RUNTIME_MANIFEST_FILE,
        manifest_sha256: pin.manifestSha256,
        files: pin.files
      },
      null,
      2
    )}\n`
  )

  log(
    `built ${tarballName(pin.sha)} from git objects (${artifact.files} files, ${artifact.tarball.length} bytes, ` +
      `sha256 ${artifact.tarballSha256.slice(0, 12)} = pin; manifest ${artifact.manifestSha256.slice(0, 12)} = pin)`
  )

  return { built: true, dir: outDir, tarball: join(outDir, tarballName(pin.sha)) }
}

export async function fetchRuntimePin({
  pin,
  outDir = BUNDLE_DIR,
  offline = false,
  cacheDir = CACHE_DIR,
  download = downloadTo,
  log = () => {},
  repo
}) {
  if (pin.source === 'repo') {
    return bundleRepoRuntime({ pin, outDir, repo, log })
  }

  mkdirSync(outDir, { recursive: true })

  for (const name of readdirSync(outDir)) {
    if (name !== tarballName(pin.sha) && /^hermes-agent-/.test(name)) {
      rmSync(join(outDir, name), { force: true, recursive: true })
      log(`removed ${name} (not the current pin)`)
    }
  }

  const tarball = join(outDir, tarballName(pin.sha))
  const cached = cacheDir ? join(cacheDir, tarballName(pin.sha)) : null
  let downloaded = false
  let fromCache = false

  if (existsSync(tarball) && (await sha256File(tarball)) === pin.tarballSha256) {
    log(`bundle present: ${tarballName(pin.sha)} (sha256 verified, nothing downloaded)`)
  } else if (cached && existsSync(cached) && (await sha256File(cached)) === pin.tarballSha256) {
    rmSync(tarball, { force: true })
    copyFileSync(cached, tarball)
    fromCache = true
    log(`bundle from the user cache: ${tarballName(pin.sha)} (sha256 verified, nothing downloaded)`)
  } else {
    rmSync(tarball, { force: true })

    if (offline) {
      throw new Error(`--offline: ${tarballName(pin.sha)} is not bundled yet`)
    }

    const partial = `${tarball}.partial`
    const url = tarballUrl(pin.sha)

    log(`downloading ${url}`)

    try {
      await download(url, partial)
      const got = await sha256File(partial)

      if (got !== pin.tarballSha256) {
        throw new Error(
          `the downloaded runtime failed its sha256 check (got ${got.slice(0, 12)}, pin ${pin.tarballSha256.slice(0, 12)}); nothing bundled`
        )
      }

      renameSync(partial, tarball)
      downloaded = true

      if (cached) {
        // Best effort: the cache is a convenience, never a requirement.
        try {
          mkdirSync(cacheDir, { recursive: true })
          copyFileSync(tarball, `${cached}.partial`)
          renameSync(`${cached}.partial`, cached)
          log(`cached for the next build: ${cached}`)
        } catch {
          rmSync(`${cached}.partial`, { force: true })
        }
      }
    } finally {
      rmSync(partial, { force: true })
    }
  }

  const script = readInstallSh(tarball, pin.sha)

  if (createHash('sha256').update(script).digest('hex') !== pin.installShSha256) {
    throw new Error('scripts/install.sh inside the runtime tarball does not match the pinned sha256')
  }

  writeFileSync(join(outDir, BUNDLED_INSTALL_SH), script)
  chmodSync(join(outDir, BUNDLED_INSTALL_SH), 0o755)
  writeFileSync(
    join(outDir, BUNDLE_MANIFEST),
    `${JSON.stringify(
      {
        sha: pin.sha,
        tarball: tarballName(pin.sha),
        tarball_sha256: pin.tarballSha256,
        install_sh_sha256: pin.installShSha256
      },
      null,
      2
    )}\n`
  )

  return { downloaded, fromCache, dir: outDir, tarball }
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2)
  const outIndex = argv.indexOf('--out')
  const log = line => console.log(`[fetch-runtime-pin] ${line}`)

  fetchRuntimePin({
    pin: readPin(readFileSync(PIN_PATH, 'utf8')),
    outDir: outIndex >= 0 ? resolve(argv[outIndex + 1]) : BUNDLE_DIR,
    offline: argv.includes('--offline'),
    log
  })
    .then(result => log(`ready: ${result.tarball}`))
    .catch(error => {
      console.error(`[fetch-runtime-pin] ${error.message}`)
      process.exit(1)
    })
}
