// REL-6 round 2, ruling 33 — the ACP CLI's native add-ons the app ships: staged from the lockfile's exact versions
// (unsigned, marked so), Team-signed by release:mac with the list rewritten to the signed bytes, ignored by the pack's
// own signing pass, and checked inside the packed app. Fakes only: no network, no keychain, no codesign.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { defaultPackages, writeFixturePin } from '../electron/iclone-acp-tools/fixture.ts'

import { checkAcpNative } from './acp-native-check.mjs'
import { signAcpNative } from './sign-acp-native.mjs'
import {
  checkNativeNotices,
  cratePathsIn,
  loadNativeNotices,
  packCrateProblems,
  unlistedCrates
} from './acp-native-notices.mjs'
import { isAcpNative } from './sign-hook.mjs'
import { stageAcpNative } from './stage-acp-native.mjs'

const temps = []

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const sha256 = data => createHash('sha256').update(data).digest('hex')
const TEAM = 'ABCDE12345'

function world() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'acp-native-'))

  temps.push(home)

  const packages = [
    ...defaultPackages().map(pkg =>
      pkg.name === '@virtuals-protocol/acp-cli'
        ? { ...pkg, deps: [...pkg.deps, 'bufferutil', '@napi-rs/keyring'] }
        : pkg
    ),
    {
      name: 'bufferutil',
      version: '4.1.0',
      license: 'MIT',
      files: {
        'package.json': { data: '{}' },
        LICENSE: { data: 'MIT bufferutil' },
        'prebuilds/darwin-arm64/bufferutil.node': { data: 'npm bufferutil arm64' },
        'prebuilds/linux-x64/bufferutil.node': { data: 'npm bufferutil linux' }
      }
    },
    {
      name: '@napi-rs/keyring',
      version: '1.3.0',
      license: 'MIT',
      deps: ['@napi-rs/keyring-darwin-arm64', '@napi-rs/keyring-linux-x64-gnu'],
      files: { 'package.json': { data: '{}' }, 'index.js': { data: 'x' }, LICENSE: { data: 'MIT keyring' } }
    },
    {
      name: '@napi-rs/keyring-darwin-arm64',
      version: '1.3.0',
      license: 'MIT',
      optional: true,
      os: ['darwin'],
      cpu: ['arm64'],
      files: {
        'package.json': { data: '{}' },
        'keyring.darwin-arm64.node': { data: 'npm keyring arm64 /rust/deps/hashbrown-0.16.1/src/raw/mod.rs' }
      }
    },
    {
      name: '@napi-rs/keyring-linux-x64-gnu',
      version: '1.3.0',
      license: 'MIT',
      optional: true,
      os: ['linux'],
      cpu: ['x64'],
      files: { 'package.json': { data: '{}' }, 'keyring.linux-x64-gnu.node': { data: 'linux' } }
    }
  ]

  const pin = writeFixturePin(path.join(home, 'pin'), packages)
  const noticesDir = writeNotices(path.join(home, 'acp-native-notices'))
  const fetched = []
  const fetchTarball = async url => {
    fetched.push(url)

    return pin.tarballs.get(url)
  }

  const stage = (overrides = {}) =>
    stageAcpNative({
      pinDir: pin.pinDir,
      out: path.join(home, 'build', 'acp-native'),
      targetName: 'darwin-arm64',
      fetchTarball,
      noticesDir,
      ...overrides
    })

  return { home, pin, fetched, fetchTarball, noticesDir, stage, out: path.join(home, 'build', 'acp-native') }
}

