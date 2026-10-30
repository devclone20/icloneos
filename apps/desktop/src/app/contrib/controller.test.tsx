/**
 * Architecture guard for the app root (E3 §5, front E3b). The chat engine has
 * ONE surface mount per window: a second one is a second composer and a second
 * submit path on the same session, which drops messages. jsdom cannot mount
 * the real root (it pulls the whole app in), so the invariants are read off the
 * sources — the same way the shared head geometry is pinned in msg-window.test.
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), 'utf8')
const controller = read('src/app/contrib/controller.tsx')
const store = read('src/components/pane-shell/tree/store.ts')
const count = (text: string, needle: string) => text.split(needle).length - 1

describe('the chat surface has exactly one owner per window', () => {
  // Every file that may mount the wired chat surface, and why it is allowed to.
  const OWNERS = {
    'src/app/home/msg-window.tsx': 'the Message window (main window, chat route)',
    'src/app/contrib/controller.tsx': 'the page host for contributed full-page views',
    'src/app/hud/hud-shell.tsx': 'the HUD window, which is its own window'
  }

  it('mounts `part="chatRoutes"` once per owner and nowhere else', () => {
    for (const [file, why] of Object.entries(OWNERS)) {
      expect(count(read(file), 'part="chatRoutes"'), `${file} — ${why}`).toBe(1)
    }
  })

  it('wires the gateway, sessions and streams once per window branch', () => {
    // One <ContribWiring> per window branch (HUD, popped-out browser, main) and
    // every one of them closed: the provider must mount exactly once.
    expect(count(controller, '<ContribWiring>')).toBe(3)
    expect(count(controller, '</ContribWiring>')).toBe(3)
    expect(count(controller, '<WorkspacePageHost />')).toBe(1)
  })
})

describe('the upstream pane layout is gone from the root', () => {
  it('the root imports no pane-shell renderer and paints no upstream shell', () => {
    expect(controller).not.toContain('pane-shell/tree/renderer')
    expect(controller).not.toContain('pane-shell/edit-mode')
    expect(controller).not.toContain('LayoutTreeRoot')
    // The shell's full-window opaque painter and its titlebar row marker.
    expect(controller).not.toContain('data-contrib-shell')
    // Nothing to seal off any more: the host holds the surface alone.
    expect(controller).not.toContain('sealAllBut')
  })

  it('the tab strips, drag handles, zone editor and layout picker are deleted, not unmounted', () => {
    for (const gone of [
      'src/components/pane-shell/tree/renderer/index.tsx',
      'src/components/pane-shell/tree/renderer/tree-group.tsx',
      'src/components/pane-shell/tree/renderer/tree-split.tsx',
      'src/components/pane-shell/tree/renderer/tree-node.tsx',
      'src/components/pane-shell/tree/renderer/edit-bar.tsx',
      'src/components/pane-shell/tree/renderer/layout-picker.tsx',
      'src/components/pane-shell/tree/renderer/narrow-overlays.tsx',
      'src/components/pane-shell/tree/renderer/floating-panes.tsx',
      'src/components/pane-shell/tree/renderer/tab-strip-scroll.ts',
      'src/components/pane-shell/tree/zone-editor.tsx',
      'src/components/pane-shell/tree/grid-model.ts',
      'src/components/pane-shell/tree/grid-to-tree.ts',
      'src/components/pane-shell/geometry.ts',
      'src/components/pane-shell/edit-mode.tsx'
    ]) {
      expect(existsSync(resolve(process.cwd(), gone)), gone).toBe(false)
    }
  })

  it('keeps no palette or keybind door onto a layout that cannot be seen', () => {
    for (const dead of ['layout.editMode', 'layout.reset', 'view.toggleTabStrip', 'logs.toggle', 'strip-tab.']) {
      expect(controller, dead).not.toContain(`'${dead}`)
    }
  })

  // The same doors outside the root: the keybind handler map and the app
  // context menu were the last two call sites into the deleted tab strip, and
  // the menu also carried E3a's status-bar row. Call sites, not just ids — the
  // imports go with them, so a re-added row cannot compile silently.
  it('leaves no keybind handler or menu row reaching the deleted tab strip or status bar', () => {
    const keybinds = read('src/app/hooks/use-keybinds.ts')
    const menu = read('src/app/context-menu/app-context-menu.tsx')

    for (const dead of ['toggleTargetZoneTabStrip', 'view.toggleTabStrip']) {
      expect(keybinds, dead).not.toContain(dead)
      expect(menu, dead).not.toContain(dead)
    }

    for (const dead of ['toggleStatusbarVisible', 'view.toggleStatusbar']) {
      expect(menu, dead).not.toContain(dead)
    }
  })
})

describe('the upstream files and review sidebars are gone from the root', () => {
  // E3c r4, contract E3 §3: the file browser and the git-review sidebar were
  // upstream Hermes surfaces. Unmounting them would have left the cluster
  // reachable, so the panes are UNREGISTERED and the code is deleted — these
  // cases pin both halves at the source, where the registry cannot be mocked.
  const panes = read('src/app/contrib/panes.tsx')
  const wiring = read('src/app/contrib/wiring.tsx')

  it('registers neither pane and imports neither renderer', () => {
    for (const dead of ["id: 'files'", "id: 'review'", 'FilesPane', 'ReviewPaneContent']) {
      expect(controller, dead).not.toContain(dead)
    }
  })

  it('binds no visibility, closer or seed zone to a pane that no longer exists', () => {
    for (const dead of ['bindPaneVisibility', 'registerPaneCloser', 'grp-files', 'grp-review']) {
      expect(controller, dead).not.toContain(dead)
    }
  })

  it('sweeps both ids out of a layout tree an older install persisted', () => {
    // The seed no longer names them, but a tree saved by the shipped v0.0.0.1
    // does — and a stale id there is an empty zone next to the chat.
    const sweep = controller.match(/for \(const staleId of \[[^\]]*\]\)/)?.[0] ?? ''

    expect(sweep).toContain("'files'")
    expect(sweep).toContain("'review'")
  })

  it('leaves no contrib file importing the deleted cluster', () => {
    for (const source of [controller, panes, wiring]) {
      expect(source).not.toContain('right-sidebar/files')
      expect(source).not.toContain('right-sidebar/review')
      expect(source).not.toContain('right-sidebar/file-actions')
      expect(source).not.toContain("from '@/app/right-sidebar'")
    }
  })
})

describe('the agent-facing layout verb stays honest', () => {
  // `apply_layout` resolves its id against the `layouts` area. E3 deleted the
  // picker and the focus / quad / terminal-deck presets, so the verb is only
  // truthful while the root registers the one layout that is left.
  it('registers exactly one core layout, and it is the seed the verb names', () => {
    const rows = controller.match(/registry\.register\(\{[^}]*area: LAYOUTS_AREA[^}]*\}\)/g) ?? []

    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain("id: 'default'")
    expect(rows[0]).toContain('data: DEFAULT_TREE')
  })

  it('resolves that id through the same area the registration writes to', () => {
    const resolver = read('src/store/pane-focus.ts')

    expect(resolver).toContain('.getArea(LAYOUTS_AREA)')
    expect(resolver).toContain("import { applyLayoutPreset, LAYOUTS_AREA } from '@/components/pane-shell/tree/presets'")
  })
})

describe('the deleted UI took its machinery with it', () => {
  // A supplier whose only consumer was a deleted renderer is dead code, not
  // API: each of these was proven unimported (knip + a text sweep) before it
  // went, so a re-export here would be a door onto nothing all over again.
  it('the layout store exports no tab-strip reader, sash writer or preset reader', () => {
    for (const gone of [
      'export function targetZoneTabStripVisible',
      'export function setTreeSplitWeights',
      'export function presetSplitWeights',
      'export function collapseTreePane',
      'export function trackActiveTreeGroup',
      'export function noteHoveredTreeGroup',
      'export function toggleTargetZoneTabStrip'
    ]) {
      expect(store, gone).not.toContain(gone)
    }
  })

  it('the track model and the presets module keep only what is imported', () => {
    const track = read('src/components/pane-shell/tree/renderer/track-model.ts')
    const presets = read('src/components/pane-shell/tree/presets.ts')

    for (const gone of ['MIN_PANE_PX', 'fixedTrackSize', 'edgeFixedZone', 'resolveCssPx', 'MINIMIZED_TRACK']) {
      expect(track, gone).not.toContain(`export const ${gone}`)
      expect(track, gone).not.toContain(`export function ${gone}`)
    }

    // Nothing can save a layout any more, so nothing may pretend to.
    for (const gone of ['saveLayoutPresetTree', 'saveCurrentLayoutAs', 'deleteUserPreset', 'isUserPreset']) {
      expect(presets, gone).not.toContain(gone)
    }
  })

  it('the tests of the deleted tab strips are deleted too', () => {
    for (const gone of ['src/components/pane-shell/tree/hovered-zone-tabs.test.ts']) {
      expect(existsSync(resolve(process.cwd(), gone)), gone).toBe(false)
    }
  })
})
