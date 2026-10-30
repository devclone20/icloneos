/**
 * V3-FX FX-1: the app ALWAYS paints. Live run (V3-ON): a pt-PT system whose config load failed before the pt-PT chunk
 * arrived switched to English and cleared the first-paint fallback timer, so #root stayed blank forever.
 *
 * Every order of (config fails / config answers / chunk late / chunk fails / chunk never) × (en / pt-PT handed to the
 * provider) ends painted, in English, with nothing ever waited for.
 *
 * Ruling 69 (owner, 2026-10-25, supersedes 61 and 59's two-language reading): the app ships in ENGLISH ONLY. A
 * starting locale of another language — a saved preference, a pt system, code handing one in — opens English, which is
 * in the boot bundle, so no locale chunk is fetched at boot and the first paint waits for nothing. The matrix stays:
 * it is what proves no order of events can blank the window, and it is ready for the day a language returns (G-31).
 */
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HermesConfigRecord } from '@/hermes'

// The real async loader, not the test environment's preloading one (vitest.setup.ts).
vi.unmock('./locale-loader')

type Chunk = 'late' | 'fails' | 'never'
type Config = 'fails' | 'stored-en' | 'empty'

const SYSTEM = { en: 'en', 'pt-PT': 'pt-PT' } as const
const CHUNK_MODULE = { 'pt-PT': './pt-PT' } as const

afterEach(() => {
  cleanup()
  vi.doUnmock('./pt-PT')
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const flush = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })

// The real chunks, read once with real timers (the module runner stalls under fake ones).
const REAL: Record<string, unknown> = {}

async function boot(system: keyof typeof SYSTEM, chunk: Chunk) {
  for (const path of Object.values(CHUNK_MODULE)) {
    REAL[path] ??= await vi.importActual(path)
  }

  // Only the app's own timers are faked: the module runner that serves the chunk import keeps its real ticks.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

  let released = false
  let asked = 0
  let wake: () => void = () => undefined

  for (const [locale, path] of Object.entries(CHUNK_MODULE)) {
    vi.doMock(path, async () => {
      asked += 1

      if (chunk === 'fails') {
        throw new Error(`chunk ${locale} 404`)
      }

      if (chunk === 'never') {
        return new Promise(() => undefined)
      }

      if (!released) {
        await new Promise<void>(resolve => {
          wake = resolve
        })
      }

      return REAL[path]
    })
  }

  vi.resetModules()

  const { I18nProvider, useI18n } = await import('./context')

  let answerConfig: (config: HermesConfigRecord) => void = () => undefined
  let failConfig: (error: Error) => void = () => undefined

  const configClient = {
    getConfig: () =>
      new Promise<HermesConfigRecord>((resolve, reject) => {
        answerConfig = resolve
        failConfig = reject
      }),
    saveConfig: () => Promise.resolve({ ok: true })
  }

  function Probe() {
    const { locale, t } = useI18n()

    return (
      <p data-locale={locale} data-testid="probe">
        {t.common.cancel}
      </p>
    )
  }

  render(
    <I18nProvider configClient={configClient} initialLocale={SYSTEM[system]}>
      <Probe />
    </I18nProvider>
  )

  const settleConfig = async (config: Config) => {
    if (config === 'fails') {
      failConfig(new Error('config unreachable'))
    } else {
      answerConfig(config === 'stored-en' ? { display: { language: 'en' } } : {})
    }

    await flush()
  }

  // Lets a `late` chunk through. Ruling 69: nothing ever imports it, so this only proves the release changes nothing.
  const settleChunk = async () => {
    released = true
    wake()

    await flush()
    await flush()
  }

  return { chunkAsked: () => asked, settleChunk, settleConfig }
}

const painted = () => screen.queryByTestId('probe')

/** Painted, in the one shipped language, whatever the config and the chunk did. */
function expectEnglishPaint(when: string) {
  expect(painted(), when).not.toBeNull()
  expect(painted()?.textContent, when).toBe('Cancel')
  expect(painted()?.dataset.locale, when).toBe('en')
}

const LOCALES = ['en', 'pt-PT'] as const
const CONFIGS: Config[] = ['fails', 'stored-en', 'empty']

describe('FX-1: the first paint never stays blank', () => {
  for (const system of LOCALES) {
    for (const config of CONFIGS) {
      it(`${system}: config ${config} settles first, a late chunk after → painted in English throughout`, async () => {
        const { chunkAsked, settleChunk, settleConfig } = await boot(system, 'late')

        expectEnglishPaint('at boot')
        await settleConfig(config)
        expectEnglishPaint(`after config ${config}`)

        await act(async () => {
          await vi.advanceTimersByTimeAsync(1_600)
        })
        expectEnglishPaint('after the old first-paint wait')
        await settleChunk()
        expectEnglishPaint('after the chunk was released')
        expect(chunkAsked()).toBe(0)
      })

      it(`${system}: a late chunk is released first, config ${config} after → painted in English throughout`, async () => {
        const { chunkAsked, settleChunk, settleConfig } = await boot(system, 'late')

        expectEnglishPaint('at boot')
        await settleChunk()
        expectEnglishPaint('after the chunk was released')

        await settleConfig(config)
        expectEnglishPaint(`after config ${config}`)
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1_600)
        })
        expectEnglishPaint('after the old first-paint wait')
        expect(chunkAsked()).toBe(0)
      })

      it(`${system}: a chunk that would fail, config ${config} → painted in English at once`, async () => {
        const { chunkAsked, settleConfig } = await boot(system, 'fails')

        await flush()
        expectEnglishPaint('at boot')
        await settleConfig(config)
        expectEnglishPaint(`after config ${config}`)
        expect(chunkAsked()).toBe(0)
      })

      it(`${system}: a chunk that would never answer, config ${config} → painted in English at once, no wait`, async () => {
        const { chunkAsked, settleConfig } = await boot(system, 'never')

        expectEnglishPaint('at boot')
        await act(async () => {
          await vi.advanceTimersByTimeAsync(700)
        })
        await settleConfig(config)
        await act(async () => {
          await vi.advanceTimersByTimeAsync(900)
        })
        expectEnglishPaint(`after config ${config} and 1.6 s`)
        expect(chunkAsked()).toBe(0)
      })
    }
  }

  // Was: "the fallback timer is not reset by a locale change". Ruling 69 leaves nothing for the timer to rescue — the
  // starting locale is always the bundled one — so what is still worth pinning is the live bug itself: the config
  // answering (or failing) after the first paint must never take the window back to blank.
  it('ruling 69: an answer from the config never blanks an already painted window', async () => {
    const { chunkAsked, settleConfig } = await boot('pt-PT', 'never')

    expectEnglishPaint('at boot, before the config answers')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    expectEnglishPaint('still waiting on the config')
    // The stored language is Arabic, whose chunk never answers either: the window stays painted, in English.
    vi.spyOn(window.navigator, 'language', 'get').mockReturnValue('ar-SA')
    await settleConfig('empty')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600)
    })
    expectEnglishPaint('after the config answered')
    expect(chunkAsked()).toBe(0)
  })
})
