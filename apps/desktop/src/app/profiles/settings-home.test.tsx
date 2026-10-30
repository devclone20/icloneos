/**
 * Profiles lives INSIDE Settings (front K3, owner request 2026-10-19).
 *
 * The owner's complaint was about LOCATION, not reachability: Profiles was
 * reachable from Settings by LEAVING Settings, through a cross-link at the
 * bottom of the Workspace pane. These tests pin the three facts that make the
 * new home real and keep it real: the rail carries the topic, the pane loads
 * the page lazily (so opening Settings does not pay for 15 files), and NOTHING
 * in the app navigates to the page route any more — which is the invariant a
 * careless future edit would break first.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isValidElement, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { en } from '@/i18n/en'

import { routeCommands } from '../command-palette/routes-commands'
import {
  appViewForPath,
  PROFILES_PANE,
  PROFILES_ROUTE,
  REMOVED_ROUTES,
  routeSessionId,
  SETTINGS_ROUTE
} from '../routes'
import {
  buildSettingsNavRows,
  renderSettingsPane,
  SETTINGS_VIEWS,
  type SettingsPaneContext,
  type SettingsPaneId
} from '../settings/panes'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', '..')

/** The only files allowed to mention the page route: the registry that reserves
 *  it, and the registry's own test. Every other mention would be a door.
 *  `contrib/surfaces.tsx` is here because its mention is the OPPOSITE of a
 *  door: it answers the legacy path with nothing at all (asserted below), which
 *  `:sessionId` would otherwise swallow as a phantom session. */
const ROUTE_MENTION_ALLOWED = [
  'app/contrib/surfaces.test.tsx',
  'app/contrib/surfaces.tsx',
  'app/profiles/settings-home.test.tsx',
  'app/routes.test.ts',
  'app/routes.ts'
]

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name)

    if (entry.isDirectory()) {
      return entry.name === 'node_modules' ? [] : sourceFiles(full)
    }

    return /\.tsx?$/.test(entry.name) ? [full] : []
  })

function paneContext(activeView: SettingsPaneId): SettingsPaneContext {
  return {
    activeView,
    importInputRef: { current: null },
    keysView: 'tools',
    navigate: vi.fn(),
    onClose: vi.fn(),
    onKeysViewChange: vi.fn(),
    onNavigateView: vi.fn(),
    onProviderViewChange: vi.fn(),
    providerView: 'accounts',
    t: en
  }
}

/** Every element in a rendered tree, without mounting it: these panes host the
 *  whole settings surface, and the facts under test are structural. */
function elements(node: ReactNode): React.ReactElement[] {
  if (Array.isArray(node)) {
    return node.flatMap(elements)
  }

  if (!isValidElement(node)) {
    return []
  }

  const { children } = node.props as { children?: ReactNode }

  return [node, ...elements(children)]
}

const LAZY = Symbol.for('react.lazy')

