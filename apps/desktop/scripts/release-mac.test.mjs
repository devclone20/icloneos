// Runs under `node --test` (the P7 gate) and under vitest's electron project. Fakes only: no keychain, no codesign.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import {
  assertFeedMinimum,
  assertFeedPublishable,
  childEnv,
  DMG_NAME,
  failingGateIds,
  feedMinimumSystemVersion,
  FORBIDDEN_ENV,
  icloudReason,
  parseArgs,
  pickAppSubmission,
  readFeedMinimum,
  releaseMac,
  runtimePin,
  selectIdentity,
  selectIdentityName,
  stampFeedMinimum,
  SUMS_SIGNATURE_NAME,
  sumsSignArgs,
  uploadNames
} from './release-mac.mjs'
import { entitlementsClass, MH_EXECUTE, unjustifiedPurposeKeys } from './sign-hook.mjs'

const { describe, it } = process.env.VITEST ? await import('vitest') : await import('node:test')

const TEAM = 'ABCDE12345'
const SHA = 'A'.repeat(40)
const OTHER = 'B'.repeat(40)
const REPO = '/Users/owner/Developer/iclone-os-release'
const DESKTOP = `${REPO}/apps/desktop`
const KC = '/Users/owner/Library/Keychains/iclone-release.keychain-db'
const GATES = '/abs/P7_gates.sh'
const PIN_JSON = JSON.stringify({
  sha: 'f'.repeat(40),
  date: '2026-10-06',
  tarball_sha256: 'e'.repeat(64),
  install_sh_sha256: 'd'.repeat(64),
  min_app: '1.1.0',
  verified: 'amber:3-roots'
})
const GENERATED_SRC = `export const RUNTIME_PIN = {\n  sha: '${'f'.repeat(40)}',\n  tarballSha256: '${'e'.repeat(64)}',\n  verified: 'amber:3-roots'\n} as const\n`
const LOCK = (rev, result = 'amber:3-roots') => JSON.stringify({ verifiedAgainst: { rev, result } })
// latest-mac.yml as electron-builder 26.15.3 writes it (no minimumSystemVersion).
const FEED_FIXTURE = `version: 0.0.5
files:
  - url: iclone-os-0.0.5-mac-arm64.zip
    sha512: ${'Q'.repeat(86)}==
    size: 123456789
path: iclone-os-0.0.5-mac-arm64.zip
sha512: ${'Q'.repeat(86)}==
releaseDate: '2026-11-04T00:00:00.000Z'
`
const sha256Hex = text => createHash('sha256').update(text).digest('hex')
const FIND = `  1) ${SHA} "Developer ID Application: Owner Name (${TEAM})"\n     1 valid identities found\n`

function fakeWorld({
  fail = null,
  notary = 'Accepted',
  present = () => true,
  lock = LOCK('f'.repeat(40)),
  find = FIND,
  macosMinimum = '13.0',
  feed = FEED_FIXTURE,
  contentHash = false
} = {}) {
  const calls = []
  const written = {}
  // Every call (full argv, `!` = interactive) and every write, in the order they happen.
  const events = []
  const run = (command, args, options = {}) => {
    const key = `${command} ${args.slice(0, 2).join(' ')}`

    calls.push({ key, args, env: options.env, cwd: options.cwd, interactive: options.interactive === true })
    events.push(`${options.interactive === true ? '!' : ''}${command} ${args.join(' ')}`)

    if (fail && key.startsWith(fail)) {
      return { status: 1, stdout: '', stderr: 'boom' }
    }

    if (key === 'git status --porcelain') {
      return { status: 0, stdout: '', stderr: '' }
    }

    if (key === 'security find-identity -v') {
      return { status: 0, stdout: find, stderr: '' }
    }

    if (key === `codesign -dvv ${args[1]}`) {
      return { status: 0, stdout: '', stderr: `Authority=Developer ID Application: Owner Name (${TEAM})\n` }
    }

    if (key === 'xcrun notarytool submit') {
      return { status: 0, stdout: JSON.stringify({ id: 'dmg-1', status: notary }), stderr: '' }
    }

    if (key === 'xcrun notarytool history') {
      const history = [{ id: 'app-1', name: 'iclone os.zip', createdDate: new Date(2000).toISOString() }]

      return { status: 0, stdout: JSON.stringify({ history }), stderr: '' }
    }

    if (command === 'bash') {
      return {
        status: 0,
        stdout: 'RESULT_JSON {"pass":false,"items":[{"id":"P7.x","pass":false}]}\nSUMMARY 1/2 PASS\n',
        stderr: ''
      }
    }

    return { status: 0, stdout: '{}', stderr: '' }
  }
  const deps = {
    run,
    env: { PATH: '/usr/bin', HOME: '/Users/owner' },
    desktopDir: DESKTOP,
    keychain: KC,
    exists: present,
    readText: path =>
      path in written
        ? written[path]
        : path.endsWith('latest-mac.yml')
          ? feed
          : path.endsWith('package.json')
            ? JSON.stringify({ version: '1.0.0', build: { mac: { minimumSystemVersion: macosMinimum } } })
            : path.endsWith('runtime-pin.generated.ts')
              ? GENERATED_SRC
              : path.endsWith('RUNTIME_PIN.json')
                ? PIN_JSON
                : path.endsWith('runtime.lock.json')
                  ? lock
                  : `# anchor comment\n#\n${'f'.repeat(40)}\n`,
    writeText: (path, text) => {
      written[path] = text
      events.push(`write ${path.split('/').at(-1)}`)
    },
    // contentHash: the sha256 of the bytes the path holds at hashing time (a write so far, else the fixture).
    hashFile: path => (contentHash ? sha256Hex(deps.readText(path)) : '0'.repeat(64)),
    fetchText: async () => null,
    now: () => 1000,
    log: () => {}
  }

  return { calls, written, events, deps, index: prefix => calls.findIndex(call => call.key.startsWith(prefix)) }
}

