// macos-signing.mjs — a STABLE local signing identity for the installed app.
//
// Why: install-macos.mjs used to ad-hoc sign the bundle (`codesign -s -`). An
// ad-hoc signature's designated requirement is the code hash of that exact
// build, so to macOS every reinstall is a brand-new application. The login
// keychain remembers "Always Allow" per application: the Virtuals CLI's
// sign-in token (service `acp-auth`) therefore asked the owner for permission
// again after EVERY build — the dock apps sat on "timed out" and the agent's
// `acp` hung until the dialog was answered.
//
// With a certificate-based identity the requirement becomes
// `identifier "io.cloneframe.icloneos" and certificate root = H"<sha1>"`,
// which every future build satisfies: the owner clicks "Always Allow" once per
// keychain item, then never again.
//
// The identity is self-signed and lives in its OWN keychain file
// (`~/Library/Keychains/iclone-signing.keychain-db`), unlocked with a random
// password kept 0600 in `~/.iclone-os/signing.key`. codesign is pointed at that
// keychain explicitly (`--keychain`), so nothing is added to the user's search
// list and no key is ever marked "allow every application". Trade-off, stated
// plainly: a process running as this user that reads the password file could
// sign code as this identity. That is the same boundary as every other file in
// the home directory, and it replaces an unusable prompt-per-build with a
// stable one. A Developer ID build is the production answer and is never
// re-signed here (contract P7 decisions 3 + 14): release-mac.mjs signs it through
// electron-builder with per-file entitlements and a secure timestamp, and
// install-macos.mjs only copies + verifies it. No Apple identity (Developer ID,
// Apple Development, Mac Developer) is ever picked for a local re-sign.
//
// Nothing here touches system trust settings, and nothing needs sudo.

import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { isMain } from './utils.mjs'

export const LOCAL_IDENTITY = 'iclone os (local signing)'
export const SIGNING_KEYCHAIN = join(homedir(), 'Library', 'Keychains', 'iclone-signing.keychain-db')
export const SIGNING_SECRET = join(homedir(), '.iclone-os', 'signing.key')

/** Ten years: long enough that no owner ever meets an expired local cert. */
const VALID_DAYS = '3650'

/** `openssl req` for a self-signed code-signing leaf (no CA, no chain). */
export function opensslRequestArgs({ keyPath, certPath, name = LOCAL_IDENTITY }) {
  return [
    'req',
    '-x509',
    '-newkey',
    'rsa:3072',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    VALID_DAYS,
    '-subj',
    `/CN=${name}/O=iCLONE`,
    '-addext',
    'keyUsage=critical,digitalSignature',
    '-addext',
    'extendedKeyUsage=critical,codeSigning',
    '-addext',
    'basicConstraints=critical,CA:FALSE'
  ]
}

/**
 * `openssl pkcs12 -export`. OpenSSL 3 defaults to PBES2/AES, which macOS's
 * `security import` rejects ("MAC verification failed"); `-legacy` restores the
 * PKCS#12 ciphers it understands. LibreSSL (Apple's /usr/bin/openssl) has no
 * `-legacy` flag and produces compatible files by default.
 */
export function pkcs12Args({ keyPath, certPath, p12Path, password, name = LOCAL_IDENTITY, legacy }) {
  return [
    'pkcs12',
    '-export',
    ...(legacy ? ['-legacy'] : []),
    '-inkey',
    keyPath,
    '-in',
    certPath,
    '-out',
    p12Path,
    '-name',
    name,
    '-passout',
    `pass:${password}`
  ]
}

export function needsLegacyPkcs12(versionLine) {
  return /^OpenSSL\s+3/i.test(String(versionLine ?? '').trim())
}

/** A build that carries a certificate, not a hash: `certificate root = H"…"`. */
export function requirementIsStable(designated) {
  return /certificate (root|leaf) = H"[0-9a-f]{40}"/i.test(String(designated ?? ''))
}

function sh(command, args, { input, allowFailure = false } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] })

  if (result.status !== 0 && !allowFailure) {
    throw new Error(
      `${command} ${args[0] ?? ''} failed (${result.status}): ${(result.stderr || result.stdout || '').trim()}`
    )
  }

  return result
}

function readSecret() {
  try {
    const value = readFileSync(SIGNING_SECRET, 'utf8').trim()

    return value.length >= 32 ? value : null
  } catch {
    return null
  }
}

function writeSecret(value) {
  mkdirSync(join(homedir(), '.iclone-os'), { recursive: true, mode: 0o700 })
  writeFileSync(SIGNING_SECRET, `${value}\n`, { mode: 0o600 })
  chmodSync(SIGNING_SECRET, 0o600)
}

/** True when the identity already exists in the signing keychain. */
export function hasLocalIdentity() {
  if (!existsSync(SIGNING_KEYCHAIN)) {
    return false
  }

  const found = sh('security', ['find-identity', '-p', 'codesigning', SIGNING_KEYCHAIN], { allowFailure: true })

  return (found.stdout || '').includes(`"${LOCAL_IDENTITY}"`)
}

/**
 * Create the keychain + identity once. Idempotent: returns quickly when both
 * exist. Never prints the password; the private key never touches the repo.
 */
