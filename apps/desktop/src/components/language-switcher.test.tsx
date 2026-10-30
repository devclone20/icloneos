/**
 * Ruling 69 (owner, 2026-10-25, supersedes 61 and 59's two-language reading): the app ships in ENGLISH ONLY, so the
 * language picker is not drawn at all — a control that offers one option is a dead control. What is still worth
 * pinning here: nothing is drawn (no trigger, no options, no search box), nothing can be written to display.language
 * through it, and a value saved by an earlier version — or by an upstream catalogue the app never offered — opens
 * English without crashing and without turning the window right-to-left. Offering a picker again is G-31, a future
 * version: these rows are the decision, not a regression.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type I18nConfigClient, I18nProvider, useI18n } from '@/i18n'
import { stubMenuDomApis, stubResizeObserver } from '@/test/jsdom'

import { LanguageSwitcher } from './language-switcher'

stubResizeObserver()
stubMenuDomApis()

/** The locale the provider settled on, and whether the config has answered yet. */
function LocaleProbe() {
  const { isLoadingConfig, locale } = useI18n()

  return <p data-testid="locale">{`${locale}:${String(isLoadingConfig)}`}</p>
}

describe('LanguageSwitcher (ruling 69: English only)', () => {
  beforeEach(() => {
    // Neither value is what the provider must end up with, so the assertions below cannot pass by leftover.
    window.document.documentElement.lang = 'xx'
    window.document.documentElement.dir = 'rtl'
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  function mount(language: string) {
    const saveConfig = vi.fn().mockResolvedValue({ ok: true })

    const configClient: I18nConfigClient = {
      getConfig: vi.fn().mockResolvedValue({ display: { language, skin: 'slate' } }),
      saveConfig
    }

    render(
      <I18nProvider configClient={configClient}>
        <div data-testid="slot">
          <LanguageSwitcher />
        </div>
        <LocaleProbe />
      </I18nProvider>
    )

    const settled = () => waitFor(() => expect(screen.getByTestId('locale').textContent).toBe('en:false'))

    return { saveConfig, settled, slot: () => screen.getByTestId('slot') }
  }

  it('ruling 69: draws no picker at all — no trigger, no options, no search box', async () => {
    const { saveConfig, settled, slot } = mount('en')

    await settled()

    expect(slot().innerHTML).toBe('')
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    // With no control there is no way to change the language, so nothing is ever written to display.language.
    expect(saveConfig).not.toHaveBeenCalled()
  })

  it.each(['ja', 'zh-hant', 'ar', 'zh', 'pt-PT', 'pt-br'])(
    'ruling 69: a saved %s opens English, with no picker and no right-to-left direction',
    async saved => {
      const { saveConfig, settled, slot } = mount(saved)

      await settled()

      expect(window.document.documentElement.lang).toBe('en')
      expect(window.document.documentElement.dir).toBe('ltr')
      expect(slot().innerHTML).toBe('')
      // Review r2 (R2-M5): the window no longer rewrites the saved value (this row asserted that mount-time write);
      // main sets display.language to English in every local profile (electron/iclone-display-language.ts).
      expect(saveConfig).not.toHaveBeenCalled()
    }
  )
})

// Ruling 69: with nothing drawn, no surface hands the picker to a header's end slot either — an aside that renders
// an empty fragment is not a design. The slot itself stays on ConsentHeader for the day a language returns (G-31).
describe('ruling 69: no surface passes the picker as a header aside', () => {
  it.each([
    'src/components/setup/setup-step.tsx',
    'src/components/consent/terms-step.tsx',
    'src/components/consent/permissions-step.tsx'
  ])('%s neither imports nor renders the switcher', file => {
    const source = readFileSync(join(process.cwd(), file), 'utf8')

    expect(source).not.toContain('LanguageSwitcher')
    expect(source).not.toContain('aside={')
  })
})
