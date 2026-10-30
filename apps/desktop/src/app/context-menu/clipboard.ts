/**
 * Writing text to the clipboard — the pure logic behind the menu's copy verbs.
 *
 * The Electron bridge first: the renderer's own clipboard API throws
 * "Write permission denied" whenever the document loses focus, which is
 * exactly the state a portaled menu leaves it in. `navigator.clipboard` is the
 * fallback for a browser-hosted renderer.
 *
 * LEAD: the identical function is still exported from
 * `components/ui/copy-button.tsx` for 8 other call sites. That file is upstream
 * chrome on E3's deletion list, and this logic belongs in `src/lib/clipboard.ts`
 * — neither file is this front's to write, so the copy lives here until the
 * canonical home exists, and then this module goes.
 */

export async function writeClipboardText(text: string): Promise<void> {
  if (!text) {
    return
  }

  if (window.hermesDesktop?.writeClipboard) {
    await window.hermesDesktop.writeClipboard(text)

    return
  }

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)

    return
  }

  throw new Error('Clipboard API is unavailable')
}
