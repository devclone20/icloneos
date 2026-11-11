import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createConfirmTracker, isPermModeShortcutTarget } from './agent-update-confirm'

const tracker = (now = () => 1000) =>
  createConfirmTracker({
    isConfirmTarget: target => target === 'row',
    isShortcutTarget: target => target === 'menu',
    now
  })

const digit = (over: Record<string, unknown> = {}) => ({
  isTrusted: true,
  key: '3',
  target: 'menu',
  type: 'keydown',
  ...over
})

describe('G20: a digit in the open selector counts as the user own key, under the same lock', () => {
  it('a trusted digit on the menu counts, once', () => {
    const lock = tracker()

    lock.observe(digit())
    expect(lock.take()).toBe(true)
    expect(lock.take()).toBe(false)
  })

  it.each(['1', '2', '3', '4', '5'])('digit %s counts', key => {
    const lock = tracker()

    lock.observe(digit({ key }))
    expect(lock.take()).toBe(true)
  })

  it.each([
    ['a script event', { isTrusted: false }],
    ['elsewhere in the window', { target: 'composer' }],
    ['a row without the shortcut mark does not widen the row', { target: 'row' }],
    ['Cmd', { metaKey: true }],
    ['Ctrl', { ctrlKey: true }],
    ['Alt', { altKey: true }],
    ['a held key', { repeat: true }],
    ['no such row', { key: '6' }],
    ['no such row, zero', { key: '0' }],
    ['a letter', { key: 'a' }]
  ])('refused: %s', (_name, over) => {
    const lock = tracker()

    lock.observe(digit(over))
    expect(lock.take()).toBe(false)
  })

  it('the proof goes stale in the same window as a click', () => {
    let at = 1000
    const lock = tracker(() => at)

    lock.observe(digit())
    at = 3000
    expect(lock.take()).toBe(false)
  })

  it('every other lock keeps its keys: a tracker with no shortcut target takes no digit', () => {
    const lock = createConfirmTracker({ isConfirmTarget: () => true, now: () => 1000 })

    lock.observe(digit())
    expect(lock.take()).toBe(false)
    lock.observe(digit({ key: 'Enter' }))
    expect(lock.take()).toBe(true)
  })

  it('Space and Enter on a marked row still count', () => {
    const lock = tracker()

    lock.observe(digit({ key: ' ', target: 'row' }))
    expect(lock.take()).toBe(true)
    lock.observe(digit({ key: 'Enter', target: 'row' }))
    expect(lock.take()).toBe(true)
  })
})

describe('G20: where a digit is the selector shortcut', () => {
  const element = (found: Record<string, boolean>) => ({
    closest: (selector: string) => (found[selector] ? {} : null)
  })

  const MENU = '[data-perm-mode-shortcuts]'
  const FIELD = 'input, textarea, select, [contenteditable]'

  it('inside the open selector, in the focused window', () => {
    expect(isPermModeShortcutTarget(element({ [MENU]: true }), true)).toBe(true)
  })

  it('not with the window unfocused, not outside the menu, not from a text field, not from a non-element', () => {
    expect(isPermModeShortcutTarget(element({ [MENU]: true }), false)).toBe(false)
    expect(isPermModeShortcutTarget(element({}), true)).toBe(false)
    expect(isPermModeShortcutTarget(element({ [FIELD]: true, [MENU]: true }), true)).toBe(false)
    expect(isPermModeShortcutTarget(window_(), true)).toBe(false)
    expect(isPermModeShortcutTarget(null, true)).toBe(false)
  })

  function window_() {
    return {}
  }

  it('only the permission lock is given the shortcut, and the preload passes it what it needs', () => {
    const preload = readFileSync(join(__dirname, 'preload.ts'), 'utf8')

    expect(preload.match(/isShortcutTarget:/g)).toHaveLength(1)
    expect(preload).toContain('isShortcutTarget: target => isPermModeShortcutTarget(target, document.hasFocus())')
    expect(preload).toContain('repeat: keyboard?.repeat')
    expect(preload).toContain('metaKey: keyboard?.metaKey')
    expect(preload).toContain('ctrlKey: keyboard?.ctrlKey')
    expect(preload).toContain('altKey: keyboard?.altKey')
  })
})