describe('release-mac — arguments and refusals', () => {
  it('requires a 10-character team id; --gates has no default (the gate lives outside the repo)', () => {
    assert.throws(() => parseArgs([]), /--team/)
    assert.throws(() => parseArgs(['--team', 'abc']), /--team/)
    assert.throws(() => parseArgs(['--team', TEAM, '--bogus']), /unknown/)

    const opts = parseArgs(['--team', TEAM, '--staple-only'])

    assert.equal(opts.stapleOnly, true)
    assert.equal(opts.gates, null)
    assert.equal(parseArgs(['--team', TEAM, '--gates', '/x/P7_gates.sh']).gates, '/x/P7_gates.sh')
  })

  it('refuses to run with any credential env var set — every name on the list', async () => {
    assert.deepEqual(FORBIDDEN_ENV, [
      'APPLE_ID',
      'APPLE_APP_SPECIFIC_PASSWORD',
      'APPLE_PASSWORD',
      'APPLE_API_KEY',
      'APPLE_API_KEY_ID',
      'APPLE_API_ISSUER',
      'CSC_LINK',
      'CSC_KEY_PASSWORD',
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'electron_use_remote_checksums',
      'npm_config_electron_use_remote_checksums',
      'ELECTRON_OVERRIDE_DIST_PATH'
    ])

    for (const name of FORBIDDEN_ENV) {
      const world = fakeWorld()

      await assert.rejects(
        releaseMac({ team: TEAM, gates: GATES }, { ...world.deps, env: { ...world.deps.env, [name]: 'x' } }),
        new RegExp(name)
      )
      assert.equal(world.calls.length, 0)
    }
  })

  it('refuses a pin whose verified is not the computed verdict BEFORE building or touching the keychain', async () => {
    const world = fakeWorld({ lock: LOCK('f'.repeat(40), 'red:3-roots') })

    await assert.rejects(releaseMac({ team: TEAM, gates: GATES }, world.deps), /the contract lock computed red:3-roots/)
    assert.equal(world.calls.length, 0)
  })

  it('refuses an iCloud path and fails closed when the gate script is missing', async () => {
    assert.equal(icloudReason('/Users/o/Desktop/icloneOS/app'), '/Desktop/')
    assert.equal(icloudReason('/Users/o/Library/Mobile Documents/x'), 'Mobile Documents')
    assert.equal(icloudReason('/Users/o/Developer/iclone-os-release'), null)

    const world = fakeWorld({ present: path => path !== GATES })

    await assert.rejects(releaseMac({ team: TEAM, gates: GATES }, world.deps), /gate script not found/)
    await assert.rejects(releaseMac({ team: TEAM, gates: '' }, world.deps), /gate script not found/)

    const icloud = fakeWorld()

    await assert.rejects(
      releaseMac({ team: TEAM, gates: GATES }, { ...icloud.deps, desktopDir: '/Users/o/Desktop/x/apps/desktop' }),
      /iCloud/
    )
    assert.equal(world.calls.length + icloud.calls.length, 0)
  })
})

describe('release-mac — identity by SHA-1', () => {
  it('selects exactly one Developer ID Application identity of the team, by its SHA-1', () => {
    assert.equal(selectIdentity(FIND, TEAM), SHA)
  })

  it('rejects zero, two, another team, Apple Development and a prefix-only match', () => {
    const two = `${FIND}  2) ${OTHER} "Developer ID Application: Owner Name (${TEAM})"\n`
    const dev = `  1) ${SHA} "Apple Development: Owner Name (${TEAM})"\n`
    const otherTeam = `  1) ${SHA} "Developer ID Application: Someone (ZZZZZ99999)"\n`
    const prefixed = `  1) ${SHA} "Developer ID Application: Owner Name (${TEAM}) copy"\n`

    for (const output of ['', two, dev, otherTeam, prefixed]) {
      assert.throws(() => selectIdentity(output, TEAM), /exactly one/)
    }
  })
})

describe('release-mac — child-only keychain env', () => {
  it('builds a copied env with the handles and without credential names; the parent env is untouched', () => {
    const parent = { PATH: '/usr/bin', GH_TOKEN: 'leak' }
    const env = childEnv(parent, { sha1: SHA, keychain: KC })

    assert.equal(env.CSC_NAME, SHA)
    assert.equal(env.CSC_KEYCHAIN, KC)
    assert.equal(env.CSC_IDENTITY_AUTO_DISCOVERY, 'false')
    assert.equal(env.APPLE_KEYCHAIN_PROFILE, 'iclone-notary')
    assert.equal(env.APPLE_KEYCHAIN, KC)
    assert.equal(env.GH_TOKEN, undefined)
    assert.deepEqual(parent, { PATH: '/usr/bin', GH_TOKEN: 'leak' })
  })

  it('passes the handles only to electron-builder and notarytool, never to npm or the gate', async () => {
    const world = fakeWorld()

    await releaseMac({ team: TEAM, gates: GATES }, world.deps)

    for (const call of world.calls) {
      const signing =
        call.key.startsWith('node scripts/run-electron-builder.mjs --mac') || call.key.startsWith('xcrun notarytool')

      assert.equal(Boolean(call.env?.CSC_NAME), signing, call.key)
    }

    assert.equal(world.deps.env.CSC_NAME, undefined)
    assert.ok(
      world.calls
        .find(c => c.key.startsWith('node scripts/run-electron-builder.mjs --mac'))
        .args.includes('-c.forceCodeSigning=true')
    )
    assert.ok(
      world.calls
        .find(c => c.key.startsWith('node scripts/run-electron-builder.mjs --mac'))
        .args.includes('--iclone-release-identity')
    )
  })
})

describe('release-mac — hygiene before notarize (PLANO_R §6 R7/R11)', () => {
  const HYGIENE = 'node scripts/artifact-hygiene.mjs'

  it('packs an unsigned --dir app and scans it before the keychain is unlocked and anything is signed or uploaded', async () => {
    const world = fakeWorld()

    await releaseMac({ team: TEAM, gates: GATES }, world.deps)

    const dirPack = world.index('node scripts/run-electron-builder.mjs --dir')
    const scans = world.calls.map((c, i) => (c.key.startsWith(HYGIENE) ? i : -1)).filter(i => i >= 0)

    assert.ok(world.index('npm run build') < dirPack)
    assert.ok(world.calls[dirPack].args.includes('-c.mac.identity=null'))
    assert.ok(world.calls[dirPack].args.includes('-c.mac.notarize=false'))
    // K144 r2: the scanned pack is the release identity, exactly what ships.
    assert.ok(world.calls[dirPack].args.includes('--iclone-release-identity'))
    assert.equal(world.calls[dirPack].env?.CSC_NAME, undefined)
    assert.equal(scans.length, 2, 'the unsigned app and the signed app are both scanned')
    assert.ok(dirPack < scans[0])
    assert.ok(scans[0] < world.index('security unlock-keychain'))
    assert.ok(scans[0] < world.index('node scripts/run-electron-builder.mjs --mac'))
    assert.ok(scans[0] < world.index('xcrun notarytool'))
    assert.ok(world.index('node scripts/run-electron-builder.mjs --mac') < scans[1])
  })

  it('a hit in the unsigned app stops the release before the unlock, the signing and the notary', async () => {
    const world = fakeWorld({ fail: HYGIENE })

    await assert.rejects(releaseMac({ team: TEAM, gates: GATES }, world.deps))
    assert.equal(world.index('security unlock-keychain'), -1)
    assert.equal(world.index('node scripts/run-electron-builder.mjs --mac'), -1)
    assert.equal(world.index('xcrun notarytool'), -1)
  })
})

