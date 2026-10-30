import { beforeEach, describe, expect, it } from 'vitest'

import { $econBadges, clearEconBadges, setEconBadge } from './badges'

describe('econ badges', () => {
  beforeEach(() => {
    clearEconBadges()
  })

  it('publishes a count per iNFT and app, never negative or fractional', () => {
    setEconBadge('slug-a', 'email', 7)
    setEconBadge('slug-a', 'bank', 2.7)
    setEconBadge('slug-b', 'email', -3)

    expect($econBadges.get()).toEqual({ 'slug-a': { email: 7, bank: 2 }, 'slug-b': { email: 0 } })
  })

  it('does not re-emit an unchanged count', () => {
    setEconBadge('slug-a', 'email', 7)

    const before = $econBadges.get()

    setEconBadge('slug-a', 'email', 7)

    expect($econBadges.get()).toBe(before)
  })

  it('clears one iNFT or all', () => {
    setEconBadge('slug-a', 'email', 1)
    setEconBadge('slug-b', 'email', 1)
    clearEconBadges('slug-a')

    expect($econBadges.get()).toEqual({ 'slug-b': { email: 1 } })

    clearEconBadges()

    expect($econBadges.get()).toEqual({})
  })
})
