import { readFileSync } from 'node:fs'
import path from 'node:path'

import { act, cleanup, render } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { __resetBackendSkinSync } from './backend-sync'
import { modePref, skinPref, type ThemeMode, ThemeProvider, useTheme } from './context'

// The ui project stubs CSS imports to '', so the skin tokens are read from disk and mounted for real: the test asks
// the cascade which rule wins, not a regex which rule exists. vitest runs with cwd = apps/desktop.
const TOKENS_CSS = readFileSync(path.join(process.cwd(), 'src/app/home/ic-tokens.css'), 'utf8')

const LIGHT_SKIN_SELECTOR = ":root[data-hermes-theme='iclone-light']"

// The cascade serialises a value without the source's spaces; compare the tokens, not the whitespace.
const squash = (value: string) => value.replace(/\s+/g, '')

/** A token's declared value inside the first rule whose selector is exactly `selector`. */
function declaredIn(selector: string, token: string): string {
  const css = TOKENS_CSS.replace(/\/\*[\s\S]*?\*\//g, '')
  const start = css.indexOf(`${selector} {`)
  const body = start === -1 ? '' : css.slice(start, css.indexOf('}', start))
  const value = new RegExp(`${token}:\\s*([^;]+);`).exec(body)?.[1]

  if (!value) {
    throw new Error(`${token} is not declared under ${selector} in ic-tokens.css`)
  }

  return squash(value)
}

// The light skin's chat glass is paper; every dark skin's is ink. Which one computes is which skin's rules applied.
const LIGHT_GLASS = declaredIn(LIGHT_SKIN_SELECTOR, '--ic-surface-glass')
const DARK_GLASS = declaredIn(":root[data-hermes-theme='iclone-dark']", '--ic-surface-glass')

const root = () => window.document.documentElement
const computedToken = (token: string) => squash(getComputedStyle(root()).getPropertyValue(token))

let ctx: ReturnType<typeof useTheme>

function Probe() {
  ctx = useTheme()

  return null
}

function paint(skin: string, mode: ThemeMode) {
  skinPref.assign('default', skin)
  modePref.assign('default', mode)
  render(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>
  )
}

function stubSystemDark(dark: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: dark && query.includes('dark'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {}
  }))
}

describe('light mode renders the light skin, and its rules are the ones that apply', () => {
  let tokens: HTMLStyleElement

  beforeAll(() => {
    tokens = window.document.createElement('style')
    tokens.textContent = TOKENS_CSS
    window.document.head.appendChild(tokens)
  })

  afterAll(() => tokens.remove())

  beforeEach(() => {
    window.localStorage.clear()
    __resetBackendSkinSync()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  function expectLightSkin() {
    expect(root().dataset.hermesTheme).toBe('iclone-light')
    expect(root().dataset.hermesMode).toBe('light')
    expect(root().classList.contains('dark')).toBe(false)
    expect(root().matches(LIGHT_SKIN_SELECTOR)).toBe(true)
    expect(computedToken('--ic-surface-glass')).toBe(LIGHT_GLASS)
  }

  it.each(['iclone-natural', 'iclone-dark', 'iclone-light'])('mode light + skin %s paints iclone-light', skin => {
    paint(skin, 'light')
    expectLightSkin()
  })

  it('system mode on a light OS paints iclone-light', () => {
    stubSystemDark(false)
    paint('iclone-natural', 'system')
    expectLightSkin()
  })

  it('Shift+X from dark to light paints iclone-light, without renaming the stored skin', () => {
    paint('iclone-dark', 'dark')
    act(() => ctx.setMode('light'))
    expectLightSkin()
    expect(skinPref.resolve('default')).toBe('iclone-dark')
    expect(modePref.resolve('default')).toBe('light')
  })

  it('a light preview from the palette paints iclone-light', () => {
    paint('iclone-natural', 'dark')
    act(() => ctx.previewTheme('iclone-natural', 'light'))
    expectLightSkin()
  })

  // A user who chose dark sees exactly what they saw before: same attribute, same class, same skin rules.
  it.each(['iclone-natural', 'iclone-dark'])('mode dark + skin %s is unchanged', skin => {
    paint(skin, 'dark')
    expect(root().dataset.hermesTheme).toBe(skin)
    expect(root().dataset.hermesMode).toBe('dark')
    expect(root().classList.contains('dark')).toBe(true)
    expect(root().matches(LIGHT_SKIN_SELECTOR)).toBe(false)

    if (skin === 'iclone-dark') {
      expect(computedToken('--ic-surface-glass')).toBe(DARK_GLASS)
    }
  })

  it('system mode on a dark OS keeps the dark skin', () => {
    stubSystemDark(true)
    paint('iclone-dark', 'system')
    expect(root().dataset.hermesTheme).toBe('iclone-dark')
    expect(root().classList.contains('dark')).toBe(true)
    expect(computedToken('--ic-surface-glass')).toBe(DARK_GLASS)
  })
})
