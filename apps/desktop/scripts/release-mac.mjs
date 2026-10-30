#!/usr/bin/env node
// release-mac.mjs — the signed, notarized arm64 release (contract P7 decisions 1, 3, 4, 5, 15).
//
//   npm run release:mac -- --team <TEAMID> --gates <abs path to RESUME/run/gates/P7_gates.sh> [--staple-only] [--sign-sums]
//
// Runs in the owner's Terminal, from a fresh clone outside iCloud. Third-party code (npm ci, vite, tsc) runs while the
// release keychain is LOCKED; the keychain is unlocked (the owner types its password at the `security` prompt) only for
// electron-builder's sign + notarize and the DMG notarization, and is locked again in `finally`. Credentials reach only
// child processes, through a copied env: this process's env is never mutated, and argv holding the keychain path is
// never logged. No credential is ever read by this script.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { RELEASE_IDENTITY_FLAG } from './build-identity.mjs'
import { isMain } from './utils.mjs'

const here = dirname(fileURLToPath(import.meta.url))

export const DESKTOP_DIR = resolve(here, '..')
export const RELEASE_KEYCHAIN = join(homedir(), 'Library', 'Keychains', 'iclone-release.keychain-db')
export const NOTARY_PROFILE = 'iclone-notary'
// The gate script lives in the private control plane, outside this repo: pass it with --gates (fail-closed without).
export const DEFAULT_GATES = null
// The rollback reference for the gate (--prev-version): the live feed of the public full-release repo (none before its
// first release; then the gate runs without --prev-version).
export const FEED_LATEST = 'https://github.com/devclone20/icloneos/releases/latest/download/latest-mac.yml'
export const DMG_NAME = 'iclone-os-mac-arm64.dmg'
export const APP_BUNDLE = 'iclone os.app'
export const SUMS_NAME = 'SHA256SUMS.txt'
export const SUMS_SIGNATURE_NAME = 'SHA256SUMS.txt.sig'
// The launchers' own verifier (packages/icloneos-cli): a signature they would refuse is never listed for upload.
export const VERIFY_SUMS_SCRIPT = join('packages', 'icloneos-cli', 'scripts', 'verify-sums-signature.js')

/** Set in the parent env = refuse: builder would pick them up and bypass the keychain-profile path. */
export const FORBIDDEN_ENV = [
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_PASSWORD',
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'GH_TOKEN',
  'GITHUB_TOKEN'
]

/** The only packages whose install scripts run (after `npm ci --ignore-scripts`). Reviewed by the lead. */
export const REBUILD_ALLOWLIST = ['electron', 'esbuild', 'node-pty']

const ICLOUD_MARKERS = ['/Desktop/', '/Documents/', 'Mobile Documents']

export function parseArgs(argv) {
  const opts = { team: null, stapleOnly: false, signSums: false, gates: DEFAULT_GATES }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]

    if (arg === '--team') {
      opts.team = argv[(i += 1)] ?? null
    } else if (arg === '--staple-only') {
      opts.stapleOnly = true
    } else if (arg === '--sign-sums') {
      opts.signSums = true
    } else if (arg === '--gates') {
      opts.gates = argv[(i += 1)] ?? ''
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }

  if (!/^[A-Z0-9]{10}$/.test(opts.team ?? '')) {
    throw new Error('--team <TEAMID> is required (10 characters, A-Z 0-9)')
  }

  return opts
}

export function forbiddenEnvSet(env) {
  return FORBIDDEN_ENV.filter(name => env[name] !== undefined && env[name] !== '')
}

export function icloudReason(dir) {
  const probe = `${resolve(dir)}/`

  return ICLOUD_MARKERS.find(marker => probe.includes(marker)) ?? null
}

/**
 * `security find-identity -v -p codesigning <kc>` output → the 40-hex SHA-1 of the ONE Developer ID Application
 * identity of `team`. Never the name: builder 26.15.3 throws on the "Developer ID Application:" prefix.
 */
export function selectIdentity(findIdentityOutput, team) {
  const pattern = new RegExp(`^\\s*\\d+\\)\\s+([0-9A-F]{40})\\s+"Developer ID Application: .* \\(${team}\\)"\\s*$`)
  const matches = String(findIdentityOutput ?? '')
    .split('\n')
    .map(line => pattern.exec(line))
    .filter(Boolean)

  if (matches.length !== 1) {
    throw new Error(`expected exactly one "Developer ID Application: … (${team})" identity, found ${matches.length}`)
  }

  return matches[0][1]
}

