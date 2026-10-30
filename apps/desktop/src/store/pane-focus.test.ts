import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LAYOUTS_AREA } from '@/components/pane-shell/tree/presets'
import { registry } from '@/contrib/registry'

import { applyDesktopLayoutPreset, revealDesktopPane } from './pane-focus'

const { applyTree, revealTreePane, setFileBrowserOpen, setSidebarOpen, setTerminalTakeover } = vi.hoisted(() => ({
  applyTree: vi.fn(),
  revealTreePane: vi.fn(),
  setFileBrowserOpen: vi.fn(),
  setSidebarOpen: vi.fn(),
  setTerminalTakeover: vi.fn()
}))

vi.mock('@/app/right-sidebar/store', () => ({ setTerminalTakeover }))
vi.mock('@/components/pane-shell/tree/store', () => ({ applyTree, revealTreePane }))
vi.mock('./layout', () => ({ setFileBrowserOpen, setSidebarOpen }))

describe('revealDesktopPane', () => {
  beforeEach(() => vi.clearAllMocks())

  it("drives each pane's own reveal path", () => {
    revealDesktopPane('chat')
    expect(revealTreePane).toHaveBeenCalledWith('workspace')
    revealDesktopPane('files')
    expect(setFileBrowserOpen).toHaveBeenCalledWith(true)
    revealDesktopPane('sessions')
    expect(setSidebarOpen).toHaveBeenCalledWith(true)
    revealDesktopPane('terminal')
    expect(setTerminalTakeover).toHaveBeenCalledWith(true)
  })

  it('returns false for an unknown pane and touches nothing', () => {
    expect(revealDesktopPane('nope')).toBe(false)
    expect(revealTreePane).not.toHaveBeenCalled()
  })

  // E3r deleted the review pane with its store: the verb must not keep a row
  // that would arm the git-diff / gh refresh subscriptions behind no UI.
  it('no longer answers for the deleted review pane', () => {
    expect(revealDesktopPane('review')).toBe(false)
  })

  it('returns true for a known pane', () => {
    expect(revealDesktopPane('terminal')).toBe(true)
  })
})

// The verb's docstring is a promise to the backend: an id a caller can read
// must resolve. It answers off the `layouts` area through the real presets
// module, so the registry is the only truth — a preset the app stopped
// registering has to answer false, and apply nothing.
describe('applyDesktopLayoutPreset resolves against the live layouts area', () => {
  const DEFAULT_TREE = { type: 'group', id: 'main', panes: ['workspace'], active: 'workspace' } as const

  let dispose = () => {}

  beforeEach(() => {
    vi.clearAllMocks()
    dispose = registry.register({ id: 'default', area: LAYOUTS_AREA, source: 'core', data: DEFAULT_TREE })
  })

  afterEach(() => dispose())

  it('applies the one layout the app seeds', () => {
    expect(applyDesktopLayoutPreset('default')).toBe(true)
    expect(applyTree).toHaveBeenCalledWith(DEFAULT_TREE, 'default')
  })

  it('answers false for an id the app stopped registering, and applies nothing', () => {
    for (const ghost of ['focus', 'quad', 'terminal-deck', '']) {
      expect(applyDesktopLayoutPreset(ghost), ghost).toBe(false)
    }

    expect(applyTree).not.toHaveBeenCalled()
  })
})
