import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { openExternal } from './external'

describe('openExternal', () => {
  const open = vi.fn<(url: string) => Promise<void>>()

  beforeEach(() => {
    open.mockReset().mockResolvedValue(undefined)
    vi.stubGlobal('hermesDesktop', { openExternal: open })
  })

  afterEach(() => vi.unstubAllGlobals())

  it('opens https URLs', () => {
    openExternal('https://app.virtuals.io/acp/auth?request=1')
    expect(open).toHaveBeenCalledExactlyOnceWith('https://app.virtuals.io/acp/auth?request=1')
  })

  it.each([
    'http://example.com',
    'http://127.0.0.1:8080/',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,hi',
    'not a url',
    '',
    null,
    undefined
  ])('drops %s', url => {
    openExternal(url)
    expect(open).not.toHaveBeenCalled()
  })

  it('swallows a rejected open', async () => {
    open.mockRejectedValueOnce(new Error('denied'))
    expect(() => openExternal('https://example.com')).not.toThrow()
    await Promise.resolve()
  })
})