/** The committed notices of the fixture's two add-ons (acp-native-notices/ shape). */
function writeNotices(dir, texts = { keyring: 'MIT keyring', bufferutil: 'MIT bufferutil' }) {
  mkdirSync(path.join(dir, 'texts'), { recursive: true })
  mkdirSync(path.join(dir, 'crates'), { recursive: true })

  const put = (rel, text) => {
    writeFileSync(path.join(dir, rel), text)

    return sha256(text)
  }

  const notices = {
    v: 1,
    target: 'darwin-arm64',
    addons: [
      {
        key: 'node_modules/@napi-rs/keyring-darwin-arm64',
        package: '@napi-rs/keyring-darwin-arm64',
        version: '1.3.0',
        licence: 'MIT',
        texts: [
          {
            file: 'texts/napi-rs+keyring@1.3.0--LICENSE',
            tarball: 'node_modules/@napi-rs/keyring',
            path: 'LICENSE',
            sha256: put('texts/napi-rs+keyring@1.3.0--LICENSE', texts.keyring)
          }
        ],
        linked: {
          what: 'Rust crates',
          method: 'fixture',
          crates: [
            {
              name: 'hashbrown',
              version: '0.16.1',
              licence: 'MIT OR Apache-2.0',
              usedUnder: 'MIT',
              via: 'the Rust standard library',
              file: 'crates/hashbrown@0.16.1--LICENSE-MIT',
              source: 'the crate source',
              sha256: put('crates/hashbrown@0.16.1--LICENSE-MIT', 'MIT hashbrown')
            },
            {
              name: 'anyhow',
              version: '1.0.0',
              licence: 'MIT OR Apache-2.0',
              usedUnder: 'MIT',
              file: 'crates/anyhow@1.0.0--LICENSE-MIT',
              source: 'the crate source',
              sha256: put('crates/anyhow@1.0.0--LICENSE-MIT', 'MIT anyhow')
            }
          ],
          rust: {
            toolchain: 'rustc x',
            licence: 'MIT OR Apache-2.0',
            usedUnder: 'MIT',
            file: 'crates/rust-std@x--LICENSE-MIT',
            source: 'rust',
            sha256: put('crates/rust-std@x--LICENSE-MIT', 'MIT rust')
          }
        }
      },
      {
        key: 'node_modules/bufferutil',
        package: 'bufferutil',
        version: '4.1.0',
        licence: 'MIT',
        texts: [
          {
            file: 'texts/bufferutil@4.1.0--LICENSE',
            tarball: 'node_modules/bufferutil',
            path: 'LICENSE',
            sha256: put('texts/bufferutil@4.1.0--LICENSE', texts.bufferutil)
          }
        ]
      }
    ]
  }

  writeFileSync(path.join(dir, 'NOTICES.json'), JSON.stringify(notices, null, 2))

  return dir
}

/** A codesign double: "signing" appends a signature blob; -dvv names the team. */
function codesign({ team = TEAM, verify = true } = {}) {
  const calls = []

  return {
    calls,
    run: (command, args) => {
      calls.push([command, ...args])

      if (args[0] === '--force') {
        appendFileSync(args.at(-1), `\nSIGNED-BY-${team}`)

        return { status: 0, stdout: '', stderr: '' }
      }

      if (args[0] === '--verify') {
        return { status: verify ? 0 : 1, stdout: '', stderr: '' }
      }

      return { status: 0, stdout: '', stderr: `Identifier=x\nTeamIdentifier=${team}\n` }
    }
  }
}

