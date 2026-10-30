/**
 * iCLONE OS — the one tolerant reader for `acp` CLI output, shared by the main
 * process and the renderer.
 *
 * The CLI prints JSON on `--json`, sometimes after a human line, and an empty
 * list comes back as a bare `[]`. Take the first JSON value found.
 */
export function parseCliJson(text: string): unknown {
  const trimmed = (text ?? '').trim()
  const starts = [trimmed.indexOf('{'), trimmed.indexOf('[')].filter(index => index >= 0)

  if (starts.length === 0) {
    return undefined
  }

  try {
    return JSON.parse(trimmed.slice(Math.min(...starts)))
  } catch {
    return undefined
  }
}
