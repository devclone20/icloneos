/**
 * V3-S r4 (lead ruling 36): where the managed runtime lives, what any other runtime is, and the app-owned plugin
 * folder of an unmanaged dev checkout (which is only ever read). Temp dirs only.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  classifyRuntime,
  DEV_PLUGIN_OVERLAY_DIR,
  devBackendRootsFor,
  MANAGED_RUNTIME_DIR,
  managedRuntimeRoot,
  prepareDevPluginOverlay
} from './iclone-runtime-location'

const temps: string[] = []

function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v3s-loc-'))
  temps.push(dir)

  return dir
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true })
  }
})

const SHA = 'a'.repeat(64)
const ICLONE = ['iclone-confinement', 'iclone-permissions']

/** Every entry under `dir` (links not followed) with its type, mode, size, mtime and bytes: any write shows. */
function untouched(dir: string): Record<string, string> {
  const out: Record<string, string> = {}

  const walk = (rel: string) => {
    for (const name of fs.readdirSync(path.join(dir, rel)).sort()) {
      const relPath = rel ? `${rel}/${name}` : name
      const stat = fs.lstatSync(path.join(dir, relPath))
      const bytes = stat.isFile() ? fs.readFileSync(path.join(dir, relPath)).toString('base64') : ''
      out[relPath] = `${stat.mode}:${stat.size}:${stat.mtimeMs}:${bytes}`

      if (stat.isDirectory()) {
        walk(relPath)
      }
    }
  }

  walk('')

  return out
}

describe('managedRuntimeRoot (the resolver V3-RT installs into)', () => {
  it('is <userData>/hermes-runtime/<artifact-sha256>, never under HERMES_HOME', () => {
    expect(managedRuntimeRoot('/Users/u/Library/Application Support/iclone os', SHA)).toBe(
      `/Users/u/Library/Application Support/iclone os/${MANAGED_RUNTIME_DIR}/${SHA}`
    )
    expect(MANAGED_RUNTIME_DIR).toBe('hermes-runtime')
    expect(DEV_PLUGIN_OVERLAY_DIR).toBe('hermes-dev-plugins')
  })

  it('refuses an artifact id that is not a sha256 (no path can be smuggled into the folder name)', () => {
    for (const bad of ['', '../x', 'A'.repeat(64), `${SHA}/..`, 'a'.repeat(63)]) {
      expect(() => managedRuntimeRoot('/ud', bad)).toThrow(/not a sha256/)
    }
  })
})

describe('classifyRuntime', () => {
  const managedRoot = managedRuntimeRoot('/ud', SHA)

  it('managed: exactly the app-owned folder', () => {
    expect(classifyRuntime({ devRoots: [], managedRoot, root: `${managedRoot}/` })).toEqual({
      kind: 'managed',
      root: managedRoot
    })
  })

  it('unmanaged-dev: a checkout the dev-backend setting names', () => {
    expect(classifyRuntime({ devRoots: ['/src/hermes'], managedRoot, root: '/src/hermes' })).toMatchObject({
      kind: 'unmanaged-dev',
      root: '/src/hermes'
    })
  })

  it('foreign: ~/.hermes/hermes-agent (a git checkout says so), a sibling folder, no root at all', () => {
    const home = temp()
    const checkout = path.join(home, '.hermes', 'hermes-agent')
    fs.mkdirSync(path.join(checkout, '.git'), { recursive: true })
    const tarball = path.join(temp(), 'hermes-agent')
    fs.mkdirSync(tarball)

    expect(classifyRuntime({ devRoots: [], managedRoot, root: checkout })).toMatchObject({
      kind: 'foreign',
      why: expect.stringMatching(/git checkout/)
    })
    expect(classifyRuntime({ devRoots: [], managedRoot, root: tarball })).toMatchObject({
      kind: 'foreign',
      why: expect.stringContaining(managedRoot)
    })
    expect(classifyRuntime({ devRoots: [], managedRoot, root: `${managedRoot}-evil` })).toMatchObject({
      kind: 'foreign'
    })
    expect(classifyRuntime({ devRoots: [], managedRoot, root: null })).toMatchObject({ kind: 'foreign', root: null })
  })
})

