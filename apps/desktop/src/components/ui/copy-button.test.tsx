import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ptPt } from '@/i18n/pt-PT'

import { CopyButton } from './copy-button'

/**
 * Ruling 69 (owner, 2026-10-25, supersedes 61 and 59's two-language reading): the app ships in ENGLISH ONLY, so no
 * provider hands out another language — `I18nProvider initialLocale="pt-PT"` opens English. The gate this row exists
 * for is that the button's words come from the catalogue instead of a hardcoded English string, and only a
 * non-English catalogue can show that, so the bank is forced here rather than selected as a language. The catalogues
 * stay in the tree, so G-31 (offering one again) needs no change to this component.
 */
vi.mock('@/i18n', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useI18n: () => ({ isSavingLocale: false, locale: 'pt-PT', setLocale: vi.fn(), t: ptPt })
}))

describe('CopyButton i18n', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('takes its default label and its copied feedback from the catalogue, never a hardcoded string', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    })

    render(<CopyButton text="hello" />)

    const button = screen.getByRole('button', { name: ptPt.common.copy })

    expect(button.textContent).toContain(ptPt.common.copy)
    fireEvent.click(button)

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('hello'))
    await waitFor(() => expect(screen.getByRole('button', { name: ptPt.common.copied })).toBeTruthy())
    expect(screen.getByRole('button', { name: ptPt.common.copied }).textContent).toContain(ptPt.common.copied)
  })
})
