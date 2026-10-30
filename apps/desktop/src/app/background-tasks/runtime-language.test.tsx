// V3-T3 (critic m5, ported from the critic's probe): the REAL runtime hook carries the active catalogue into the
// permissions source, so a live task's line is said in the reader's words. Removing the hook's `setPermissionWords`
// effect leaves the line in English and turns this red.
//
// Ruling 69 (owner, 2026-10-25, supersedes 61): the app ships in ENGLISH ONLY, so `setLocale('pt-PT')` is clamped to
// English and a language switch is no longer a gesture the product has — `src/i18n/context.test.tsx` pins that
// clamp. What this row still has to prove is the WIRING: the hook reads the catalogue it is handed and re-folds the
// live task when that catalogue changes, in both directions. So the catalogue is forced (`vi.mock('@/i18n')`, the
// repo's idiom) instead of selected, and the hook, the source and the fold are all the real ones.
import { act, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { en } from '@/i18n/en'
import { ptPt } from '@/i18n/pt-PT'
import type { Translations } from '@/i18n/types'
import type { AuditRecordView } from '@/iclone-shared/permissions'
import { $backgroundTasks } from '@/store/background-tasks'

import { useBackgroundTasksRuntime } from './runtime'

/** The catalogue the window is showing. Swapped between renders the way a new catalogue would arrive. */
let catalogue: Translations = en

vi.mock('@/i18n', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useI18n: () => ({ isSavingLocale: false, locale: 'en', setLocale: vi.fn(), t: catalogue })
}))

const RECORD: AuditRecordView = {
  seq_main: 1,
  ts: new Date(Date.now() - 5_000).toISOString(),
  kind: 'refuse',
  src: 'plugin',
  mode: 'manual',
  scope: null,
  class: 'X',
  action: { tool: 'terminal', target: 'rm x', project_root: null },
  agent: { inft: null, session_id: 's1' },
  answer: null,
  reason: 'mode: the manual permission mode'
}

function Host() {
  useBackgroundTasksRuntime()

  return null
}

const settle = () => act(async () => await new Promise(resolve => setTimeout(resolve, 100)))
const line = () => $backgroundTasks.get().find(task => task.id === 'perm:s1')?.lastLine

afterEach(() => {
  vi.unstubAllGlobals()
  catalogue = en
})

describe('Background tasks runtime · the permission line is said in the catalogue’s words', () => {
  it('en → pt-PT → en through the real hook, the real source and the real fold', async () => {
    vi.stubGlobal('hermesDesktop', {
      icloneConsent: { permissions: { tail: async () => [RECORD], onChanged: () => () => undefined } }
    })

    const view = render(<Host />)

    await settle()
    expect(line()).toBe('Refused · terminal · rm x')

    catalogue = ptPt
    await act(async () => view.rerender(<Host />))
    await settle()
    expect(line()).toBe('Recusado · terminal · rm x')

    catalogue = en
    await act(async () => view.rerender(<Host />))
    await settle()
    expect(line()).toBe('Refused · terminal · rm x')

    view.unmount()
  })
})