describe('release-mac — unlock/lock ordering', () => {
  it('npm ci and the build run before the unlock; the lock comes last', async () => {
    const world = fakeWorld()

    await releaseMac({ team: TEAM, gates: GATES }, world.deps)

    const unlock = world.index('security unlock-keychain')

    assert.ok(world.index('security lock-keychain') < world.index('npm ci'))
    assert.ok(world.index('npm ci') < world.index('npm rebuild'))
    assert.ok(world.index('npm rebuild') < world.index('node node_modules/electron/install.js'))
    assert.ok(world.index('node node_modules/electron/install.js') < world.index('npm run build'))
    // The package is hoisted to the repo root: from the workspace this path does not exist and the release stops.
    assert.equal(world.calls[world.index('node node_modules/electron/install.js')].cwd, REPO)
    assert.ok(world.index('npm run build') < unlock)
    assert.ok(unlock < world.index('node scripts/run-electron-builder.mjs --mac'))

    const locks = world.calls.map((c, i) => (c.key.startsWith('security lock-keychain') ? i : -1)).filter(i => i >= 0)
    const lastLock = locks.at(-1)

    assert.ok(lastLock > world.index('xcrun notarytool history'))
    assert.ok(world.calls[lastLock - 1].key.startsWith('security set-keychain-settings'))
    assert.ok(world.calls[lastLock - 1].args.includes('300'))
    assert.ok(lastLock < world.index('bash'))
  })

  it('locks the keychain in finally when signing fails, and a rejected DMG fails the release', async () => {
    for (const world of [
      fakeWorld({ fail: 'node scripts/run-electron-builder.mjs --mac' }),
      fakeWorld({ notary: 'Invalid' })
    ]) {
      await assert.rejects(releaseMac({ team: TEAM, gates: GATES }, world.deps))
      assert.equal(world.calls.at(-1).key.startsWith('security lock-keychain'), true)
      assert.equal(world.index('bash'), -1)
    }
  })

  it('writes both notary logs, SHA256SUMS, UPLOAD.txt and runs the gate with --full --team --repo', async () => {
    const world = fakeWorld()
    const out = await releaseMac({ team: TEAM, gates: GATES }, world.deps)
    const release = `${DESKTOP}/release`

    assert.ok(`${release}/notary-app.json` in world.written)
    assert.ok(`${release}/notary-dmg.json` in world.written)
    assert.match(world.written[`${release}/SHA256SUMS.txt`], new RegExp(`  ${DMG_NAME}\n`))
    assert.equal(world.written[`${release}/UPLOAD.txt`], `${uploadNames('1.0.0').join('\n')}\n`)

    const gate = world.calls.find(c => c.key.startsWith('bash'))

    assert.deepEqual(gate.args.slice(0, 4), [GATES, '--full', '--team', TEAM])
    assert.ok(gate.args.includes('--repo'))
    assert.deepEqual(out.failing, ['P7.x'])
  })
})

