// REL-6 — the ACP tools installer against a fake registry (fixture.ts): no network, a temp userData per case.
import {
  appendFileSync,
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { ACP_CLI_NAME } from '../../src/iclone-shared/acp-pin'

import { AcpToolsError } from './errors'
import {
  defaultPackages,
  type FixturePackage,
  type FixtureRegistry,
  memoryRecord,
  memorySealer,
  writeAddonDir,
  writeFixturePin
} from './fixture'
import { type AcpToolsAudit, createAcpTools, type InstallAnswer, NOTICES_FILE, sameTree } from './installer'
import { KEY_FILE, MANIFEST_FILE, sha256Hex, treeDigest } from './manifest'
import { type NativeAddons, nativeAddonsFor } from './native'

const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) {
    try {
      chmodSync(dir, 0o700)
    } catch {
      // already gone
    }

    rmSync(dir, { recursive: true, force: true })
  }
})

const MAC = { platform: 'darwin', arch: 'arm64' }

interface LabOptions {
  packages?: FixturePackage[]
  sealer?: typeof memorySealer | null
  noSealReason?: 'keychain-off' | 'unsealable'
  /** V3-FX M1: a sealer read live on every check (the Keychain setting toggled while the app runs). */
  live?: { on: boolean }
  native?: NativeAddons
  fetch?: (url: string, signal: AbortSignal) => Promise<Buffer>
}

function lab(options: LabOptions = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'iclone-acp-tools-'))

  temps.push(home)

  const registry = writeFixturePin(path.join(home, 'pin'), options.packages)
  const fetched: string[] = []
  const audit: AcpToolsAudit[] = []
  const record = memoryRecord()
  let gate: Promise<void> | null = null
  let onFetch: ((url: string) => Promise<void> | void) | null = null

  // V3-FX M1: a live sealer is a getter on the deps object, read on every check (as iclone-acp.ts passes it).
  const live = <T extends object>(deps: T): T => {
    const switchOf = options.live

    return switchOf
      ? Object.defineProperties(deps, {
          sealer: { get: () => (switchOf.on ? memorySealer : null) },
          noSealReason: { get: () => (switchOf.on ? 'unsealable' : 'keychain-off') }
        })
      : deps
  }

  const make = (reg: FixtureRegistry = registry, overrides: Partial<LabOptions> = {}) =>
    createAcpTools(
      live({
        root: path.join(home, 'userData', 'acp-cli'),
        pinDir: reg.pinDir,
        launcher: reg.launcher,
        target: MAC,
        fetch:
          overrides.fetch ??
          options.fetch ??
          (async (url, signal) => {
            fetched.push(url)

            if (gate) {
              await gate
            }

            await onFetch?.(url)

            if (signal.aborted) {
              throw new Error('aborted')
            }

            const tgz = reg.tarballs.get(url)

            if (!tgz) {
              throw new Error(`404 ${url}`)
            }

            return tgz
          }),
        sealer:
          'sealer' in overrides
            ? (overrides.sealer ?? null)
            : options.sealer === undefined
              ? memorySealer
              : options.sealer,
        noSealReason: options.noSealReason,
        record,
        native: overrides.native ?? options.native ?? { dir: null, required: false },
        audit: entry => audit.push(entry),
        log: () => undefined
      })
    )

  return {
    home,
    root: path.join(home, 'userData', 'acp-cli'),
    userData: path.join(home, 'userData'),
    registry,
    fetched,
    audit,
    record,
    make,
    onFetch: (fn: (url: string) => Promise<void> | void) => {
      onFetch = fn
    },
    hold: () => {
      let release = () => undefined as void

      gate = new Promise<void>(resolve => {
        release = resolve
      })

      return () => {
        gate = null
        release()
      }
    }
  }
}

const treeOf = (root: string, lockText: string) => path.join(root, sha256Hex(lockText))

const cliFile = (tree: string, rel: string) =>
  path.join(tree, 'runtime', 'node_modules', ...ACP_CLI_NAME.split('/'), rel)

const refusals = (audit: AcpToolsAudit[]) => audit.filter(entry => entry.kind === 'refuse').map(entry => entry.reason)

const failure = (answer: InstallAnswer) => (answer.ok || answer.cancelled === true ? null : answer)