describe('Profiles as a Settings topic', () => {
  it('has its own row in the rail, under Profile', () => {
    const rows = buildSettingsNavRows(paneContext('profiles'), { expanded: new Set(), toggle: () => {} })
    const index = rows.findIndex(row => row.id === 'profiles')

    expect(index).toBeGreaterThan(0)
    expect(rows[index]).toMatchObject({ active: true, label: en.profiles.title })

    const heading = rows.slice(0, index).findLast(row => 'kind' in row && row.kind === 'heading')

    expect(heading?.id).toBe('group:profile')
  })

  it('is a deep link, so `?tab=profiles` lands on it', () => {
    expect(PROFILES_PANE).toBe(`${SETTINGS_ROUTE}?tab=profiles`)
    expect(SETTINGS_VIEWS).toContain('profiles')
  })

  it('loads the page lazily: opening Settings does not pay for 15 files', () => {
    const lazies = elements(renderSettingsPane(paneContext('profiles'))).filter(
      element => typeof element.type === 'object' && (element.type as { $$typeof?: symbol }).$$typeof === LAZY
    )

    expect(lazies).toHaveLength(1)
  })

  it('left the Workspace pane with no cross-link out of Settings', () => {
    const titles = elements(renderSettingsPane(paneContext('config:workspace'))).map(
      element => (element.props as { title?: unknown }).title
    )

    expect(titles).not.toContain(en.profiles.title)
  })

  it('is not offered as a palette destination any more (the row went to its path)', () => {
    const paths = routeCommands(en, (path: string) => () => path).map(item => (item.run as () => string)())

    expect(paths).not.toContain(PROFILES_ROUTE)
  })

  it('leaves no door that navigates to the page route', () => {
    const offenders = sourceFiles(SRC)
      .map(file => ({ rel: relative(SRC, file).replaceAll('\\', '/'), text: readFileSync(file, 'utf8') }))
      .filter(({ rel, text }) => text.includes('PROFILES_ROUTE') && !ROUTE_MENTION_ALLOWED.includes(rel))
      .map(({ rel }) => rel)

    expect(offenders).toEqual([])
  })

  // The location defect in one word was `overlay: true` in the page's own
  // route.ts. A page with no route.ts cannot be travelled to, which is what
  // makes the Settings pane the ONLY home rather than merely the newest door.
  it('declares no route of its own any more, so it has one home', () => {
    const declarations = readdirSync(HERE).filter(name => name === 'route.ts')

    expect(declarations).toEqual([])
  })

  // ANSWERED, not redirected, and not dropped. r2 shipped a <Navigate> here and
  // r3 measured it on lab 2 (2026-10-20, CDP 9224): `#/profiles` keeps its hash
  // and renders the home stage with the Dock — the same 180 characters of body
  // text as `#/artifacts` — because `appViewForPath` resolves a REMOVED_ROUTES
  // path to 'home' before the chat surface routes, so that element could never
  // run. What the path needs is a RESERVATION: `:sessionId` matches before the
  // catch-all, so an unanswered `/profiles` would open a phantom session.
  it('reserves the legacy address and lands it on home, claiming nothing more', () => {
    expect(REMOVED_ROUTES).toContain(PROFILES_ROUTE)
    expect(routeSessionId(PROFILES_ROUTE)).toBeNull()
    expect(appViewForPath(PROFILES_ROUTE)).toBe('home')

    const surfaces = readFileSync(join(SRC, 'app', 'contrib', 'surfaces.tsx'), 'utf8')

    expect(surfaces).toContain('<Route element={null} path={PROFILES_ROUTE.slice(1)} />')
  })

  // The defect this test exists for is not the landing, it is a CLAIM about the
  // landing: a gate item, a test and two comments once said "redirects" over
  // behaviour that never happened. No element anywhere may send this address
  // somewhere the shell cannot take it. (The prose half of the same claim is
  // policed by the front gate, where a planted comment proves the item reds.)
  it('declares no element that sends the legacy address anywhere', () => {
    const offenders = sourceFiles(SRC)
      .map(file => ({ rel: relative(SRC, file).replaceAll('\\', '/'), text: readFileSync(file, 'utf8') }))
      .filter(({ text }) => /<Navigate[^>]{0,80}PROFILES_PANE/.test(text.replace(/\s+/g, ' ')))
      .map(({ rel }) => rel)

    expect(offenders).toEqual([])
  })

  // Only the Settings pane may mount the page. A second mount anywhere is the
  // overlay coming back under another name.
  it('is mounted by Settings and by nothing else', () => {
    const mounts = sourceFiles(SRC)
      .map(file => ({ rel: relative(SRC, file).replaceAll('\\', '/'), text: readFileSync(file, 'utf8') }))
      .filter(({ text }) => text.includes('<ProfilesView'))
      .map(({ rel }) => rel)
      .sort()

    expect(mounts).toEqual([
      'app/profiles/index.test.tsx',
      'app/profiles/settings-home.test.tsx',
      'app/settings/panes.tsx'
    ])
  })
})