describe('release-mac — --sign-sums (signed SHA256SUMS, off by default)', () => {
  it('parses the flag, off unless given', () => {
    assert.equal(parseArgs(['--team', TEAM]).signSums, false)
    assert.equal(parseArgs(['--team', TEAM, '--sign-sums']).signSums, true)
  })

  it('picks the full identity name for security cms -N', () => {
    assert.equal(selectIdentityName(FIND, TEAM), `Developer ID Application: Owner Name (${TEAM})`)
    assert.throws(() => selectIdentityName(`${FIND}${FIND}`, TEAM), /exactly one/)
  })

  it('signs with certificate usage 6 (object signer), the usage a Developer ID Application certificate has', () => {
    const args = sumsSignArgs({ identityName: 'ID', keychain: KC, sumsPath: '/r/SHA256SUMS.txt', sigPath: '/r/x.sig' })
    const usage = args.indexOf('-u')

    // Without -u, security cms looks for an e-mail signer and refuses a code-signing certificate.
    assert.ok(usage > 0, 'security cms must be given -u')
    assert.equal(args[usage + 1], '6', 'usage 6 = certUsageObjectSigner')
    assert.equal(args.filter(a => a === '-u').length, 1)
    assert.deepEqual(args, [
      'cms',
      '-S',
      '-N',
      'ID',
      '-k',
      KC,
      '-u',
      '6',
      '-H',
      'SHA256',
      '-G',
      '-T',
      '-i',
      '/r/SHA256SUMS.txt',
      '-o',
      '/r/x.sig'
    ])
  })

  it('without the flag: no cms call, no .sig listed for upload', async () => {
    const world = fakeWorld()

    await releaseMac({ team: TEAM, gates: GATES }, world.deps)
    assert.equal(world.index('security cms'), -1)
    assert.ok(!world.written[`${DESKTOP}/release/UPLOAD.txt`].includes(SUMS_SIGNATURE_NAME))
  })

  it('signs the written list inside the signing window, locks in finally, verifies, then lists the .sig', async () => {
    const world = fakeWorld()
    const release = `${DESKTOP}/release`

    await releaseMac({ team: TEAM, gates: GATES, signSums: true }, world.deps)

    const cms = world.calls.find(c => c.key === 'security cms -S')
    const at = world.index('security cms')
    const unlocks = world.calls
      .map((c, i) => (c.key.startsWith('security unlock-keychain') ? i : -1))
      .filter(i => i >= 0)

    const identity = `Developer ID Application: Owner Name (${TEAM})`

    assert.deepEqual(cms.args.slice(0, 6), ['cms', '-S', '-N', identity, '-k', KC])
    assert.ok(cms.args.includes('-T') && cms.args.includes('SHA256'))
    assert.deepEqual(cms.args.slice(-4), ['-i', `${release}/SHA256SUMS.txt`, '-o', `${release}/${SUMS_SIGNATURE_NAME}`])
    assert.deepEqual(cms.args, [
      'cms',
      '-S',
      '-N',
      identity,
      '-k',
      KC,
      '-u',
      '6',
      '-H',
      'SHA256',
      '-G',
      '-T',
      '-i',
      `${release}/SHA256SUMS.txt`,
      '-o',
      `${release}/${SUMS_SIGNATURE_NAME}`
    ])
    // Interactive, so a password or key-access prompt from security reaches the terminal instead of hanging on a pipe.
    assert.equal(cms.interactive, true)
    assert.equal(world.calls[unlocks.at(-1)].interactive, true)
    assert.ok(unlocks.at(-1) < at, 'unlocked just before signing')
    // The window's own finally follows the signature: idle timeout back to 300 s, then the lock.
    assert.ok(world.calls[at + 1].key.startsWith('security set-keychain-settings'), 'timeout restored right after')
    assert.ok(world.calls[at + 1].args.includes('300'))
    assert.ok(world.calls[at + 2].key.startsWith('security lock-keychain'), 'then locked')

    const verify = world.calls.findIndex(
      c => c.key.startsWith('node') && c.args[0].endsWith('verify-sums-signature.js')
    )

    assert.ok(verify > at + 2)
    assert.ok(world.calls[verify].args.includes(TEAM))
    assert.ok(world.written[`${release}/UPLOAD.txt`].includes(SUMS_SIGNATURE_NAME))
    assert.ok(!world.written[`${release}/SHA256SUMS.txt`].includes(SUMS_SIGNATURE_NAME), 'no self-reference')
  })

  it('one password per release: the list is hashed, written and signed inside the one signing window', async () => {
    const world = fakeWorld()
    const release = `${DESKTOP}/release`

    await releaseMac({ team: TEAM, gates: GATES, signSums: true }, world.deps)

    const all = prefix => world.calls.map((c, i) => (c.key.startsWith(prefix) ? i : -1)).filter(i => i >= 0)
    const unlocks = all('security unlock-keychain')
    const locks = all('security lock-keychain')
    const cms = world.index('security cms -S')
    const staple = world.calls.findIndex(c => c.key === 'xcrun stapler staple' && c.args[2].endsWith(DMG_NAME))
    const verify = world.calls.findIndex(c => c.args[0]?.endsWith?.('verify-sums-signature.js'))

    assert.equal(unlocks.length, 1, 'exactly one unlock-keychain')
    assert.equal(world.calls[unlocks[0]].interactive, true)
    assert.equal(locks.length, 2, 'the lock before npm ci and the signing window lock')
    assert.ok(locks[0] < world.index('npm ci'))
    assert.ok(unlocks[0] < staple && staple < cms, 'cms after the DMG is stapled')
    assert.ok(world.index('xcrun notarytool history') < cms)
    assert.ok(cms < locks[1], 'cms before the window lock')
    assert.equal(all('security set-keychain-settings').filter(i => i < cms).length, 1, 'still the 60 min window')
    assert.deepEqual(
      world.calls[cms].args,
      sumsSignArgs({
        identityName: `Developer ID Application: Owner Name (${TEAM})`,
        keychain: KC,
        sumsPath: `${release}/SHA256SUMS.txt`,
        sigPath: `${release}/${SUMS_SIGNATURE_NAME}`
      })
    )
    assert.equal(world.calls[cms].interactive, true)
    assert.ok(verify > locks[1], 'the verifier runs after the lock')
    // Written once, before cms: a list rewritten after signing would no longer match its signature.
    assert.equal(
      world.events.filter(e => e === 'write SHA256SUMS.txt').length,
      1,
      'SHA256SUMS.txt written exactly once'
    )
    assert.ok(world.events.indexOf('write SHA256SUMS.txt') < world.events.findIndex(e => e.startsWith('!security cms')))
    assert.ok(world.events.indexOf('write notary-app.json') < world.events.indexOf('write SHA256SUMS.txt'))
    assert.ok(world.written[`${release}/UPLOAD.txt`].includes(SUMS_SIGNATURE_NAME))
    assert.equal(world.written[`${release}/UPLOAD.txt`], `${uploadNames('1.0.0', { signedSums: true }).join('\n')}\n`)
  })

  it('validates both staples inside the signing window, before the list is hashed and signed', async () => {
    const world = fakeWorld()
    const app = `${DESKTOP}/release/mac-arm64/iclone os.app`
    const dmg = `${DESKTOP}/release/iclone-os-mac-arm64.dmg`
    const release = `${DESKTOP}/release`
    const identity = `Developer ID Application: Owner Name (${TEAM})`

    await releaseMac({ team: TEAM, gates: GATES, signSums: true }, world.deps)
    assert.deepEqual(world.events, [
      `git status --porcelain`,
      `security lock-keychain ${KC}`,
      `npm ci --ignore-scripts`,
      `npm rebuild esbuild node-pty`,
      `node node_modules/electron/install.js`,
      `npm run build`,
      `node scripts/run-electron-builder.mjs --dir --mac --arm64 --publish never -c.mac.identity=null -c.mac.notarize=false --iclone-release-identity`,
      `node scripts/artifact-hygiene.mjs --release ${app}`,
      `security find-identity -v -p codesigning ${KC}`,
      `!security unlock-keychain ${KC}`,
      `security set-keychain-settings -l -u -t 3600 ${KC}`,
      `node scripts/sign-acp-native.mjs --identity ${SHA} --keychain ${KC} --team ${TEAM}`,
      `!node scripts/run-electron-builder.mjs --mac --arm64 --publish never -c.forceCodeSigning=true --iclone-release-identity`,
      `node scripts/artifact-hygiene.mjs --release ${app}`,
      `node scripts/acp-native-check.mjs ${app} --signed --team ${TEAM}`,
      `node scripts/iclone-fsevents-check.mjs ${app} --signed --team ${TEAM}`,
      `codesign -dvv ${app}`,
      `xcrun stapler validate ${app}`,
      `node scripts/verify-packaged-acp.mjs ${app}`,
      `xcrun notarytool submit ${dmg} --wait --output-format json --keychain-profile iclone-notary --keychain ${KC}`,
      `xcrun notarytool log dmg-1 --keychain-profile iclone-notary --keychain ${KC}`,
      `write notary-dmg.json`,
      `xcrun stapler staple ${dmg}`,
      `xcrun stapler validate ${app}`,
      `xcrun stapler validate ${dmg}`,
      `xcrun notarytool history --output-format json --keychain-profile iclone-notary --keychain ${KC}`,
      `xcrun notarytool log app-1 --keychain-profile iclone-notary --keychain ${KC}`,
      `write notary-app.json`,
      `write latest-mac.yml`,
      `write SHA256SUMS.txt`,
      `!security cms -S -N ${identity} -k ${KC} -u 6 -H SHA256 -G -T -i ${release}/SHA256SUMS.txt -o ${release}/${SUMS_SIGNATURE_NAME}`,
      `security set-keychain-settings -l -u -t 300 ${KC}`,
      `security lock-keychain ${KC}`,
      `node ${REPO}/packages/icloneos-cli/scripts/verify-sums-signature.js ${release}/SHA256SUMS.txt ${release}/${SUMS_SIGNATURE_NAME} ${TEAM}`,
      `write UPLOAD.txt`,
      `bash ${GATES} --full --team ${TEAM} --release-dir ${release} --repo ${DESKTOP}`,
      `write GATES.txt`
    ])
  })

  it('a stapled DMG that does not validate stops the window before anything is hashed or signed', async () => {
    const world = fakeWorld()
    const dmg = `${DESKTOP}/release/iclone-os-mac-arm64.dmg`
    const { run } = world.deps

    world.deps.run = (command, args, options) => {
      const result = run(command, args, options)

      return command === 'xcrun' && args[1] === 'validate' && args[2] === dmg
        ? { status: 1, stdout: '', stderr: 'boom' }
        : result
    }

    await assert.rejects(releaseMac({ team: TEAM, gates: GATES, signSums: true }, world.deps), /stapler validate DMG/)
    assert.equal(world.index('security cms'), -1, 'nothing signed')
    assert.equal(`${DESKTOP}/release/SHA256SUMS.txt` in world.written, false, 'nothing hashed')
    assert.equal(`${DESKTOP}/release/UPLOAD.txt` in world.written, false)
    assert.deepEqual(world.events.slice(-3), [
      `xcrun stapler validate ${dmg}`,
      `security set-keychain-settings -l -u -t 300 ${KC}`,
      `security lock-keychain ${KC}`
    ])
  })

  it('an ambiguous identity fails before the keychain password is asked for, on both --sign-sums paths', async () => {
    const two = `${FIND}  2) ${OTHER} "Developer ID Application: Owner Name (${TEAM})"\n`

    for (const opts of [{ signSums: true }, { stapleOnly: true, signSums: true }]) {
      const world = fakeWorld({ find: two })

      await assert.rejects(releaseMac({ team: TEAM, gates: GATES, ...opts }, world.deps), /exactly one/)
      assert.ok(world.index('security find-identity') >= 0, 'the identity was looked up')
      assert.equal(world.calls.filter(c => c.key.startsWith('security unlock-keychain')).length, 0, 'no unlock')
      assert.equal(world.index('security cms'), -1)
    }
  })

  it('a failed cms locks the signing window (timeout restored first) and stops before UPLOAD.txt', async () => {
    const world = fakeWorld({ fail: 'security cms' })

    await assert.rejects(releaseMac({ team: TEAM, gates: GATES, signSums: true }, world.deps), /sign SHA256SUMS/)

    const cms = world.index('security cms')

    assert.equal(world.calls.filter(c => c.key.startsWith('security unlock-keychain')).length, 1)
    assert.deepEqual(
      world.calls.slice(cms + 1).map(c => [c.key, ...c.args.slice(2)]),
      [['security set-keychain-settings -l', '-u', '-t', '300', KC], ['security lock-keychain ' + KC]]
    )
    assert.equal(`${DESKTOP}/release/UPLOAD.txt` in world.written, false)
    assert.equal(world.index('bash'), -1)
  })

  it('a failed signature or verification fails the release, with the keychain locked', async () => {
    for (const fail of ['security cms', 'node /Users/owner/Developer/iclone-os-release/packages']) {
      const world = fakeWorld({ fail })

      await assert.rejects(releaseMac({ team: TEAM, gates: GATES, signSums: true }, world.deps))
      assert.equal(world.index('bash'), -1, 'no gate, no upload list')
      assert.equal(`${DESKTOP}/release/UPLOAD.txt` in world.written, false)
      const lastLock = world.calls
        .map((c, i) => (c.key.startsWith('security lock-keychain') ? i : -1))
        .filter(i => i >= 0)
        .at(-1)

      assert.ok(lastLock > world.index('security cms'))
    }
  })
})

