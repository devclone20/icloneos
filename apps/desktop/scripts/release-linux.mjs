#!/usr/bin/env node
// Linux release build (deb + AppImage) for ONE arch, run on a Linux host of that
// arch (GitHub Actions ubuntu-24.04 / ubuntu-24.04-arm): node-pty has no Linux
// prebuilds, so native deps are compiled on the host and never cross-staged.
// No signing, no publishing — the owner promotes the CI artifacts.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { checkAcpAbsent } from './acp-pack-absent.mjs'
import { assertClean, compileMarkers, scanTree } from './artifact-hygiene.mjs'
import { RELEASE_IDENTITY_FLAG } from './build-identity.mjs'
import { runtimePin, sha256SumsText } from './release-mac.mjs'
import { isMain } from './utils.mjs'

const here = dirname(fileURLToPath(import.meta.url))

export const DESKTOP_DIR = resolve(here, '..')
export const ARCHES = ['x64', 'arm64']
export const SELFTEST_MODES = ['pty', 'acp', 'all']
export const DESKTOP_ENTRY = './usr/share/applications/iclone-os.desktop'
// Electron links libasound.so.2 and libgbm.so.1 at load time; gtk3/nss do not pull them into a minimal Ubuntu.
export const REQUIRED_DEPENDS = [
  'libasound2t64 | libasound2',
  'libgbm1',
  'libsecret-1-0',
  'libsecret-tools',
  'gnome-keyring | kwalletmanager',
  'git',
  'curl',
  'python3',
  // The runtime's first-run build uses a glibc Node that links libatomic.so.1 (absent on minimal Ubuntu).
  'libatomic1'
]

const MACH_O_MAGICS = new Set(['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe'])
// cafebabe is shared with Java class files; a fat Mach-O has a small arch count where Java has its version (>= 45).
const FAT_MACH_O_MAGICS = new Set(['cafebabe', 'cafebabf'])
const FAT_MAX_ARCHES = 20
export const ELF_MACHINES = { 3: 'x86', 40: 'arm', 62: 'x86-64', 183: 'aarch64' }
export const DEB_ARCH = { x64: 'amd64', arm64: 'arm64' }
const TARGET_MACHINE = { x64: 62, arm64: 183 }

export function parseArgs(argv) {
  const opts = { arch: null, skipBuild: false, checkSelftest: [], checkSelftestMode: 'pty' }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]

    if (arg === '--arch') {
      opts.arch = argv[++i] ?? null
    } else if (arg === '--skip-build') {
      opts.skipBuild = true
    } else if (arg === '--check-selftest') {
      const file = argv[++i]

      if (!file) {
        throw new Error('--check-selftest needs a file')
      }

      opts.checkSelftest.push(file)
    } else if (arg === '--check-selftest-mode') {
      const mode = argv[++i]

      if (!SELFTEST_MODES.includes(mode)) {
        throw new Error(`--check-selftest-mode must be one of ${SELFTEST_MODES.join(', ')}`)
      }

      opts.checkSelftestMode = mode
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }

  if (opts.checkSelftest.length > 0 && opts.arch === null) {
    return opts
  }

  if (!ARCHES.includes(opts.arch)) {
    throw new Error(`--arch must be one of ${ARCHES.join(', ')}`)
  }

  return opts
}

/** electron-builder's own arch spelling per target (deb: Debian names, AppImage: uname -m). */
export function linuxArtifactNames(version, arch) {
  const deb = arch === 'x64' ? 'amd64' : 'arm64'
  const appImage = arch === 'x64' ? 'x86_64' : 'arm64'

  return {
    deb: `iclone-os-${version}-linux-${deb}.deb`,
    appImage: `iclone-os-${version}-linux-${appImage}.AppImage`,
    updateInfo: arch === 'x64' ? 'latest-linux.yml' : 'latest-linux-arm64.yml',
    unpacked: arch === 'x64' ? 'linux-unpacked' : 'linux-arm64-unpacked',
    sums: `SHA256SUMS-linux-${arch}.txt`
  }
}

/** 'mach-o' | { elf: e_machine } | null from the first bytes of a file. */
export function classifyBinary(head) {
  if (head.length < 4) {
    return null
  }

  const magic = head.subarray(0, 4).toString('hex')

  if (MACH_O_MAGICS.has(magic)) {
    return 'mach-o'
  }

  if (FAT_MACH_O_MAGICS.has(magic) && head.length >= 8) {
    const count = head.readUInt32BE(4)

    return count > 0 && count < FAT_MAX_ARCHES ? 'mach-o' : null
  }

  if (magic === '7f454c46' && head.length >= 20) {
    return { elf: head[5] === 2 ? head.readUInt16BE(18) : head.readUInt16LE(18) }
  }

  return null
}

function readHead(path) {
  const fd = openSync(path, 'r')

  try {
    const head = Buffer.alloc(20)

    return head.subarray(0, readSync(fd, head, 0, head.length, 0))
  } finally {
    closeSync(fd)
  }
}