export function ensureLocalIdentity({ log = () => {} } = {}) {
  if (process.platform !== 'darwin') {
    throw new Error('local signing identities are a macOS concern')
  }

  let secret = readSecret()

  if (!secret || !existsSync(SIGNING_KEYCHAIN)) {
    // A keychain without its password is unusable — start both over.
    rmSync(SIGNING_KEYCHAIN, { force: true })
    secret = randomBytes(32).toString('hex')
    writeSecret(secret)
    sh('security', ['create-keychain', '-p', secret, SIGNING_KEYCHAIN])
    // No auto-lock, no lock-on-sleep: an install at 3 a.m. must not stall.
    sh('security', ['set-keychain-settings', SIGNING_KEYCHAIN])
    log(`[macos-signing] created ${SIGNING_KEYCHAIN}`)
  }

  sh('security', ['unlock-keychain', '-p', secret, SIGNING_KEYCHAIN])

  if (hasLocalIdentity()) {
    return LOCAL_IDENTITY
  }

  const work = mkdtempSync(join(tmpdir(), 'iclone-signing-'))

  chmodSync(work, 0o700)

  try {
    const keyPath = join(work, 'key.pem')
    const certPath = join(work, 'cert.pem')
    const p12Path = join(work, 'identity.p12')
    const openssl = existsSync('/opt/homebrew/bin/openssl') ? '/opt/homebrew/bin/openssl' : 'openssl'
    const version = sh(openssl, ['version'], { allowFailure: true }).stdout
    const p12Password = randomBytes(16).toString('hex')

    sh(openssl, opensslRequestArgs({ keyPath, certPath }))
    sh(openssl, pkcs12Args({ keyPath, certPath, p12Path, password: p12Password, legacy: needsLegacyPkcs12(version) }))
    // Only codesign may use the key, and only through this keychain.
    sh('security', ['import', p12Path, '-k', SIGNING_KEYCHAIN, '-P', p12Password, '-T', '/usr/bin/codesign'])
    // Without this partition list codesign asks for the keychain password in a
    // dialog on every use — the very thing this file exists to end.
    sh('security', [
      'set-key-partition-list',
      '-S',
      'apple-tool:,apple:,codesign:',
      '-s',
      '-k',
      secret,
      SIGNING_KEYCHAIN
    ])
    log(`[macos-signing] created the identity "${LOCAL_IDENTITY}"`)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }

  if (!hasLocalIdentity()) {
    throw new Error(`the identity "${LOCAL_IDENTITY}" was not found after import`)
  }

  return LOCAL_IDENTITY
}

/**
 * Sign a LOCAL build with the stable local identity, else ad-hoc (and say so).
 * Returns what was used and the designated requirement codesign reports
 * afterwards. Never called on a Developer ID bundle (see installPlan).
 */
export function signBundle(bundlePath, { log = () => {} } = {}) {
  try {
    const identity = ensureLocalIdentity({ log })
    const secret = readSecret()

    sh('security', ['unlock-keychain', '-p', secret, SIGNING_KEYCHAIN])
    sh('codesign', ['--force', '--deep', '--sign', identity, '--keychain', SIGNING_KEYCHAIN, bundlePath])

    return { identity, kind: 'local', requirement: designatedRequirement(bundlePath) }
  } catch (error) {
    log(`[macos-signing] local identity unavailable (${error.message}); falling back to ad-hoc`)
    sh('codesign', ['--force', '--deep', '--sign', '-', bundlePath])

    return { identity: '-', kind: 'adhoc', requirement: designatedRequirement(bundlePath) }
  }
}

/** True when `codesign -dvv` output names a Developer ID Application leaf. */
export function isDeveloperIdSigned(codesignDetails) {
  return /^Authority=Developer ID Application: .+\([A-Z0-9]{10}\)$/m.test(String(codesignDetails ?? ''))
}

/**
 * What install-macos may do with a built bundle (decision 14): a Developer ID
 * bundle is copied and verified only — stapled, or refused until it is; any
 * other bundle is a local build and gets the stable local identity as before.
 */
export function installPlan({ codesignDetails, stapled }) {
  if (!isDeveloperIdSigned(codesignDetails)) {
    return { action: 'sign-local' }
  }

  return stapled ? { action: 'copy-verify' } : { action: 'refuse', reason: 'Developer ID bundle is not stapled' }
}

/** Reads the facts installPlan needs. `run(command, args)` returns {status, stdout, stderr}. */
export function inspectBundle(bundlePath, run = (command, args) => sh(command, args, { allowFailure: true })) {
  const details = run('codesign', ['-dvv', bundlePath])
  const codesignDetails = `${details.stdout || ''}\n${details.stderr || ''}`
  const stapled = isDeveloperIdSigned(codesignDetails)
    ? run('xcrun', ['stapler', 'validate', bundlePath]).status === 0
    : false

  return { codesignDetails, stapled }
}

export function designatedRequirement(bundlePath) {
  const result = sh('codesign', ['-d', '-r-', bundlePath], { allowFailure: true })
  const line = `${result.stdout || ''}\n${result.stderr || ''}`.split('\n').find(row => row.startsWith('designated =>'))

  return line ? line.replace('designated =>', '').trim() : ''
}

if (isMain(import.meta.url)) {
  try {
    const identity = ensureLocalIdentity({ log: console.log })

    console.log(`[macos-signing] ready: "${identity}" in ${SIGNING_KEYCHAIN}`)
  } catch (error) {
    console.error(`[macos-signing] ${error.message}`)
    process.exit(1)
  }
}
