#!/usr/bin/env node
/**
 * stage-acp-native.mjs — REL-6 round 2, ruling 33: the ACP CLI's native add-ons the app ships for the hardened runtime.
 *
 *   node scripts/stage-acp-native.mjs [--target darwin-arm64] [--out build/acp-native] [--check]
 *
 * The first-use install (electron/iclone-acp-tools/) fetches the ACP CLI from npm; its three MIT native add-ons
 * (`@napi-rs/keyring-<platform>`, `bufferutil`, `utf-8-validate`) arrive ad-hoc signed, and library validation refuses
 * to load them into the Team-signed app. So the build takes those add-ons from the LOCKFILE'S EXACT VERSIONS (the same
 * registry tarballs, checked against the lockfile's sha512 before anything is read), writes each `.node` this target
 * loads into `<out>/<target>/` under a flat name, and lists them in ADDONS.json with npm's sha256 (what the installer
 * must find before it swaps) and the shipped copy's sha256. Here the copies are unsigned (`signed: false`, the marker an
 * unsigned `--dir` pack carries); `release:mac` Team-signs them and rewrites the list with the signed bytes' sha256
 * (scripts/sign-acp-native.mjs), before electron-builder packs and seals them into Resources/acp-native/<target>/.
 *
 * LICENCES (critic r2 M3, rulings 32 + 33). Every add-on ships with the licence texts that cover its bytes, listed in
 * the committed acp-native-notices/NOTICES.json and pinned there by sha256 (scripts/acp-native-notices.mjs): the
 * package texts are read again from the same sha512-checked tarballs and must be those exact bytes (else the build
 * stops), and they go to `<out>/<target>/licences/` with the keyring binding's Rust crate and Rust std texts. The list
 * names them (`notices`, and each add-on's `licences`), so the pack check and the installer read one truth. A binary
 * that names a Rust crate (a /rust/deps/ or cargo registry source path) its notices do not list stops the build.
 *
 * Idempotent: a list for this lock whose files all hash to it (unsigned OR already signed) is kept as is.
 * Only macOS targets ship add-ons (the hardened runtime is the reason); other targets print and exit 0.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { isMain } from './utils.mjs'

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { ACP_CLI_NAME, installsFile, parsePin, runtimeClosure } = await import('../src/iclone-shared/acp-pin.ts')
const { ADDONS_FILE, blobName, isAddonPackage, parseAddonList } = await import('../src/iclone-shared/acp-native.ts')
const { gunzipAsync, readTar } = await import('../electron/iclone-acp-tools/tar.ts')
const { NOTICES_DIR, loadNativeNotices, textsOf, unlistedCrates } = await import('./acp-native-notices.mjs')

export const DEFAULT_OUT = path.join(DESKTOP, 'build', 'acp-native')
const MAX_UNPACKED = 256 * 1024 * 1024

const sha256 = data => createHash('sha256').update(data).digest('hex')
const sri512 = data => `sha512-${createHash('sha512').update(data).digest('base64')}`

export function parseTarget(name) {
  const [platform, arch, libc] = String(name).split('-')

  return { platform, arch, libc: libc ?? null }
}

/** The pin's add-on rows for `target`: the closure's rows whose package is one of the three. */
export function addonRows(pinDir, target) {
  const lockText = readFileSync(path.join(pinDir, 'package-lock.json'), 'utf8')
  const pin = parsePin(readFileSync(path.join(pinDir, 'package.json'), 'utf8'), lockText)

  return {
    lockSha256: sha256(lockText),
    cliVersion: pin.cliVersion,
    rows: runtimeClosure(pin, target).filter(row => isAddonPackage(row.name) && row.name !== ACP_CLI_NAME)
  }
}

/** Does `dir` already hold a complete list for this lock (signed or not)? */
export function upToDate(dir, lockSha256, target) {
  try {
    const list = parseAddonList(readFileSync(path.join(dir, ADDONS_FILE), 'utf8'))

    return Boolean(
      list &&
      list.lockSha256 === lockSha256 &&
      list.target === target &&
      list.addons.every(entry => sha256(readFileSync(path.join(dir, entry.blob))) === entry.sha256)
    )
  } catch {
    return false
  }
}

/**
 * Stage `target`'s add-ons into `<out>/<target>/`. `fetchTarball(url)` returns the bytes (the registry in a build,
 * a fake in tests); every tarball is checked against the lockfile's sha512 before it is read.
 */
