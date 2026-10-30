import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as HermesApi from '@/hermes'
import { en } from '@/i18n/en'
import { notifyError } from '@/store/notifications'
import type { CronJob } from '@/types/hermes'

import { mutateAndRefreshCronJobs, refreshCronJobs } from './cron-actions'
import type { CronEditorDraft } from './editor-draft'
import { clearCronEditorDraft, readCronEditorDraft, writeCronEditorDraft } from './editor-draft'

import { CronView } from './index'

type HermesModule = typeof HermesApi

// Real i18n, the real $cronJobs atom and the real draft storage; the backend
// and the fenced refresh helpers (own tests) are stubbed. What is pinned here:
// our frame, the list/detail pair, the search, the delete confirmation, the
// failure path — and that a reload mid-typing does not lose the user's work.

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<HermesModule>()),
  createCronJob: vi.fn(async () => null),
  deleteCronJob: vi.fn(async () => undefined),
  getAutomationBlueprints: vi.fn(async () => ({ blueprints: [] })),
  getCronDeliveryTargets: vi.fn(async () => [
    { home_env_var: null, home_target_set: true, id: 'local', name: 'This desktop' }
  ]),
  getCronJobRuns: vi.fn(async () => []),
  pauseCronJob: vi.fn(async () => undefined),
  resumeCronJob: vi.fn(async () => undefined),
  updateCronJob: vi.fn(async () => null)
}))

vi.mock('./cron-actions', () => ({
  mutateAndRefreshCronJobs: vi.fn(async (_profile: string, run: () => Promise<unknown>) => ({
    refreshError: null,
    stale: false,
    value: await run()
  })),
  refreshCronJobs: vi.fn(async () => ({ jobs: [], refreshError: null, stale: false })),
  triggerAndRefreshCronJobs: vi.fn(async () => ({ jobs: [], refreshError: null, stale: false }))
}))

vi.mock('@/store/notifications', () => ({ notify: vi.fn(), notifyError: vi.fn() }))

vi.mock('@/lib/model-options', () => ({ requestModelOptions: vi.fn(async () => ({ providers: [] })) }))

const job = (id: string, name: string): CronJob =>
  ({
    enabled: true,
    id,
    name,
    prompt: `prompt for ${name}`,
    schedule: '0 9 * * *',
    schedule_display: 'Every day at 09:00',
    state: 'enabled'
  }) as unknown as CronJob

// An edit draft as the dialog writes it: the work a reload left behind.
const editDraft = (jobId: string, name: string): CronEditorDraft => ({
  jobId,
  mode: 'edit',
  schedulePreset: 'daily',
  slotValues: {},
  templateChoice: 'custom',
  values: {
    deliver: 'local',
    model: '',
    name,
    prompt: 'what the user was writing',
    provider: '',
    schedule: '0 9 * * *'
  }
})

async function setJobs(jobs: CronJob[]) {
  const { $cronJobs } = await import('@/store/cron')

  $cronJobs.set(jobs)
}

function open() {
  const onClose = vi.fn()
  const onOpenSession = vi.fn()

  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CronView onClose={onClose} onOpenSession={onOpenSession} />
    </QueryClientProvider>
  )

  return { onClose, onOpenSession }
}

beforeEach(async () => {
  clearCronEditorDraft()
  vi.clearAllMocks()
  await setJobs([job('a', 'Alpha digest'), job('b', 'Beta sweep')])
})

afterEach(() => {
  cleanup()
  clearCronEditorDraft()
})