describe('release-mac — without --sign-sums the call order is unchanged', () => {
  // Recorded from the release script before the SHA256SUMS signature moved into the signing window.
  it('a full release: the same calls, argv and writes, in the same order', async () => {
    const world = fakeWorld()

    await releaseMac({ team: TEAM, gates: GATES }, world.deps)
    assert.deepEqual(world.events, [
      `git status --porcelain`,
      `security lock-keychain ${KC}`,
      `npm ci --ignore-scripts`,
      `npm rebuild esbuild node-pty`,
      `node node_modules/electron/install.js`,
      `npm run build`,
      `node scripts/run-electron-builder.mjs --dir --mac --arm64 --publish never -c.mac.identity=null -c.mac.notarize=false --iclone-release-identity`,
      `node scripts/artifact-hygiene.mjs --release ${DESKTOP}/release/mac-arm64/iclone os.app`,
      `security find-identity -v -p codesigning ${KC}`,
      `!security unlock-keychain ${KC}`,
      `security set-keychain-settings -l -u -t 3600 ${KC}`,
      `node scripts/sign-acp-native.mjs --identity ${SHA} --keychain ${KC} --team ${TEAM}`,
      `!node scripts/run-electron-builder.mjs --mac --arm64 --publish never -c.forceCodeSigning=true --iclone-release-identity`,
      `node scripts/artifact-hygiene.mjs --release ${DESKTOP}/release/mac-arm64/iclone os.app`,
      `node scripts/acp-native-check.mjs ${DESKTOP}/release/mac-arm64/iclone os.app --signed --team ${TEAM}`,
      `node scripts/iclone-fsevents-check.mjs ${DESKTOP}/release/mac-arm64/iclone os.app --signed --team ${TEAM}`,
      `codesign -dvv ${DESKTOP}/release/mac-arm64/iclone os.app`,
      `xcrun stapler validate ${DESKTOP}/release/mac-arm64/iclone os.app`,
      `node scripts/verify-packaged-acp.mjs ${DESKTOP}/release/mac-arm64/iclone os.app`,
      `xcrun notarytool submit ${DESKTOP}/release/iclone-os-mac-arm64.dmg --wait --output-format json --keychain-profile iclone-notary --keychain ${KC}`,
      `xcrun notarytool log dmg-1 --keychain-profile iclone-notary --keychain ${KC}`,
      `write notary-dmg.json`,
      `xcrun stapler staple ${DESKTOP}/release/iclone-os-mac-arm64.dmg`,
      `xcrun notarytool history --output-format json --keychain-profile iclone-notary --keychain ${KC}`,
      `xcrun notarytool log app-1 --keychain-profile iclone-notary --keychain ${KC}`,
      `write notary-app.json`,
      `security set-keychain-settings -l -u -t 300 ${KC}`,
      `security lock-keychain ${KC}`,
      `xcrun stapler validate ${DESKTOP}/release/mac-arm64/iclone os.app`,
      `xcrun stapler validate ${DESKTOP}/release/iclone-os-mac-arm64.dmg`,
      `write latest-mac.yml`,
      `write SHA256SUMS.txt`,
      `write UPLOAD.txt`,
      `bash ${GATES} --full --team ${TEAM} --release-dir ${DESKTOP}/release --repo ${DESKTOP}`,
      `write GATES.txt`
    ])
  })

  it('--staple-only: the same calls, argv and writes, in the same order', async () => {
    const world = fakeWorld()

    await releaseMac({ team: TEAM, gates: GATES, stapleOnly: true }, world.deps)
    assert.deepEqual(world.events, [
      `xcrun stapler staple ${DESKTOP}/release/mac-arm64/iclone os.app`,
      `xcrun stapler staple ${DESKTOP}/release/iclone-os-mac-arm64.dmg`,
      `xcrun stapler validate ${DESKTOP}/release/mac-arm64/iclone os.app`,
      `xcrun stapler validate ${DESKTOP}/release/iclone-os-mac-arm64.dmg`,
      `write latest-mac.yml`,
      `write SHA256SUMS.txt`,
      `write UPLOAD.txt`,
      `bash ${GATES} --full --team ${TEAM} --release-dir ${DESKTOP}/release --repo ${DESKTOP}`,
      `write GATES.txt`
    ])
  })

  it('--staple-only --sign-sums has no signing window, so it opens one short one: still one password', async () => {
    const world = fakeWorld()

    await releaseMac({ team: TEAM, gates: GATES, stapleOnly: true, signSums: true }, world.deps)

    const unlocks = world.calls.filter(c => c.key.startsWith('security unlock-keychain'))
    const cms = world.index('security cms -S')
    const release = `${DESKTOP}/release`
    const identity = `Developer ID Application: Owner Name (${TEAM})`

    assert.deepEqual(world.events, [
      `xcrun stapler staple ${release}/mac-arm64/iclone os.app`,
      `xcrun stapler staple ${release}/iclone-os-mac-arm64.dmg`,
      `xcrun stapler validate ${release}/mac-arm64/iclone os.app`,
      `xcrun stapler validate ${release}/iclone-os-mac-arm64.dmg`,
      `write latest-mac.yml`,
      `write SHA256SUMS.txt`,
      `security find-identity -v -p codesigning ${KC}`,
      `!security unlock-keychain ${KC}`,
      `!security cms -S -N ${identity} -k ${KC} -u 6 -H SHA256 -G -T -i ${release}/SHA256SUMS.txt -o ${release}/${SUMS_SIGNATURE_NAME}`,
      `security lock-keychain ${KC}`,
      `node ${REPO}/packages/icloneos-cli/scripts/verify-sums-signature.js ${release}/SHA256SUMS.txt ${release}/${SUMS_SIGNATURE_NAME} ${TEAM}`,
      `write UPLOAD.txt`,
      `bash ${GATES} --full --team ${TEAM} --release-dir ${release} --repo ${DESKTOP}`,
      `write GATES.txt`
    ])
    assert.equal(unlocks.length, 1)
    assert.equal(unlocks[0].interactive, true, 'the one unlock reaches the terminal')
    assert.ok(world.index('xcrun stapler staple') < world.index('security unlock-keychain'))
    assert.ok(world.events.indexOf('write SHA256SUMS.txt') < world.events.findIndex(e => e.startsWith('!security cms')))
    assert.ok(world.calls[cms + 1].key.startsWith('security lock-keychain'))
    assert.ok(world.calls.findIndex(c => c.args[0]?.endsWith?.('verify-sums-signature.js')) > cms + 1)
  })
})