describe('install — npm ci --ignore-scripts from the pin, without npm', () => {
  it('starts absent, installs the closure for this platform only, verifies, and leaves no temp dir', async () => {
    const t = lab()
    const tools = t.make()

    expect((await tools.refresh()).state).toBe('absent')

    const answer = await tools.install()

    expect(answer.ok).toBe(true)
    expect(tools.view()).toMatchObject({ state: 'installed', cliVersion: '1.0.38', packages: 2 })
    // The linux-only optional package is never fetched.
    expect(t.fetched.map(url => url.split('/-/')[1]).sort()).toEqual(['acp-cli-1.0.38.tgz', 'dep-a-2.0.0.tgz'])
    expect(t.fetched.every(url => url.startsWith('https://registry.npmjs.org/'))).toBe(true)
    expect(readdirSync(t.root).filter(name => name.startsWith('.'))).toEqual([])

    const tree = treeOf(t.root, t.registry.lockText)
    const dep = path.join(tree, 'runtime', 'node_modules', 'dep-a')

    expect(existsSync(path.join(dep, 'index.js'))).toBe(true)
    expect(existsSync(path.join(dep, 'README.md'))).toBe(false)
    expect(existsSync(path.join(dep, 'test'))).toBe(false)
    expect(existsSync(path.join(dep, 'prebuilds', 'darwin-arm64', 'a.node'))).toBe(true)
    expect(existsSync(path.join(dep, 'prebuilds', 'linux-x64'))).toBe(false)
    expect(existsSync(cliFile(tree, 'README.md'))).toBe(true)
    expect(existsSync(cliFile(tree, 'dist/bin/acp.js.map'))).toBe(false)
    expect(existsSync(cliFile(tree, 'bin/acp-cli-signer-linux'))).toBe(false)
    // The Go signer is made executable explicitly, whatever the tarball said.
    expect(statSync(cliFile(tree, 'bin/acp-cli-signer-macos')).mode & 0o777).toBe(0o755)

    const notices = readFileSync(path.join(tree, NOTICES_FILE), 'utf8')

    expect(notices).toMatch(/dep-a 2\.0\.0 — MIT[\s\S]*MIT License — dep-a/)
    // Ruling 34: the in-app notices say what the signer is and that it runs without quarantine.
    expect(notices).toMatch(
      /Go signer `bin\/acp-cli-signer-macos` is a program published inside[\s\S]*without the macOS quarantine flag/
    )

    const runtime = await tools.runtime()

    expect(runtime.ok && runtime.rt.entry).toBe(cliFile(tree, 'dist/bin/acp.js'))
    expect(runtime.ok && runtime.rt.launcher).toBe(t.registry.launcher)
    expect(runtime.ok && runtime.rt.treeSha256).toMatch(/^[0-9a-f]{64}$/)
    // The record of the install is in the protected state, and names this tree.
    expect(t.record.read()).toMatchObject({ lockSha256: sha256Hex(t.registry.lockText) })
  })

  it('refuses a tarball whose bytes are not the lockfile’s sha512, and leaves nothing behind', async () => {
    const t = lab()

    const evil = writeFixturePin(path.join(t.home, 'evil'), defaultPackages(), (url, tgz) =>
      url.includes('dep-a') ? Buffer.concat([tgz, Buffer.from([0])]) : tgz
    )

    const tools = t.make(evil)
    const answer = await tools.install()

    expect(failure(answer)).toEqual({ ok: false, reason: 'integrity', subject: 'dep-a@2.0.0' })
    expect(readdirSync(t.root).filter(name => name !== KEY_FILE)).toEqual([])
    expect(tools.view()).toMatchObject({ state: 'absent', lastError: { reason: 'integrity', subject: 'dep-a@2.0.0' } })
    expect(t.audit.at(-1)).toMatchObject({ kind: 'refuse', reason: expect.stringMatching(/install failed: integrity/) })
  })

  it('refuses a package that carries its own node_modules (critic survivor C5)', async () => {
    const packages = defaultPackages().map(pkg =>
      pkg.name === 'dep-a' ? { ...pkg, files: { ...pkg.files, 'node_modules/sneaky/index.js': { data: 'x' } } } : pkg
    )

    const t = lab({ packages })
    const answer = await t.make().install()

    expect(failure(answer)).toMatchObject({ reason: 'nested-modules', subject: 'dep-a@2.0.0' })
    expect(existsSync(treeOf(t.root, t.registry.lockText))).toBe(false)
  })

  it('a case variant (Node_Modules) is refused too: APFS would resolve it as node_modules (critic r2 D11)', async () => {
    const packages = defaultPackages().map(pkg =>
      pkg.name === 'dep-a' ? { ...pkg, files: { ...pkg.files, 'Node_Modules/sneaky/index.js': { data: 'x' } } } : pkg
    )

    const t = lab({ packages })

    expect(failure(await t.make().install())).toMatchObject({ reason: 'nested-modules', subject: 'dep-a@2.0.0' })
  })

  it('cancels: nothing installed, no partial tree, the state goes back', async () => {
    const t = lab()
    const tools = t.make()
    const release = t.hold()
    const running = tools.install()

    expect(tools.view().state).toBe('installing')
    expect(tools.install()).toBe(running)
    expect(tools.cancel()).toBe(true)
    release()

    expect(await running).toEqual({ ok: false, cancelled: true })
    expect(readdirSync(t.root).filter(name => name !== KEY_FILE)).toEqual([])
    expect(tools.view().state).toBe('absent')
  })

  it('refuses every spawn while installing', async () => {
    const t = lab()
    const tools = t.make()
    const release = t.hold()
    const running = tools.install()

    expect(await tools.runtime()).toMatchObject({ ok: false, code: 'installing' })
    release()
    await running
    expect((await tools.runtime()).ok).toBe(true)
  })

  it('a stalled download fails the install with its own reason (critic m6), and nothing is left', async () => {
    const t = lab({
      fetch: async url => {
        throw new AcpToolsError('download-stalled', url.split('/-/')[1]?.replace(/\.tgz$/, ''))
      }
    })

    const tools = t.make()
    const answer = await tools.install()

    expect(failure(answer)).toMatchObject({ reason: 'download-stalled' })
    expect(tools.view()).toMatchObject({ state: 'absent', lastError: { reason: 'download-stalled' } })
    expect(readdirSync(t.root).filter(name => name !== KEY_FILE)).toEqual([])
  })

  it('a check already running before the rename never decides the install’s answer (critic m5)', async () => {
    const t = lab()

    expect((await t.make().install()).ok).toBe(true)

    // The old tree no longer verifies, and a check of it is held in flight across the whole reinstall.
    appendFileSync(path.join(treeOf(t.root, t.registry.lockText), NOTICES_FILE), 'x')

    let release = () => undefined as void
    let held = false

    const hold = new Promise<void>(resolve => {
      release = resolve
    })

    const tools = createAcpTools({
      root: t.root,
      pinDir: t.registry.pinDir,
      launcher: t.registry.launcher,
      target: MAC,
      fetch: async url => t.registry.tarballs.get(url) as Buffer,
      sealer: memorySealer,
      record: t.record,
      native: { dir: null, required: false },
      log: () => undefined,
      beforeCheck: () => {
        if (held) {
          return Promise.resolve()
        }

        held = true

        return hold
      }
    })

    const stale = tools.refresh()

    const answer = await Promise.race([
      tools.install(),
      new Promise(resolve => setTimeout(() => resolve('the install waited on the stale check'), 3_000))
    ])

    expect(answer).toMatchObject({ ok: true, view: { state: 'installed' } })
    release()
    await stale
    // Whatever the stale check finds, it never sets the view or the spawn path.
    expect(tools.view().state).toBe('installed')
    expect((await tools.runtime()).ok).toBe(true)
  })
})

