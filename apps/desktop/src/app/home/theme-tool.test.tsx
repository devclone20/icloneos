// Proof run: "the header theme control never sets html.light". No path sets it: the theme system toggles `.dark` and
// publishes data-hermes-theme / data-hermes-mode (themes/context.tsx applyTheme). This pins the cycle end to end.
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { registry } from '@/contrib/registry'
import { ThemeProvider } from '@/themes/context'

import { registerIcloneThemeTool } from './theme-tool'

const root = () => window.document.documentElement

function cycle() {
  const tool = registry.getArea('titleBar.tools.right').find(entry => entry.id === 'iclone-theme-cycle')

  act(() => (tool?.data as { onSelect: () => void }).onSelect())
}

// jsdom refuses the test environment's localStorage as `storageArea`; the app's own Storage passes (proof run, step 7).
const RealStorageEvent = StorageEvent

beforeEach(() => {
  vi.stubGlobal(
    'StorageEvent',
    class extends RealStorageEvent {
      constructor(type: string, init?: StorageEventInit) {
        super(type, { key: init?.key, newValue: init?.newValue })
      }
    }
  )
  window.localStorage.clear()
  window.localStorage.setItem('hermes-desktop-theme-v2', 'iclone-natural')
  window.localStorage.setItem('hermes-desktop-mode-v1', 'dark')
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('the titlebar theme control', () => {
  it('natural, dark, light, natural: light clears .dark and names itself on the root', () => {
    registerIcloneThemeTool()
    render(
      <ThemeProvider>
        <span />
      </ThemeProvider>
    )
    expect(root().dataset.hermesTheme).toBe('iclone-natural')
    expect(root().classList.contains('dark')).toBe(true)

    cycle()
    expect(root().dataset.hermesTheme).toBe('iclone-dark')
    expect(root().classList.contains('dark')).toBe(true)

    cycle()
    expect(root().dataset.hermesTheme).toBe('iclone-light')
    expect(root().dataset.hermesMode).toBe('light')
    expect(root().classList.contains('dark')).toBe(false)
    expect(root().classList.contains('light')).toBe(false)

    cycle()
    expect(root().dataset.hermesTheme).toBe('iclone-natural')
    expect(root().classList.contains('dark')).toBe(true)
  })
})
