/**
 * v0.0.9 e2e harness (root cause #2, proven on ee84df1705): what "ready" means for icloneOS. The upstream rule (a
 * composer in the DOM, and no fixed full-viewport element at the centre) never holds here: the chat composer exists
 * only once the Message pane is open, and the icloneOS home shell IS a fixed full-viewport surface.
 *
 * Ready = the home region is on screen, main's own boot progress says the backend is up (the real
 * `hermesDesktop.getBootProgress()` IPC: phase `backend.ready`, no error), and none of the known blockers is up: the
 * permission-gate card, the consent dialog, the connecting/boot overlay, or any other aria-modal dialog.
 *
 * E2E-ONLY. `collectReadiness` runs in the page (self-contained: no closures, the gate title passed in);
 * `judgeReadiness` is pure. Both are proven by scripts/e2e-readiness.test.mjs, including a negative case per blocker.
 */
/**
 * The fail-closed card's title and the home region's accessible name: the app's own copy (src/i18n/en/boot.ts
 * `failure.gateTitle`, src/i18n/en/desktop.ts `home.region`), held equal by scripts/e2e-readiness.test.mjs.
 */
export const GATE_TITLE = 'The permission gate is not in place'
export const HOME_REGION_LABEL = 'iclone os home'

export interface ReadinessFacts {
  /** The `iclone os home` region is in the DOM and shown. */
  home: boolean
  /** A shown dialog carries the permission-gate card's title. */
  gate: boolean
  /** The first-run consent sheet is up (`[data-consent-step]`). */
  consent: boolean
  /** The connecting / boot overlay is up (`[data-boot-void]`). */
  connecting: boolean
  /** Any other shown `[aria-modal="true"]` element (boot failure, onboarding, a confirm…). */
  modal: boolean
  /** main's boot progress (`hermesDesktop.getBootProgress()`), or null when it could not be read. */
  boot: { phase: string; error: null | string } | null
}

export type ReadinessVerdict = 'backend-error' | 'backend-not-ready' | 'connecting' | 'consent' | 'gate' | 'modal' | 'no-home' | 'ready'

/** The blockers that never clear by themselves: waitForAppReady fails at once on them, with their cause. */
export const TERMINAL_VERDICTS: readonly ReadinessVerdict[] = ['gate', 'consent', 'backend-error']

export function judgeReadiness(facts: ReadinessFacts): ReadinessVerdict {
  if (facts.gate) {
    return 'gate'
  }

  if (facts.consent) {
    return 'consent'
  }

  if (facts.boot?.error || facts.boot?.phase === 'backend.error') {
    return 'backend-error'
  }

  if (facts.connecting) {
    return 'connecting'
  }

  if (facts.modal) {
    return 'modal'
  }

  if (!facts.home) {
    return 'no-home'
  }

  if (facts.boot?.phase !== 'backend.ready') {
    return 'backend-not-ready'
  }

  return 'ready'
}

/** The DOM half of the facts, read from `doc` (the page's document, or a jsdom one in the unit gate). */
export function collectDomFacts(doc: Document, gateTitle: string, homeLabel: string): Omit<ReadinessFacts, 'boot'> {
  // Shown = neither it nor an ancestor is hidden, aria-hidden, display:none or visibility:hidden.
  const shown = (el: Element) => {
    if (el.closest('[hidden], [aria-hidden="true"]')) {
      return false
    }

    const view = el.ownerDocument.defaultView

    for (let node: Element | null = el; node; node = node.parentElement) {
      const style = view?.getComputedStyle(node)

      if (style && (style.display === 'none' || style.visibility === 'hidden')) {
        return false
      }
    }

    return true
  }

  const modals = [...doc.querySelectorAll('[aria-modal="true"]')].filter(shown)
  const gate = modals.some(el => (el.textContent ?? '').includes(gateTitle))
  const consent = [...doc.querySelectorAll('[data-consent-step]')].some(shown)
  const connecting = [...doc.querySelectorAll('[data-boot-void]')].some(shown)
  const home = [...doc.querySelectorAll('[role="region"]')].some(el => el.getAttribute('aria-label') === homeLabel && shown(el))

  return {
    home,
    gate,
    consent,
    connecting,
    modal: modals.some(el => !(el.textContent ?? '').includes(gateTitle) && !el.closest('[data-consent-step]') && !el.matches('[data-consent-step]'))
  }
}
