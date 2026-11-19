// v0.0.9 F5 — the words and the style contract of the iNFT Collection and the wallet popover:
// every string lives in i18n/en/v009-f5.ts (the spec's exact copy included), no literal is left in their JSX,
// and their stylesheets hold the ic-style-ratchet line (no raw colour, radius, shadow, blur or z) on tokens that exist.
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { f5Collection, f5Wallet } from '@/i18n/en/v009-f5'

const here = (file: string) => readFileSync(path.join(__dirname, file), 'utf8')

const STYLESHEETS = ['collections.css', 'wallet-panel.css'] as const
const COMPONENTS = ['collections.tsx', 'collections-tab.tsx', 'wallet-panel.tsx'] as const
const TOKEN_FILES = ['ic-tokens.css', 'ic-bridge.css', 'ic-layers.css'].map(here).join('\n')

/** Every leaf of a copy bank rendered once (functions with representative arguments). */
function leaves(bank: Record<string, unknown>): [string, string][] {
  return Object.entries(bank).map(([key, value]) => {
    if (typeof value === 'function') {
      const render = value as (...args: unknown[]) => string
      const single: unknown = key === 'partial' ? ['Solana'] : key === 'zeroNetworks' || key === 'updated' ? 12 : 'x'
      const args = render.length === 2 ? [3, 2] : [single]

      return [key, String(render(...args))]
    }

    return [key, String(value)]
  })
}

describe('F5 i18n', () => {
  it.each([
    ['f5Collection', f5Collection],
    ['f5Wallet', f5Wallet]
  ] as const)('%s: every key renders words', (_, bank) => {
    for (const [key, text] of leaves(bank as unknown as Record<string, unknown>)) {
      expect(text.trim(), key).not.toBe('')
      expect(text, key).not.toMatch(/undefined|NaN|\[object/)
    }
  })

  it('carries the spec copy word for word', () => {
    expect(f5Collection.title).toBe('iNFT Collection')
    expect(f5Collection.openBook).toBe('Open iNFT Book')
    expect(f5Collection.count(12, 3)).toBe('12 iNFTs · 3 collections')
    expect(f5Collection.signedOut).toBe('Connect a wallet to see your iNFTs')
    expect(f5Collection.connectWallet).toBe('Connect wallet')
    expect(f5Collection.setUp).toBe('Set up in EconomyOS')
    expect(f5Wallet.copied).toBe('Copied')
    expect(f5Wallet.copyFailed).toBe("Couldn't copy")
    expect(f5Wallet.accountEmbedded).toBe('Privy embedded wallet')
    expect(f5Wallet.accountExternal).toBe('External wallet')
    expect(f5Wallet.zeroNetworks(6)).toBe('6 networks with no balance')
    expect(f5Wallet.zeroNetworks(1)).toBe('1 network with no balance')
    expect(f5Wallet.updated(12)).toBe('Updated 12 s ago')
    expect(f5Wallet.signOut).toBe('Sign out of wallet')
    expect(f5Wallet.confirmTitle).toBe('Sign out of your wallet?')
    expect(f5Wallet.confirmBody).toBe(
      'Your iNFTs stay yours; the app forgets this session until you sign in again.'
    )
    expect(f5Wallet.confirmCancel).toBe('Cancel')
    expect(f5Wallet.confirmAction).toBe('Sign out')
    expect(f5Wallet.signedOut).toBe('Signed out')
  })

  it.each(COMPONENTS)('%s writes no user-facing literal in its JSX', file => {
    const source = here(file)
    // A JSX text node that starts with a letter: `>Words<` (types such as `useRef<HTMLElement>(` never match).
    const textNodes = source.match(/>\s*[A-Za-z][A-Za-z ,.'!?-]*\s*</g) ?? []

    expect(textNodes).toEqual([])

    for (const retired of [
      'No iNFTs yet',
      'It retries on the next open',
      'No balances yet',
      'balances refresh every 90s',
      "'ECONOMYOS'",
      "'SETUP NEEDED'",
      'Close collections',
      'wallet balances'
    ]) {
      expect(source, retired).not.toContain(retired)
    }
  })
})

/** [property, value] of every declaration; comments stripped (a light mirror of the ratchet's parser). */
function declarations(css: string): [string, string][] {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '')

  return [...stripped.matchAll(/([-a-zA-Z]+)\s*:\s*([^;{}]+);/g)].map(m => [m[1].toLowerCase(), m[2].trim()])
}

const NUMBER = /(?<![\w.#-])-?(?:\d+\.?\d*|\.\d+)(?:px|rem|em|%|vh|vw)?(?![\w.])/g

const hasLiteralNumber = (value: string) =>
  (value.replace(/--[\w-]+/g, '').match(NUMBER) ?? []).some(n => Number.parseFloat(n) !== 0)

describe('F5 stylesheets hold the ic-style-ratchet line (baseline 0 for both files)', () => {
  it.each(STYLESHEETS)('%s: no raw colour, radius, shadow, blur or z-index', file => {
    const offenders: string[] = []

    for (const [prop, value] of declarations(here(file))) {
      if (/(?<![\w-])#(?:[0-9a-fA-F]{3,8})(?![\w-])/.test(value) || /(?<![\w-])(?:rgba?|hsla?)\(/i.test(value)) {
        offenders.push(`colour ${prop}: ${value}`)
      }

      if (/(?<![\w-])blur\(\s*(?!var\()/i.test(value)) {
        offenders.push(`blur ${prop}: ${value}`)
      }

      if (/^(?:-webkit-)?border(?:-[a-z]+)*-radius$/.test(prop) && hasLiteralNumber(value)) {
        offenders.push(`radius ${prop}: ${value}`)
      }

      const shadow = /^(?:-webkit-)?box-shadow$/.test(prop) && !/^(none|inherit|initial|unset)$/.test(value)

      if (shadow && hasLiteralNumber(value)) {
        offenders.push(`shadow ${prop}: ${value}`)
      }

      if (prop === 'z-index' && /\d/.test(value.replace(/--[\w-]+/g, ''))) {
        offenders.push(`z ${prop}: ${value}`)
      }
    }

    expect(offenders).toEqual([])
  })

  it.each(STYLESHEETS)('%s: every --ic-* token it reads is defined in the token files', file => {
    const used = new Set([...here(file).matchAll(/var\((--ic-[\w-]+)/g)].map(m => m[1]))
    const missing = [...used].filter(name => !new RegExp(`(^|\\s)${name}:`, 'm').test(TOKEN_FILES))

    expect(missing).toEqual([])
  })

  it('the F5 knobs exist on both skins where they differ', () => {
    const tokens = here('ic-tokens.css')
    const light = tokens.slice(tokens.indexOf(":root[data-hermes-theme='iclone-light'] {\n  --ic-stage-fill"))

    for (const knob of ['--ic-inft-panel-fill', '--ic-inft-card-fill', '--ic-inft-card-line', '--ic-wallet-panel-fill']) {
      expect(tokens, knob).toMatch(new RegExp(`${knob}:`))
      expect(light, `${knob} (light skin)`).toMatch(new RegExp(`${knob}:`))
    }

    // The wallet plate is opaque on both skins: no glass under running text.
    expect(tokens).toMatch(/--ic-wallet-panel-fill:\s*var\(--ic-ink-800\);/)
    expect(light).toMatch(/--ic-wallet-panel-fill:\s*var\(--ic-paper\);/)
    expect(here('wallet-panel.css')).not.toMatch(/backdrop-filter/)
  })
})
