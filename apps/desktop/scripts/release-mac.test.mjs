// Runs under `node --test` (the P7 gate) and under vitest's electron project. Fakes only: no keychain, no codesign.
import assert from 'node:assert/strict'

import {
  childEnv,
  DMG_NAME,
  failingGateIds,
  FORBIDDEN_ENV,
  icloudReason,
  parseArgs,
  pickAppSubmission,
  releaseMac,
  runtimePin,
  selectIdentity,
  selectIdentityName,
  SUMS_SIGNATURE_NAME,
  uploadNames
} from './release-mac.mjs'
import { entitlementsClass, MH_EXECUTE, unjustifiedPurposeKeys } from './sign-hook.mjs'

const { describe, it } = process.env.VITEST ? await import('vitest') : await import('node:test')

const TEAM = 'ABCDE12345'
const SHA = 'A'.repeat(40)
const OTHER = 'B'.repeat(40)
const DESKTOP = '/Users/owner/Developer/iclone-os-release/apps/desktop'
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
const FIND = `  1) ${SHA} "Developer ID Application: Owner Name (${TEAM})"\n     1 valid identities found\n`

function fakeWorld({ fail = null, notary = 'Accepted', present = () => true, lock = LOCK('f'.repeat(40)) } = {}) {
  const calls = []
  const written = {}
  const run = (command, args, options = {}) => {
    const key = `${command} ${args.slice(0, 2).join(' ')}`

    calls.push({ key, args, env: options.env })

    if (fail && key.startsWith(fail)) {
      return { status: 1, stdout: '', stderr: 'boom' }
    }

    if (key === 'git status --porcelain') {
      return { status: 0, stdout: '', stderr: '' }
    }

    if (key === 'security find-identity -v') {
      return { status: 0, stdout: FIND, stderr: '' }
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
      path.endsWith('package.json')
        ? '{"version":"1.0.0"}'
        : path.endsWith('runtime-pin.generated.ts')
          ? GENERATED_SRC
          : path.endsWith('RUNTIME_PIN.json')
            ? PIN_JSON
            : path.endsWith('runtime.lock.json')
              ? lock
              : `# anchor comment\n#\n${'f'.repeat(40)}\n`,
    writeText: (path, text) => {
      written[path] = text
    },
    hashFile: () => '0'.repeat(64),
    fetchText: async () => null,
    now: () => 1000,
    log: () => {}
  }

  return { calls, written, deps, index: prefix => calls.findIndex(call => call.key.startsWith(prefix)) }
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
      'GITHUB_TOKEN'
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
    assert.ok(world.index('npm rebuild') < world.index('npm run build'))
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

  it('without the flag: no cms call, no .sig listed for upload', async () => {
    const world = fakeWorld()

    await releaseMac({ team: TEAM, gates: GATES }, world.deps)
    assert.equal(world.index('security cms'), -1)
    assert.ok(!world.written[`${DESKTOP}/release/UPLOAD.txt`].includes(SUMS_SIGNATURE_NAME))
  })

  it('signs the written list in its own unlock window, locks in finally, verifies, then lists the .sig', async () => {
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
    assert.ok(unlocks.at(-1) < at, 'unlocked just before signing')
    assert.ok(world.calls[at + 1].key.startsWith('security lock-keychain'), 'locked right after')

    const verify = world.calls.findIndex(
      c => c.key.startsWith('node') && c.args[0].endsWith('verify-sums-signature.js')
    )

    assert.ok(verify > at + 1)
    assert.ok(world.calls[verify].args.includes(TEAM))
    assert.ok(world.written[`${release}/UPLOAD.txt`].includes(SUMS_SIGNATURE_NAME))
    assert.ok(!world.written[`${release}/SHA256SUMS.txt`].includes(SUMS_SIGNATURE_NAME), 'no self-reference')
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
      cls('Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libEGL.dylib', { fileType: 6 }),
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
