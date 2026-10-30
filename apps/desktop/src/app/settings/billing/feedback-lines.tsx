import type { ReactNode } from 'react'

/**
 * A billing result in two lines — the sentence that names it, then the detail under it — the same stacked
 * anatomy as a row's title and hint. Never joined by punctuation: a colon between two sentences is not
 * localisable and reads as a label.
 */
export function FeedbackLines({ message, title }: { message: ReactNode; title: ReactNode }) {
  return (
    <span className="flex min-w-0 flex-col gap-0.5" data-feedback-lines="">
      <span className="font-medium text-foreground">{title}</span>
      <span>{message}</span>
    </span>
  )
}
