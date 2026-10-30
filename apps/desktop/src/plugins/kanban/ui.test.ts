import { describe, expect, it } from 'vitest'

import { errText } from './ui'

describe('errText', () => {
  it('pulls the detail out of a bridge error', () => {
    expect(errText(new Error('409: {"detail":"Task is locked"}'))).toBe('Task is locked')
    expect(errText(new Error('no json {here'))).toBe('no json {here')
  })

  it('keeps the old text for a string, undefined and a plain object', () => {
    expect(errText('plain')).toBe('plain')
    expect(errText(undefined)).toBe('undefined')
    expect(errText({ code: 1 })).toBe('[object Object]')
  })
})