/** Every Mach-O (thin or fat) and every ELF file under `dir`, with its e_machine. */
export function scanBinaries(dir) {
  const found = { elf: [], machO: [] }

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)

    if (entry.isDirectory()) {
      const inner = scanBinaries(full)
      found.elf.push(...inner.elf)
      found.machO.push(...inner.machO)
    } else if (entry.isFile()) {
      const kind = classifyBinary(readHead(full))

      if (kind === 'mach-o') {
        found.machO.push(full)
      } else if (kind) {
        found.elf.push({ machine: kind.elf, path: full })
      }
    }
  }

  return found
}

/** Every Mach-O file under `dir` (a darwin binary in a Linux package is a broken build). */
export function findMachO(dir) {
  return scanBinaries(dir).machO
}

/** ELF files under `dir` built for another machine than `arch` (they cannot run in that package). */
export function foreignElf(elf, arch) {
  return elf.filter(binary => binary.machine !== TARGET_MACHINE[arch])
}

/** Fields of `dpkg-deb -f` output → map; refuses a control file without our Depends. */
export function checkDebControl(controlText, desktopEntryText, arch) {
  const fields = {}

  for (const line of controlText.split('\n')) {
    const match = /^([A-Za-z-]+):\s*(.*)$/.exec(line)

    if (match) {
      fields[match[1]] = match[2]
    }
  }

  const depends = (fields.Depends ?? '').split(',').map(dep => dep.trim())
  const missing = REQUIRED_DEPENDS.filter(dep => !depends.includes(dep))
  const problems = missing.map(dep => `Depends lacks ${dep}`)

  if (arch && fields.Architecture !== DEB_ARCH[arch]) {
    problems.push(`Architecture is ${fields.Architecture ?? 'missing'}, expected ${DEB_ARCH[arch]} for ${arch}`)
  }

  if (fields.Package !== 'iclone-os') {
    problems.push(`Package is ${fields.Package ?? 'missing'}, expected iclone-os`)
  }

  if (!/x-scheme-handler\/iclone;/.test(desktopEntryText)) {
    problems.push('desktop entry has no x-scheme-handler/iclone')
  }

  if (!/^Exec=.*iclone-os/m.test(desktopEntryText)) {
    problems.push('desktop entry Exec does not run iclone-os')
  }

  return { fields, problems }
}

/** Problems with the stdout of a packaged `--iclone-selftest=<mode>` run (the CI smoke stage); [] = it passed. */
export function checkSelftestOutput(text, mode = 'pty') {
  const reports = []

  for (const line of String(text).split('\n')) {
    try {
      const parsed = JSON.parse(line.trim())

      if (parsed && typeof parsed === 'object' && 'selftest' in parsed) {
        reports.push(parsed)
      }
    } catch {
      // Electron and Chromium log lines around the one JSON report.
    }
  }

  if (reports.length !== 1) {
    return [`expected one self-test report, found ${reports.length}`]
  }

  const [report] = reports
  const problems = []

  if (report.selftest !== mode) {
    problems.push(`self-test ran mode ${report.selftest}, expected ${mode}`)
  }

  if (report.ok !== true) {
    problems.push(`self-test failed: ${JSON.stringify(report).slice(0, 200)}`)
  }

  if (report.packaged !== true) {
    problems.push('self-test did not run the packaged app')
  }

  for (const check of mode === 'all' ? ['acp', 'pty'] : [mode]) {
    if (report[check]?.ok !== true) {
      problems.push(`${check} check did not pass`)
    }
  }

  return problems
}

