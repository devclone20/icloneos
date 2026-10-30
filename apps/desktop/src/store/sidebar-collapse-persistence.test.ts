import { beforeEach, describe, expect, it, vi } from 'vitest'

// Ground-truth repro for "hiding the sidebar doesn't persist on reload": drive
// the REAL stores, then re-import them (fresh module state reading persisted
// localStorage) to simulate a ⌃R reload. `bind` mirrors the controller wiring.
async function loadStores() {
  const layout = await import('./layout')
  const tree = await import('@/components/pane-shell/tree/store')

  return {
    layout,
    tree,
    bind: () => tree.bindTreeSideVisibility('left', layout.$sidebarOpen, layout.setSidebarOpen),
    leftCollapsed: () => tree.$collapsedTreeSides.get().has('left')
  }
}

const reload = () => vi.resetModules() // fresh modules; localStorage is the carry-over

describe('sidebar collapse persistence', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.resetModules()
  })

  it('restores a hidden sidebar after a reload', async () => {
    const s1 = await loadStores()
    s1.bind()
    s1.layout.setSidebarOpen(false)
    expect(s1.leftCollapsed()).toBe(true)

    reload()
    const s2 = await loadStores()
    expect(s2.layout.$sidebarOpen.get()).toBe(false) // persisted open:false survives
    s2.bind()
    expect(s2.leftCollapsed()).toBe(true) // and re-collapses
  })

  // What the reported repro is really about: the toggle must stay TRUTHFUL
  // across a reload in BOTH directions, or a stale-collapsed column flips the
  // next ⌘B into the wrong verb and the user's hide never appears to persist.
  // This case used to drive the "restore everything" layout reset through the
  // dev-only automation hook; that verb is deleted (E3b r5 — no shipped build
  // could reach it), so the repro drives the production path it really guards.
  it('keeps the toggle truthful across a reload in both directions', async () => {
    const s1 = await loadStores()
    const { group, split } = await import('@/components/pane-shell/tree/model')
    s1.tree.declareDefaultTree(split('row', [group(['sessions']), group(['workspace'])], [1, 3]))
    s1.bind()

    s1.layout.setSidebarOpen(false) // hidden BEFORE the reload
    expect(s1.leftCollapsed()).toBe(true)

    reload()
    const s2 = await loadStores()
    s2.bind()
    expect(s2.leftCollapsed()).toBe(true) // still hidden, and the column agrees

    s2.layout.setSidebarOpen(true) // ⌘B after the reload SHOWS
    expect(s2.leftCollapsed()).toBe(false)

    s2.layout.setSidebarOpen(false) // and the next hide sticks
    expect(s2.layout.$sidebarOpen.get()).toBe(false)
    expect(s2.leftCollapsed()).toBe(true)

    reload()
    const s3 = await loadStores()
    expect(s3.layout.$sidebarOpen.get()).toBe(false)
    s3.bind()
    expect(s3.leftCollapsed()).toBe(true)
  })
})
