import { describe, expect, it } from 'vitest'

import { isTerminalFocusExit } from './focus-exit'

const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init)

describe('isTerminalFocusExit (U4-p2-10)', () => {
  it('Shift+Tab leaves the terminal', () => {
    expect(isTerminalFocusExit(key({ key: 'Tab', shiftKey: true }))).toBe(true)
  })

  it('Tab, Escape and modified Shift+Tab stay with the pty', () => {
    expect(isTerminalFocusExit(key({ key: 'Tab' }))).toBe(false)
    expect(isTerminalFocusExit(key({ key: 'Escape' }))).toBe(false)
    expect(isTerminalFocusExit(key({ key: 'Tab', shiftKey: true, ctrlKey: true }))).toBe(false)
    expect(isTerminalFocusExit(key({ key: 'Tab', shiftKey: true, metaKey: true }))).toBe(false)
  })
})
