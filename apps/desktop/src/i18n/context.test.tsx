import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HermesConfigRecord } from '@/hermes'

import { type I18nConfigClient, I18nProvider, useI18n } from './context'
import type { Locale } from './types'

function LanguageProbe({ target = 'pt-PT' }: { target?: Locale }) {
  const { isLoadingConfig, isSavingLocale, locale, saveError, setLocale, t } = useI18n()

  return (
    <div>
      <p data-testid="locale">{locale}</p>
      <p data-testid="label">{t.language.label}</p>
      <p data-testid="save">{t.common.save}</p>
      <p data-testid="loading">{String(isLoadingConfig)}</p>
      <p data-testid="saving">{String(isSavingLocale)}</p>
      <p data-testid="save-error">{saveError?.message ?? ''}</p>
      <button onClick={() => void setLocale(target).catch(() => undefined)} type="button">
        switch
      </button>
    </div>
  )
}

describe('I18nProvider', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('defaults to English without a config client', () => {
    render(
      <I18nProvider configClient={null}>
        <LanguageProbe />
      </I18nProvider>
    )

    expect(screen.getByTestId('locale').textContent).toBe('en')
    expect(screen.getByTestId('label').textContent).toBe('Language')
  })

  it('ruling 61: a pt-PT system with nothing saved boots English, before and after the config answers', async () => {
    for (const tag of ['pt-PT', 'pt-BR', 'pt-AO']) {
      vi.spyOn(window.navigator, 'language', 'get').mockReturnValue(tag)
      const empty: I18nConfigClient = { getConfig: vi.fn().mockResolvedValue({}), saveConfig: vi.fn() }

      render(
        <I18nProvider configClient={empty}>
          <LanguageProbe />
        </I18nProvider>
      )
      expect(screen.getByTestId('locale').textContent, tag).toBe('en')
      await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'))
      expect(screen.getByTestId('locale').textContent, tag).toBe('en')
      expect(screen.getByTestId('label').textContent).toBe('Language')
      expect(window.document.documentElement.lang).toBe('en')
      cleanup()
    }

    const noClient = render(
      <I18nProvider configClient={null}>
        <LanguageProbe />
      </I18nProvider>
    )

    expect(screen.getByTestId('locale').textContent).toBe('en')
    noClient.unmount()
  })

  // Ruling 69 (owner, 2026-10-25, supersedes 61): the app ships in ENGLISH ONLY. A pt-PT, pt or pt-BR left in the
  // config by an earlier version opens English. Review r2 (R2-M5): the window no longer writes it back — main sets
  // display.language to English in every local profile's config (electron/iclone-display-language.ts), and a remote
  // gateway's config is never the window's to rewrite. This row asserted the old mount-time write; it now asserts none.
  it('ruling 69: a saved pt-PT, pt or pt-BR opens English, and the window writes nothing back (R2-M5)', async () => {
    vi.spyOn(window.navigator, 'language', 'get').mockReturnValue('en-US')

    for (const saved of ['pt-PT', 'pt', 'pt-BR']) {
      const stored: I18nConfigClient = {
        getConfig: vi.fn().mockResolvedValue({ display: { language: saved, other: 1 } }),
        saveConfig: vi.fn().mockResolvedValue({ ok: true })
      }

      render(
        <I18nProvider configClient={stored}>
          <LanguageProbe />
        </I18nProvider>
      )
      await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'))
      expect(screen.getByTestId('locale').textContent, saved).toBe('en')
      expect(screen.getByTestId('label').textContent).toBe('Language')
      expect(screen.getByTestId('save').textContent).toBe('Save')
      await waitFor(() => expect(window.document.documentElement.lang).toBe('en'))
      expect(window.document.documentElement.dir).toBe('ltr')
      expect(stored.saveConfig).not.toHaveBeenCalled()
      cleanup()
    }
  })

  // Was "the one-time rewrite re-reads the config" (critic B, s4 r2): with no rewrite left in the window (R2-M5), the
  // concurrent-writer case it guarded cannot arise here; what remains true is that boot reads once and writes nothing.
  it('R2-M5: a non-English display.language through the config client (a remote gateway too) is read once, never written', async () => {
    const configClient: I18nConfigClient = {
      getConfig: vi.fn().mockResolvedValue({ display: { language: 'pt-PT', skin: 'new' }, model: 'theirs' }),
      saveConfig: vi.fn().mockResolvedValue({ ok: true })
    }

    render(
      <I18nProvider configClient={configClient}>
        <LanguageProbe />
      </I18nProvider>
    )

    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'))
    expect(screen.getByTestId('locale').textContent).toBe('en')
    expect(configClient.getConfig).toHaveBeenCalledTimes(1)
    expect(configClient.saveConfig).not.toHaveBeenCalled()
  })

  // Ruling 69: a starting locale is still normalized, but every language now normalizes to the one that ships, and
  // asking for another one changes nothing on screen.
  it('ruling 69: an initial locale alias of another language opens English, and a switch request keeps English', () => {
    render(
      <I18nProvider configClient={null} initialLocale="pt-BR">
        <LanguageProbe target="pt-PT" />
      </I18nProvider>
    )

    expect(screen.getByTestId('locale').textContent).toBe('en')
    expect(screen.getByTestId('label').textContent).toBe('Language')

    fireEvent.click(screen.getByRole('button', { name: 'switch' }))

    expect(screen.getByTestId('locale').textContent).toBe('en')
    expect(screen.getByTestId('label').textContent).toBe('Language')
  })

  // The boot still reads display.language and still normalizes it; ruling 69 only shrinks what it can resolve to.
  it('reads display.language at boot, accepts an English alias, and writes nothing back', async () => {
    const configClient: I18nConfigClient = {
      getConfig: vi.fn().mockResolvedValue({ display: { language: 'EN-US' } }),
      saveConfig: vi.fn()
    }

    render(
      <I18nProvider configClient={configClient}>
        <LanguageProbe />
      </I18nProvider>
    )

    expect(screen.getByTestId('loading').textContent).toBe('true')
    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'))

    expect(configClient.getConfig).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('locale').textContent).toBe('en')
    expect(screen.getByTestId('label').textContent).toBe('Language')
    expect(configClient.saveConfig).not.toHaveBeenCalled()
  })

  it('keeps English usable when config loading fails', async () => {
    const configClient: I18nConfigClient = {
      getConfig: vi.fn().mockRejectedValue(new Error('config unavailable')),
      saveConfig: vi.fn()
    }

    render(
      <I18nProvider configClient={configClient} initialLocale="pt-PT">
        <LanguageProbe />
      </I18nProvider>
    )

    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'))

    expect(screen.getByTestId('locale').textContent).toBe('en')
    expect(screen.getByTestId('label').textContent).toBe('Language')
    expect(configClient.saveConfig).not.toHaveBeenCalled()
  })

  it.each(['zh-Hans', 'zh-TW', 'ja-JP', 'ar-SA'])(
    'ruling 59/69: a saved %s opens English; the window writes nothing back (R2-M5)',
    async saved => {
      const configClient: I18nConfigClient = {
        getConfig: vi.fn().mockResolvedValue({ display: { language: saved } }),
        saveConfig: vi.fn().mockResolvedValue({ ok: true })
      }

      render(
        <I18nProvider configClient={configClient}>
          <LanguageProbe />
        </I18nProvider>
      )

      await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'))

      expect(screen.getByTestId('locale').textContent).toBe('en')
      expect(screen.getByTestId('save').textContent).toBe('Save')
      expect(configClient.saveConfig).not.toHaveBeenCalled()
    }
  )

  it.each(['ja-JP', 'zh-TW', 'ar-SA'])('ruling 59: a %s system boots English with no RTL', saved => {
    vi.spyOn(window.navigator, 'language', 'get').mockReturnValue(saved)

    render(
      <I18nProvider configClient={null}>
        <LanguageProbe />
      </I18nProvider>
    )

    expect(screen.getByTestId('locale').textContent).toBe('en')
    expect(window.document.documentElement.dir).toBe('ltr')
  })

  it('ruling 69: an unsupported configured language opens English, never the initial locale, and is not written back', async () => {
    const configClient: I18nConfigClient = {
      getConfig: vi.fn().mockResolvedValue({ display: { language: 'de' } }),
      saveConfig: vi.fn().mockResolvedValue({ ok: true })
    }

    render(
      <I18nProvider configClient={configClient} initialLocale="pt-PT">
        <LanguageProbe />
      </I18nProvider>
    )

    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'))

    expect(screen.getByTestId('locale').textContent).toBe('en')
    expect(screen.getByTestId('label').textContent).toBe('Language')
    expect(configClient.saveConfig).not.toHaveBeenCalled()
  })

  it('reads latest config before saving language and preserves unrelated values', async () => {
    const saveConfig = vi.fn().mockResolvedValue({ ok: true })

    const latestConfig: HermesConfigRecord = {
      display: { language: 'en', skin: 'slate' },
      terminal: { cwd: '/new' }
    }

    const configClient: I18nConfigClient = {
      getConfig: vi
        .fn()
        .mockResolvedValueOnce({ display: { language: 'en', skin: 'mono' }, terminal: { cwd: '/old' } })
        .mockResolvedValueOnce(latestConfig),
      saveConfig
    }

    render(
      <I18nProvider configClient={configClient}>
        <LanguageProbe />
      </I18nProvider>
    )

    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'))
    fireEvent.click(screen.getByRole('button', { name: 'switch' }))

    await waitFor(() => expect(saveConfig).toHaveBeenCalledTimes(1))
    // Ruling 69: the probe asks for pt-PT, which is clamped to the one shipped language before anything is written.
    expect(saveConfig).toHaveBeenCalledWith({
      display: { language: 'en', skin: 'slate' },
      terminal: { cwd: '/new' }
    })
  })

  it('ruling 59: a hidden locale can never be applied or written, even when asked for by code', async () => {
    const saveConfig = vi.fn().mockResolvedValue({ ok: true })

    const configClient: I18nConfigClient = {
      getConfig: vi.fn().mockResolvedValue({ display: { language: 'en', skin: 'mono' } }),
      saveConfig
    }

    render(
      <I18nProvider configClient={configClient}>
        <LanguageProbe target="ja" />
      </I18nProvider>
    )

    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'))
    fireEvent.click(screen.getByRole('button', { name: 'switch' }))

    await waitFor(() => expect(saveConfig).toHaveBeenCalledTimes(1))
    expect(saveConfig).toHaveBeenCalledWith({ display: { language: 'en', skin: 'mono' } })
    expect(screen.getByTestId('locale').textContent).toBe('en')
  })

  it('ruling 59: Arabic is not selectable, so no RTL direction is ever applied', async () => {
    render(
      <I18nProvider configClient={null} initialLocale="ar">
        <LanguageProbe target="ar" />
      </I18nProvider>
    )

    expect(screen.getByTestId('locale').textContent).toBe('en')
    expect(window.document.documentElement.dir).toBe('ltr')
    expect(window.document.documentElement.lang).toBe('en')

    fireEvent.click(screen.getByRole('button', { name: 'switch' }))
    await waitFor(() => expect(screen.getByTestId('saving').textContent).toBe('false'))
    expect(window.document.documentElement.dir).toBe('ltr')
    expect(window.document.documentElement.lang).toBe('en')
  })
})
