/** The email data module's `validation` section — its public names are re-exported by ../email-data.ts. */
import { BODY_MAX, type Draft, type DraftErrors, EMAIL, EMAIL_MAX, SUBJECT_MAX } from './types'

// ── validation ──────────────────────────────────────────────────────────────

export function isEmail(value: string): boolean {
  const trimmed = value.trim()

  return trimmed.length > 0 && trimmed.length <= EMAIL_MAX && EMAIL.test(trimmed)
}

function bodyProblem(body: string): string | undefined {
  if (!body.trim()) {
    return 'Write a message'
  }

  return body.length > BODY_MAX ? 'Keep the message under 20,000 characters' : undefined
}

export function validateDraft(draft: Draft): DraftErrors {
  const errors: DraftErrors = {}
  const to = draft.to.trim()
  const subject = draft.subject.trim()
  const body = bodyProblem(draft.body)

  if (!to) {
    errors.to = 'Add a recipient'
  } else if (!isEmail(to)) {
    errors.to = 'That isn’t a valid email address'
  }

  if (!subject) {
    errors.subject = 'Add a subject'
  } else if (subject.length > SUBJECT_MAX) {
    errors.subject = 'Keep the subject under 300 characters'
  }

  if (body) {
    errors.body = body
  }

  return errors
}

export function validateReply(body: string): string | undefined {
  return bodyProblem(body)
}

export function hasDraft(draft: Draft): boolean {
  return Boolean(draft.to.trim() || draft.subject.trim() || draft.body.trim())
}
