/**
 * The draft with `from` changed to `to`, or null when the draft does not hold `from`: text the user has changed is theirs.
 * An empty `to` also takes the blank line the text left behind.
 */
export function replaceDraftText(draft: string, from: string, to: string): null | string {
  const at = draft.indexOf(from)

  if (at < 0) {
    return null
  }

  const before = draft.slice(0, at)
  const after = draft.slice(at + from.length)

  return to ? `${before}${to}${after}` : `${before.trimEnd()}\n\n${after.trimStart()}`.trim()
}
