import { beforeEach, describe, expect, it } from 'vitest'

import {
  clearCronEditorDraft,
  type CronEditorDraft,
  draftIsEmpty,
  readCronEditorDraft,
  writeCronEditorDraft
} from './editor-draft'

// A half-typed schedule is the user's work. These tests pin the contract the
// page relies on after a reload: a draft round-trips, a pristine create draft
// is never stored, and corrupt storage never throws into render.

const draft = (over: Partial<CronEditorDraft> = {}): CronEditorDraft => ({
  mode: 'create',
  schedulePreset: 'custom',
  slotValues: {},
  templateChoice: 'custom',
  values: { deliver: 'local', model: '', name: 'Nightly', prompt: 'run it', provider: '', schedule: '*/5 * * * *' },
  ...over
})

beforeEach(() => {
  clearCronEditorDraft()
})

describe('cron editor draft', () => {
  it('round-trips what the user typed', () => {
    writeCronEditorDraft(draft())

    expect(readCronEditorDraft()).toEqual(draft())
  })

  it('keeps the job id of an edit draft so the right dialog reopens', () => {
    writeCronEditorDraft(draft({ jobId: 'job-7', mode: 'edit' }))

    expect(readCronEditorDraft()?.jobId).toBe('job-7')
  })

  it('reads nothing when there is nothing stored', () => {
    expect(readCronEditorDraft()).toBeNull()
  })

  it('ignores a draft that is not shaped like one', () => {
    globalThis.sessionStorage.setItem('iclone.cron.editor-draft', '{"mode":"create"}')

    expect(readCronEditorDraft()).toBeNull()
  })

  it('ignores storage that is not JSON at all', () => {
    globalThis.sessionStorage.setItem('iclone.cron.editor-draft', 'not json')

    expect(readCronEditorDraft()).toBeNull()
  })

  it('calls a pristine create draft empty, and a typed one not', () => {
    expect(
      draftIsEmpty(draft({ values: { deliver: 'local', model: '', name: '', prompt: '', provider: '', schedule: '' } }))
    ).toBe(true)
    expect(draftIsEmpty(draft())).toBe(false)
  })

  it('never calls an edit draft empty — editing an existing job is already work', () => {
    const empty = draft({
      jobId: 'job-1',
      mode: 'edit',
      values: { deliver: '', model: '', name: '', prompt: '', provider: '', schedule: '' }
    })

    expect(draftIsEmpty(empty)).toBe(false)
  })

  it('clears what it wrote', () => {
    writeCronEditorDraft(draft())
    clearCronEditorDraft()

    expect(readCronEditorDraft()).toBeNull()
  })
})
