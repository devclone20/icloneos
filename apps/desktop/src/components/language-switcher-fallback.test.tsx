import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { en } from '@/i18n/en'
import { stubMenuDomApis, stubResizeObserver } from '@/test/jsdom'

vi.mock('@/i18n', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useI18n: () => ({ isSavingLocale: false, locale: 'ja', setLocale: vi.fn(), t: en })
}))

stubResizeObserver()
stubMenuDomApis()

describe('LanguageSwitcher with a locale that is not offered (ruling 69)', () => {
  afterEach(cleanup)

  // Ruling 69 (owner, 2026-10-25): the app ships in English only and the picker is not drawn. A locale outside the
  // offered list — an old saved value, an upstream catalogue — must still render nothing rather than fail on a
  // missing picker entry.
  it('renders nothing instead of failing', async () => {
    const { LanguageSwitcher } = await import('./language-switcher')

    const { container } = render(<LanguageSwitcher />)

    expect(container.innerHTML).toBe('')
    expect(screen.queryByRole('button')).toBeNull()
  })
})
