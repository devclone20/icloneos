// v0.0.9 F1-B (owner decision 17 Nov, replaces ruling 26) — the ACP tools run the CLI the app SHIPS. Each case builds
// a bundle with the real build code (fixture.ts `writeFixtureBundle` → materialise.ts) from a fake registry, then runs
// the real tools module against a temp userData. v0.0.9 Q (tests-perf 7): the network is a real guard now — the
// global `fetch` is stubbed to throw and count, so "no download" is an assertion that can fail (the tools' own
// deprecated `fetch` dep was never called, which made the old counter a tautology).
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

import type { BundleManifest } from './bundle'
import { defaultPackages, memorySealer, writeFixtureBundle, writeFixturePin } from './fixture'
import { type AcpToolsAudit, type AcpToolsDeps, createAcpTools, NOTICES_FILE, problemText, sameTree } from './installer'
import { requestInstall } from './ipc'
import { MANIFEST_FILE, sha256Hex } from './manifest'

const temps: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()

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

/** A temp home with a pin, the bundle built from it, and a factory for the tools module (no network: fetch throws). */
async function lab(options: { packages?: Parameters<typeof writeFixturePin>[1]; bundle?: boolean } = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'iclone-acp-bundled-'))

  temps.push(home)

  const registry = writeFixturePin(path.join(home, 'pin'), options.packages ?? defaultPackages())
  const bundleDir = path.join(home, 'Resources', 'acp-tools')

  const manifest: BundleManifest | null =
    options.bundle === false ? null : await writeFixtureBundle(registry, bundleDir)

  const audit: AcpToolsAudit[] = []
  let fetched = 0

  vi.stubGlobal('fetch', async () => {
    fetched += 1
    throw new Error('F1-B: the tools never download anything')
  })

  const make = (overrides: Partial<AcpToolsDeps> = {}) =>
    createAcpTools({
      root: path.join(home, 'userData', 'acp-cli'),
      pinDir: registry.pinDir,
      launcher: registry.launcher,
      target: MAC,
      bundleDir,
      native: { dir: null, required: false },
      audit: entry => audit.push(entry),
      log: () => undefined,
      ...overrides
    })

  return {
    home,
    root: path.join(home, 'userData', 'acp-cli'),
    tree: path.join(home, 'userData', 'acp-cli', sha256Hex(registry.lockText)),
    bundleDir,
    manifest,
    registry,
    audit,
    fetched: () => fetched,
    make
  }
}

const cliFile = (tree: string, rel: string) =>
  path.join(tree, 'runtime', 'node_modules', ...ACP_CLI_NAME.split('/'), rel)

const refusals = (audit: AcpToolsAudit[]) => audit.filter(entry => entry.kind === 'refuse').map(entry => entry.reason)
const uses = (audit: AcpToolsAudit[]) => audit.filter(entry => entry.kind === 'use').map(entry => entry.reason)