describe('stage-acp-native: the add-ons from the lockfile’s exact versions, unsigned and marked so', () => {
  it('stages the target’s .node files under flat names with npm’s and the copy’s sha256', async () => {
    const w = world()
    const list = await w.stage()

    expect(list.signed).toBe(false)
    expect(list.team).toBeNull()
    expect(list.lockSha256).toBe(sha256(w.pin.lockText))
    expect(list.addons.map(entry => entry.file).sort()).toEqual([
      'node_modules/@napi-rs/keyring-darwin-arm64/keyring.darwin-arm64.node',
      'node_modules/bufferutil/prebuilds/darwin-arm64/bufferutil.node'
    ])

    for (const entry of list.addons) {
      const bytes = readFileSync(path.join(w.out, 'darwin-arm64', entry.blob))

      expect(entry.npmSha256).toBe(sha256(bytes))
      expect(entry.sha256).toBe(entry.npmSha256)
    }

    // Only the add-on packages (and the keyring wrapper, for its LICENSE) are fetched; linux's keyring never.
    expect(w.fetched.every(url => /bufferutil|keyring-darwin-arm64|@napi-rs\/keyring\/-\//.test(url))).toBe(true)
  })

  it('critic r2 M3: ships each add-on’s licence texts beside it, re-read from the pinned tarballs, named in the list', async () => {
    const w = world()
    const list = await w.stage()
    const dir = path.join(w.out, 'darwin-arm64')

    expect(list.notices.map(n => n.file).sort()).toEqual([
      'licences/anyhow@1.0.0--LICENSE-MIT',
      'licences/bufferutil@4.1.0--LICENSE',
      'licences/hashbrown@0.16.1--LICENSE-MIT',
      'licences/napi-rs+keyring@1.3.0--LICENSE',
      'licences/rust-std@x--LICENSE-MIT'
    ])
    expect(list.addons.find(a => a.package === 'bufferutil').licences).toEqual(['bufferutil@4.1.0--LICENSE'])
    expect(list.addons.find(a => a.package === '@napi-rs/keyring-darwin-arm64').licences).toHaveLength(4)
    expect(readFileSync(path.join(dir, 'licences', 'bufferutil@4.1.0--LICENSE'), 'utf8')).toBe('MIT bufferutil')
    // The keyring binding's text comes from its wrapper package's tarball (the binding ships none): fetched too.
    expect(w.fetched.some(url => url.includes('/@napi-rs/keyring/-/'))).toBe(true)
  })

  it('a committed text that is not the tarball’s bytes, or an add-on without a notice, stops the build', async () => {
    const a = world()

    writeNotices(a.noticesDir, { keyring: 'MIT keyring', bufferutil: 'MIT bufferutil, edited' })
    await expect(a.stage()).rejects.toThrow(/LICENSE in node_modules\/bufferutil is not the pinned/)

    const b = world()
    const notices = JSON.parse(readFileSync(path.join(b.noticesDir, 'NOTICES.json'), 'utf8'))

    notices.addons = notices.addons.filter(addon => addon.package !== 'bufferutil')
    writeFileSync(path.join(b.noticesDir, 'NOTICES.json'), JSON.stringify(notices))
    await expect(b.stage()).rejects.toThrow(/bufferutil@4\.1\.0: no licence notice/)
  })

  it('refuses a tarball that is not the lockfile’s sha512', async () => {
    const w = world()

    await expect(
      w.stage({ fetchTarball: async url => Buffer.concat([w.pin.tarballs.get(url), Buffer.from([0])]) })
    ).rejects.toThrow(/does not match the lockfile's sha512/)
  })

  it('keeps an up-to-date list (signed or not) without fetching; other platforms ship none', async () => {
    const w = world()

    await w.stage()
    signAcpNative({
      dir: path.join(w.out, 'darwin-arm64'),
      identity: 'A'.repeat(40),
      keychain: '/kc',
      team: TEAM,
      run: codesign().run
    })

    const again = await w.stage({ fetchTarball: () => Promise.reject(new Error('no network')) })

    expect(again.signed).toBe(true)
    expect(await w.stage({ targetName: 'linux-x64' })).toBeNull()
  })
})

describe('sign-acp-native: Team-signed in release:mac, the list rewritten to the signed bytes', () => {
  it('signs each copy with the hardened runtime and a timestamp, verifies the team, and re-lists', async () => {
    const w = world()

    await w.stage()

    const cs = codesign()
    const dir = path.join(w.out, 'darwin-arm64')
    const signed = signAcpNative({ dir, identity: 'A'.repeat(40), keychain: '/kc', team: TEAM, run: cs.run })

    expect(signed).toMatchObject({ signed: true, team: TEAM })

    for (const entry of signed.addons) {
      const bytes = readFileSync(path.join(dir, entry.blob))

      expect(bytes.toString()).toMatch(new RegExp(`SIGNED-BY-${TEAM}$`))
      expect(entry.sha256).toBe(sha256(bytes))
      expect(entry.sha256).not.toBe(entry.npmSha256)
    }

    expect(
      cs.calls
        .filter(call => call[1] === '--force')
        .every(call => call.includes('runtime') && call.includes('--timestamp'))
    ).toBe(true)
  })

  it('a copy that does not verify, or another team, stops the release', async () => {
    for (const cs of [codesign({ verify: false }), codesign({ team: 'ZZZZZ99999' })]) {
      const w = world()

      await w.stage()
      expect(() =>
        signAcpNative({
          dir: path.join(w.out, 'darwin-arm64'),
          identity: 'A'.repeat(40),
          keychain: '/kc',
          team: TEAM,
          run: cs.run
        })
      ).toThrow(/does not verify|is not signed by team/)
    }
  })
})

describe('the pack: osx-sign leaves the add-ons alone; the packed app is checked', () => {
  it('sign-hook ignores exactly Resources/acp-native', () => {
    const app = '/R/iclone os.app'

    expect(
      isAcpNative(app, `${app}/Contents/Resources/acp-native/darwin-arm64/bufferutil@4.1.0--bufferutil.node`)
    ).toBe(true)
    expect(isAcpNative(app, `${app}/Contents/Resources/acp-pin/launch.cjs`)).toBe(false)
    expect(isAcpNative(app, `${app}/Contents/Resources/app.asar.unpacked/node_modules/x.node`)).toBe(false)
  })

  async function packed(sign = false) {
    const w = world()

    await w.stage()

    if (sign) {
      signAcpNative({
        dir: path.join(w.out, 'darwin-arm64'),
        identity: 'A'.repeat(40),
        keychain: '/kc',
        team: TEAM,
        run: codesign().run
      })
    }

    const app = path.join(w.home, 'iclone os.app')
    const resources = path.join(app, 'Contents', 'Resources')

    mkdirSync(path.join(resources, 'acp-pin'), { recursive: true })
    cpSync(path.join(w.pin.pinDir, 'package.json'), path.join(resources, 'acp-pin', 'package.json'))
    cpSync(path.join(w.pin.pinDir, 'package-lock.json'), path.join(resources, 'acp-pin', 'package-lock.json'))
    cpSync(w.out, path.join(resources, 'acp-native'), { recursive: true })

    return { app, dir: path.join(resources, 'acp-native', 'darwin-arm64') }
  }

  it('an unsigned --dir pack carries the add-ons with the unsigned marker', async () => {
    const { app } = await packed()

    expect(checkAcpNative(app, { signed: false })).toMatchObject({
      target: 'darwin-arm64',
      signed: false,
      files: 2,
      problems: []
    })
    expect(checkAcpNative(app, { signed: true, team: TEAM, run: codesign().run }).problems).toContainEqual(
      expect.stringMatching(/not marked Team-signed/)
    )
  })

  it('the command line reads the app path wherever --unsigned stands (the gate’s call)', async () => {
    const { app } = await packed()
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'acp-native-check.mjs')

    for (const args of [
      [app, '--unsigned'],
      ['--unsigned', app]
    ]) {
      const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })

      expect(result.status, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({ signed: false, files: 2, problems: [] })
    }
  })

  it('critic r2 M3 negative control: one licence file removed from the pack is red', async () => {
    const { app, dir } = await packed()

    expect(checkAcpNative(app, { signed: false }).notices).toBe(5)
    rmSync(path.join(dir, 'licences', 'bufferutil@4.1.0--LICENSE'))
    expect(checkAcpNative(app, { signed: false }).problems).toContainEqual(
      'licences/bufferutil@4.1.0--LICENSE is missing (a licence notice the list names)'
    )
  })

  it('a signed pack passes --signed; a changed copy or a missing listing fails', async () => {
    const { app, dir } = await packed(true)

    expect(checkAcpNative(app, { signed: true, team: TEAM, run: codesign().run }).problems).toEqual([])

    const list = JSON.parse(readFileSync(path.join(dir, 'ADDONS.json'), 'utf8'))

    appendFileSync(path.join(dir, list.addons[0].blob), 'x')
    list.addons = list.addons.slice(1)
    writeFileSync(path.join(dir, 'ADDONS.json'), JSON.stringify(list))

    expect(checkAcpNative(app, { signed: true, team: TEAM, run: codesign().run }).problems).toEqual(
      expect.arrayContaining([expect.stringMatching(/no add-on listed for/)])
    )
  })
})

describe('acp-native-notices: the committed notices are complete and pinned (critic r2 M3)', () => {
  const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

  function copy() {
    const home = mkdtempSync(path.join(os.tmpdir(), 'acp-native-notices-'))

    temps.push(home)
    cpSync(path.join(desktop, 'acp-native-notices'), path.join(home, 'acp-native-notices'), { recursive: true })
    cpSync(path.join(desktop, 'acp-cli-lock'), path.join(home, 'acp-cli-lock'), { recursive: true })

    return home
  }

  it('the repository’s notices cover every add-on of the pinned closure, every text pinned', () => {
    expect(checkNativeNotices({ desktopDir: desktop })).toEqual([])
  })

  it('negative controls: a LICENSE removed, a text changed, an unlisted file, an add-on dropped', () => {
    const removed = copy()

    rmSync(path.join(removed, 'acp-native-notices', 'texts', 'bufferutil@4.1.0--LICENSE'))
    expect(checkNativeNotices({ desktopDir: removed })).toContainEqual(
      'acp-native: texts/bufferutil@4.1.0--LICENSE is missing'
    )

    const changed = copy()

    appendFileSync(path.join(changed, 'acp-native-notices', 'crates', 'anyhow@1.0.102--LICENSE-MIT'), ' ')
    expect(checkNativeNotices({ desktopDir: changed })).toContainEqual(
      'acp-native: crates/anyhow@1.0.102--LICENSE-MIT is not the pinned text (sha256)'
    )

    const extra = copy()

    writeFileSync(path.join(extra, 'acp-native-notices', 'texts', 'stray'), 'x')
    expect(checkNativeNotices({ desktopDir: extra })).toContainEqual(
      'acp-native: texts/stray is not listed in NOTICES.json'
    )

    const dropped = copy()
    const file = path.join(dropped, 'acp-native-notices', 'NOTICES.json')
    const notices = JSON.parse(readFileSync(file, 'utf8'))

    notices.addons = notices.addons.filter(addon => addon.version !== '5.0.10')
    writeFileSync(file, JSON.stringify(notices))
    expect(checkNativeNotices({ desktopDir: dropped })).toContainEqual(
      'acp-native: utf-8-validate@5.0.10 (node_modules/websocket/node_modules/utf-8-validate) ships with no licence notice'
    )
  })
})

describe('critic r3 M4: every Rust crate a shipped binary names is on its notices list', () => {
  it('reads std’s /rust/deps/ paths and cargo registry paths, name and version, hyphens and pre-releases included', () => {
    const binary = Buffer.from(
      [
        'x\0/rust/deps/hashbrown-0.16.1/src/raw/mod.rs\0',
        '/rustc/59807616e1fa2540724bfbac14d7976d7e4a3860/library/core/src/x.rs\0',
        '/Users/runner/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/apple-native-keyring-store-1.0.0/src/lib.rs\0',
        '/home/u/.cargo/registry/src/github.com-1ecc6299db9ec823/foo-bar-0.1.0-alpha.1/src/a.rs\0',
        '/rust/deps/rustc-demangle-0.1.27/src/v0.rs'
      ].join('')
    )

    expect(cratePathsIn(binary)).toEqual([
      'apple-native-keyring-store@1.0.0',
      'foo-bar@0.1.0-alpha.1',
      'hashbrown@0.16.1',
      'rustc-demangle@0.1.27'
    ])
  })

  it('a binary naming a crate its notices drop stops the build (negative control)', async () => {
    const w = world()
    const file = path.join(w.noticesDir, 'NOTICES.json')
    const notices = JSON.parse(readFileSync(file, 'utf8'))

    notices.addons[0].linked.crates = notices.addons[0].linked.crates.filter(c => c.name !== 'hashbrown')
    writeFileSync(file, JSON.stringify(notices))
    rmSync(path.join(w.noticesDir, 'crates', 'hashbrown@0.16.1--LICENSE-MIT'))

    await expect(w.stage()).rejects.toThrow(/names crate\(s\) its notices do not list: hashbrown@0\.16\.1/)
  })

  it('in a pack: every listed crate passes; one entry dropped is red (negative control)', async () => {
    const w = world()

    await w.stage()

    const app = path.join(w.home, 'iclone os.app')

    cpSync(w.out, path.join(app, 'Contents', 'Resources', 'acp-native'), { recursive: true })

    const notices = loadNativeNotices(path.dirname(w.noticesDir))

    expect(packCrateProblems(app, notices)).toEqual({ problems: [], checked: 2 })

    notices.addons[0].linked.crates = notices.addons[0].linked.crates.filter(c => c.name !== 'hashbrown')
    expect(packCrateProblems(app, notices).problems).toEqual([
      '@napi-rs/keyring-darwin-arm64@1.3.0: the binary names crate hashbrown@0.16.1, which its notices do not list'
    ])
  })

  it('a listed crate name with another version is not covered (critic r4 G5)', () => {
    const addon = { linked: { crates: [{ name: 'hashbrown', version: '0.16.0' }] } }
    const binary = Buffer.from('/rust/deps/hashbrown-0.16.1/src/raw/mod.rs')

    expect(unlistedCrates(addon, binary)).toEqual(['hashbrown@0.16.1'])
    expect(unlistedCrates({ linked: { crates: [{ name: 'hashbrown', version: '0.16.1' }] } }, binary)).toEqual([])
  })

  it('a pack with no add-on binary is red, never a vacuous pass (critic r4 G3)', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'acp-native-empty-'))

    temps.push(home)
    mkdirSync(path.join(home, 'iclone os.app', 'Contents', 'Resources'), { recursive: true })

    expect(packCrateProblems(path.join(home, 'iclone os.app'), { addons: [] })).toEqual({
      problems: ['no add-on binary found under Resources/acp-native (the check would pass vacuously)'],
      checked: 0
    })
  })

  it('the repository’s notices list std’s crates.io dependencies on aarch64-apple-darwin', () => {
    const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const keyring = loadNativeNotices(desktop).addons.find(a => a.linked)
    const ids = keyring.linked.crates.filter(c => c.via).map(c => `${c.name}@${c.version}`)

    expect(ids.sort()).toEqual([
      'addr2line@0.25.1',
      'adler2@2.0.1',
      'cfg-if@1.0.4',
      'gimli@0.32.3',
      'hashbrown@0.16.1',
      'libc@0.2.178',
      'memchr@2.7.6',
      'miniz_oxide@0.8.9',
      'object@0.37.3',
      'rustc-demangle@0.1.27'
    ])
  })
})
