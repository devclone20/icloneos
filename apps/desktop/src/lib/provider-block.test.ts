import { beforeEach, describe, expect, it } from 'vitest'

import {
  $providerBlock,
  isAuthRejection,
  noteTurnFailure,
  noteTurnSuccess,
  providerBlockCta,
  providerBlockFromSurface,
  providerBlockMessage
} from './provider-block'

beforeEach(() => $providerBlock.set(null))

describe('provider block', () => {
  it('auth layer → auth block with the settings CTA', () => {
    noteTurnFailure({ layer: 'auth', code: 'auth', retryable: false, provider: 'anthropic', model: 'claude-opus-5-5' })

    const block = $providerBlock.get()

    expect(block?.kind).toBe('auth')
    expect(providerBlockCta(block!)).toBe('Open Settings → Providers')
    expect(providerBlockMessage(block!)).not.toMatch(/sk-|key=|bearer/i)
  })

  it('model_not_found → model block; billing → nothing', () => {
    expect(providerBlockFromSurface({ layer: 'provider', code: 'model_not_found', retryable: false })?.kind).toBe(
      'model'
    )
    expect(providerBlockFromSurface({ layer: 'billing', code: 'billing', retryable: false })).toBeNull()
  })

  it('clears only on a clean completion of the same provider/model', () => {
    noteTurnFailure({ layer: 'auth', code: 'auth', retryable: false, provider: 'anthropic', model: 'claude-opus-5-5' })
    noteTurnSuccess('deepseek', 'deepseek-chat')
    expect($providerBlock.get()).not.toBeNull()
    noteTurnSuccess('anthropic', 'claude-opus-5-5')
    expect($providerBlock.get()).toBeNull()
  })

  it('a provider/endpoint failure with an HTTP 401/403 is an auth block; other statuses are not', () => {
    const generic = { layer: 'provider', code: 'non_retryable_client_error', retryable: false } as const

    expect(providerBlockFromSurface({ ...generic, provider: 'anthropic' }, 'HTTP 401: invalid x-api-key')).toEqual({
      kind: 'auth',
      provider: 'anthropic',
      model: ''
    })
    expect(providerBlockFromSurface({ ...generic, layer: 'endpoint' }, 'Error code: 403 - forbidden')?.kind).toBe(
      'auth'
    )
    expect(providerBlockFromSurface(null, 'HTTP 401: Unauthorized')?.kind).toBe('auth')
    expect(providerBlockFromSurface(generic, 'HTTP 400: bad request')).toBeNull()
    expect(providerBlockFromSurface(generic, 'took 401 ms then HTTP 500')).toBeNull()
    expect(providerBlockFromSurface({ ...generic, layer: 'gateway' }, 'HTTP 401')).toBeNull()
    expect(providerBlockFromSurface({ ...generic, code: 'model_not_found' }, 'HTTP 404')?.kind).toBe('model')
    expect(isAuthRejection(undefined)).toBe(false)
  })

  it('the auth copy names the provider in plain words and never echoes the error text', () => {
    noteTurnFailure({ layer: 'provider', code: 'x', retryable: false, provider: 'anthropic' }, 'HTTP 401: sk-ant-abc')

    const text = providerBlockMessage($providerBlock.get()!)

    expect(text).toBe(
      'The configured Anthropic key is not a valid Anthropic key. Replies stay off until it is replaced.'
    )
    expect(text).not.toMatch(/sk-|401/)
  })
})