function defaultRun(command, args, { cwd, env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 256 * 1024 * 1024
  })

  return { status: result.status ?? 1, stdout: result.stdout ?? '' }
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export async function releaseLinux(opts, deps = {}) {
  const platform = deps.platform ?? process.platform
  const run = deps.run ?? defaultRun
  const log = deps.log ?? (line => console.log(`[release-linux] ${line}`))
  const desktopDir = deps.desktopDir ?? DESKTOP_DIR
  const repoRoot = resolve(desktopDir, '..', '..')
  const releaseDir = join(desktopDir, 'release')
  const exists = deps.exists ?? existsSync
  const readText = deps.readText ?? (path => readFileSync(path, 'utf8'))
  const writeText = deps.writeText ?? ((path, text) => writeFileSync(path, text))
  const hashFile = deps.sha256File ?? sha256File
  const scan = deps.scanBinaries ?? scanBinaries

  if (platform !== 'linux') {
    throw new Error(`release-linux runs on a Linux host of the target arch (CI); this host is ${platform}`)
  }

  if (!ARCHES.includes(opts.arch)) {
    throw new Error(`unknown arch ${opts.arch} (expected ${ARCHES.join(' or ')})`)
  }

  const version = JSON.parse(readText(join(desktopDir, 'package.json'))).version
  const names = linuxArtifactNames(version, opts.arch)
  const npm = (args, what) => {
    log(what)

    if (run('npm', args, { cwd: desktopDir, env: process.env }).status !== 0) {
      throw new Error(`${what} failed`)
    }
  }

  if (!opts.skipBuild) {
    npm(['run', 'build'], 'npm run build')
    npm(
      [
        'run',
        'builder',
        '--',
        '--linux',
        'deb',
        'AppImage',
        `--${opts.arch}`,
        '--publish',
        'never',
        RELEASE_IDENTITY_FLAG
      ],
      `electron-builder ${opts.arch}`
    )
  }

  for (const name of [names.deb, names.appImage, names.updateInfo]) {
    if (!exists(join(releaseDir, name))) {
      throw new Error(`missing build output: release/${name}`)
    }
  }

  const binaries = scan(join(releaseDir, names.unpacked))

  if (binaries.machO.length > 0) {
    throw new Error(`darwin binaries in the Linux package: ${binaries.machO.slice(0, 3).join(', ')}`)
  }

  const foreign = foreignElf(binaries.elf, opts.arch)

  if (foreign.length > 0) {
    const list = foreign
      .slice(0, 3)
      .map(binary => `${binary.path} (${ELF_MACHINES[binary.machine] ?? `e_machine ${binary.machine}`})`)
    throw new Error(`ELF binaries for another arch in the linux-${opts.arch} package: ${list.join(', ')}`)
  }

  // REL-6 (ruling 26): the package carries no ACP CLI (no tree, no Go signer), only Resources/acp-pin; the app
  // installs the CLI at first use from the npm registry.
  const acp = (deps.acpAbsent ?? checkAcpAbsent)(join(releaseDir, names.unpacked))

  if (!acp.ok) {
    throw new Error(`the linux-${opts.arch} package carries the ACP CLI or lacks its pin: ${acp.problems.join('; ')}`)
  }

  // PLANO_R §6 R7/R11: the tree the deb and the AppImage are made of carries no trace of the owner or his usage.
  // Ruling 48: the owner markers come from outside the repo (the CI secret); without them the release fails closed.
  const hygiene = deps.hygiene ?? (dir => scanTree(dir, { markers: compileMarkers({ release: true }) }))

  assertClean(hygiene(join(releaseDir, names.unpacked)), `release/${names.unpacked}`)

  const control = run('dpkg-deb', ['-f', join(releaseDir, names.deb)], {})
  const desktopEntry = run(
    'sh',
    ['-c', `dpkg-deb --fsys-tarfile "$1" | tar -xO "${DESKTOP_ENTRY}"`, 'sh', join(releaseDir, names.deb)],
    {}
  )

  if (control.status !== 0 || desktopEntry.status !== 0) {
    throw new Error('dpkg-deb could not read the .deb control file or desktop entry')
  }

  const { problems } = checkDebControl(control.stdout, desktopEntry.stdout, opts.arch)

  if (problems.length > 0) {
    throw new Error(`deb check failed: ${problems.join('; ')}`)
  }

  const runtimeJson = join(releaseDir, 'runtime.json')
  const pin = runtimePin(
    readText(join(repoRoot, 'iclone', 'RUNTIME_PIN.json')),
    readText(join(desktopDir, 'electron', 'runtime-pin.generated.ts')),
    readText(join(repoRoot, 'iclone', 'contract', 'runtime.lock.json'))
  )

  writeText(runtimeJson, `${JSON.stringify(pin)}\n`)
  ;(deps.chmod ?? chmodSync)(join(releaseDir, names.appImage), 0o755)

  const uploads = [names.deb, names.appImage, names.updateInfo, 'runtime.json']
  const sums = uploads.map(name => ({ name, sha256: hashFile(join(releaseDir, name)) }))

  writeText(join(releaseDir, names.sums), sha256SumsText(sums))
  writeText(join(releaseDir, `UPLOAD-linux-${opts.arch}.txt`), [...uploads, names.sums].join('\n') + '\n')
  log(`ready: ${[...uploads, names.sums].join(', ')}`)

  return { names, uploads: [...uploads, names.sums], sums, pin }
}

export function checkSelftestFiles(files, mode = 'pty', read = file => readFileSync(file, 'utf8')) {
  let failed = false

  for (const file of files) {
    const problems = checkSelftestOutput(read(file), mode)

    console.log(`[release-linux] ${file}: ${problems.length === 0 ? 'self-test passed' : problems.join('; ')}`)
    failed ||= problems.length > 0
  }

  return failed ? 1 : 0
}

if (isMain(import.meta.url)) {
  const opts = parseArgs(process.argv.slice(2))

  if (opts.checkSelftest.length > 0) {
    process.exit(checkSelftestFiles(opts.checkSelftest, opts.checkSelftestMode))
  }

  releaseLinux(opts).catch(error => {
    console.error(`[release-linux] ${error.message}`)
    process.exit(1)
  })
}