/** The full "Developer ID Application: Name (TEAM)" of the ONE identity of `team`: `security cms -N` takes the name. */
export function selectIdentityName(findIdentityOutput, team) {
  const pattern = new RegExp(`^\\s*\\d+\\)\\s+[0-9A-F]{40}\\s+"(Developer ID Application: .* \\(${team}\\))"\\s*$`)
  const names = String(findIdentityOutput ?? '')
    .split('\n')
    .map(line => pattern.exec(line)?.[1])
    .filter(Boolean)

  if (names.length !== 1) {
    throw new Error(`expected exactly one "Developer ID Application: … (${team})" identity, found ${names.length}`)
  }

  return names[0]
}

/** A copy of `base` without the forbidden names, plus the signing/notary handles. `base` is not touched. */
export function childEnv(base, { sha1, keychain }) {
  const env = { ...base }

  for (const name of FORBIDDEN_ENV) {
    delete env[name]
  }

  return {
    ...env,
    CSC_NAME: sha1,
    CSC_KEYCHAIN: keychain,
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    APPLE_KEYCHAIN_PROFILE: NOTARY_PROFILE,
    APPLE_KEYCHAIN: keychain
  }
}

/** The app zip @electron/notarize submitted: newest history entry named "<app>.zip" created after `since`. */
export function pickAppSubmission(historyJson, { since, zipName = `${basename(APP_BUNDLE, '.app')}.zip` }) {
  const entries = (historyJson?.history ?? []).filter(
    entry => entry.name === zipName && Date.parse(entry.createdDate) >= since
  )

  entries.sort((a, b) => Date.parse(b.createdDate) - Date.parse(a.createdDate))

  return entries[0]?.id ?? null
}

/**
 * The release's runtime.json — a PUBLISHED COPY of the bundled pin (P7 d13(b) amended 2026-10-16, PLAN R front R1):
 * iclone/RUNTIME_PIN.json is canonical, compiled into electron/runtime-pin.generated.ts, and must equal the rev the
 * contract lock is verified against. Its `verified` must equal the verdict the extractor COMPUTED for that rev
 * (lock.verifiedAgainst.result): one truth, never a hand-typed restatement. Any drift refuses the release instead of
 * shipping a pin the app cannot verify; the published `verified` is the computed one.
 */
export function runtimePin(pinJsonText, generatedSource, lockJsonText) {
  const pin = JSON.parse(pinJsonText)
  const against = JSON.parse(lockJsonText)?.verifiedAgainst
  const lockRev = against?.rev
  const lockResult = against?.result
  const generatedSha = /sha: '([0-9a-f]{40})'/.exec(generatedSource)?.[1]
  const generatedTarball = /tarballSha256: '([0-9a-f]{64})'/.exec(generatedSource)?.[1]
  const generatedVerified = /verified: '([^']*)'/.exec(generatedSource)?.[1]

  if (!/^[0-9a-f]{40}$/.test(pin?.sha ?? '') || !/^[0-9a-f]{64}$/.test(pin?.tarball_sha256 ?? '')) {
    throw new Error('iclone/RUNTIME_PIN.json has no 40-hex sha or 64-hex tarball_sha256')
  }

  if (generatedSha !== pin.sha || generatedTarball !== pin.tarball_sha256) {
    throw new Error(`runtime-pin.generated.ts pins ${generatedSha ?? 'nothing'}, RUNTIME_PIN.json says ${pin.sha}`)
  }

  if (lockRev !== pin.sha) {
    throw new Error(`runtime.lock.json is verified against ${lockRev ?? 'nothing'}, RUNTIME_PIN.json says ${pin.sha}`)
  }

  if (typeof lockResult !== 'string' || !/^(green|amber|red|unknown):\d+-roots$/.test(lockResult)) {
    throw new Error(`runtime.lock.json has no computed verdict (${lockResult ?? 'nothing'}) — rerun the extractor`)
  }

  if (pin.verified !== lockResult) {
    throw new Error(
      `RUNTIME_PIN.json says verified ${pin.verified ?? 'nothing'}, the contract lock computed ${lockResult}`
    )
  }

  if (generatedVerified !== lockResult) {
    throw new Error(
      `runtime-pin.generated.ts says verified ${generatedVerified ?? 'nothing'}, the lock computed ${lockResult}`
    )
  }

  return {
    sha: pin.sha,
    date: pin.date,
    min_app: pin.min_app,
    tarball_sha256: pin.tarball_sha256,
    install_sh_sha256: pin.install_sh_sha256,
    verified: lockResult
  }
}

export function sha256SumsText(entries) {
  return entries.map(({ name, sha256 }) => `${sha256}  ${name}`).join('\n') + '\n'
}