describe('devBackendRootsFor (the explicit dev-backend setting)', () => {
  const isSourceRoot = (root: string) => root.startsWith('/src/')

  it('the override and the dev repository, when they are Hermes source trees; never in a packaged app', () => {
    expect(devBackendRootsFor({ isSourceRoot, override: '/src/a', packaged: false, sourceRoot: '/src/repo' })).toEqual([
      '/src/a',
      '/src/repo'
    ])
    expect(devBackendRootsFor({ isSourceRoot, override: '/elsewhere', packaged: false, sourceRoot: '/app' })).toEqual(
      []
    )
    expect(devBackendRootsFor({ isSourceRoot, override: '/src/a', packaged: true, sourceRoot: '/src/repo' })).toEqual(
      []
    )
  })
})

describe('prepareDevPluginOverlay', () => {
  /** A checkout's plugins/: two upstream plugins, a file, and its own (edited) iclone plugins. */
  function checkout(): string {
    const root = temp()
    fs.mkdirSync(path.join(root, '.git'))

    for (const name of ['kanban', 'platforms', ...ICLONE, 'iclone-old']) {
      fs.mkdirSync(path.join(root, 'plugins', name), { recursive: true })
      fs.writeFileSync(path.join(root, 'plugins', name, '__init__.py'), `# ${name} (edited)\n`)
    }

    fs.writeFileSync(path.join(root, 'plugins', '__init__.py'), '')

    return root
  }

  it('links every non-iclone entry of the checkout; no iclone entry of the checkout; the checkout is only read', () => {
    const root = checkout()
    const before = untouched(root)
    const overlay = path.join(temp(), 'hermes-dev-plugins')

    const plugins = prepareDevPluginOverlay(overlay, root, ICLONE)

    expect(plugins).toBe(path.join(overlay, 'plugins'))
    expect(fs.readdirSync(plugins).sort()).toEqual(['__init__.py', 'kanban', 'platforms'])

    for (const name of ['__init__.py', 'kanban', 'platforms']) {
      expect(fs.readlinkSync(path.join(plugins, name))).toBe(path.join(root, 'plugins', name))
    }

    expect(fs.statSync(overlay).mode & 0o777).toBe(0o700)
    expect(untouched(root)).toEqual(before)
  })

  it('a second run follows the checkout: a removed plugin’s link goes, a new one comes, a re-pointed link is fixed', () => {
    const root = checkout()
    const overlay = path.join(temp(), 'hermes-dev-plugins')
    const plugins = prepareDevPluginOverlay(overlay, root, ICLONE)

    fs.rmSync(path.join(root, 'plugins', 'kanban'), { recursive: true })
    fs.mkdirSync(path.join(root, 'plugins', 'web'))
    fs.rmSync(path.join(plugins, 'platforms'))
    fs.symlinkSync('/elsewhere', path.join(plugins, 'platforms'))
    fs.mkdirSync(path.join(plugins, 'stray'))
    fs.mkdirSync(path.join(plugins, 'iclone-planted'))
    fs.mkdirSync(path.join(plugins, 'iclone-permissions'))

    prepareDevPluginOverlay(overlay, root, ICLONE)

    expect(fs.readdirSync(plugins).sort()).toEqual(['__init__.py', 'iclone-permissions', 'platforms', 'web'])
    expect(fs.readlinkSync(path.join(plugins, 'platforms'))).toBe(path.join(root, 'plugins', 'platforms'))
  })

  it('an overlay root (or its plugins/) that is a link is refused; the link target is never written', () => {
    const root = checkout()
    const elsewhere = temp()
    const overlay = path.join(temp(), 'hermes-dev-plugins')
    fs.symlinkSync(elsewhere, overlay)

    expect(() => prepareDevPluginOverlay(overlay, root, ICLONE)).toThrow(/not a real directory/)
    expect(fs.readdirSync(elsewhere)).toEqual([])

    const other = path.join(temp(), 'hermes-dev-plugins')
    fs.mkdirSync(other)
    fs.symlinkSync(elsewhere, path.join(other, 'plugins'))

    expect(() => prepareDevPluginOverlay(other, root, ICLONE)).toThrow(/not a real directory/)
    expect(fs.readdirSync(elsewhere)).toEqual([])
  })
})
