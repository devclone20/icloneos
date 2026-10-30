import { describe, expect, it } from 'vitest'

import { previewShortcutDecision } from './preview-shortcut'

describe('previewShortcutDecision', () => {
  it('acts on the keyDown of ⌘W only once per press', () => {
    expect(previewShortcutDecision({ key: 'w', meta: true, type: 'keyDown' }, true)).toEqual({
      action: 'close',
      claim: true
    })
    expect(previewShortcutDecision({ key: 'w', meta: true, type: 'keyUp' }, true)).toEqual({
      action: null,
      claim: true
    })
  })

  it('a held ⌘W acts once: auto-repeat keyDowns are claimed but never act — R3d r4', () => {
    expect(previewShortcutDecision({ isAutoRepeat: true, key: 'w', meta: true, type: 'keyDown' }, true)).toEqual({
      action: null,
      claim: true
    })
  })

  it('treats ⌘R the same way', () => {
    expect(previewShortcutDecision({ key: 'R', meta: true, type: 'keyDown' }, true).action).toBe('reload')
    expect(previewShortcutDecision({ key: 'r', meta: true, type: 'keyUp' }, true)).toEqual({
      action: null,
      claim: true
    })
  })

  it('leaves shifted, alt and unmodified keys alone', () => {
    expect(previewShortcutDecision({ key: 'r', meta: true, shift: true, type: 'keyDown' }, true).claim).toBe(false)
    expect(previewShortcutDecision({ alt: true, key: 'w', meta: true, type: 'keyDown' }, true).claim).toBe(false)
    expect(previewShortcutDecision({ key: 'w', type: 'keyDown' }, true).claim).toBe(false)
    expect(previewShortcutDecision({ key: 'x', meta: true, type: 'keyDown' }, true).claim).toBe(false)
  })

  it('uses Control off macOS', () => {
    expect(previewShortcutDecision({ control: true, key: 'w', type: 'keyDown' }, false).action).toBe('close')
    expect(previewShortcutDecision({ key: 'w', meta: true, type: 'keyDown' }, false).claim).toBe(false)
  })
})
