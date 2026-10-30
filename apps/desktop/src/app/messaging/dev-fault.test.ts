// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'

import { messagingFault } from './dev-fault'

const field = () => window as unknown as Record<string, unknown>

afterEach(() => {
  delete field().__icloneMessagingFault
})

describe('messagingFault', () => {
  it('is inert until something sets the field', () => {
    expect(messagingFault()).toBeUndefined()
  })

  it('reports the two faults a probe may ask for', () => {
    field().__icloneMessagingFault = 'empty'
    expect(messagingFault()).toBe('empty')

    field().__icloneMessagingFault = 'error'
    expect(messagingFault()).toBe('error')
  })

  it('ignores anything else, so a stray value can never change the page', () => {
    for (const stray of ['Empty', 'boom', '', 1, true, null, {}]) {
      field().__icloneMessagingFault = stray
      expect(messagingFault()).toBeUndefined()
    }
  })
})
