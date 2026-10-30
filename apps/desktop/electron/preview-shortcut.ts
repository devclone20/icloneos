type PreviewShortcutAction = 'close' | 'reload'

interface PreviewShortcutInput {
  alt?: boolean
  control?: boolean
  isAutoRepeat?: boolean
  key?: string
  meta?: boolean
  shift?: boolean
  type?: string
}

interface PreviewShortcutDecision {
  action: PreviewShortcutAction | null
  claim: boolean
}

const NONE: PreviewShortcutDecision = { action: null, claim: false }

/**
 * ⌘W / ⌘R (Ctrl elsewhere) as seen by `before-input-event`. Electron reports
 * the keyDown AND the keyUp of the same press; both are claimed so the page
 * never sees half a shortcut, but only the first keyDown acts — acting on
 * both closed two panes for one press, and a held ⌘W must not close one pane
 * per auto-repeat.
 */
export function previewShortcutDecision(input: PreviewShortcutInput, isMac: boolean): PreviewShortcutDecision {
  const key = String(input.key || '').toLowerCase()
  const accel = Boolean(isMac ? input.meta : input.control) && !input.alt

  if (!accel || input.shift) {
    return NONE
  }

  const action: PreviewShortcutAction | null = key === 'w' ? 'close' : key === 'r' ? 'reload' : null

  if (!action) {
    return NONE
  }

  return { action: input.type === 'keyDown' && !input.isAutoRepeat ? action : null, claim: true }
}
