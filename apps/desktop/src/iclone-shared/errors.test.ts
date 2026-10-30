import { describe, expect, it } from 'vitest'

import { errorMessage } from './errors'

describe('errorMessage', () => {
  it('reads the message of an Error (subclasses and empty messages included)', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom')
    expect(errorMessage(new TypeError('bad type'))).toBe('bad type')
    expect(errorMessage(new Error(''), 'fallback')).toBe('')
  })

  it('stringifies anything else', () => {
    expect(errorMessage('plain')).toBe('plain')
    expect(errorMessage(42)).toBe('42')
    expect(errorMessage(undefined)).toBe('undefined')
    expect(errorMessage(null)).toBe('null')
    expect(errorMessage({ message: 'not an Error' })).toBe('[object Object]')
  })

  it('uses the fallback only for falsy non-Error values', () => {
    for (const value of [undefined, null, '', 0, false]) {
      expect(errorMessage(value, 'Unknown error')).toBe('Unknown error')
    }

    expect(errorMessage('real', 'Unknown error')).toBe('real')
    expect(errorMessage(1, 'Unknown error')).toBe('1')
  })

  it('never throws on hostile values', () => {
    const noProto = Object.create(null) as object

    const throwing = {
      toString(): string {
        throw new Error('nope')
      }
    }

    expect(errorMessage(noProto)).toBe('[object Object]')
    expect(errorMessage(throwing)).toBe('[object Object]')
    expect(errorMessage(Symbol('s'))).toBe('Symbol(s)')
  })
})