describe('CronView', () => {
  it('wears OUR page frame and lists the jobs with their schedule', async () => {
    open()

    expect(await screen.findByRole('heading', { level: 2, name: en.cron.title })).toBeTruthy()
    expect(globalThis.document.querySelectorAll('.icpage__frame')).toHaveLength(1)
    expect(globalThis.document.querySelectorAll('[data-ic-row]')).toHaveLength(2)
    expect(screen.getAllByText('Every day at 09:00').length).toBeGreaterThan(0)
  })

  it('shows the first job in the detail pane, with its prompt', async () => {
    open()

    expect(await screen.findByRole('heading', { level: 3, name: 'Alpha digest' })).toBeTruthy()
    expect(screen.getByText('prompt for Alpha digest')).toBeTruthy()
  })

  it('filters the list from the search field', async () => {
    open()

    fireEvent.change(await screen.findByLabelText(en.cron.search), { target: { value: 'beta' } })

    await waitFor(() => expect(globalThis.document.querySelectorAll('[data-ic-row]')).toHaveLength(1))
    expect(screen.getByRole('heading', { level: 3, name: 'Beta sweep' })).toBeTruthy()
  })

  it('offers the empty state when there is nothing scheduled', async () => {
    await setJobs([])
    open()

    expect(await screen.findByText(en.cron.emptyTitleNew)).toBeTruthy()
  })

  it('reports a failed load instead of a blank page', async () => {
    vi.mocked(refreshCronJobs).mockResolvedValueOnce({
      jobs: [],
      refreshError: new Error('gateway down'),
      stale: false
    })
    open()

    await waitFor(() => expect(vi.mocked(notifyError)).toHaveBeenCalled())
    expect(globalThis.document.querySelectorAll('.icpage__frame')).toHaveLength(1)
  })

  it('asks before deleting, then deletes through the fenced helper', async () => {
    open()

    fireEvent.click((await screen.findAllByLabelText(en.common.delete))[0])

    const dialog = await screen.findByRole('dialog', { name: en.cron.deleteTitle })

    fireEvent.click(within(dialog).getByRole('button', { name: en.common.delete }))

    await waitFor(() => expect(vi.mocked(mutateAndRefreshCronJobs)).toHaveBeenCalled())
  })

  it('opens the editor and keeps a half-typed schedule across a reload', async () => {
    open()

    fireEvent.click(await screen.findByRole('button', { name: en.cron.newCron }))
    fireEvent.change(await screen.findByLabelText(new RegExp(`^${en.cron.nameLabel}`)), {
      target: { value: 'Nightly backup' }
    })

    await waitFor(() => expect(readCronEditorDraft()?.values.name).toBe('Nightly backup'))

    // The reload: the page is torn down and mounted again, as it is after an
    // HMR update or a window restore. The draft must bring the dialog back.
    cleanup()
    open()

    await waitFor(() =>
      expect((screen.getByLabelText(new RegExp(`^${en.cron.nameLabel}`)) as HTMLInputElement).value).toBe(
        'Nightly backup'
      )
    )
    // The restored dialog must not eat the draft it just restored: a second
    // mount (React's dev double-mount, a second reload) has to find it too.
    expect(readCronEditorDraft()?.values.name).toBe('Nightly backup')
  })

  it('discards the draft when the user cancels the dialog', async () => {
    open()

    fireEvent.click(await screen.findByRole('button', { name: en.cron.newCron }))
    fireEvent.change(await screen.findByLabelText(new RegExp(`^${en.cron.nameLabel}`)), {
      target: { value: 'throwaway' }
    })

    await waitFor(() => expect(readCronEditorDraft()).not.toBeNull())

    fireEvent.click(screen.getByRole('button', { name: en.common.cancel }))

    expect(readCronEditorDraft()).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  // EDIT mode is where work is most likely lost: the user opens a job they
  // already have, changes it, and something reloads. Create mode is proven
  // above; these three pin the edit branch — restored, dropped, and waiting.
  it('reopens the EDIT dialog with the user work after a reload', async () => {
    open()

    fireEvent.click((await screen.findAllByLabelText(en.cron.edit))[0])
    expect(await screen.findByRole('dialog', { name: en.cron.editTitle })).toBeTruthy()

    fireEvent.change(screen.getByLabelText(new RegExp(`^${en.cron.nameLabel}`)), {
      target: { value: 'Alpha digest, revised' }
    })
    fireEvent.change(screen.getByLabelText(new RegExp(`^${en.cron.promptLabel}`)), {
      target: { value: 'summarise yesterday instead' }
    })

    await waitFor(() => expect(readCronEditorDraft()?.jobId).toBe('a'))
    expect(readCronEditorDraft()?.mode).toBe('edit')

    cleanup()
    open()

    const dialog = await screen.findByRole('dialog', { name: en.cron.editTitle })

    expect((within(dialog).getByLabelText(new RegExp(`^${en.cron.nameLabel}`)) as HTMLInputElement).value).toBe(
      'Alpha digest, revised'
    )
    expect((within(dialog).getByLabelText(new RegExp(`^${en.cron.promptLabel}`)) as HTMLTextAreaElement).value).toBe(
      'summarise yesterday instead'
    )
  })

  it('drops an edit draft whose job is gone instead of reopening a stranger job', async () => {
    writeCronEditorDraft(editDraft('vanished', 'draft for a deleted job'))
    open()

    expect(await screen.findByRole('heading', { level: 2, name: en.cron.title })).toBeTruthy()
    await waitFor(() => expect(readCronEditorDraft()).toBeNull())
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps an edit draft while the list is still empty, and restores it when the job arrives', async () => {
    await setJobs([])
    writeCronEditorDraft(editDraft('b', 'Beta sweep, revised'))
    open()

    expect(await screen.findByText(en.cron.emptyTitleNew)).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
    // An empty list is "not loaded yet", never "the job is gone".
    expect(readCronEditorDraft()?.jobId).toBe('b')

    await act(async () => {
      await setJobs([job('b', 'Beta sweep')])
    })

    const dialog = await screen.findByRole('dialog', { name: en.cron.editTitle })

    expect((within(dialog).getByLabelText(new RegExp(`^${en.cron.nameLabel}`)) as HTMLInputElement).value).toBe(
      'Beta sweep, revised'
    )
  })
})
