#!/usr/bin/env node
// Assemble the owner's publishing folder from finished artifacts — pure copy + hash:
//   ~/Desktop/iclone-os-distribution/v<A.B.C>/{01-macOS-DMG, 02-Chrome-App, 03-Linux-Ubuntu, MANIFEST.json}
//   (<version> is the three-number A.B.C the artifacts carry; the folder and the READMEs show the same three numbers,
//   src/iclone-shared/version.ts. Everything else under iclone-os-distribution/ — docs, the iPhone folder — is never touched.)
// Inputs are verified against the SHA256SUMS they were built with; a mismatch, a DMG Gatekeeper rejects, a version
// that is not <version> or a runtime pin that differs between artifacts refuses the whole run. It never builds,
// signs or uploads, and never deletes outside its own <version> folder.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { assertClean, compileMarkers, pinnedProvenance, scanDistribution } from './artifact-hygiene.mjs'
import { loadPrivateMarkers } from './private-markers.mjs'
import { ownerNamesOf } from './skill-text-policy.mjs'
import { linuxArtifactNames } from './release-linux.mjs'
import { DMG_NAME, sha256SumsText } from './release-mac.mjs'
import { isMain } from './utils.mjs'
import { displayVersion } from '../src/iclone-shared/version.ts'

const here = dirname(fileURLToPath(import.meta.url))

export const DESKTOP_DIR = resolve(here, '..')
export const FOLDERS = { mac: '01-macOS-DMG', web: '02-Chrome-App', linux: '03-Linux-Ubuntu' }
export const CI_REPO = 'devclone20/iclone-os'
export const CI_WORKFLOW = { name: 'release-linux', path: '.github/workflows/release-linux.yml' }
export const WEB_REQUIRED = ['index.html', 'manifest.webmanifest', 'sw.js']
// Absolute: a shell whose PATH lacks /usr/sbin (a non-login shell, some agents) found no `spctl`, and the failed spawn
// read as "Gatekeeper rejects" with an empty reason.
export const SPCTL = '/usr/sbin/spctl'

export function parseArgs(argv) {
  const opts = {
    version: null,
    dmgDir: null,
    webDir: null,
    linuxDir: null,
    linuxRun: null,
    out: null,
    replace: false,
    linuxPending: false,
    commit: null
  }
  const flags = {
    '--dmg-dir': 'dmgDir',
    '--web': 'webDir',
    '--linux': 'linuxDir',
    '--linux-run': 'linuxRun',
    '--out': 'out',
    '--commit': 'commit'
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]

    if (flags[arg]) {
      opts[flags[arg]] = argv[++i] ?? null
    } else if (arg === '--replace') {
      opts.replace = true
    } else if (arg === '--linux-pending') {
      // The Linux packages come from the CI run; until it exists the folder says so instead of blocking the macOS
      // and Chrome deliverables.
      opts.linuxPending = true
    } else if (!arg.startsWith('--') && !opts.version) {
      opts.version = arg
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }

  if (!/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(opts.version ?? '')) {
    throw new Error(
      'usage: make-distribution.mjs <version> [--dmg-dir D] [--web D] [--linux D | --linux-run ID | --linux-pending] [--out D] [--replace]'
    )
  }

  if ([opts.linuxDir, opts.linuxRun, opts.linuxPending].filter(Boolean).length > 1) {
    throw new Error('--linux, --linux-run and --linux-pending are exclusive')
  }

  return opts
}

export function parseSums(text) {
  const sums = new Map()

  for (const line of text.split('\n')) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim())

    if (match) {
      sums.set(match[2], match[1])
    }
  }

  return sums
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Relative paths of every file under `dir`, sorted, POSIX separators. */
export function listFiles(dir) {
  const out = []
  const walk = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)

      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile()) {
        out.push(relative(dir, full).split(sep).join('/'))
      }
    }
  }

  walk(dir)

  return out.sort()
}

function requireFile(path, what) {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`missing ${what}: ${path}`)
  }

  return path
}

function verifyAgainst(sums, name, path, source) {
  const expected = sums.get(name)

  if (!expected) {
    throw new Error(`${name} is not listed in ${source}`)
  }

  const actual = sha256File(path)

  if (actual !== expected) {
    throw new Error(`sha256 mismatch for ${name}: ${source} says ${expected}, file is ${actual}`)
  }

  return actual
}

