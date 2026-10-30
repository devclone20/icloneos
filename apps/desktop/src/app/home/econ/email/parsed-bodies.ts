import { parseBody } from './email-text'

const PARSED_BODIES_MAX = 64
const parsedBodies = new Map<string, ReturnType<typeof parseBody>>()

/** A body parses once per text: a re-open mounts the blocks it already built. */
export function parsedBody(text: string): ReturnType<typeof parseBody> {
  const known = parsedBodies.get(text)

  if (known) {
    return known
  }

  const body = parseBody(text)

  parsedBodies.set(text, body)

  for (const oldest of parsedBodies.keys()) {
    if (parsedBodies.size <= PARSED_BODIES_MAX) {
      break
    }

    parsedBodies.delete(oldest)
  }

  return body
}

/** A sign-out forgets the bodies it read (the thread memo's `forgetThreads`): the
 *  cache is keyed by text, not iNFT, so it empties whole — a re-open re-parses. */
export function forgetParsedBodies(): void {
  parsedBodies.clear()
}