describe('sealed or nothing (critic M2, lead ruling on m7)', () => {
  async function installed(options?: LabOptions) {
    const t = lab(options)
    const tools = t.make()

    expect((await tools.install()).ok).toBe(true)

    return { t, tools, tree: treeOf(t.root, t.registry.lockText) }
  }

  /** The critic's forgery: acp.js changed, its entry and the tree digest recomputed, the MAC dropped. */
  function forge(tree: string) {
    const file = cliFile(tree, 'dist/bin/acp.js')
    const rel = path.relative(tree, file).split(path.sep).join('/')
    const manifest = JSON.parse(readFileSync(path.join(tree, MANIFEST_FILE), 'utf8'))

    appendFileSync(file, ';evil()')

    const data = readFileSync(file)

    manifest.files[rel] = { ...manifest.files[rel], sha256: sha256Hex(data), size: data.length }
    manifest.treeSha256 = treeDigest(manifest.files)
    manifest.mac = null
    writeFileSync(path.join(tree, MANIFEST_FILE), JSON.stringify(manifest))
  }

  it('a forged, unsigned manifest is refused with the key in place', async () => {
    const { t, tree } = await installed()

    forge(tree)
    expect(await t.make().runtime()).toMatchObject({ ok: false, code: 'unverified', reason: 'manifest-signature' })
    expect(refusals(t.audit)).toContainEqual(expect.stringMatching(/manifest-signature/))
  })

  it('the key file replaced by an empty folder: refused (key-unopenable) and audited, never run unsigned', async () => {
    const { t, tree } = await installed()

    forge(tree)
    rmSync(path.join(t.root, KEY_FILE))
    mkdirSync(path.join(t.root, KEY_FILE))

    const tools = t.make()

    expect(await tools.refresh()).toMatchObject({ state: 'unverified', reason: 'key-unopenable' })
    expect(await tools.runtime()).toMatchObject({ ok: false, code: 'unverified', reason: 'key-unopenable' })
    expect(refusals(t.audit)).toContainEqual(expect.stringMatching(/key-unopenable/))
  })

  it('the key file deleted and acp-cli/ made read-only: refused and audited', async () => {
    const { t, tree } = await installed()

    forge(tree)
    rmSync(path.join(t.root, KEY_FILE))
    chmodSync(t.root, 0o500)

    try {
      const tools = t.make()

      expect(await tools.refresh()).toMatchObject({ state: 'unverified', reason: 'key-unopenable' })
      expect((await tools.runtime()).ok).toBe(false)
      expect(refusals(t.audit)).toContainEqual(expect.stringMatching(/key-unopenable/))
    } finally {
      chmodSync(t.root, 0o700)
    }
  })

  it('a check never writes a key: the key file deleted ⇒ refused, and no new key appears', async () => {
    const { t } = await installed()

    rmSync(path.join(t.root, KEY_FILE))
    expect(await t.make().refresh()).toMatchObject({ state: 'unverified', reason: 'key-unopenable' })
    expect(existsSync(path.join(t.root, KEY_FILE))).toBe(false)
  })

  it('an OS or session that cannot seal: unavailable, and the install is refused before any fetch, audited', async () => {
    const t = lab({ sealer: null })
    const tools = t.make()

    expect(await tools.refresh()).toMatchObject({ state: 'unavailable', reason: 'unsealable' })

    const answer = await tools.install()

    expect(failure(answer)).toEqual({ ok: false, reason: 'unsealable' })
    expect(t.fetched).toEqual([])
    expect(refusals(t.audit)).toContainEqual(expect.stringMatching(/install failed: unsealable/))
  })

  it('FX-2 r1b: no seal because the Keychain setting is off says so (the pane names the fix), and still refuses', async () => {
    const t = lab({ sealer: null, noSealReason: 'keychain-off' })
    const tools = t.make()

    expect(await tools.refresh()).toMatchObject({ state: 'unavailable', reason: 'keychain-off' })
    expect((await tools.install()).ok).toBe(false)
    expect(t.fetched).toEqual([])
  })

  it('V3-FX M1: the Keychain setting toggled while the app runs takes effect at the next check, both ways', async () => {
    const live = { on: false }
    const t = lab({ live })
    const tools = t.make()

    expect(await tools.refresh()).toMatchObject({ state: 'unavailable', reason: 'keychain-off' })
    live.on = true
    expect(await tools.refresh()).toMatchObject({ state: 'absent' })
    expect((await tools.install()).ok).toBe(true)
    expect(await tools.refresh()).toMatchObject({ state: 'installed' })
    live.on = false
    expect(await tools.refresh()).toMatchObject({ state: 'unavailable', reason: 'keychain-off' })
    expect((await tools.runtime()).ok).toBe(false)
    live.on = true
    expect(await tools.refresh()).toMatchObject({ state: 'installed' })
  })

  it('a sealed tree read by a run without the OS key is refused, never "installed"', async () => {
    const { t } = await installed()

    expect(await t.make(t.registry, { sealer: null }).refresh()).toMatchObject({
      state: 'unavailable',
      reason: 'unsealable'
    })
  })

  it('a reinstall replaces a key that no longer opens (the owner’s click is the only key writer)', async () => {
    const { t } = await installed()

    writeFileSync(path.join(t.root, KEY_FILE), 'garbage')

    const tools = t.make()

    expect(await tools.refresh()).toMatchObject({ state: 'unverified', reason: 'key-unopenable' })
    expect((await tools.install()).ok).toBe(true)
    expect((await tools.runtime()).ok).toBe(true)
  })

  it('an OS seal that does not read back the key it sealed refuses the install (critic r2 D5)', async () => {
    let n = 0

    const lying = {
      seal: (plain: string) => memorySealer.seal(plain),
      // Every read returns a valid, but different, key.
      unseal: () => (n++).toString(16).padStart(64, '0')
    }

    const t = lab({ sealer: lying })
    const answer = await t.make().install()

    expect(failure(answer)).toEqual({ ok: false, reason: 'unsealable' })
    expect(t.fetched).toEqual([])
  })

  it('a tree this app has no record of installing is refused (the record lives in V3-F’s protected state)', async () => {
    const { t } = await installed()

    t.record.clear()
    expect(await t.make().runtime()).toMatchObject({ ok: false, reason: 'not-recorded' })
  })
})