describe('the bundled tree verifies: placed from the app on its own, checked against the bundle’s manifest', () => {
  it('the first check places the included copy (no click, no network) and the runtime is that copy', async () => {
    const t = await lab()
    const tools = t.make()

    expect(await tools.refresh()).toMatchObject({ state: 'installed', cliVersion: '1.0.38', packages: 2 })
    expect(t.fetched()).toBe(0)
    // The copy carries the bundle's manifest, byte for byte (what the launcher hashes every load against).
    expect(readFileSync(path.join(t.tree, MANIFEST_FILE))).toEqual(readFileSync(path.join(t.bundleDir, MANIFEST_FILE)))
    expect(lstatSync(cliFile(t.tree, 'bin/acp-cli-signer-macos')).mode & 0o777).toBe(0o755)
    expect(uses(t.audit)).toContainEqual(expect.stringMatching(/included .*first run of this build/))

    const answer = await tools.runtime()

    expect(answer.ok).toBe(true)

    if (answer.ok) {
      expect(answer.rt.dir).toBe(t.tree)
      expect(answer.rt.entry).toBe(cliFile(t.tree, 'dist/bin/acp.js'))
      expect(answer.rt.treeSha256).toBe(t.manifest!.treeSha256)
      expect(answer.rt.version).toBe('1.0.38')
    }

    expect(tools.problem()).toBeNull()
    expect(readdirSync(t.root).filter(name => name.startsWith('.install-'))).toEqual([])
  })

  it('blocker K: the Keychain setting off (no sealer) is still ready — the bundle needs no key', async () => {
    const t = await lab()
    const tools = t.make({ sealer: null, noSealReason: 'keychain-off' })

    expect(await tools.refresh()).toMatchObject({ state: 'installed' })
    expect((await tools.runtime()).ok).toBe(true)
    // Negative control: a sealer present changes nothing either way.
    expect(await t.make({ sealer: memorySealer }).refresh()).toMatchObject({ state: 'installed' })
  })

  it('a new process re-verifies the placed copy from disk; nothing is copied twice', async () => {
    const t = await lab()

    await t.make().refresh()

    const placed = uses(t.audit).length
    const again = t.make()

    expect(await again.refresh()).toMatchObject({ state: 'installed' })
    expect(uses(t.audit).length).toBe(placed)
  })

  it('a build without the CLI (no bundle) is absent — with the refusal every ACP path classifies on', async () => {
    const t = await lab({ bundle: false })
    const tools = t.make()

    expect(await tools.refresh()).toEqual({ state: 'absent', cliVersion: '1.0.38', stale: false })
    expect(tools.problem()).toMatch(/^\[acp-tools:absent\] ACP tools are not installed/)
    expect(existsSync(t.tree)).toBe(false)
  })

  it('a bundle built for another pin, target or add-on list cannot run here (no copy is placed)', async () => {
    const t = await lab()

    expect(await t.make({ target: { platform: 'linux', arch: 'x64', libc: 'glibc' } }).refresh()).toMatchObject({
      state: 'unavailable',
      reason: 'other-pin'
    })

    const other = writeFixturePin(path.join(t.home, 'pin2'), defaultPackages('1.0.39'))

    expect(
      await t.make({ pinDir: other.pinDir, launcher: other.launcher }).refresh()
    ).toMatchObject({ state: 'unavailable', reason: 'other-pin' })

    const addons = path.join(t.home, 'addons')

    mkdirSync(addons)
    writeFileSync(path.join(addons, 'ADDONS.json'), '{}')
    expect(await t.make({ native: { dir: addons, required: true } }).refresh()).toMatchObject({
      state: 'unavailable',
      reason: 'addons-mismatch'
    })
    expect(existsSync(t.tree)).toBe(false)
  })

  it('a bundle manifest with a MAC (a v0.0.8 install manifest) or a broken digest is refused', async () => {
    const t = await lab()
    const file = path.join(t.bundleDir, MANIFEST_FILE)
    const good = JSON.parse(readFileSync(file, 'utf8'))

    writeFileSync(file, JSON.stringify({ ...good, mac: 'a'.repeat(64) }))
    expect(await t.make().refresh()).toMatchObject({ state: 'unavailable', reason: 'manifest-malformed' })

    writeFileSync(file, JSON.stringify({ ...good, treeSha256: 'b'.repeat(64) }))
    expect(await t.make().refresh()).toMatchObject({ state: 'unavailable', reason: 'manifest-digest' })
  })
})

