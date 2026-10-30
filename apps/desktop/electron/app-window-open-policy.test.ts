import { describe, expect, it, vi } from 'vitest'

import { createAppWindowOpenHandler } from './app-window-open-policy'

// X1b (review M2): the app window handler gets requests from every frame of the window — the artifact iframe
// (GHSA-9f4c-93c8-jc8g: a synthetic modifier/middle click with no allow-popups and no gesture) included. It denies and
// logs; it never hands the URL to anything (it has no way to: the policy module takes only a logger).
describe('createAppWindowOpenHandler', () => {
  it.each([
    ['https://attacker.example.test/from-iframe', 'foreground-tab', 'https:'],
    ['https://attacker.example.test/from-iframe', 'background-tab', 'https:'],
    ['http://attacker.example.test/', 'new-window', 'http:'],
    ['mailto:someone@example.test', 'foreground-tab', 'mailto:'],
    ['file:///etc/hosts', 'new-window', 'file:'],
    ['not a url', 'other', 'invalid']
  ])('denies %s (%s) and logs only the scheme', (url, disposition, scheme) => {
    const log = vi.fn()
    const handler = createAppWindowOpenHandler(log)

    expect(handler({ disposition, url })).toEqual({ action: 'deny' })
    expect(log).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalledWith(`[link] denied window request from page content: ${scheme} ${disposition}`)
    expect(log.mock.calls[0]?.[0]).not.toContain('attacker')
  })
})