describe('verify before every spawn — tamper ⇒ refused', () => {
  async function installed(options?: LabOptions) {
    const t = lab(options)
    const tools = t.make()

    expect((await tools.install()).ok).toBe(true)

    return { t, tools, tree: treeOf(t.root, t.registry.lockText) }
  }

  it('one changed byte in one file is refused, audited once, and named', async () => {
    const { t, tools, tree } = await installed()

    appendFileSync(cliFile(tree, 'dist/bin/acp.js'), ';evil()')

    const first = await tools.runtime()
    const second = await tools.runtime()

    expect(first).toMatchObject({ ok: false, code: 'unverified', reason: 'file-changed' })
    expect(!first.ok && first.error).toMatch(/^\[acp-tools:unverified:file-changed\]/)
    expect(second.ok).toBe(false)
    expect(refusals(t.audit).filter(reason => /file-changed/.test(reason))).toHaveLength(1)
    expect(tools.view()).toMatchObject({
      state: 'unverified',
      reason: 'file-changed',
      subject: 'runtime/node_modules/@virtuals-protocol/acp-cli/dist/bin/acp.js'
    })
  })

  it('a same-size edit with the times put back is still refused: the quick check reads ctime (critic C14)', async () => {
    const { tools, tree } = await installed()
    const file = cliFile(tree, 'dist/bin/acp.js')
    const text = readFileSync(file, 'utf8')
    const at = 1_700_000_000

    // A whole-second mtime the edit can put back exactly; the snapshot is taken with it.
    utimesSync(file, at, at)
    expect((await tools.runtime()).ok).toBe(true)

    const before = statSync(file, { bigint: true })

    writeFileSync(file, text.replace('acp', 'xyz'))
    utimesSync(file, at, at)

    const after = statSync(file, { bigint: true })

    expect(after.size).toBe(before.size)
    expect(after.mtimeNs).toBe(before.mtimeNs)
    expect(after.ino).toBe(before.ino)
    expect(await tools.runtime()).toMatchObject({ ok: false, reason: 'file-changed' })
  })

  it('an added file is refused (Node would load foo.js before foo/index.js)', async () => {
    const { tools, tree } = await installed()

    writeFileSync(path.join(tree, 'runtime', 'node_modules', 'dep-a', 'index.mjs'), 'evil')

    expect(await tools.runtime()).toMatchObject({
      ok: false,
      reason: 'extra-file',
      error: expect.stringMatching(/extra-file: runtime\/node_modules\/dep-a\/index\.mjs/)
    })
  })

  it('a removed file and a lost exec bit are refused', async () => {
    const a = await installed()

    rmSync(path.join(a.tree, 'runtime', 'node_modules', 'dep-a', 'index.js'))
    expect(await a.tools.runtime()).toMatchObject({ ok: false, reason: 'missing-file' })

    const b = await installed()

    chmodSync(cliFile(b.tree, 'bin/acp-cli-signer-macos'), 0o644)
    expect(await b.tools.runtime()).toMatchObject({ ok: false, reason: 'mode-changed' })
  })

  it('a file and its manifest entry rewritten together fail the sealed signature', async () => {
    const { tools, tree } = await installed()
    const file = cliFile(tree, 'dist/bin/acp.js')
    const rel = path.relative(tree, file).split(path.sep).join('/')
    const manifest = JSON.parse(readFileSync(path.join(tree, MANIFEST_FILE), 'utf8'))

    writeFileSync(file, 'evil()')
    manifest.files[rel] = { ...manifest.files[rel], sha256: sha256Hex('evil()'), size: 6 }
    manifest.treeSha256 = treeDigest(manifest.files)
    writeFileSync(path.join(tree, MANIFEST_FILE), JSON.stringify(manifest))

    expect(await tools.runtime()).toMatchObject({ ok: false, reason: 'manifest-signature' })
  })

  it('a touch that keeps the bytes costs a full check, then passes', async () => {
    const { tools, tree } = await installed()
    const file = cliFile(tree, 'dist/bin/acp.js')
    const later = new Date(Date.now() + 60_000)

    utimesSync(file, later, later)
    expect((await tools.runtime()).ok).toBe(true)
  })

  it('a new process (a new installer) re-verifies from disk before trusting the tree', async () => {
    const { t, tree } = await installed()

    appendFileSync(path.join(tree, NOTICES_FILE), 'x')
    expect(await t.make().runtime()).toMatchObject({ ok: false, code: 'unverified' })
  })

  it('M1: a package planted beside the tree is refused and audited (never loaded; the tree stays usable)', async () => {
    const { t } = await installed()
    const planted = path.join(t.root, 'node_modules', '@napi-rs', 'keyring-darwin-universal')

    mkdirSync(planted, { recursive: true })
    writeFileSync(path.join(planted, 'index.js'), "throw new Error('PLANTED')")
    mkdirSync(path.join(t.userData, 'node_modules'))

    const tools = t.make()

    expect((await tools.runtime()).ok).toBe(true)
    expect(refusals(t.audit)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/refused acp-cli\/node_modules beside the verified tree/),
        expect.stringMatching(/refused node_modules beside the verified tree/)
      ])
    )
    // The planted package is still there: the app never deletes what it did not create.
    expect(existsSync(planted)).toBe(true)
  })

  it('the launcher’s reports reach the audit; a load-time mismatch forces a full check', async () => {
    const { t, tools, tree } = await installed()

    tools.launcherReport({ type: 'escape', what: 'supports-color -> ~/node_modules/supports-color/index.js' })
    appendFileSync(cliFile(tree, 'dist/bin/acp.js'), ';')
    tools.launcherReport({ type: 'integrity', what: 'runtime/node_modules/x.js is not the verified file' })

    expect(refusals(t.audit)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/refused a module outside the verified tree \(supports-color/),
        expect.stringMatching(/changed after the check and was refused at load/)
      ])
    )
    expect(await tools.runtime()).toMatchObject({ ok: false, reason: 'file-changed' })
  })
})

