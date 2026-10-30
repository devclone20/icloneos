import { describe, expect, it } from 'vitest'

import { kindError } from './kind-error'

describe('kindError', () => {
  it('tags the error and keeps the cause enumerable', () => {
    const cause = new Error('inner')
    const err = kindError('superseded', 'later settings won', { cause })
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe('later settings won')
    expect(err.kind).toBe('superseded')
    expect(Object.keys(err)).toEqual(expect.arrayContaining(['kind', 'cause']))
    expect((err as Error & { cause?: unknown }).cause).toBe(cause)
  })

  it('works without extra', () => {
    expect(kindError('timeout', 'slow').kind).toBe('timeout')
  })
})