export async function stageAcpNative({
  pinDir,
  out,
  targetName,
  fetchTarball,
  noticesDir = path.join(DESKTOP, NOTICES_DIR),
  log = () => undefined
}) {
  const target = parseTarget(targetName)
  const dir = path.join(out, targetName)

  if (target.platform !== 'darwin') {
    log(`[stage-acp-native] ${targetName}: no app add-ons (only the macOS hardened runtime needs them)`)

    return null
  }

  const { lockSha256, rows } = addonRows(pinDir, target)

  if (upToDate(dir, lockSha256, targetName)) {
    log(`[stage-acp-native] ${targetName}: up to date`)

    return JSON.parse(readFileSync(path.join(dir, ADDONS_FILE), 'utf8'))
  }

  rmSync(dir, { recursive: true, force: true })
  mkdirSync(path.join(dir, 'licences'), { recursive: true })

  const notices = loadNativeNotices(path.dirname(noticesDir))
  const lockText = readFileSync(path.join(pinDir, 'package-lock.json'), 'utf8')
  const allRows = new Map(Object.entries(JSON.parse(lockText).packages))
  const tarballs = new Map()

  // Every tarball is fetched once and checked against the lockfile's sha512 before anything is read from it.
  const filesOf = async key => {
    if (!tarballs.has(key)) {
      const row = allRows.get(key)

      if (!row) {
        throw new Error(`${key} is not in the lockfile`)
      }

      const tgz = await fetchTarball(row.resolved)

      if (sri512(tgz) !== row.integrity) {
        throw new Error(`${key}: the tarball does not match the lockfile's sha512`)
      }

      tarballs.set(key, readTar(await gunzipAsync(tgz, MAX_UNPACKED)))
    }

    return tarballs.get(key)
  }

  const addons = []
  const shipped = new Map()

  for (const row of rows) {
    const notice = notices.addons.find(addon => addon.key === row.key)

    if (!notice || notice.package !== row.name || notice.version !== row.version) {
      throw new Error(`${row.name}@${row.version}: no licence notice in ${NOTICES_DIR}/NOTICES.json`)
    }

    // The package texts are read again from the pinned tarballs: they must be the committed bytes.
    for (const text of notice.texts) {
      const inTarball = (await filesOf(text.tarball)).find(file => file.path === text.path)
      const committed = readFileSync(path.join(noticesDir, text.file))

      if (!inTarball || !inTarball.data.equals(committed)) {
        throw new Error(`${row.name}@${row.version}: ${text.path} in ${text.tarball} is not the pinned ${text.file}`)
      }
    }

    const licences = []

    for (const text of textsOf(notice)) {
      const data = readFileSync(path.join(noticesDir, text.file))

      if (sha256(data) !== text.sha256) {
        throw new Error(`${text.file} is not the pinned text`)
      }

      const name = path.basename(text.file)

      writeFileSync(path.join(dir, 'licences', name), data, { mode: 0o644 })
      shipped.set(`licences/${name}`, text.sha256)
      licences.push(name)
    }

    for (const file of await filesOf(row.key)) {
      if (!file.path.endsWith('.node') || !installsFile(row, file.path, target)) {
        continue
      }

      // Critic r3 M4: every Rust crate the binary names in its own source paths must be on its notices list.
      const unlisted = unlistedCrates(notice, file.data)

      if (unlisted.length > 0) {
        throw new Error(
          `${row.name}@${row.version}: ${file.path} names crate(s) its notices do not list: ${unlisted.join(', ')}`
        )
      }

      const installPath = `${row.key}/${file.path}`
      const blob = blobName(row.name, row.version, installPath)

      writeFileSync(path.join(dir, blob), file.data, { mode: 0o644 })
      addons.push({
        file: installPath,
        package: row.name,
        version: row.version,
        blob,
        npmSha256: sha256(file.data),
        sha256: sha256(file.data),
        licences
      })
    }
  }

  const list = {
    v: 1,
    target: targetName,
    lockSha256,
    signed: false,
    team: null,
    addons,
    notices: [...shipped].map(([file, digest]) => ({ file, sha256: digest }))
  }

  if (!parseAddonList(JSON.stringify(list))) {
    throw new Error('the add-on list did not validate')
  }

  writeFileSync(path.join(dir, ADDONS_FILE), `${JSON.stringify(list, null, 2)}\n`)
  log(
    `[stage-acp-native] ${targetName}: ${addons.length} add-on file(s) from ${rows.length} package(s), unsigned, ` +
      `with ${shipped.size} licence file(s)`
  )

  return list
}

async function registryTarball(url) {
  if (!url.startsWith('https://registry.npmjs.org/')) {
    throw new Error(`refusing ${url}`)
  }

  const response = await fetch(url, { redirect: 'error' })

  if (response.status !== 200) {
    throw new Error(`HTTP ${response.status} for ${url}`)
  }

  return Buffer.from(await response.arrayBuffer())
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2)
  const value = flag => {
    const at = args.indexOf(flag)

    return at >= 0 ? args[at + 1] : undefined
  }

  const targetName =
    value('--target') ?? (process.platform === 'darwin' ? 'darwin-arm64' : `${process.platform}-${process.arch}`)
  const out = path.resolve(value('--out') ?? DEFAULT_OUT)

  try {
    if (args.includes('--check')) {
      const { lockSha256 } = addonRows(path.join(DESKTOP, 'acp-cli-lock'), parseTarget(targetName))
      const ok =
        parseTarget(targetName).platform !== 'darwin' || upToDate(path.join(out, targetName), lockSha256, targetName)

      console.log(ok ? `acp-native ${targetName}: ok` : `acp-native ${targetName}: missing or stale`)
      process.exit(ok ? 0 : 1)
    }

    await stageAcpNative({
      pinDir: path.join(DESKTOP, 'acp-cli-lock'),
      out,
      targetName,
      fetchTarball: registryTarball,
      log: line => console.log(line)
    })
  } catch (error) {
    console.error(`[stage-acp-native] ${error instanceof Error ? error.message : error}`)
    process.exit(1)
  }
}