export function uploadNames(version, { signedSums = false } = {}) {
  const zip = `iclone-os-${version}-mac-arm64.zip`

  const signature = signedSums ? [SUMS_SIGNATURE_NAME] : []

  return [DMG_NAME, zip, `${zip}.blockmap`, 'latest-mac.yml', 'runtime.json', SUMS_NAME, ...signature]
}

/** Ids of the failing items in the gate's RESULT_JSON line; ['P7.gates.output'] when the line is missing or bad. */
export function failingGateIds(gateStdout) {
  const line = /^RESULT_JSON (.*)$/m.exec(String(gateStdout ?? ''))?.[1]

  try {
    return JSON.parse(line)
      .items.filter(entry => !entry.pass)
      .map(entry => entry.id)
  } catch {
    return ['P7.gates.output']
  }
}

export function gateArgs({ gates, team, desktopDir, prevVersion }) {
  return [
    gates,
    '--full',
    '--team',
    team,
    '--release-dir',
    join(desktopDir, 'release'),
    '--repo',
    desktopDir,
    ...(prevVersion ? ['--prev-version', prevVersion] : [])
  ]
}

function defaultRun(command, args, { env, cwd, interactive = false, input } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    input,
    encoding: 'utf8',
    stdio: interactive ? 'inherit' : ['pipe', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024
  })

  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

