import { describe, expect, it } from 'vitest'

import type { InftAcpStatus } from './acp-setup'
import { activeInftConfigured } from './inft-profile-configured'

const probe = (configured: boolean) => ({ configured }) as InftAcpStatus

describe('activeInftConfigured', () => {
  it('prefers the config-map probe over a stale roster card', () => {
    expect(activeInftConfigured('inft-7', { 'inft-7': probe(true) }, { configured: false })).toBe(true)
    expect(activeInftConfigured('inft-7', { 'inft-7': probe(false) }, { configured: true })).toBe(false)
  })

  it('falls back to the roster card when the slug was never probed', () => {
    expect(activeInftConfigured('inft-7', {}, { configured: true })).toBe(true)
    expect(activeInftConfigured('inft-7', {}, undefined)).toBe(false)
  })

  it('is false without an active iNFT', () => {
    expect(activeInftConfigured(undefined, { 'inft-7': probe(true) }, { configured: true })).toBe(false)
  })
})
