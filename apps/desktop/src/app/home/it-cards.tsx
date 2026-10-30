import { useStore } from '@nanostores/react'
import { atom } from 'nanostores'

/** Dev/lab only: the pane (terminal id) or 'surface' that must throw next render. */
export const $itCrashProbe = atom<null | string>(null)

/** Throws while the probe names `target` — how the lab proves a boundary holds. */
export function ItCrashProbe({ target }: { target: string }) {
  if (useStore($itCrashProbe) === target) {
    throw new Error(`iT crash probe (${target})`)
  }

  return null
}

/** The whole iT view failed: the Message window and the app stay usable. */
export function ItCrashCard({ onRetry }: { onRetry: () => void }) {
  return (
    <section aria-label="iT terminal" className="itwin" data-scope="message" role="alert">
      <header className="itwin__rail">
        <span className="itwin__mark">iT</span>
        <span className="itwin__tab itwin__tab--on">iT failed — the rest of the app is fine</span>
        <button className="itwin__add" onClick={onRetry} type="button">
          Retry
        </button>
      </header>
    </section>
  )
}

/** One pane's shell failed: only that pane shows this; its siblings keep
 *  running. No `onClose` = the pane can never close (iT's last shell). */
export function ItPaneCrashCard({ onClose, onRetry }: { onClose?: () => void; onRetry: () => void }) {
  return (
    <div className="itwin__crash" data-it-crash role="alert">
      <span className="itwin__tab itwin__tab--on">shell failed</span>
      <button className="itwin__tab-name" onClick={onRetry} type="button">
        Retry
      </button>
      {onClose && (
        <button className="itwin__tab-name" onClick={onClose} type="button">
          Close pane
        </button>
      )}
    </div>
  )
}

/** A ⌘⇧N peer window never hosts shells (the pool is this origin's, shared). */
export function ItPeerCard() {
  return (
    <section aria-label="iT terminal" className="itwin" role="status">
      <header className="itwin__rail">
        <span className="itwin__mark">iT</span>
        <span className="itwin__tab itwin__tab--on">iT lives in the primary window</span>
      </header>
    </section>
  )
}
