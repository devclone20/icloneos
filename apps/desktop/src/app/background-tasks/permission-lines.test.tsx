// V3-T3 — Background tasks: a permission task's lines and the panel's permission log say the record in the reader's
// words; main's English log line (`reason`) never reaches the panel.
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useI18n } from '@/i18n'
import { enPermissions } from '@/i18n/en/enPermissions'
import { ptPt } from '@/i18n/pt-PT'
import { ptPtPermissions as pt } from '@/i18n/pt-PT/permissions'
import type { AuditRecordView } from '@/iclone-shared/permissions'

import { BackgroundTasksPanel } from './panel'
import { TaskRow } from './row'
import { $permissionAudit, foldPermissionRecords, setPermissionWords } from './sources/permissions'

// Ruling 69 (owner, 2026-10-25, supersedes 61): the app ships in ENGLISH ONLY, so a locale can no longer be
// SELECTED — `I18nProvider initialLocale="pt-PT"` now opens English. This row's point is not that a reader can pick
// Portuguese; it is that these lines are READ FROM THE CATALOGUE and never printed from main's English `reason`. So
// it forces the catalogue the way the rest of the repo does (`vi.mock('@/i18n')`, language-switcher-fallback.test)
// instead of selecting a language: the pt-PT catalogue is handed to the components directly, and an English word on
// screen is still a leak. The catalogues stay in the tree for G-31; this row keeps its teeth meanwhile.
vi.mock('@/i18n', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useI18n: () => ({ isSavingLocale: false, locale: 'pt-PT', setLocale: vi.fn(), t: ptPt })
}))

const T0 = 1_000_000

let seq = 0

function rec(kind: string, sid: string | null, fields: Partial<AuditRecordView> = {}): AuditRecordView {
  seq += 1

  return {
    seq_main: seq,
    ts: new Date(T0 + seq * 1_000).toISOString(),
    kind,
    mode: 'manual',
    scope: null,
    class: 'X',
    action: { tool: 'terminal', target: `job-${seq}`, project_root: null },
    agent: { inft: null, session_id: sid },
    answer: null,
    reason: null,
    ...fields
  }
}

// Every producer's English log line the panel could have printed, on records that fold into failed tasks or the log.
const RECORDS: AuditRecordView[] = [
  rec('refuse', 's1', { reason: 'mode: the manual permission mode' }),
  rec('ask', 's2', { reason: 'Hermes flagged this command as dangerous' }),
  rec('timeout', 's2', { reason: 'ask 2 unanswered' }),
  rec('refuse', 's3', { action: null, reason: 'function: email is set to manual' }),
  rec('refuse', null, { action: null, class: '$', mode: null, src: 'payment', reason: 'per_tx' }),
  rec('use', null, { action: null, class: '$', mode: null, src: 'payment', reason: 'settled' }),
  rec('gap', null, { action: null, class: null, mode: null, reason: 'plugin events 5..7 from pid 9 never arrived' }),
  rec('mode_refused', null, {
    action: null,
    class: null,
    mode: 'ignore',
    reason: 'Ignore permissions cannot be the standing default.'
  }),
  rec('answer', 's4', { action: null, answer: 'deny', reason: 'too many permission requests are already waiting' }),
  rec('refuse', 's5', {
    action: { tool: 'cat', target: '/Users/u/outside/secret.txt', project_root: null },
    src: 'confinement',
    reason: 'confinement: the sandbox refused file-read-data'
  }),
  rec('escalate', 's6', { action: null, reason: 'a future kind with English' }),
  rec('restart', null, { action: null, class: null, mode: null, reason: 'main pid 777' })
]

const NOW = T0 + RECORDS.length * 1_000 + 1_000

const ENGLISH =
  /\b(the|was|were|not|never|from|refused|denied|waiting|settled|unanswered|flagged|dangerous|function|mode|main|pid 777|standing|default|permission|events?)\b|per_tx/i

afterEach(() => {
  setPermissionWords(enPermissions)
  $permissionAudit.set(null)
})

function Rows() {
  const { t } = useI18n()

  return (
    <ul>
      {foldPermissionRecords(RECORDS, NOW, t.settings.permissions).map(task => (
        <TaskRow copy={t.backgroundTasks} key={task.id} now={NOW} onToggle={() => undefined} open task={task} />
      ))}
    </ul>
  )
}

describe('V3-T3 · Background tasks permission lines in the reader’s words', () => {
  it('pt-PT: a failed task says what was refused, from the record’s fields, never the log line', () => {
    const tasks = foldPermissionRecords(RECORDS, NOW, pt)

    expect(tasks.map(task => [task.id, task.state, task.title, task.lastLine])).toEqual([
      ['perm:s1', 'failed', 'terminal', 'Recusado · terminal · job-1'],
      ['perm:s2', 'failed', 'terminal', 'Sem resposta · terminal · job-3'],
      ['perm:s3', 'failed', 'Recusado', 'Recusado'],
      ['perm:s5', 'failed', 'cat', 'Bloqueado pelo confinamento · cat · /Users/u/outside/secret.txt']
    ])
  })

  it('the live source re-folds in the active locale’s words', () => {
    setPermissionWords(pt)
    expect(foldPermissionRecords(RECORDS, NOW).map(task => task.lastLine)).toContain('Recusado · terminal · job-1')
    setPermissionWords(enPermissions)
    expect(foldPermissionRecords(RECORDS, NOW).map(task => task.lastLine)).toContain('Refused · terminal · job-1')
  })

  it('no English leaks: the pt-PT task rows and the panel’s permission log', () => {
    const rows = render(<Rows />)

    const taskText = rows.container.textContent ?? ''

    expect(taskText).toContain('Recusado · terminal · job-1')
    expect(taskText.replace(/terminal|job-\d+/g, '')).not.toMatch(ENGLISH)
    rows.unmount()

    $permissionAudit.set(RECORDS)

    render(<BackgroundTasksPanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Registo de permissões' }))

    const log = screen.getByTestId('bg-tasks-log')
    const lines = [...log.querySelectorAll('*')].map(node => node.textContent ?? '')

    expect(log.textContent).toContain('Acima de um limite em Economia › Pagamentos')
    // critic m4: a kind a later front adds is titled in the reader's words, never its raw code
    expect(log.textContent).toContain('Registo de permissões')
    expect(log.textContent).not.toContain('escalate')

    for (const line of lines) {
      expect(line.replace(/terminal|job-\d+/g, ''), line).not.toMatch(ENGLISH)
    }
  })
})