describe('release-mac — --staple-only', () => {
  it('re-staples and re-checks: no npm, no keychain, no builder, no notary submission', async () => {
    const world = fakeWorld()

    await releaseMac({ team: TEAM, gates: GATES, stapleOnly: true }, world.deps)

    for (const prefix of ['npm', 'security', 'node scripts/run-electron-builder.mjs', 'xcrun notarytool', 'git']) {
      assert.equal(world.index(prefix), -1, prefix)
    }

    assert.ok(world.index('xcrun stapler') >= 0)
    assert.ok(world.index('bash') > world.index('xcrun stapler'))
  })
})

describe('release-mac — notary history and gate output', () => {
  it('picks the newest app zip submission created after the build started', () => {
    const history = {
      history: [
        { id: 'old', name: 'iclone os.zip', createdDate: '2026-10-01T00:00:00Z' },
        { id: 'dmg', name: DMG_NAME, createdDate: '2026-10-08T00:00:02Z' },
        { id: 'a', name: 'iclone os.zip', createdDate: '2026-10-08T00:00:01Z' },
        { id: 'b', name: 'iclone os.zip', createdDate: '2026-10-08T00:00:03Z' }
      ]
    }

    assert.equal(pickAppSubmission(history, { since: Date.parse('2026-10-08T00:00:00Z') }), 'b')
    assert.equal(pickAppSubmission(history, { since: Date.parse('2026-10-09T00:00:00Z') }), null)
  })

  it('reads failing ids from RESULT_JSON and fails closed on garbage', () => {
    assert.deepEqual(failingGateIds('RESULT_JSON {"items":[{"id":"a","pass":true},{"id":"b","pass":false}]}'), ['b'])
    assert.deepEqual(failingGateIds('nothing'), ['P7.gates.output'])
  })
})