function yamlVersion(text) {
  return /^version:\s*['"]?([^'"\s]+)/m.exec(text)?.[1] ?? null
}

function pinOf(runtimeJsonPath) {
  const pin = JSON.parse(readFileSync(runtimeJsonPath, 'utf8'))

  return { sha: pin.sha, tarball_sha256: pin.tarball_sha256, min_app: pin.min_app }
}

export const COMMIT_RE = /^[0-9a-f]{40}$/
export const LINUX_COMMIT_FILE = 'BUILD_COMMIT.txt'
export const WEB_COMMIT_FILE = 'BUILD_COMMIT.txt'

/** install-stamp.json of the app inside the DMG (mounted read-only, always detached). */
export function readDmgStamp(dmgPath, deps) {
  const mount = mkdtempSync(join(tmpdir(), 'iclone-dmg-'))

  try {
    const attach = deps.run('hdiutil', ['attach', '-readonly', '-nobrowse', '-noverify', '-mountpoint', mount, dmgPath])

    if (attach.status !== 0) {
      throw new Error(`hdiutil could not mount ${basename(dmgPath)}: ${(attach.stderr || '').trim()}`)
    }

    try {
      const app = readdirSync(mount).find(name => name.endsWith('.app'))
      const stamp = app && join(mount, app, 'Contents', 'Resources', 'install-stamp.json')

      if (!stamp || !existsSync(stamp)) {
        throw new Error(`${basename(dmgPath)} has no app with Contents/Resources/install-stamp.json`)
      }

      return JSON.parse(readFileSync(stamp, 'utf8'))
    } finally {
      deps.run('hdiutil', ['detach', mount, '-quiet'])
    }
  } finally {
    rmSync(mount, { recursive: true, force: true })
  }
}

/** The commit that built every artifact: the CI run's headSha, which the DMG's stamp (and --commit, if given) must equal. */
export function buildCommit({ dmgStamp, linuxCommit, runHeadSha, webCommit, expected, linuxPending = false }) {
  // With the Linux packages pending, the DMG's own build commit is the one every other artifact must match.
  const linux = linuxPending ? dmgStamp?.commit : (runHeadSha ?? linuxCommit)

  if (!linuxPending && !COMMIT_RE.test(linux ?? '')) {
    throw new Error(
      'no Linux build commit: use --linux-run <id> (gh run view headSha) or CI artifacts with BUILD_COMMIT.txt'
    )
  }

  if (runHeadSha && linuxCommit && linuxCommit !== runHeadSha) {
    throw new Error(`the Linux artifacts say ${linuxCommit}, the CI run built ${runHeadSha}`)
  }

  if (dmgStamp?.dirty === true || !COMMIT_RE.test(dmgStamp?.commit ?? '')) {
    throw new Error(
      `the DMG has no clean build commit (install-stamp ${JSON.stringify(dmgStamp ?? null).slice(0, 120)})`
    )
  }

  if (dmgStamp.commit !== linux) {
    throw new Error(`the DMG was built from ${dmgStamp.commit}, the Linux artifacts from ${linux}`)
  }

  if (!COMMIT_RE.test(webCommit ?? '')) {
    throw new Error(
      `the web build has no ${WEB_COMMIT_FILE} (build it with npm run build:web from a clean tree, never --dev)`
    )
  }

  if (webCommit !== linux) {
    throw new Error(`the web build was built from ${webCommit}, the Linux artifacts from ${linux}`)
  }

  if (expected && expected !== linux) {
    throw new Error(`--commit ${expected} is not the build commit ${linux}`)
  }

  return linux
}

function collectMac(opts, deps) {
  const dir = resolve(opts.dmgDir ?? join(DESKTOP_DIR, 'release'))
  const sums = parseSums(readFileSync(requireFile(join(dir, 'SHA256SUMS.txt'), 'macOS SHA256SUMS.txt'), 'utf8'))
  const files = [DMG_NAME, 'latest-mac.yml', 'runtime.json'].map(name => {
    const path = requireFile(join(dir, name), `macOS ${name}`)

    return { name, path, sha256: verifyAgainst(sums, name, path, `${dir}/SHA256SUMS.txt`) }
  })
  const feedVersion = yamlVersion(readFileSync(files[1].path, 'utf8'))

  if (feedVersion !== opts.version) {
    throw new Error(`latest-mac.yml is version ${feedVersion ?? 'unknown'}, not ${opts.version}`)
  }

  if (deps.platform !== 'darwin') {
    throw new Error('the DMG can only be verified with spctl on macOS; run make-distribution on the Mac')
  }

  const gatekeeper = deps.run(SPCTL, [
    '-a',
    '-vv',
    '-t',
    'open',
    '--context',
    'context:primary-signature',
    files[0].path
  ])

  if (gatekeeper.status !== 0) {
    throw new Error(
      `Gatekeeper rejects ${DMG_NAME} (not signed + notarized): ${(gatekeeper.stderr || gatekeeper.stdout || String(gatekeeper.error ?? '')).trim()}`
    )
  }

  return { files, pin: pinOf(files[2].path), stamp: deps.dmgStamp(files[0].path, deps) }
}

function collectWeb(opts) {
  const dir = resolve(opts.webDir ?? join(DESKTOP_DIR, 'dist-web'))
  const sums = parseSums(readFileSync(requireFile(join(dir, 'SHA256SUMS.txt'), 'web SHA256SUMS.txt'), 'utf8'))
  const names = listFiles(dir).filter(name => name !== 'SHA256SUMS.txt')

  for (const name of WEB_REQUIRED) {
    requireFile(join(dir, name), `web ${name}`)
  }

  const unlisted = names.filter(name => !sums.has(name))

  if (unlisted.length > 0) {
    throw new Error(`web files not in its SHA256SUMS.txt: ${unlisted.slice(0, 5).join(', ')}`)
  }

  const files = names.map(name => ({
    name,
    path: join(dir, name),
    sha256: verifyAgainst(sums, name, join(dir, name), `${dir}/SHA256SUMS.txt`)
  }))
  const version = JSON.parse(readFileSync(join(dir, 'manifest.webmanifest'), 'utf8')).version ?? null

  if (version && version !== opts.version) {
    throw new Error(`web build is version ${version}, not ${opts.version}`)
  }

  // Hash-checked above with the rest; buildCommit refuses a web build without it or from another commit.
  const commit = names.includes(WEB_COMMIT_FILE) ? readFileSync(join(dir, WEB_COMMIT_FILE), 'utf8').trim() : null

  return { commit, files }
}

function collectLinux(opts, deps) {
  let dir = opts.linuxDir ? resolve(opts.linuxDir) : null

  let runHeadSha = null

  if (opts.linuxRun) {
    const view = deps.run('gh', [
      'run',
      'view',
      String(opts.linuxRun),
      '--repo',
      CI_REPO,
      '--json',
      'headSha,conclusion,workflowName'
    ])
    const info = view.status === 0 ? JSON.parse(view.stdout || '{}') : null

    if (!info || info.conclusion !== 'success' || !COMMIT_RE.test(info.headSha ?? '')) {
      throw new Error(
        `CI run ${opts.linuxRun} is not a successful run with a headSha: ${(view.stderr || view.stdout || '').trim().slice(0, 160)}`
      )
    }

    // `gh run view --json` has no path field; the REST run object does. A green run of any other workflow is refused.
    const source = deps.run('gh', ['api', `repos/${CI_REPO}/actions/runs/${opts.linuxRun}`, '--jq', '.path'])
    const runPath = source.status === 0 ? source.stdout.trim() : ''

    if (info.workflowName !== CI_WORKFLOW.name || runPath !== CI_WORKFLOW.path) {
      throw new Error(
        `CI run ${opts.linuxRun} is ${info.workflowName ?? '?'} (${runPath || 'unknown path'}), not ${CI_WORKFLOW.path}`
      )
    }

    runHeadSha = info.headSha
    dir = mkdtempSync(join(tmpdir(), 'iclone-linux-run-'))
    deps.cleanup.push(dir)
    const download = deps.run('gh', ['run', 'download', String(opts.linuxRun), '--repo', CI_REPO, '--dir', dir])

    if (download.status !== 0) {
      throw new Error(`gh run download ${opts.linuxRun} failed: ${(download.stderr || '').trim()}`)
    }
  }

  if (!dir) {
    throw new Error('Linux artifacts: pass --linux <dir> (downloaded CI artifacts) or --linux-run <run id>')
  }

  const byName = new Map()

  for (const rel of listFiles(dir)) {
    const path = join(dir, rel)
    const name = basename(rel)
    const prior = byName.get(name)

    if (prior && sha256File(prior) !== sha256File(path)) {
      throw new Error(`two different ${name} in the Linux artifacts`)
    }

    byName.set(name, path)
  }

  const wanted = []
  const sums = new Map()

  for (const arch of ['x64', 'arm64']) {
    const names = linuxArtifactNames(opts.version, arch)
    const sumsPath = byName.get(names.sums)

    if (!sumsPath) {
      throw new Error(`missing Linux ${names.sums} (the CI run for ${arch})`)
    }

    for (const [name, sha] of parseSums(readFileSync(sumsPath, 'utf8'))) {
      if (sums.has(name) && sums.get(name) !== sha) {
        throw new Error(`${name} has different sha256 in the x64 and arm64 SHA256SUMS`)
      }

      sums.set(name, sha)
    }

    wanted.push(names.deb, names.appImage, names.updateInfo)
  }

  wanted.push('runtime.json')
  const files = wanted.map(name => {
    const path = byName.get(name)

    if (!path) {
      throw new Error(`missing Linux artifact ${name}`)
    }

    return { name, path, sha256: verifyAgainst(sums, name, path, 'the CI SHA256SUMS-linux-*.txt') }
  })

  const commitFile = byName.get(LINUX_COMMIT_FILE)

  return {
    commit: commitFile ? readFileSync(commitFile, 'utf8').trim() : null,
    files,
    pin: pinOf(byName.get('runtime.json')),
    runHeadSha
  }
}

/** `0.0.3` → `v0.0.3`: the folder people see, three numbers; a pre-release semver keeps its raw form. */
export function versionFolder(version) {
  return /^\d+\.\d+\.\d+$/.test(version) ? `v${displayVersion(version)}` : version
}

function readme(name, version) {
  return readFileSync(join(DESKTOP_DIR, 'distribution', name), 'utf8').replaceAll(
    '{{version}}',
    displayVersion(version)
  )
}

function artifactMeta(folder, name) {
  if (folder === FOLDERS.mac) {
    return name.endsWith('.dmg')
      ? { platform: 'darwin', arch: 'arm64', kind: 'dmg' }
      : { platform: 'darwin', arch: null, kind: 'metadata' }
  }

  if (folder === FOLDERS.linux) {
    const arch = /-(amd64|x86_64)\./.test(name) ? 'x64' : /-arm64\./.test(name) ? 'arm64' : null
    const kind = name.endsWith('.deb') ? 'deb' : name.endsWith('.AppImage') ? 'appimage' : 'metadata'

    return { platform: 'linux', arch, kind }
  }

  return { platform: 'web', arch: null, kind: name.startsWith('web/') ? 'pwa' : 'metadata' }
}

export async function makeDistribution(opts, overrides = {}) {
  const deps = {
    platform: process.platform,
    run: (cmd, args) => {
      const result = spawnSync(cmd, args, { encoding: 'utf8' })

      return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
    },
    now: () => new Date().toISOString(),
    home: homedir(),
    repoRoot: resolve(DESKTOP_DIR, '..', '..'),
    log: line => console.log(`[make-distribution] ${line}`),
    dmgStamp: readDmgStamp,
    hygiene: scanDistribution,
    // Ruling 48: the owner markers are read now, from outside the repo; a release fails closed without them.
    privateMarkers: () => loadPrivateMarkers({ release: true }),
    ...overrides,
    cleanup: []
  }

  try {
    return await assemble(opts, deps)
  } finally {
    for (const dir of deps.cleanup) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

async function assemble(opts, deps) {
  const pinned = JSON.parse(readFileSync(join(deps.repoRoot, 'iclone', 'RUNTIME_PIN.json'), 'utf8'))
  const mac = collectMac(opts, deps)
  const web = collectWeb(opts)
  const linux = opts.linuxPending
    ? { commit: null, files: [], pin: mac.pin, runHeadSha: null }
    : collectLinux(opts, deps)

  for (const [what, pin] of [
    ['macOS runtime.json', mac.pin],
    ['Linux runtime.json', linux.pin]
  ]) {
    if (pin.sha !== pinned.sha || pin.tarball_sha256 !== pinned.tarball_sha256) {
      throw new Error(`${what} pins ${pin.sha}, iclone/RUNTIME_PIN.json pins ${pinned.sha}`)
    }
  }

  const commit = buildCommit({
    dmgStamp: mac.stamp,
    expected: opts.commit,
    linuxCommit: linux.commit,
    linuxPending: opts.linuxPending,
    runHeadSha: linux.runHeadSha,
    webCommit: web.commit
  })
  const final = resolve(opts.out ?? join(deps.home, 'Desktop', 'iclone-os-distribution'), versionFolder(opts.version))

  if (existsSync(final) && !opts.replace) {
    throw new Error(`${final} exists; pass --replace to rebuild it`)
  }

  // Assembled beside the final folder (same volume) and renamed into place only after the MANIFEST self-check.
  mkdirSync(dirname(final), { recursive: true })
  const root = mkdtempSync(join(dirname(final), `.${versionFolder(opts.version)}.partial-`))
  deps.cleanup.push(root)

  const plan = [
    [FOLDERS.mac, mac.files.map(f => ({ ...f, dest: f.name })), 'README-01-macOS-DMG.txt'],
    [
      FOLDERS.web,
      [
        ...web.files.map(f => ({ ...f, dest: `web/${f.name}` })),
        {
          name: 'start-gateway.sh',
          path: join(DESKTOP_DIR, 'distribution', 'start-gateway.sh'),
          dest: 'start-gateway.sh',
          mode: 0o755
        }
      ],
      'README-02-Chrome-App.txt'
    ],
    [
      FOLDERS.linux,
      linux.files.map(f => ({ ...f, dest: f.name })),
      opts.linuxPending ? 'README-03-Linux-Ubuntu-pending.txt' : 'README-03-Linux-Ubuntu.txt'
    ]
  ]
  const artifacts = []

  for (const [folder, files, readmeName] of plan) {
    const base = join(root, folder)
    const entries = []

    // A pending folder (--linux-pending) has no artifacts, only its README.
    mkdirSync(base, { recursive: true })

    for (const file of files) {
      const dest = join(base, file.dest)
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(file.path, dest)

      if (file.mode || file.dest.endsWith('.AppImage')) {
        chmodSync(dest, file.mode ?? 0o755)
      }

      const sha256 = sha256File(dest)

      if (file.sha256 && sha256 !== file.sha256) {
        throw new Error(`copy of ${file.dest} does not match its source`)
      }

      entries.push({ name: file.dest, sha256 })
    }

    writeFileSync(join(base, 'README.txt'), readme(readmeName, opts.version))
    entries.push({ name: 'README.txt', sha256: sha256File(join(base, 'README.txt')) })
    writeFileSync(join(base, 'SHA256SUMS.txt'), sha256SumsText(entries))

    for (const { name, sha256 } of [
      ...entries,
      { name: 'SHA256SUMS.txt', sha256: sha256File(join(base, 'SHA256SUMS.txt')) }
    ]) {
      artifacts.push({
        folder,
        file: name,
        bytes: statSync(join(base, name)).size,
        sha256,
        ...artifactMeta(folder, name)
      })
    }
  }

  const manifest = {
    version: opts.version,
    display: `v${displayVersion(opts.version)}`,
    built_at: deps.now(),
    app_commit: commit,
    runtime_pin: { sha: pinned.sha, tarball_sha256: pinned.tarball_sha256, min_app: pinned.min_app },
    ...(opts.linuxPending ? { pending: ['linux'] } : {}),
    artifacts
  }

  // PLANO_R §6 R7/R11: every collected artifact is scanned (DMG mounted, deb unpacked, web files as they ship). An
  // AppImage's squashfs cannot be opened here: it passes only as the exact file (sha256 checked against the CI sums
  // above) that release-linux.mjs built from the linux-unpacked tree it scanned before writing those sums.
  const owner = deps.privateMarkers()
  const markers = compileMarkers({
    privateTokens: owner.tokens,
    privateIds: owner.ids,
    ownerNames: ownerNamesOf(owner),
    provenance: [
      ...pinnedProvenance(join(deps.repoRoot, 'iclone', 'RUNTIME_PIN.json')),
      ...linux.files
        .filter(file => file.name.endsWith('.AppImage'))
        .map(file => ({ label: `${file.name} (CI-built from the scanned linux-unpacked)`, sha256: file.sha256 }))
    ]
  })

  assertClean(deps.hygiene(root, { run: deps.run, markers }), 'the distribution folder')
  writeFileSync(join(root, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  const bad = artifacts.filter(a => sha256File(join(root, a.folder, a.file)) !== a.sha256)

  if (bad.length > 0) {
    throw new Error(`MANIFEST self-check failed for ${bad.map(a => a.file).join(', ')}`)
  }

  const previous = existsSync(final) ? `${final}.replaced-${process.pid}` : null

  if (previous) {
    renameSync(final, previous)
    deps.cleanup.push(previous)
  }

  renameSync(root, final)
  deps.log(`${final}: ${artifacts.length} files, MANIFEST.json written`)

  return { root: final, manifest }
}

if (isMain(import.meta.url)) {
  makeDistribution(parseArgs(process.argv.slice(2))).catch(error => {
    console.error(`[make-distribution] ${error.message}`)
    process.exit(1)
  })
}