describe('tampered copy ⇒ refused, audited; the owner’s Repair restores it from the bundle, offline', () => {
  it('one changed byte is refused before any spawn, named and audited once; Repair restores the bytes', async () => {
    const t = await lab()
    const tools = t.make()

    await tools.refresh()

    const entry = cliFile(t.tree, 'dist/bin/acp.js')
    const original = readFileSync(entry)

    appendFileSync(entry, ';evil()')

    const refused = await tools.runtime()

    expect(refused).toMatchObject({ ok: false, code: 'unverified', reason: 'file-changed' })
    expect(tools.view()).toMatchObject({ state: 'unverified', reason: 'file-changed' })
    await tools.runtime()
    expect(refusals(t.audit).filter(reason => reason.includes('file-changed'))).toHaveLength(1)
    // Never re-placed behind the owner's back: the copy stays refused until Repair.
    expect(readFileSync(entry)).not.toEqual(original)

    const repaired = await tools.install()

    expect(repaired).toMatchObject({ ok: true, view: { state: 'installed' } })
    expect(readFileSync(entry)).toEqual(original)
    expect((await tools.runtime()).ok).toBe(true)
    expect(t.fetched()).toBe(0)
    expect(uses(t.audit)).toContainEqual(expect.stringMatching(/the owner's Repair/))
  })

  it('an added file, a removed file, a lost exec bit and a link are each refused, and Repair fixes each', async () => {
    const t = await lab()
    const tools = t.make()

    await tools.refresh()

    const cases: [() => void, string][] = [
      [() => writeFileSync(cliFile(t.tree, 'dist/bin/extra.js'), 'x'), 'extra-file'],
      [() => rmSync(cliFile(t.tree, 'dist/bin/acp.js')), 'missing-file'],
      [() => chmodSync(cliFile(t.tree, 'bin/acp-cli-signer-macos'), 0o644), 'mode-changed'],
      [() => symlinkSync('/etc/hosts', cliFile(t.tree, 'dist/bin/link.js')), 'not-plain']
    ]

    for (const [tamper, reason] of cases) {
      tamper()
      expect(await tools.runtime()).toMatchObject({ ok: false, reason })
      expect((await tools.install()).ok).toBe(true)
      expect((await tools.runtime()).ok).toBe(true)
    }
  })

  it('a copy whose files AND manifest were rewritten together is not the bundle’s: refused (manifest-signature)', async () => {
    const t = await lab()
    const tools = t.make()

    await tools.refresh()

    const manifestFile = path.join(t.tree, MANIFEST_FILE)
    const forged = JSON.parse(readFileSync(manifestFile, 'utf8'))

    forged.createdAt = '2099-01-01T00:00:00.000Z'
    writeFileSync(manifestFile, JSON.stringify(forged))
    expect(await tools.runtime()).toMatchObject({ ok: false, code: 'unverified', reason: 'manifest-signature' })
    expect((await tools.install()).ok).toBe(true)
  })

  it('Repair never copies a changed INCLUDED copy: refused with the file named, the old copy left where it was', async () => {
    const t = await lab()
    const tools = t.make()

    await tools.refresh()
    appendFileSync(cliFile(t.tree, 'dist/bin/acp.js'), ';tamper')
    await tools.runtime()
    // The bundle itself changed too (it lives in the signed app: this is what a broken install looks like).
    appendFileSync(cliFile(t.bundleDir, 'dist/bin/acp.js'), ';tamper')

    const answer = await tools.install()

    expect(answer).toMatchObject({
      ok: false,
      reason: 'file-changed',
      subject: `included copy: runtime/node_modules/${ACP_CLI_NAME}/dist/bin/acp.js`
    })
    expect(readdirSync(t.root).filter(name => name.startsWith('.install-') || name.startsWith('.trash-'))).toEqual([])
    expect(existsSync(t.tree)).toBe(true)
    expect(tools.view()).toMatchObject({ state: 'unverified', lastError: { reason: 'file-changed' } })
  })

  it('a first placement that fails is not retried in a loop: unverified with the reason, Repair retries', async () => {
    const t = await lab()

    rmSync(cliFile(t.bundleDir, 'SKILL.md'))

    const tools = t.make()

    expect(await tools.refresh()).toMatchObject({ state: 'unverified', reason: 'missing-file' })

    const attempts = uses(t.audit).filter(reason => reason.includes('first run')).length

    await tools.refresh()
    await tools.runtime()
    expect(uses(t.audit).filter(reason => reason.includes('first run')).length).toBe(attempts)
    expect(existsSync(t.tree)).toBe(false)
  })
})

describe('v0.0.8 → v0.0.9: the npm install at the same path is replaced once, from the bundle', () => {
  it('a legacy tree (its MANIFEST carries the sealed-key MAC) is replaced by the included copy, audited', async () => {
    const t = await lab()

    mkdirSync(path.join(t.tree, 'runtime'), { recursive: true })
    writeFileSync(path.join(t.tree, 'runtime', 'old.js'), 'old npm install')
    writeFileSync(
      path.join(t.tree, MANIFEST_FILE),
      JSON.stringify({ v: 1, files: {}, treeSha256: 'c'.repeat(64), mac: 'd'.repeat(64) })
    )

    const tools = t.make()

    expect(await tools.refresh()).toMatchObject({ state: 'installed' })
    expect(existsSync(path.join(t.tree, 'runtime', 'old.js'))).toBe(false)
    expect(uses(t.audit)).toContainEqual(expect.stringMatching(/replacing the v0\.0\.8 npm install/))
  })

  it('other pins’ trees and interrupted placements are swept; the legacy key file is not a stray', async () => {
    const t = await lab()

    mkdirSync(path.join(t.root, 'e'.repeat(64)), { recursive: true })
    mkdirSync(path.join(t.root, '.install-abc'), { recursive: true })
    writeFileSync(path.join(t.root, 'manifest-key.sealed'), 'legacy')

    const tools = t.make()

    await tools.refresh()
    await tools.sweep()
    expect(existsSync(path.join(t.root, 'e'.repeat(64)))).toBe(false)
    expect(existsSync(path.join(t.root, '.install-abc'))).toBe(false)
    expect(refusals(t.audit).some(reason => reason.includes('manifest-key.sealed'))).toBe(false)
  })
})

describe('the Repair door (ipc.ts): the owner’s own click, audited, or nothing', () => {
  it('without the gesture: refused and audited, nothing copied; with it: audited first, then restored', async () => {
    const t = await lab()
    const tools = t.make()

    await tools.refresh()
    appendFileSync(cliFile(t.tree, 'dist/bin/acp.js'), ';x')
    await tools.runtime()

    const ipcAudit: { kind: string; reason: string; gesture: boolean }[] = []

    const sink = (entry: { kind: 'refuse' | 'use'; reason: string; gesture: boolean }) => {
      ipcAudit.push(entry)

      return { seq: ipcAudit.length }
    }

    expect(await requestInstall({ tools, audit: sink }, false)).toEqual({ ok: false, error: 'gesture' })
    expect(ipcAudit.at(-1)).toMatchObject({ kind: 'refuse', gesture: false })
    expect(tools.view()).toMatchObject({ state: 'unverified' })

    expect(await requestInstall({ tools, audit: () => null }, true)).toEqual({ ok: false, error: 'audit' })
    expect(tools.view()).toMatchObject({ state: 'unverified' })

    expect(await requestInstall({ tools, audit: sink }, true)).toMatchObject({ ok: true, view: { state: 'installed' } })
    expect(ipcAudit.at(-1)).toMatchObject({ kind: 'use', gesture: true, reason: expect.stringMatching(/repair/) })
    expect(t.fetched()).toBe(0)
  })
})

describe('the spawn gate and the notices', () => {
  it('the same entry with another manifest digest is not the verified tree (critic r2 D10)', () => {
    expect(sameTree({ entry: '/a', treeSha256: 'x' }, { entry: '/a', treeSha256: 'x' })).toBe(true)
    expect(sameTree({ entry: '/a', treeSha256: 'x' }, { entry: '/a', treeSha256: 'y' })).toBe(false)
    expect(problemText('unverified', 'file-changed', 'x.js')).toMatch(/^\[acp-tools:unverified:file-changed\]/)
  })

  it('the included notices: the pin’s table first, then each package’s licence texts; opened as a re-hashed copy', async () => {
    const t = await lab()
    const tools = t.make()

    await tools.refresh()

    const text = readFileSync(path.join(t.tree, NOTICES_FILE), 'utf8')

    expect(text).toMatch(/^# Virtuals ACP CLI — included in iclone os/)
    expect(text).toContain('# ACP CLI — fixture pin table')
    expect(text).toContain('MIT License — dep-a')

    const tmp = mkdtempSync(path.join(os.tmpdir(), 'acp-notices-'))

    temps.push(tmp)
    vi.stubEnv('TMPDIR', tmp)

    const copy = tools.noticesFile()

    expect(copy).not.toBeNull()
    expect(readFileSync(copy!, 'utf8')).toBe(text)
    expect(lstatSync(copy!).mode & 0o777).toBe(0o444)
  })
})

// v0.0.9 Q (tests-perf 3): the regressions the bundle rewrite dropped, restored against the bundle design.
describe('restored regressions (tests-perf 3) and the cancel loop (correctness 4)', () => {
  it('a same-size edit with the times put back is still refused: the quick check reads ctime (critic C14)', async () => {
    const t = await lab()
    const tools = t.make()

    await tools.refresh()
    expect((await tools.runtime()).ok).toBe(true)

    const entry = cliFile(t.tree, 'dist/bin/acp.js')
    const before = statSync(entry)
    const bytes = readFileSync(entry)

    bytes[0] = bytes[0] === 0x2f ? 0x2a : 0x2f
    writeFileSync(entry, bytes)
    utimesSync(entry, before.atime, before.mtime)
    expect(statSync(entry).size).toBe(before.size)
    expect(Math.floor(statSync(entry).mtimeMs / 1000)).toBe(Math.floor(before.mtimeMs / 1000))

    expect(await tools.runtime()).toMatchObject({ ok: false, code: 'unverified', reason: 'file-changed' })
  })

  it('a touch that keeps the bytes costs a full check, then passes', async () => {
    const t = await lab()
    const tools = t.make()

    await tools.refresh()

    const entry = cliFile(t.tree, 'dist/bin/acp.js')

    utimesSync(entry, new Date(), new Date())
    expect((await tools.runtime()).ok).toBe(true)
    expect(tools.view()).toMatchObject({ state: 'installed' })
  })

  it('M1: a package planted beside the tree is refused and audited once; the tree stays usable', async () => {
    const t = await lab()
    const tools = t.make()

    await tools.refresh()
    mkdirSync(path.join(t.home, 'userData', 'node_modules', 'evil'), { recursive: true })
    mkdirSync(path.join(t.root, 'foo'), { recursive: true })

    expect((await tools.refresh()).state).toBe('installed')
    expect((await tools.runtime()).ok).toBe(true)
    await tools.refresh()

    const planted = refusals(t.audit).filter(reason => /refused (node_modules|acp-cli\/foo) beside/.test(reason))

    expect(planted).toHaveLength(2)
    expect(existsSync(path.join(t.root, 'foo'))).toBe(true)
  })

  it('cancel of the automatic placement: no partial tree, absent until Repair, never placed again by itself', async () => {
    const t = await lab()
    let cancelled: boolean | null = null

    // The owner's Cancel, the moment the placement shows (after the placement registered itself).
    const tools = t.make({
      onChange: view => {
        if (view.state === 'installing' && cancelled === null) {
          cancelled = false
          queueMicrotask(() => {
            cancelled = tools.cancel()
          })
        }
      }
    })

    await tools.refresh()
    expect(cancelled).toBe(true)

    expect(existsSync(t.tree)).toBe(false)
    expect(readdirSync(t.root).filter(name => name.startsWith('.install-'))).toEqual([])
    expect(tools.view()).toMatchObject({ state: 'absent' })

    // Red on the old code: the check after a cancel started the copy again (a repeated Cancel looped).
    expect(await tools.refresh()).toMatchObject({ state: 'absent' })
    expect(await tools.runtime()).toMatchObject({ ok: false, code: 'absent' })
    expect(existsSync(t.tree)).toBe(false)
    expect(uses(t.audit).filter(reason => reason.includes('first run of this build'))).toHaveLength(1)

    expect(await tools.install()).toMatchObject({ ok: true, view: { state: 'installed' } })
    expect(t.fetched()).toBe(0)
  })

  it('a spawn asked for while placing waits for the placement and gets its answer', async () => {
    const t = await lab()
    let during: Promise<Awaited<ReturnType<typeof tools.runtime>>> | null = null

    const tools = t.make({
      onChange: view => {
        if (view.state === 'installing' && !during) {
          during = new Promise(resolve => queueMicrotask(() => void tools.runtime().then(resolve)))
        }
      }
    })

    await tools.refresh()
    expect(during).not.toBeNull()
    expect((await during!).ok).toBe(true)
  })

  it('a check already running before the rename never decides the install (m5): one placement only', async () => {
    const t = await lab()
    let release: () => void = () => undefined
    let held = true

    const tools = t.make({
      beforeCheck: () =>
        held
          ? new Promise<void>(resolve => {
              held = false
              release = resolve
            })
          : Promise.resolve()
    })

    const stale = tools.refresh()

    await vi.waitFor(() => expect(held).toBe(false))

    const repaired = await tools.install()

    expect(repaired).toMatchObject({ ok: true })
    release()
    await stale
    expect(tools.view()).toMatchObject({ state: 'installed' })
    expect(uses(t.audit).filter(reason => reason.startsWith('acp tools: place the included'))).toHaveLength(1)
  })

  describe('the notices copy is never anything planted under its name', () => {
    async function ready() {
      const t = await lab()
      const tools = t.make()

      await tools.refresh()

      const tmp = mkdtempSync(path.join(os.tmpdir(), 'acp-notices-'))

      temps.push(tmp)
      vi.stubEnv('TMPDIR', tmp)

      const copy = tools.noticesFile()!
      const text = readFileSync(copy, 'utf8')

      return { copy, dir: path.dirname(copy), tmp, text, tools }
    }

    it('a link or other bytes under the copy name are replaced by the real bytes', async () => {
      const r = await ready()
      const bait = path.join(r.tmp, 'bait.md')

      writeFileSync(bait, 'not the notices')
      rmSync(r.copy, { force: true })
      symlinkSync(bait, r.copy)
      expect(readFileSync(r.tools.noticesFile()!, 'utf8')).toBe(r.text)
      expect(lstatSync(r.copy).isSymbolicLink()).toBe(false)
      expect(readFileSync(bait, 'utf8')).toBe('not the notices')

      chmodSync(r.copy, 0o644)
      writeFileSync(r.copy, 'other bytes')
      expect(readFileSync(r.tools.noticesFile()!, 'utf8')).toBe(r.text)
    })

    it('a hard link under the copy name is not opened as the notices', async () => {
      const r = await ready()
      const other = path.join(r.tmp, 'other.md')

      writeFileSync(other, r.text)
      rmSync(r.copy, { force: true })
      linkSync(other, r.copy)

      const opened = r.tools.noticesFile()

      expect(opened).not.toBeNull()
      expect(lstatSync(opened!).nlink).toBe(1)
    })

    it('a notices folder that is a link is refused', async () => {
      const r = await ready()
      const elsewhere = path.join(r.tmp, 'elsewhere')

      rmSync(r.dir, { recursive: true, force: true })
      mkdirSync(elsewhere)
      symlinkSync(elsewhere, r.dir)
      expect(r.tools.noticesFile()).toBeNull()
    })
  })
})