describe('sign-hook — least-privilege entitlements per file', () => {
  const app = '/r/mac-arm64/iclone os.app'

  it('main for the bundle and its own executable; inherit for helpers and libraries; none for other executables', () => {
    const cls = (rel, extra = {}) =>
      entitlementsClass({ appPath: app, filePath: rel ? `${app}/${rel}` : app, ...extra })

    assert.equal(cls(''), 'main')
    assert.equal(cls('Contents/MacOS/iclone os', { fileType: MH_EXECUTE }), 'main')
    assert.equal(cls('Contents/Frameworks/iclone os Helper (Renderer).app', { isDirectory: true }), 'inherit')
    assert.equal(
      cls('Contents/Frameworks/iclone os Helper.app/Contents/MacOS/iclone os Helper', { fileType: MH_EXECUTE }),
      'inherit'
    )
    assert.equal(cls('Contents/Frameworks/Electron Framework.framework', { isDirectory: true }), 'inherit')
    assert.equal(
      cls('Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libvk_swiftshader.dylib', {
        fileType: 6
      }),
      'inherit'
    )
    assert.equal(
      cls('Contents/Resources/app.asar.unpacked/node_modules/x/build/Release/x.node', { fileType: 8 }),
      'inherit'
    )

    for (const exe of [
      'Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler',
      'Contents/Frameworks/Squirrel.framework/Versions/A/Resources/ShipIt',
      'Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
      'Contents/Resources/app.asar.unpacked/node_modules/get-windows/main',
      'Contents/Resources/acp-cli/node_modules/x/acp-cli-signer-macos'
    ]) {
      assert.equal(cls(exe, { fileType: MH_EXECUTE }), 'none', exe)
    }
  })
})

describe('sign-hook — purpose strings only for what is used', () => {
  it('drops Camera, Calendars, Reminders, Music; keeps the justified ones and non-purpose keys', () => {
    const keys = [
      'CFBundleName',
      'NSCameraUsageDescription',
      'NSCalendarsUsageDescription',
      'NSRemindersFullAccessUsageDescription',
      'NSAppleMusicUsageDescription',
      'NSMicrophoneUsageDescription',
      'NSAppleEventsUsageDescription',
      'NSBluetoothAlwaysUsageDescription'
    ]

    assert.deepEqual(unjustifiedPurposeKeys(keys), [
      'NSCameraUsageDescription',
      'NSCalendarsUsageDescription',
      'NSRemindersFullAccessUsageDescription',
      'NSAppleMusicUsageDescription'
    ])
  })
})

describe('runtimePin', () => {
  it('publishes a copy of the bundled pin when JSON == generated == lock.verifiedAgainst.rev', () => {
    assert.deepEqual(runtimePin(PIN_JSON, GENERATED_SRC, LOCK('f'.repeat(40))), {
      sha: 'f'.repeat(40),
      date: '2026-10-06',
      min_app: '1.1.0',
      tarball_sha256: 'e'.repeat(64),
      install_sh_sha256: 'd'.repeat(64),
      verified: 'amber:3-roots'
    })
  })

  it('refuses when the pin is not the rev the contract lock is verified against', () => {
    assert.throws(() => runtimePin(PIN_JSON, GENERATED_SRC, LOCK('a'.repeat(40))), /verified against a{40}/)
  })

  it('refuses when RUNTIME_PIN.verified is not the verdict the lock computed (one truth)', () => {
    assert.throws(
      () => runtimePin(PIN_JSON, GENERATED_SRC, LOCK('f'.repeat(40), 'red:4-roots')),
      /RUNTIME_PIN.json says verified amber:3-roots, the contract lock computed red:4-roots/
    )
  })

  it('refuses when the generated pin carries a different verdict than the lock', () => {
    const lock = LOCK('f'.repeat(40), 'red:3-roots')
    const pin = PIN_JSON.replace('amber:3-roots', 'red:3-roots')
    assert.throws(() => runtimePin(pin, GENERATED_SRC, lock), /runtime-pin.generated.ts says verified amber:3-roots/)
  })

  it('refuses a lock with no computed verdict (unverified or missing)', () => {
    for (const result of [null, 'unverified', '']) {
      assert.throws(() => runtimePin(PIN_JSON, GENERATED_SRC, LOCK('f'.repeat(40), result)), /no computed verdict/)
    }
  })

  it('publishes the computed verdict, never a hand-typed one', () => {
    const lock = LOCK('f'.repeat(40), 'red:3-roots')
    const pin = PIN_JSON.replace('amber:3-roots', 'red:3-roots')
    const gen = GENERATED_SRC.replace('amber:3-roots', 'red:3-roots')
    assert.equal(runtimePin(pin, gen, lock).verified, JSON.parse(lock).verifiedAgainst.result)
  })

  it('refuses when the generated pin drifted from RUNTIME_PIN.json', () => {
    assert.throws(
      () => runtimePin(PIN_JSON, GENERATED_SRC.replace(/f{40}/, 'b'.repeat(40)), LOCK('f'.repeat(40))),
      /pins b{40}/
    )
  })
})

describe('release-mac — ruling 33: the ACP native add-ons', () => {
  it('Team-signs them inside the signing window, before the signed pack, and checks them in the signed app', async () => {
    const world = fakeWorld()

    await releaseMac({ team: TEAM, gates: GATES }, world.deps)

    const sign = world.index('node scripts/sign-acp-native.mjs')
    const pack = world.index('node scripts/run-electron-builder.mjs --mac')
    const check = world.index('node scripts/acp-native-check.mjs')

    assert.ok(world.index('security unlock-keychain') < sign)
    assert.ok(sign < pack)
    assert.ok(world.calls[sign].args.includes(TEAM))
    assert.ok(world.calls[sign].args.includes(SHA))
    assert.equal(world.calls[sign].env?.CSC_NAME, undefined)
    assert.ok(pack < check)
    assert.ok(world.calls[check].args.includes('--signed'))
    assert.ok(check < world.index('xcrun notarytool submit'))
  })

  it('a copy that fails to sign stops the release before the pack, and the keychain is locked', async () => {
    const world = fakeWorld({ fail: 'node scripts/sign-acp-native.mjs' })

    await assert.rejects(releaseMac({ team: TEAM, gates: GATES }, world.deps), /Team-sign the ACP native add-ons/)
    assert.equal(world.index('node scripts/run-electron-builder.mjs --mac'), -1)
    assert.equal(world.calls.at(-1).key.startsWith('security lock-keychain'), true)
  })
})

