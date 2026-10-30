import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it, vi } from 'vitest'

import { en } from '@/i18n/en'

import { appRoutes, ARTIFACTS_ROUTE, REMOVED_ROUTES, STARMAP_ROUTE } from '../routes'

import { PALETTE_PAGES } from './pages'
import { routeCommands } from './routes-commands'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', '..')

/**
 * Doors into a palette page that live in files this front does not own. Each
 * line is a LEAD ASK (front G2 owns `slash.ts`), never an allowance: a NEW
 * dead door fails the test, and so does an entry whose door is already gone,
 * so the list only ever shrinks.
 */
const CROSS_FRONT_DEAD_DOORS: string[] = []

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name)

    if (entry.isDirectory()) {
      return entry.name === 'node_modules' ? [] : sourceFiles(full)
    }

    return /\.tsx?$/.test(entry.name) && !entry.name.includes('.test.') ? [full] : []
  })

const run = (path: string) => () => path

describe('routeCommands', () => {
  it('offers exactly the registered routes it has a label for', () => {
    const items = routeCommands(en, run)
    const registered = appRoutes().map(route => route.path)

    expect(items.length).toBeGreaterThan(0)

    for (const item of items) {
      expect(item.label.length).toBeGreaterThan(0)
      // `run` is built from the registry's own path, never from a literal here.
      expect(registered).toContain((item.run as () => string)())
    }
  })

  it('never offers a removed page (the doors that lied twice)', () => {
    const paths = routeCommands(en, run).map(item => (item.run as () => string)())

    expect(paths).not.toContain(ARTIFACTS_ROUTE)
    expect(paths).not.toContain(STARMAP_ROUTE)

    for (const removed of REMOVED_ROUTES) {
      expect(paths).not.toContain(removed)
    }
  })

  it('leaves the home stage out on purpose, and ids follow the route id', () => {
    const items = routeCommands(en, run)

    expect(items.map(item => item.id)).not.toContain('nav-home')

    for (const item of items) {
      expect(item.id).toMatch(/^nav-[a-z-]+$/)
    }
  })

  it('keeps the curated order: a new session first, then settings', () => {
    const ids = routeCommands(en, run).map(item => item.id)

    expect(ids.indexOf('nav-new')).toBe(0)
    expect(ids.indexOf('nav-settings')).toBe(1)
    expect(ids).not.toContain('nav-agents')
  })

  it('shrinks with the registry: a page that stops declaring its route stops being offered', async () => {
    vi.resetModules()
    vi.doMock('../routes', () => ({
      appRoutes: () => [{ id: 'skills', path: '/skills', view: 'skills', overlay: true }]
    }))

    const { routeCommands: scoped } = await import('./routes-commands')

    expect(scoped(en, run).map(item => item.id)).toEqual(['nav-skills'])

    vi.doUnmock('../routes')
    vi.resetModules()
  })
})

describe('palette sub-pages', () => {
  const index = readFileSync(join(HERE, 'index.tsx'), 'utf8')

  it('declares exactly the pages the subPages map builds', () => {
    // `PALETTE_PAGES` is what a door is allowed to name; the map is what the
    // sheet can actually render. If they drift, a door points at nothing and
    // the palette shows the root list as if that were the answer.
    const map = index.slice(index.indexOf('const subPages'), index.indexOf('const activePage'))
    const built = [...map.matchAll(/^ {6}'?([a-z-]+)'?: \{$/gm)].map(match => match[1])

    expect(built.length).toBe(PALETTE_PAGES.length)
    expect([...built].sort()).toEqual([...PALETTE_PAGES].sort())
  })

  it('has no door anywhere in the tree that opens a page nobody builds', () => {
    // Tree-wide on purpose: the doors live in files this front does not own
    // (a slash command, Settings, a keybind), so a check scoped to the palette
    // can never see the one that breaks.
    const dead: string[] = []

    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8')

      if (!text.includes('openCommandPalettePage(')) {
        continue
      }

      for (const match of text.matchAll(/openCommandPalettePage\(\s*'([^']+)'/g)) {
        if (!(PALETTE_PAGES as readonly string[]).includes(match[1])) {
          dead.push(`${relative(SRC, file)} → '${match[1]}'`)
        }
      }
    }

    // A dead door in a file this front owns is a defect to fix here. One in
    // another front's file is a hand-off, listed above — and the second
    // assertion makes that list self-expiring, so it can never rot into a
    // standing exception that keeps a deleted page's label alive.
    expect(dead.filter(door => !CROSS_FRONT_DEAD_DOORS.includes(door))).toEqual([])
    expect(CROSS_FRONT_DEAD_DOORS.filter(door => !dead.includes(door))).toEqual([])
  })

  it('reports a door into nothing without throwing out of the effect', () => {
    // THIS test is the hard failure for a dead door, which is why the runtime
    // guard does not need to be one. The effect that reads the id is mounted
    // under the app's root error boundary (index.tsx -> contrib/wiring.tsx ->
    // main.tsx), so a throw there replaced the WHOLE window in dev builds
    // instead of refusing one row. Pinned at the source so the crash path
    // cannot come back as a well-meant "make it loud" edit.
    const guard = /if \(!isPalettePage\(pendingPage\)\) \{([\s\S]+?)\n {4}\}/.exec(index)

    expect(guard).not.toBeNull()
    expect(guard?.[1]).toContain('console.error(')
    expect(guard?.[1]).not.toContain('throw')
  })
})
