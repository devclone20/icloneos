import { describe, expect, it } from 'vitest'

import { normalizeOpenRequests, SettledIds } from './replay'

describe('open_requests replay helpers', () => {
  it('keeps well-formed entries and stringifies ids', () => {
    expect(
      normalizeOpenRequests([
        { id: 'srq-1', method: 'clarify', params: { session_id: 's1' } },
        { id: 7, method: 'sudo' },
        { id: 'srq-2' },
        'garbage',
        null
      ])
    ).toEqual([
      { id: 'srq-1', method: 'clarify', params: { session_id: 's1' } },
      { id: '7', method: 'sudo', params: {} }
    ])
    expect(normalizeOpenRequests(undefined)).toEqual([])
  })

  it('bounds the settled set, evicting the oldest id', () => {
    const ids = new SettledIds(2)
    ids.add('a')
    ids.add('b')
    ids.add('c')

    expect([ids.has('a'), ids.has('b'), ids.has('c')]).toEqual([false, true, true])
  })
})