describe('the new tree is proven before it replaces anything (critic survivor C9)', () => {
  it('a tree that changes while it is being built never moves into place; the old one stays verified', async () => {
    const t = lab()

    expect((await t.make().install()).ok).toBe(true)

    const tools = t.make()

    expect((await tools.refresh()).state).toBe('installed')

    // While dep-a downloads, the CLI's acp.js is written into the new tree in full; it is then changed under the
    // installer. Waits for the whole file (a tamper racing its write could be overwritten), with a generous budget.
    let tampered = false
    const ACP_JS = 'console.log("acp")'

    t.onFetch(async url => {
      if (!url.includes('dep-a')) {
        return
      }

      for (let i = 0; i < 2000 && !tampered; i++) {
        const tmp = readdirSync(t.root).find(name => name.startsWith('.install-'))
        const file = tmp && cliFile(path.join(t.root, tmp), 'dist/bin/acp.js')

        if (file && existsSync(file) && statSync(file).size === ACP_JS.length) {
          appendFileSync(file, ';evil()')
          tampered = true
        } else {
          await new Promise(resolve => setTimeout(resolve, 5))
        }
      }
    })

    const answer = await tools.install()

    expect(tampered).toBe(true)
    expect(failure(answer)).toMatchObject({ reason: 'new-tree-unverified' })
    expect(await tools.runtime()).toMatchObject({ ok: true })
    expect(readFileSync(cliFile(treeOf(t.root, t.registry.lockText), 'dist/bin/acp.js'), 'utf8')).not.toMatch(/evil/)
  }, 30_000)
})