async function defaultFetchText(url) {
  const response = await fetch(url, { redirect: 'follow' })

  return response.ok ? response.text() : null
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * The release. `deps` exists so tests drive the order with fakes; production uses the real process.
 * Every external step is `step(label, command, args, options)`: the label is logged, the argv is not.
 */
export async function releaseMac(opts, deps = {}) {
  const {
    run = defaultRun,
    env = process.env,
    desktopDir = DESKTOP_DIR,
    keychain = RELEASE_KEYCHAIN,
    exists = existsSync,
    readText = path => readFileSync(path, 'utf8'),
    writeText = (path, text) => writeFileSync(path, text),
    hashFile = sha256File,
    fetchText = defaultFetchText,
    now = () => Date.now(),
    log = message => console.log(`[release-mac] ${message}`)
  } = deps

  const forbidden = forbiddenEnvSet(env)

  if (forbidden.length) {
    throw new Error(`refusing to run with ${forbidden.join(', ')} set — unset them (credentials live in the keychain)`)
  }

  if (!opts.gates || !exists(opts.gates)) {
    throw new Error(`gate script not found: ${opts.gates || '(empty)'} — pass --gates <abs path to P7_gates.sh>`)
  }

  const repoRoot = resolve(desktopDir, '..', '..')
  const releaseDir = join(desktopDir, 'release')
  const icloud = icloudReason(repoRoot)

  if (icloud) {
    throw new Error(`refusing an iCloud-synced path (${icloud}) — release from a fresh clone in ~/Developer`)
  }

  const step = (label, command, args, options = {}) => {
    log(label)
    const result = run(command, args, { cwd: desktopDir, env, ...options })

    if (result.status !== 0 && !options.allowFailure) {
      throw new Error(`${label} failed (exit ${result.status})`)
    }

    return result
  }

  const version = JSON.parse(readText(join(desktopDir, 'package.json'))).version
  // The published runtime.json is checked before anything is built or sent to Apple, so a pin whose `verified` is not
  // the lock's computed verdict fails in seconds, not after notarization.
  const readPin = () =>
    runtimePin(
      readText(join(repoRoot, 'iclone', 'RUNTIME_PIN.json')),
      readText(join(desktopDir, 'electron', 'runtime-pin.generated.ts')),
      readText(join(repoRoot, 'iclone', 'contract', 'runtime.lock.json'))
    )
  const publishedPin = readPin()
  const appPath = join(releaseDir, 'mac-arm64', APP_BUNDLE)
  const dmgPath = join(releaseDir, DMG_NAME)
  const started = now()

  if (!opts.stapleOnly) {
    if (step('git status', 'git', ['status', '--porcelain'], { cwd: repoRoot }).stdout.trim()) {
      throw new Error('refusing a dirty tree — release builds come from a clean clone at the source tag')
    }

    // Third-party code runs only while the release keychain is locked.
    step('lock the release keychain', 'security', ['lock-keychain', keychain])
    step('npm ci --ignore-scripts', 'npm', ['ci', '--ignore-scripts'], { cwd: repoRoot })
    step(`npm rebuild ${REBUILD_ALLOWLIST.join(' ')}`, 'npm', ['rebuild', ...REBUILD_ALLOWLIST], { cwd: repoRoot })
    step('npm run build', 'npm', ['run', 'build'])
    // PLANO_R §6 R7/R11: an unsigned --dir pack is scanned before anything is signed or uploaded to Apple's notary, so
    // a dirty app never leaves the machine. The signed app is scanned again below, and the DMG by make-distribution.
    step('electron-builder --dir (unsigned, for the hygiene scan)', 'node', [
      'scripts/run-electron-builder.mjs',
      '--dir',
      '--mac',
      '--arm64',
      '--publish',
      'never',
      '-c.mac.identity=null',
      '-c.mac.notarize=false',
      RELEASE_IDENTITY_FLAG
    ])
    step('artifact hygiene of the unsigned app (PLANO_R §6 R7/R11)', 'node', [
      'scripts/artifact-hygiene.mjs',
      '--release',
      appPath
    ])

    const identities = step('find the Developer ID identity', 'security', [
      'find-identity',
      '-v',
      '-p',
      'codesigning',
      keychain
    ])
    const sha1 = selectIdentity(identities.stdout, opts.team)
    const signingEnv = childEnv(env, { sha1, keychain })

    try {
      step('unlock the release keychain (type its password)', 'security', ['unlock-keychain', keychain], {
        interactive: true
      })
      step('keychain idle lock 60 min for the signing window', 'security', [
        'set-keychain-settings',
        '-l',
        '-u',
        '-t',
        '3600',
        keychain
      ])
      // Ruling 33: the ACP CLI's native add-ons the app ships are Team-signed HERE, inside the signing window and
      // before the app is packed and sealed, and their list is rewritten with the signed bytes (sign-acp-native.mjs).
      step('Team-sign the ACP native add-ons (ruling 33)', 'node', [
        'scripts/sign-acp-native.mjs',
        '--identity',
        sha1,
        '--keychain',
        keychain,
        '--team',
        opts.team
      ])
      step(
        'electron-builder pack + sign + notarize',
        'node',
        [
          'scripts/run-electron-builder.mjs',
          '--mac',
          '--arm64',
          '--publish',
          'never',
          '-c.forceCodeSigning=true',
          RELEASE_IDENTITY_FLAG
        ],
        { env: signingEnv, interactive: true }
      )
      step('artifact hygiene of the signed app (PLANO_R §6 R7/R11)', 'node', [
        'scripts/artifact-hygiene.mjs',
        '--release',
        appPath
      ])
      step('the ACP native add-ons in the signed app: listed, Team-signed, byte-equal (ruling 33)', 'node', [
        'scripts/acp-native-check.mjs',
        appPath,
        '--signed',
        '--team',
        opts.team
      ])

      const leaf = step('read the app signature', 'codesign', ['-dvv', appPath])

      if (!/^Authority=Developer ID Application: .+\(([A-Z0-9]{10})\)$/m.test(`${leaf.stdout}\n${leaf.stderr}`)) {
        throw new Error('the app leaf is not a Developer ID Application certificate')
      }

      step('stapler validate app', 'xcrun', ['stapler', 'validate', appPath])
      // RESUME/scout/R7_pack_hang_macos26.md decision 2: the signed, notarized app is LAUNCHED and self-tested here,
      // before the DMG is notarized, stapled or listed for upload. A hang (SIGKILL after 180 s) fails the release.
      step('launch the signed app: packaged self-test (--iclone-selftest=all)', 'node', [
        'scripts/verify-packaged-acp.mjs',
        appPath
      ])

      const submit = step(
        'notarize the DMG',
        'xcrun',
        [
          'notarytool',
          'submit',
          dmgPath,
          '--wait',
          '--output-format',
          'json',
          '--keychain-profile',
          NOTARY_PROFILE,
          '--keychain',
          keychain
        ],
        { env: signingEnv, allowFailure: true }
      )
      const dmgSubmission = JSON.parse(submit.stdout || '{}')
      const notaryLog = id =>
        step(
          'fetch a notary log',
          'xcrun',
          ['notarytool', 'log', id, '--keychain-profile', NOTARY_PROFILE, '--keychain', keychain],
          { env: signingEnv }
        ).stdout

      if (dmgSubmission.id) {
        writeText(join(releaseDir, 'notary-dmg.json'), notaryLog(dmgSubmission.id))
      }

      if (submit.status !== 0 || dmgSubmission.status !== 'Accepted') {
        throw new Error(`DMG notarization: ${dmgSubmission.status ?? 'no status'} — see release/notary-dmg.json`)
      }

      step('staple the DMG', 'xcrun', ['stapler', 'staple', dmgPath])

      const history = step(
        'notary history',
        'xcrun',
        [
          'notarytool',
          'history',
          '--output-format',
          'json',
          '--keychain-profile',
          NOTARY_PROFILE,
          '--keychain',
          keychain
        ],
        { env: signingEnv }
      )
      const appSubmission = pickAppSubmission(JSON.parse(history.stdout || '{}'), { since: started })

      if (!appSubmission) {
        throw new Error('no app notarization submission found after the build started')
      }

      writeText(join(releaseDir, 'notary-app.json'), notaryLog(appSubmission))
    } finally {
      run('security', ['set-keychain-settings', '-l', '-u', '-t', '300', keychain], { cwd: desktopDir, env })
      run('security', ['lock-keychain', keychain], { cwd: desktopDir, env })
      log('release keychain locked')
    }
  } else {
    step('staple the app', 'xcrun', ['stapler', 'staple', appPath])
    step('staple the DMG', 'xcrun', ['stapler', 'staple', dmgPath])
  }

  step('stapler validate app', 'xcrun', ['stapler', 'validate', appPath])
  step('stapler validate DMG', 'xcrun', ['stapler', 'validate', dmgPath])

  const runtimeJson = join(releaseDir, 'runtime.json')

  if (!exists(runtimeJson)) {
    writeText(runtimeJson, `${JSON.stringify(publishedPin)}\n`)
  }

  const names = uploadNames(version, { signedSums: opts.signSums })
  const hashed = names
    .filter(name => name !== SUMS_NAME && name !== SUMS_SIGNATURE_NAME)
    .map(name => {
      const path = join(releaseDir, name)

      if (!exists(path)) {
        throw new Error(`missing release asset: ${name}`)
      }

      return { name, sha256: hashFile(path) }
    })

  const sumsPath = join(releaseDir, SUMS_NAME)

  writeText(sumsPath, sha256SumsText(hashed))

  if (opts.signSums) {
    // A second, short unlock: the list only exists once the DMG is stapled, after the signing window has closed.
    const sigPath = join(releaseDir, SUMS_SIGNATURE_NAME)
    const identities = step('find the Developer ID identity (SHA256SUMS)', 'security', [
      'find-identity',
      '-v',
      '-p',
      'codesigning',
      keychain
    ])
    const identityName = selectIdentityName(identities.stdout, opts.team)

    try {
      step(
        'unlock the release keychain to sign SHA256SUMS.txt (type its password)',
        'security',
        ['unlock-keychain', keychain],
        { interactive: true }
      )
      step(
        'sign SHA256SUMS.txt (detached CMS, Developer ID Application)',
        'security',
        ['cms', '-S', '-N', identityName, '-k', keychain, '-H', 'SHA256', '-G', '-T', '-i', sumsPath, '-o', sigPath],
        { interactive: true }
      )
    } finally {
      run('security', ['lock-keychain', keychain], { cwd: desktopDir, env })
      log('release keychain locked')
    }

    step('verify SHA256SUMS.txt.sig exactly as the launchers will', 'node', [
      join(repoRoot, VERIFY_SUMS_SCRIPT),
      sumsPath,
      sigPath,
      opts.team
    ])
  }

  writeText(join(releaseDir, 'UPLOAD.txt'), `${names.join('\n')}\n`)

  const live = await fetchText(FEED_LATEST).catch(() => null)
  const prevVersion = /^version:\s*(\S+)/m.exec(live ?? '')?.[1] ?? null
  const gate = step(
    'P7 gates --full',
    'bash',
    gateArgs({ gates: opts.gates, team: opts.team, desktopDir, prevVersion }),
    {
      allowFailure: true
    }
  )
  const summary = /^SUMMARY .*$/m.exec(gate.stdout)?.[0] ?? 'SUMMARY missing'
  const failing = failingGateIds(gate.stdout)

  log(summary)

  if (failing.length) {
    // Owner-step items (acceptance, feed, site) fail until guide steps 8-12 are done; the list says which remain.
    log(`failing: ${failing.join(' ')}`)
  }

  writeText(join(releaseDir, 'GATES.txt'), `${summary}\n${failing.join('\n')}\n`)

  return { version, summary, failing }
}

if (isMain(import.meta.url)) {
  try {
    if (process.platform !== 'darwin') {
      throw new Error('release-mac only runs on macOS')
    }

    await releaseMac(parseArgs(process.argv.slice(2)))
  } catch (error) {
    console.error(`[release-mac] ${error instanceof Error ? error.message : error}`)
    process.exit(1)
  }
}
