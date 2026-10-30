/**
 * K99: one locale chunk at a time. vitest.setup.ts preloads all six for the component tests; this file unmocks that
 * and imports a FRESH loader (vi.resetModules) per case, so it sees the app's real async path.
 */
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The real loader, not the test environment's preloading one (vitest.setup.ts).
vi.unmock('./locale-loader')

const fresh = async () => {
  vi.resetModules()

  return import('./locale-loader')
}

afterEach(() => {
  vi.doUnmock('./ja')
  vi.doUnmock('./pt-PT')
  vi.useRealTimers()
})

describe('locale-loader', () => {
  it('English is there from the start; another locale is English until its chunk is in, then its own words', async () => {
    const loader = await fresh()
    const { en } = await import('./en')

    expect(loader.loadedTranslations('en')).toBe(en)
    expect(loader.loadedTranslations('ja')).toBeNull()
    expect(loader.translationsOrEnglish('ja')).toBe(en)

    const first = loader.loadTranslations('ja')
    const second = loader.loadTranslations('ja')

    expect(second).toBe(first)

    const ja = await first

    expect(ja).not.toBe(en)
    expect(loader.loadedTranslations('ja')).toBe(ja)
    expect(loader.translationsOrEnglish('ja')).toBe(ja)
    expect(loader.loadedTranslations('ar')).toBeNull()
  })

  it('a chunk that fails to load answers English and is asked for again next time', async () => {
    vi.doMock('./ja', () => {
      throw new Error('chunk 404')
    })

    const loader = await fresh()
    const { en } = await import('./en')

    await expect(loader.loadTranslations('ja')).resolves.toBe(en)
    expect(loader.loadedTranslations('ja')).toBeNull()

    vi.doUnmock('./ja')
    vi.doUnmock('./pt-PT')
    vi.resetModules()

    const again = await import('./locale-loader')

    await expect(again.loadTranslations('ja')).resolves.not.toBe(en)
  })
})

/**
 * Ruling 69 (owner, 2026-10-25, supersedes 61 and 59's two-language reading): the app ships in ENGLISH ONLY, and
 * English is in the boot bundle, so the first paint never waits for a chunk and never shows another language. What
 * still matters here is FX-1: the app ALWAYS paints — a stalled chunk can never leave a blank window.
 */
describe('I18nProvider on the first paint (ruling 69)', () => {
  it('a starting pt-PT opens English on the very first frame: nothing waited for, nothing Portuguese', async () => {
    vi.resetModules()

    const { I18nProvider, useI18n } = await import('./context')

    function Probe() {
      return <p data-testid="probe">{useI18n().t.common.cancel}</p>
    }

    render(
      <I18nProvider configClient={null} initialLocale="pt-PT">
        <Probe />
      </I18nProvider>
    )

    expect(screen.getByTestId('probe').textContent).toBe('Cancel')
  })

  it('a chunk that never answers is never even asked for, and the app paints in English at once', async () => {
    let asked = 0

    vi.useFakeTimers()
    vi.doMock('./pt-PT', () => {
      asked += 1

      return new Promise(() => undefined)
    })
    vi.resetModules()

    const { I18nProvider, useI18n } = await import('./context')

    function Probe() {
      return <p data-testid="probe">{useI18n().t.common.cancel}</p>
    }

    render(
      <I18nProvider configClient={null} initialLocale="pt-PT">
        <Probe />
      </I18nProvider>
    )

    expect(screen.getByTestId('probe').textContent).toBe('Cancel')
    // No locale chunk is fetched at boot any more (K99 cost): the starting locale is always the bundled one.
    expect(asked).toBe(0)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_600)
    })
    expect(screen.getByTestId('probe').textContent).toBe('Cancel')
  })
})

describe('the boot bundle holds English only (K99 static gate)', () => {
  const SRC = join(__dirname, '..')

  it('no app module imports a non-English locale barrel or the six-locale catalogue', async () => {
    const { globSync } = await import('node:fs')

    const offenders = globSync('**/*.{ts,tsx}', { cwd: SRC })
      .filter(file => !/\.test\.tsx?$/.test(file))
      .filter(file => !['i18n/catalog.ts', 'i18n/locale-loader.ts', 'i18n/parity/banks.ts'].includes(file))
      .filter(file => {
        const text = readFileSync(join(SRC, file), 'utf8')
        const inI18n = file.startsWith('i18n/')

        return (
          /from '@\/i18n\/(?:catalog|ar|ja|zh|zh-hant|pt-PT)'/.test(text) ||
          (inI18n && /from '\.{1,2}\/(?:catalog|ar|ja|zh|zh-hant|pt-PT)'/.test(text))
        )
      })
      .map(file => relative(SRC, join(SRC, file)))

    expect(offenders).toEqual([])
  })
})
