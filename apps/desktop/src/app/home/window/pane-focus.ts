/**
 * v0.0.9 F6 — the keyboard follows the panes: a dropped pane takes it, and closing one of two hands it to the other
 * (it fills the window now), never to a Dock tile the user is not looking at.
 */

/** Where a pane takes the keyboard: the Message window its composer (or its first control), a self window its root. */
function paneFocusTarget(id: string): HTMLElement | null {
  if (id === 'message') {
    return (
      document.querySelector<HTMLElement>(
        '[data-slot="composer-root"] textarea, [data-slot="composer-root"] [contenteditable="true"]'
      ) ?? document.querySelector<HTMLElement>('[data-ic-pane="message"] button')
    )
  }

  return document.querySelector<HTMLElement>(`aside[data-ic-window="${id}"]`)
}

/** Whether the keyboard is inside a pane already (its window, its column, the Message window's shells). */
export function focusIsInPane(): boolean {
  const active = document.activeElement

  return (
    active instanceof Element &&
    active !== document.body &&
    active.closest('[data-ic-window], [data-ic-pane], [data-chat-surface], .itwin') !== null
  )
}

/**
 * Focus pane `id` as soon as it is drawn (a lazy pane mounts a few frames later; gives up after ~half a second). A
 * focus the pane already holds is left where it is.
 */
export function focusPane(id: string, frames = 30): void {
  const attempt = (left: number) => {
    const target = paneFocusTarget(id)

    if (target) {
      const owner = target.closest(`[data-ic-window="${id}"], [data-ic-pane="${id}"]`)

      if (!(owner && owner.contains(document.activeElement))) {
        target.focus({ preventScroll: true })
      }

      return
    }

    if (left > 0) {
      requestAnimationFrame(() => attempt(left - 1))
    }
  }

  requestAnimationFrame(() => attempt(frames))
}
