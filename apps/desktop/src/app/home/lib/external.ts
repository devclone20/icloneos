/**
 * iCLONE OS — the one door from the renderer to the system browser.
 *
 * Only https is ever opened: these URLs come from CLI output and token
 * metadata, so http, file:, javascript: and custom schemes are dropped
 * silently. No call site needs loopback http today; if one ever does, allow
 * it here explicitly — never add a second opener.
 */
export function openExternal(url: null | string | undefined): void {
  if (!url) {
    return
  }

  let parsed: URL

  try {
    parsed = new URL(url)
  } catch {
    return
  }

  if (parsed.protocol !== 'https:') {
    return
  }

  void window.hermesDesktop?.openExternal(parsed.href).catch(() => undefined)
}
