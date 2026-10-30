/**
 * V3-FX m3 (critic c6): "Report an issue" carries the static, localized issue title and nothing else — never the
 * error context or any report text, whatever the dialog holds.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { en as enAll } from '@/i18n/en'
import { sendDiagnostics as en } from '@/i18n/en/sendDiagnostics'
import { ptPt as ptAll } from '@/i18n/pt-PT'
import { sendDiagnostics as ptOverrides } from '@/i18n/pt-PT/sendDiagnostics'
import type { Translations } from '@/i18n/types'
import { $sendDiagnostics } from '@/store/send-diagnostics'

import { SendDiagnosticsHost } from './send-diagnostics-dialog'

const pt = ptOverrides as typeof en
const original = window.hermesDesktop

/**
 * Ruling 69 (owner, 2026-10-25): the app ships in English only, so no provider hands out another language — the
 * catalogue under test is forced here instead of selected. The gate is that the issue title comes from whichever
 * catalogue is active (and carries nothing else), which only a non-English one can show; the catalogues stay in the
 * tree, so G-31 (offering a language again) needs no change here.
 */
let bank: Translations = enAll

vi.mock('@/i18n', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useI18n: () => ({ isSavingLocale: false, locale: 'en', setLocale: vi.fn(), t: bank })
}))

afterEach(() => {
  cleanup()
  bank = enAll
  $sendDiagnostics.set(null)
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: original })
})

function open(locale: 'en' | 'pt-PT') {
  const openExternal = vi.fn(async (_url: string) => undefined)

  bank = locale === 'en' ? enAll : ptAll
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { ...original, openExternal } })
  $sendDiagnostics.set({
    errorContext: 'turn failed: SECRET-CONTEXT owner@example.com',
    phase: 'preview',
    view: { parts: [{ id: 'context', lines: 1 }], text: 'REPORT-TEXT', suggestedName: 'x.txt' }
  })
  render(<SendDiagnosticsHost />)

  return openExternal
}

describe('m3: the issue link carries the static title only', () => {
  for (const [locale, bank] of [
    ['en', en],
    ['pt-PT', pt]
  ] as const) {
    it(`${locale}: title = the bank's issueTitle, no context or report text`, () => {
      const openExternal = open(locale)

      fireEvent.click(screen.getByRole('button', { name: bank.reportIssue }))

      const url = new URL(openExternal.mock.calls[0]![0])

      expect(url.origin + url.pathname).toBe('https://github.com/devclone20/icloneos/issues/new')
      expect([...url.searchParams.entries()]).toEqual([['title', bank.issueTitle]])
      expect(url.href).not.toMatch(/SECRET|REPORT|example\.com/)
    })
  }
})