describe('ruling 28: a package that names its licence file must carry it', () => {
  const withSee = (files: Record<string, { data: string }>) =>
    defaultPackages().map(pkg => (pkg.name === 'dep-a' ? { ...pkg, license: 'SEE LICENSE IN LICENSE', files } : pkg))

  it('installs with the file, and its text reaches the in-app notices', async () => {
    const t = lab({ packages: withSee({ 'index.js': { data: '1' }, LICENSE: { data: 'The MIT License (Segment)' } }) })
    const tools = t.make()

    expect((await tools.install()).ok).toBe(true)
    expect(readFileSync(path.join(treeOf(t.root, t.registry.lockText), NOTICES_FILE), 'utf8')).toMatch(
      /dep-a 2\.0\.0 — SEE LICENSE IN LICENSE[\s\S]*The MIT License \(Segment\)/
    )
  })

  it('refuses the whole install without it (negative control)', async () => {
    const t = lab({ packages: withSee({ 'index.js': { data: '1' } }) })
    const answer = await t.make().install()

    expect(failure(answer)).toMatchObject({ reason: 'licence-file-missing', subject: 'dep-a@2.0.0' })
  })
})

describe('lock hash change ⇒ reinstall', () => {
  it('a new pin finds its tree absent (stale), installs beside it, then sweeps the old one', async () => {
    const t = lab()

    expect((await t.make().install()).ok).toBe(true)

    const oldTree = treeOf(t.root, t.registry.lockText)
    const bumped = writeFixturePin(path.join(t.home, 'pin2'), defaultPackages('1.0.39'))
    const tools = t.make(bumped)

    expect(await tools.refresh()).toMatchObject({ state: 'absent', cliVersion: '1.0.39', stale: true })
    expect(await tools.runtime()).toMatchObject({ ok: false, code: 'absent' })
    expect((await tools.install()).ok).toBe(true)
    expect(existsSync(oldTree)).toBe(false)
    expect(existsSync(treeOf(t.root, bumped.lockText))).toBe(true)
  })

  it('a tree whose manifest names another pin is refused, never run', async () => {
    const t = lab()
    const tools = t.make()

    expect((await tools.install()).ok).toBe(true)

    const tree = treeOf(t.root, t.registry.lockText)
    const manifest = JSON.parse(readFileSync(path.join(tree, MANIFEST_FILE), 'utf8'))

    manifest.lockSha256 = 'f'.repeat(64)
    writeFileSync(path.join(tree, MANIFEST_FILE), JSON.stringify(manifest))

    expect(await t.make().runtime()).toMatchObject({ ok: false, code: 'unverified' })
  })

  it('an old pin’s genuine, signed and recorded tree moved into the new pin’s folder is refused (C20)', async () => {
    const t = lab()

    expect((await t.make().install()).ok).toBe(true)

    const bumped = writeFixturePin(path.join(t.home, 'pin2'), defaultPackages('1.0.39'))

    renameSync(treeOf(t.root, t.registry.lockText), treeOf(t.root, bumped.lockText))

    expect(await t.make(bumped).runtime()).toMatchObject({ ok: false, code: 'unverified', reason: 'other-pin' })
  })

  it('a broken pin in the build is unavailable, never installed', async () => {
    const t = lab()

    writeFileSync(path.join(t.registry.pinDir, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}')

    const tools = t.make()

    expect(await tools.refresh()).toMatchObject({ state: 'unavailable', reason: 'pin-invalid' })
    expect(failure(await tools.install())).toMatchObject({ reason: 'pin-invalid' })
    expect(t.fetched).toEqual([])
  })

  it('sweeps an interrupted install left by a crash', async () => {
    const t = lab()

    mkdirSync(path.join(t.root, '.install-deadbeef00ff', 'runtime'), { recursive: true })
    await t.make().refresh()
    expect(existsSync(path.join(t.root, '.install-deadbeef00ff'))).toBe(false)
  })
})

describe('ruling 33: the app’s own native add-ons replace npm’s before the manifest is written', () => {
  const ADDON = 'node_modules/bufferutil/prebuilds/darwin-x64+arm64/bufferutil.node'
  const NPM_BYTES = 'npm ad-hoc signed addon'

  const packages = (): FixturePackage[] => [
    ...defaultPackages().map(pkg =>
      pkg.name === ACP_CLI_NAME ? { ...pkg, deps: [...(pkg.deps ?? []), 'bufferutil'] } : pkg
    ),
    {
      name: 'bufferutil',
      version: '4.1.0',
      license: 'MIT',
      files: {
        'package.json': { data: '{"name":"bufferutil"}' },
        'index.js': { data: 'module.exports = 1' },
        LICENSE: { data: 'MIT' },
        'prebuilds/darwin-x64+arm64/bufferutil.node': { data: NPM_BYTES },
        'prebuilds/linux-x64/bufferutil.node': { data: 'linux' }
      }
    }
  ]

  function withAddons(shipped: string, change?: (list: Record<string, unknown>) => void, required = true) {
    const t = lab({ packages: packages() })

    const dir = writeAddonDir(path.join(t.home, 'acp-native', 'darwin-arm64'), {
      target: 'darwin-arm64',
      lockText: t.registry.lockText,
      addons: [{ pkg: 'bufferutil', version: '4.1.0', file: ADDON, npm: NPM_BYTES, shipped }]
    })

    if (change) {
      const list = JSON.parse(readFileSync(path.join(dir, 'ADDONS.json'), 'utf8'))

      change(list)
      writeFileSync(path.join(dir, 'ADDONS.json'), JSON.stringify(list))
    }

    return { t, tools: t.make(t.registry, { native: { dir, required } }) }
  }

  it('swaps the shipped copy in, the manifest covers its bytes (source app), and the tree verifies', async () => {
    const { t, tools } = withAddons('TEAM-SIGNED addon bytes')

    expect((await tools.install()).ok).toBe(true)

    const tree = treeOf(t.root, t.registry.lockText)
    const manifest = JSON.parse(readFileSync(path.join(tree, MANIFEST_FILE), 'utf8'))

    expect(readFileSync(path.join(tree, 'runtime', ...ADDON.split('/')), 'utf8')).toBe('TEAM-SIGNED addon bytes')
    expect(manifest.files[`runtime/${ADDON}`]).toMatchObject({
      sha256: sha256Hex('TEAM-SIGNED addon bytes'),
      source: 'app'
    })
    expect(readFileSync(path.join(tree, NOTICES_FILE), 'utf8')).toMatch(/native add-on file\(s\)/)
    expect((await tools.runtime()).ok).toBe(true)
  })

  it('an install made with another app build’s add-ons is refused: the manifest and the record carry the list digest (critic r2 m4)', async () => {
    const { t, tools } = withAddons('build 1 copy')

    expect((await tools.install()).ok).toBe(true)

    const tree = treeOf(t.root, t.registry.lockText)
    const manifest = JSON.parse(readFileSync(path.join(tree, MANIFEST_FILE), 'utf8'))

    expect(manifest.addons).toMatch(/^[0-9a-f]{64}$/)
    expect(t.record.read()?.addons).toBe(manifest.addons)

    // The app is updated (same pin, new add-on copies): the old tree, manifest and record — a "replay" — is refused.
    const dir = path.join(t.home, 'acp-native', 'darwin-arm64')

    writeAddonDir(dir, {
      target: 'darwin-arm64',
      lockText: t.registry.lockText,
      addons: [{ pkg: 'bufferutil', version: '4.1.0', file: ADDON, npm: NPM_BYTES, shipped: 'build 2 copy' }]
    })

    const next = t.make(t.registry, { native: { dir, required: true } })

    expect(await next.refresh()).toMatchObject({ state: 'unverified', reason: 'other-pin' })
    expect((await next.install()).ok).toBe(true)
    expect((await next.runtime()).ok).toBe(true)
  })

  it('a shipped copy that is not the listed one is REFUSED, never a silent fallback to npm’s', async () => {
    const { t, tools } = withAddons('good', list => {
      ;(list.addons as { sha256: string }[])[0]!.sha256 = sha256Hex('other')
    })

    expect(failure(await tools.install())).toMatchObject({ reason: 'addon-swap', subject: 'bufferutil@4.1.0' })
    expect(existsSync(treeOf(t.root, t.registry.lockText))).toBe(false)
  })

  it('npm’s file is not the one the copy was built from: refused', async () => {
    const { tools } = withAddons('good', list => {
      ;(list.addons as { npmSha256: string }[])[0]!.npmSha256 = sha256Hex('another npm build')
    })

    expect(failure(await tools.install())).toMatchObject({ reason: 'addon-swap' })
  })

  it('an add-on npm installs that the list does not name, or a list for another pin: refused', async () => {
    const a = withAddons('good', list => {
      list.addons = []
    })

    expect(failure(await a.tools.install())).toMatchObject({ reason: 'addons-mismatch', subject: ADDON })

    const b = withAddons('good', list => {
      list.lockSha256 = 'b'.repeat(64)
    })

    expect(failure(await b.tools.install())).toMatchObject({ reason: 'addons-mismatch' })
  })

  it('a packaged macOS build without its add-ons is refused; a dev build without them keeps npm’s', async () => {
    const t = lab({ packages: packages() })

    expect(
      failure(await t.make(t.registry, { native: { dir: path.join(t.home, 'nowhere'), required: true } }).install())
    ).toMatchObject({ reason: 'addons-missing' })
    expect(failure(await t.make(t.registry, { native: { dir: null, required: true } }).install())).toMatchObject({
      reason: 'addons-missing'
    })
    expect((await t.make(t.registry, { native: { dir: null, required: false } }).install()).ok).toBe(true)
  })
})

describe('the spawn gate compares the tree, not only the path (critic r2 D10)', () => {
  it('the same entry with another manifest digest is not the verified tree', () => {
    const a = { entry: '/t/acp.js', treeSha256: 'a'.repeat(64) }

    expect(sameTree(a, { ...a })).toBe(true)
    expect(sameTree(a, { ...a, treeSha256: 'b'.repeat(64) })).toBe(false)
    expect(sameTree(a, { ...a, entry: '/u/acp.js' })).toBe(false)
  })
})

describe('ruling 33: which builds carry add-ons', () => {
  const base = { target: 'x', resourcesPath: '/R', appPath: '/A' }

  it('a packaged macOS app must carry them; packaged Linux and Windows keep npm’s; a dev run uses staged ones', () => {
    expect(nativeAddonsFor({ ...base, packaged: true, platform: 'darwin', exists: () => false })).toEqual({
      dir: '/R/acp-native/x',
      required: true
    })
    expect(nativeAddonsFor({ ...base, packaged: true, platform: 'linux', exists: () => false })).toEqual({
      dir: null,
      required: false
    })
    expect(nativeAddonsFor({ ...base, packaged: true, platform: 'win32', exists: () => true })).toEqual({
      dir: '/R/acp-native/x',
      required: false
    })
    expect(nativeAddonsFor({ ...base, packaged: false, platform: 'darwin', exists: () => false })).toEqual({
      dir: null,
      required: false
    })
  })
})

describe('m-r5-4: the installed notices copy the user opens is re-hashed, a regular file, in a folder of ours', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  async function installed() {
    const t = lab()
    const tools = t.make()

    expect((await tools.install()).ok).toBe(true)

    const tmp = mkdtempSync(path.join(os.tmpdir(), 'acp-notices-'))

    vi.stubEnv('TMPDIR', tmp)

    const bytes = readFileSync(path.join(treeOf(t.root, t.registry.lockText), NOTICES_FILE), 'utf8')

    return { tools, tmp, bytes, dir: path.join(tmp, 'iclone-acp-notices') }
  }

  it('m-r5-4: a fresh copy is the verified notices, 0444 in a 0700 folder', async () => {
    const { tools, bytes, dir } = await installed()
    const copy = tools.noticesFile()

    expect(copy).not.toBeNull()
    expect(path.dirname(copy!)).toBe(dir)
    expect(readFileSync(copy!, 'utf8')).toBe(bytes)
    expect(lstatSync(dir).mode & 0o777).toBe(0o700)
    expect(lstatSync(copy!).isFile()).toBe(true)
  })

  it('m-r5-4: a link or other bytes planted under the copy’s name are replaced by the verified notices', async () => {
    const { tools, tmp, bytes } = await installed()
    const copy = tools.noticesFile()!
    const elsewhere = path.join(tmp, 'elsewhere.app')

    writeFileSync(elsewhere, 'not the notices')
    rmSync(copy)
    symlinkSync(elsewhere, copy)
    expect(tools.noticesFile()).toBe(copy)
    expect(lstatSync(copy).isFile()).toBe(true)
    expect(readFileSync(copy, 'utf8')).toBe(bytes)
    expect(readFileSync(elsewhere, 'utf8')).toBe('not the notices')

    chmodSync(copy, 0o644)
    writeFileSync(copy, 'tampered')
    expect(tools.noticesFile()).toBe(copy)
    expect(readFileSync(copy, 'utf8')).toBe(bytes)
  })

  it('m-r6 (defense in depth): a hard link planted under the copy’s name is replaced; a looser folder goes back to 0700', async () => {
    const { tools, tmp, bytes, dir } = await installed()
    const copy = tools.noticesFile()!
    const outside = path.join(tmp, 'same-bytes-elsewhere.md')

    // Same bytes, so only the link count tells it apart: the copy must be single-linked (else a write there lands here).
    writeFileSync(outside, bytes)
    rmSync(copy)
    linkSync(outside, copy)
    expect(lstatSync(copy).nlink).toBe(2)
    expect(tools.noticesFile()).toBe(copy)
    expect(lstatSync(copy).nlink).toBe(1)
    expect(readFileSync(outside, 'utf8')).toBe(bytes)

    chmodSync(dir, 0o755)
    expect(tools.noticesFile()).toBe(copy)
    expect(lstatSync(dir).mode & 0o777).toBe(0o700)
  })

  it('m-r5-4: a notices folder that is a link (or not ours) is refused: nothing to open', async () => {
    const { tools, tmp, dir } = await installed()
    const target = path.join(tmp, 'planted')

    mkdirSync(target)
    symlinkSync(target, dir)
    expect(tools.noticesFile()).toBeNull()
    expect(readdirSync(target)).toEqual([])
  })
})
