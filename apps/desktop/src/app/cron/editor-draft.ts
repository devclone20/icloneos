/**
 * The cron editor's unsaved draft. A schedule half-typed into the dialog is the
 * user's work: a reload (HMR, a crash, a window restore) must not swallow it,
 * so every keystroke is mirrored into session storage and the page reopens the
 * dialog where it stood. Session scope is deliberate — the draft dies with the
 * window, never outlives the machine.
 */

import type { EditorValues } from './schedule'

const DRAFT_KEY = 'iclone.cron.editor-draft'

export interface CronEditorDraft {
  /** Pre-selected blueprint in create mode (the list rail's recipe rows). */
  blueprintKey?: string
  /** The job being edited; a draft whose job is gone is dropped on restore. */
  jobId?: string
  mode: 'create' | 'edit'
  schedulePreset: string
  slotValues: Record<string, string>
  templateChoice: string
  values: EditorValues
}

const VALUE_FIELDS = ['deliver', 'model', 'name', 'prompt', 'provider', 'schedule'] as const

function store(): null | Storage {
  try {
    // Private windows and a wiped profile throw on access, not on use.
    return globalThis.sessionStorage
  } catch {
    return null
  }
}

function isDraft(value: unknown): value is CronEditorDraft {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const draft = value as Record<string, unknown>
  const values = draft.values as Record<string, unknown> | undefined

  return (
    (draft.mode === 'create' || draft.mode === 'edit') &&
    typeof draft.schedulePreset === 'string' &&
    typeof draft.templateChoice === 'string' &&
    typeof values === 'object' &&
    values !== null &&
    VALUE_FIELDS.every(field => typeof values[field] === 'string')
  )
}

/** True when the user has typed nothing worth keeping (a pristine dialog). */
export function draftIsEmpty(draft: CronEditorDraft): boolean {
  const { name, prompt, schedule } = draft.values

  return (
    !name.trim() &&
    !prompt.trim() &&
    !schedule.trim() &&
    Object.values(draft.slotValues).every(value => !value.trim()) &&
    draft.mode === 'create'
  )
}

export function readCronEditorDraft(): CronEditorDraft | null {
  const raw = store()?.getItem(DRAFT_KEY)

  if (!raw) {
    return null
  }

  try {
    const parsed: unknown = JSON.parse(raw)

    return isDraft(parsed) ? { ...parsed, slotValues: parsed.slotValues ?? {} } : null
  } catch {
    return null
  }
}

export function writeCronEditorDraft(draft: CronEditorDraft): void {
  try {
    store()?.setItem(DRAFT_KEY, JSON.stringify(draft))
  } catch {
    // A full or blocked store must never break typing.
  }
}

export function clearCronEditorDraft(): void {
  try {
    store()?.removeItem(DRAFT_KEY)
  } catch {
    // Same: clearing is best-effort.
  }
}
