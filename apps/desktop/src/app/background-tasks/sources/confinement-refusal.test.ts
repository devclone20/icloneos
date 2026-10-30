/** K07: the panel half. A confinement refusal record, as `recordConfinement` writes it, folds into a failed task. */
import { describe, expect, it } from 'vitest'

import type { AuditRecordView } from '@/iclone-shared/permissions'

import { foldPermissionRecords } from './permissions'

describe('K07 — a confinement refusal shows in the Background-tasks panel', () => {
  it('folds into a failed task of its session, titled by the process, with the refusal as its last line', () => {
    const now = Date.parse('2026-10-21T10:01:00.000Z')

    const record: AuditRecordView = {
      seq_main: 9,
      ts: '2026-10-21T10:00:00.000Z',
      kind: 'refuse',
      mode: null,
      scope: null,
      class: null,
      action: { tool: 'cat', target: '/Users/u/outside/secret.txt', project_root: null },
      agent: { inft: null, session_id: 'sess-7' },
      answer: null,
      reason: 'confinement: the sandbox refused file-read-data'
    }

    expect(foldPermissionRecords([record], now)).toEqual([
      expect.objectContaining({
        id: 'perm:sess-7',
        sessionId: 'sess-7',
        state: 'failed',
        title: 'cat',
        // V3-T3: said in the reader's words from the record's fields, never main's English log line
        lastLine: 'Blocked by confinement · cat · /Users/u/outside/secret.txt'
      })
    ])
  })
})
