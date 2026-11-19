/**
 * r5 (design, pane chip casing): the pane chips read "email", "wallet"… beside "Settings" and "Message". Red on
 * b290e6d7f3. Every Dock pane's title is cased like the others; the stylesheet never lowercases a pane chip.
 */
import { describe, expect, it } from 'vitest'

import { read } from '@/test/token-contrast'

import { ECON_APPS, ECON_ORDER } from './registry'

describe('pane titles are cased alike', () => {
  it('every econ pane title starts with a capital, like Settings and Message', () => {
    expect(ECON_ORDER.map(kind => ECON_APPS[kind].title)).toEqual(['Email', 'Wallet', 'Bank card', 'Hyperliquid', 'ACP Market'])
  })

  it('no pane chip rule lowercases its title', () => {
    const econ = read('app/home/econ/econ.css')
    const at = econ.indexOf('.ic-win__head h2 {')

    expect(econ.slice(at, econ.indexOf('}', at))).not.toMatch(/text-transform/)
  })
})
