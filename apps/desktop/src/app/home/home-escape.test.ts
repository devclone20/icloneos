import { renderHook } from '@testing-library/react'
import { createElement, StrictMode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { $msgSidebarOpen, setMsgSidebarOpen } from '@/app/chat/sidebar/msg-sidebar-state'

import { closeMessageWindow, homeEscapeTarget, useMsgSidebarResetOnLeave } from './home-escape'

const base = { collectionsOpen: false, econ: false, editable: false, expanded: false, mode: 'window' as const }

describe('homeEscapeTarget', () => {
  it('closes an open inner panel before the econ window (U3-p2-12-p2b)', () => {
    expect(homeEscapeTarget({ ...base, econ: true, panel: true })).toBe('econ-panel')
    expect(homeEscapeTarget({ ...base, econ: true, panel: false })).toBe('econ')
    expect(homeEscapeTarget({ ...base, econ: true })).toBe('econ')
  })

  it('closes the Message window on Escape, like every Dock window (U4-p2-02)', () => {
    expect(homeEscapeTarget(base)).toBe('message')
  })

  it('leaves Escape to a text field inside the Message window', () => {
    expect(homeEscapeTarget({ ...base, editable: true })).toBe(null)
  })

  it('closes the innermost layer first: econ, then the island, then the window', () => {
    expect(homeEscapeTarget({ ...base, econ: true, collectionsOpen: true })).toBe('econ')
    expect(homeEscapeTarget({ ...base, collectionsOpen: true })).toBe('collections')
    expect(homeEscapeTarget({ ...base, mode: 'stage' })).toBe('stage')
    expect(homeEscapeTarget({ ...base, mode: 'stage', editable: true })).toBe('stage')
  })

  it('an expanded window retracts before it closes (doc 07 #7; STAGE tester 1 W-1)', () => {
    // The econ window: its inner panel first, then the retract, then the close.
    expect(homeEscapeTarget({ ...base, econ: true, expanded: true, panel: true })).toBe('econ-panel')
    expect(homeEscapeTarget({ ...base, econ: true, expanded: true })).toBe('retract')
    expect(homeEscapeTarget({ ...base, econ: true, expanded: true, collectionsOpen: true })).toBe('retract')
    expect(homeEscapeTarget({ ...base, econ: true, expanded: false })).toBe('econ')
    // The Message window: the island over it first, then the retract — from a text field too — then the close.
    expect(homeEscapeTarget({ ...base, expanded: true, collectionsOpen: true })).toBe('collections')
    expect(homeEscapeTarget({ ...base, expanded: true })).toBe('retract')
    expect(homeEscapeTarget({ ...base, expanded: true, editable: true })).toBe('retract')
    expect(homeEscapeTarget({ ...base, expanded: false })).toBe('message')
    // Nothing to retract on the bare stage.
    expect(homeEscapeTarget({ ...base, mode: 'stage', expanded: true })).toBe('stage')
  })
})

describe('closeMessageWindow', () => {
  it('clears the sidebar store exactly on the explicit close, then closes (UF2B2-r2-C1)', () => {
    const onClose = vi.fn(() => {
      // The store is already clear when the host navigates away.
      expect($msgSidebarOpen.get()).toBe(false)
    })

    setMsgSidebarOpen(true)
    closeMessageWindow(onClose)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect($msgSidebarOpen.get()).toBe(false)
  })
})

describe('useMsgSidebarResetOnLeave', () => {
  const wrapper = ({ children }: { children: React.ReactNode }) => createElement(StrictMode, null, children)

  it('clears the store when the home leaves the Message window by any path (UF2B2-r3-C1)', () => {
    setMsgSidebarOpen(true)

    const hook = renderHook(({ mode }) => useMsgSidebarResetOnLeave(mode), {
      initialProps: { mode: 'window' as 'stage' | 'window' },
      wrapper
    })

    expect($msgSidebarOpen.get()).toBe(true)

    hook.rerender({ mode: 'stage' })
    expect($msgSidebarOpen.get()).toBe(false)
  })

  it('keeps a pre-set sent just before the open, under StrictMode', () => {
    const hook = renderHook(({ mode }) => useMsgSidebarResetOnLeave(mode), {
      initialProps: { mode: 'stage' as 'stage' | 'window' },
      wrapper
    })

    expect($msgSidebarOpen.get()).toBe(false)

    setMsgSidebarOpen(true)
    hook.rerender({ mode: 'window' })
    expect($msgSidebarOpen.get()).toBe(true)
  })
})