describe('release-mac — latest-mac.yml carries the Darwin minimum (macOS 12 never offered a 13.0 build)', () => {
  const STAMPED = `${FEED_FIXTURE}minimumSystemVersion: 22.0.0\n`
  const sumsOf = world => world.written[`${DESKTOP}/release/SHA256SUMS.txt`]
  const feedOf = world => world.written[`${DESKTOP}/release/latest-mac.yml`]

  it('maps macOS majors to Darwin majors with an explicit table, and refuses anything else', () => {
    for (const [macos, darwin] of [
      ['13.0', '22.0.0'],
      ['13', '22.0.0'],
      ['13.0.0', '22.0.0'],
      ['14.0', '23.0.0'],
      ['15.0', '24.0.0'],
      ['26.0', '25.0.0'],
      ['27.0', '26.0.0']
    ]) {
      assert.equal(feedMinimumSystemVersion(macos), darwin, macos)
    }

    for (const bad of ['12.0', '13.1', '16.0', '28.0', '', null, undefined, '22.0.0', 'x']) {
      assert.throws(() => feedMinimumSystemVersion(bad), /no Darwin mapping/, String(bad))
    }
  })

  it('stamps the fixture: one line appended, every other byte identical, idempotent, replaces a wrong value', () => {
    const stamped = stampFeedMinimum(FEED_FIXTURE, '22.0.0')

    assert.equal(stamped, STAMPED)
    assert.equal(stamped.slice(0, FEED_FIXTURE.length), FEED_FIXTURE)
    assert.equal(stampFeedMinimum(stamped, '22.0.0'), stamped)
    assert.equal(stampFeedMinimum(`${FEED_FIXTURE}minimumSystemVersion: '13.0'\n`, '22.0.0'), STAMPED)
    assert.equal(stampFeedMinimum('version: 0.0.5', '22.0.0'), 'version: 0.0.5\nminimumSystemVersion: 22.0.0\n')
    assert.equal(readFeedMinimum(stamped), '22.0.0')
    assert.equal(readFeedMinimum(FEED_FIXTURE), null)
    assert.throws(() => readFeedMinimum(`${STAMPED}minimumSystemVersion: 22.0.0\n`), /2 minimumSystemVersion/)
    // An indented key belongs to a nested map, not the feed's top level.
    assert.equal(readFeedMinimum('files:\n  minimumSystemVersion: 22.0.0\n'), null)
  })

  it('the check refuses a missing, a macOS-numbered or a different value', () => {
    assertFeedMinimum(STAMPED, '22.0.0')
    assert.throws(() => assertFeedMinimum(FEED_FIXTURE, '22.0.0'), /is null, expected 22.0.0/)
    assert.throws(() => assertFeedMinimum(`${FEED_FIXTURE}minimumSystemVersion: 13.0\n`, '22.0.0'), /"13.0"/)
    assert.throws(() => assertFeedMinimum(`${FEED_FIXTURE}minimumSystemVersion: 23.0.0\n`, '22.0.0'), /"23.0.0"/)
  })

  for (const [label, opts] of [
    ['a full release', {}],
    ['a full release with --sign-sums', { signSums: true }],
    ['--staple-only', { stapleOnly: true }],
    ['--staple-only --sign-sums', { stapleOnly: true, signSums: true }]
  ]) {
    it(`${label}: stamps the feed BEFORE SHA256SUMS, and the list hashes the stamped bytes`, async () => {
      const world = fakeWorld({ contentHash: true })

      await releaseMac({ team: TEAM, gates: GATES, ...opts }, world.deps)
      assert.equal(feedOf(world), STAMPED)
      assert.ok(world.events.indexOf('write latest-mac.yml') < world.events.indexOf('write SHA256SUMS.txt'))
      assert.match(sumsOf(world), new RegExp(`^${sha256Hex(STAMPED)}  latest-mac.yml$`, 'm'))
      assert.doesNotMatch(sumsOf(world), new RegExp(sha256Hex(FEED_FIXTURE)))
    })
  }

  it('an already stamped feed is not rewritten (a re-run is idempotent)', async () => {
    const world = fakeWorld({ contentHash: true, feed: STAMPED })

    await releaseMac({ team: TEAM, gates: GATES, stapleOnly: true }, world.deps)
    assert.equal(world.events.includes('write latest-mac.yml'), false)
    assert.match(sumsOf(world), new RegExp(`^${sha256Hex(STAMPED)}  latest-mac.yml$`, 'm'))
  })

  it('an unmapped macOS minimum is refused before anything runs', async () => {
    for (const macosMinimum of ['13.1', '12.0', null]) {
      const world = fakeWorld({ macosMinimum })

      await assert.rejects(releaseMac({ team: TEAM, gates: GATES }, world.deps), /no Darwin mapping/)
      assert.deepEqual(world.events, [])
    }
  })

  it('the gate before upload: a feed without the minimum, or a list that does not cover its bytes, is refused', () => {
    const sha = sha256Hex(STAMPED)
    const sums = `${'1'.repeat(64)}  iclone-os-mac-arm64.dmg\n${sha}  latest-mac.yml\n`

    assertFeedPublishable({ ymlText: STAMPED, ymlSha256: sha, sumsText: sums, expected: '22.0.0' })
    assert.throws(
      () => assertFeedPublishable({ ymlText: FEED_FIXTURE, ymlSha256: sha, sumsText: sums, expected: '22.0.0' }),
      /minimumSystemVersion is null/
    )
    assert.throws(
      () =>
        assertFeedPublishable({
          ymlText: STAMPED,
          ymlSha256: sha,
          sumsText: `${sha256Hex(FEED_FIXTURE)}  latest-mac.yml\n`,
          expected: '22.0.0'
        }),
      /does not cover the stamped latest-mac.yml/
    )
    assert.throws(
      () => assertFeedPublishable({ ymlText: STAMPED, ymlSha256: sha, sumsText: '', expected: '22.0.0' }),
      /listed none/
    )
  })

  it('the stamp is re-read: a write that did not land stops the release before SHA256SUMS is written or signed', async () => {
    const world = fakeWorld({ contentHash: true })
    const { writeText } = world.deps

    // A write that reports success but leaves the file as electron-builder wrote it.
    world.deps.writeText = (path, text) => (path.endsWith('latest-mac.yml') ? undefined : writeText(path, text))
    await assert.rejects(
      releaseMac({ team: TEAM, gates: GATES, signSums: true }, world.deps),
      /minimumSystemVersion is null, expected 22.0.0/
    )
    assert.equal(world.events.includes('write SHA256SUMS.txt'), false)
    assert.equal(
      world.events.some(event => event.startsWith('!security cms')),
      false
    )
  })

  it('the gate runs in the release: a feed changed after the list is hashed stops it before UPLOAD.txt', async () => {
    const world = fakeWorld({ contentHash: true })
    const { writeText } = world.deps

    world.deps.writeText = (path, text) => {
      writeText(path, text)

      // A late writer (what a stamp after the sums would be): the feed's bytes change once the list exists.
      if (path.endsWith('SHA256SUMS.txt')) {
        world.written[`${DESKTOP}/release/latest-mac.yml`] = `${STAMPED}# late\n`
      }
    }
    await assert.rejects(releaseMac({ team: TEAM, gates: GATES }, world.deps), /does not cover the stamped/)
    assert.equal(world.events.includes('write UPLOAD.txt'), false)
  })
})
