// V3-T3 — Settings › Agent › Permissions › Activity: a record about a function's level is said in the reader's words
// (its row and old → new level), never main's English log line; every other record keeps its target or reason.
//
// Ruling 69 (owner, 2026-10-25, supersedes 61 and 59's two-language reading): the app ships in ENGLISH ONLY, so no
// provider hands out another language. The gate here is that the rows are built from the active catalogue and never
// from main's English log line — which only a non-English catalogue can show — so the catalogue is forced below
// instead of selected as a language. The catalogues stay in the tree (G-31 offers one again untouched).
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { enPermissions } from '@/i18n/en/enPermissions'
import { ptPtPermissions } from '@/i18n/pt-PT/permissions'
import type { AuditRecordView } from '@/iclone-shared/permissions'

import { AuditList } from './audit-list'

let copy: typeof enPermissions = enPermissions

vi.mock('@/i18n', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useI18n: () => ({ isSavingLocale: false, locale: 'en', setLocale: vi.fn(), t: { settings: { permissions: copy } } })
}))

let seq = 0

function record(fields: Partial<AuditRecordView>): AuditRecordView {
  seq += 1

  return {
    seq_main: seq,
    ts: '2026-10-22T10:00:00.000Z',
    kind: 'fn_level_set',
    scope: null,
    class: null,
    mode: null,
    action: null,
    agent: null,
    answer: null,
    reason: null,
    ...fields
  }
}

const RECORDS: AuditRecordView[] = [
  record({ kind: 'fn_level_set', fn: 'email', level: 'manual', prev_level: 'mode', reason: 'lowered' }),
  record({
    kind: 'fn_level_set',
    fn: 'payments',
    level: 'ignore',
    prev_level: 'askAlways',
    reason: 'raised: confirmed on the system dialog'
  }),
  record({
    kind: 'fn_level_refused',
    fn: 'shell',
    level: 'automatic',
    prev_level: 'mode',
    reason: 'The raise was not confirmed on the system dialog.'
  }),
  record({ kind: 'fn_level_refused', reason: 'Unknown function or level.' }),
  record({ kind: 'revoke', fn: 'shopping', reason: 'the function’s level changed' }),
  record({ kind: 'mode_set', scope: 'project', reason: '/work/project' })
]

function renderIn(locale: 'en' | 'pt-PT') {
  copy = locale === 'en' ? enPermissions : (ptPtPermissions as typeof enPermissions)

  return render(<AuditList records={RECORDS} />)
}

describe('Permissions › Activity — level changes in the catalogue’s words', () => {
  it('pt-PT catalogue: the row and its old → new level, the revoked function grant, and no English log line', () => {
    const { container } = renderIn('pt-PT')

    expect(screen.getByText('E-mail: Seguir o modo → Manual')).toBeTruthy()
    expect(screen.getByText('Pagamentos: Perguntar sempre → Ignorar')).toBeTruthy()
    expect(screen.getByText(/^Terminal: Seguir o modo → Automático · /)).toBeTruthy()
    expect(screen.getByText('Compras · Perguntar uma vez')).toBeTruthy()
    expect(screen.getAllByText('Nível alterado')).toHaveLength(2)
    expect(screen.getAllByText('Alteração de nível recusada')).toHaveLength(2)

    for (const english of ['lowered', 'raised', 'system dialog', 'Unknown function', 'level changed']) {
      expect(container.textContent).not.toContain(english)
    }

    // A record that is not about a function keeps its own detail.
    expect(screen.getByText('este projeto · /work/project')).toBeTruthy()
  })

  it('en catalogue: the same rows read in English', () => {
    renderIn('en')

    expect(screen.getByText('Email: Follow mode → Manual')).toBeTruthy()
    expect(screen.getByText('Payments: Ask always → Ignore')).toBeTruthy()
    expect(screen.getByText('Shopping · Ask once')).toBeTruthy()
  })
})
