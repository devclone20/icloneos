import { afterEach, describe, expect, it } from 'vitest'

import { HOME_ROUTE } from '@/app/routes'

import { applyBootRoute, bootHash } from './boot-route'

describe('bootHash', () => {
  it('sends an empty main-window hash to the home route', () => {
    for (const hash of ['', '#', '#/']) {
      expect(bootHash(hash, false)).toBe(`#${HOME_ROUTE}`)
    }
  })

  it('keeps deep links and every auxiliary window untouched', () => {
    expect(bootHash('#/settings?tab=providers', false)).toBeNull()
    expect(bootHash('#/home', false)).toBeNull()
    expect(bootHash('', true)).toBeNull()
    expect(bootHash('#/', true)).toBeNull()
  })
})

describe('applyBootRoute', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '#/')
  })

  it('rewrites the hash in place, without a history entry', () => {
    window.history.replaceState(null, '', '#/')
    const length = window.history.length

    applyBootRoute(window, false)

    expect(window.location.hash).toBe(`#${HOME_ROUTE}`)
    expect(window.history.length).toBe(length)
  })

  it('leaves an auxiliary window on its own hash', () => {
    window.history.replaceState(null, '', '#/')

    applyBootRoute(window, true)

    expect(window.location.hash).toBe('#/')
  })
})
