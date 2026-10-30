// Ruling 69 ships English only, so a switch to any other tag clamps to 'en' and a rollback would change nothing. To
// exercise the rollback for real, this file offers a second language (the G-31 shape: a language returns).
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HermesConfigRecord } from '@/hermes'

import { type I18nConfigClient, I18nProvider, useI18n } from './context'
import type * as Languages from './languages'

vi.mock('./languages', async importOriginal => {
  const actual = await importOriginal<typeof Languages>()
  const offered: readonly string[] = ['en', 'pt-PT']

  return {
    ...actual,
    isOfferedLocale: (value: unknown) => typeof value === 'string' && offered.includes(value),
    OFFERED_LOCALES: offered
  }
})

function SwitchProbe() {
  const { isLoadingConfig, isSavingLocale, locale, saveError, setLocale } = useI18n()

  return (
    <div>
      <p data-testid="locale">{locale}</p>
      <p data-testid="loading">{String(isLoadingConfig)}</p>
      <p data-testid="saving">{String(isSavingLocale)}</p>
      <p data-testid="save-error">{saveError?.message ?? ''}</p>
      <button onClick={() => void setLocale('pt-PT').catch(() => undefined)} type="button">
        switch
      </button>
    </div>
  )
}

describe('I18nProvider rollback', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('shows the chosen locale while saving and rolls it back when saving fails', async () => {
    let rejectSave: (error: Error) => void = () => undefined

    const configClient: I18nConfigClient = {
      getConfig: vi.fn().mockResolvedValue({ display: { language: 'en' } } satisfies HermesConfigRecord),
      saveConfig: vi.fn(
        () =>
          new Promise<{ ok: boolean }>((_resolve, reject) => {
            rejectSave = reject
          })
      )
    }

    render(
      <I18nProvider configClient={configClient}>
        <SwitchProbe />
      </I18nProvider>
    )

    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'))
    fireEvent.click(screen.getByRole('button', { name: 'switch' }))

    await waitFor(() => expect(configClient.saveConfig).toHaveBeenCalled())
    expect(screen.getByTestId('locale').textContent).toBe('pt-PT')

    rejectSave(new Error('save failed'))

    await waitFor(() => expect(screen.getByTestId('save-error').textContent).toBe('save failed'))
    expect(screen.getByTestId('locale').textContent).toBe('en')
    expect(screen.getByTestId('saving').textContent).toBe('false')
  })
})
