import { type FocusEvent, useCallback, useEffect, useLayoutEffect, useRef } from 'react'

interface FocusAnchor {
  element: HTMLElement
  run: string | null
  inInspector: boolean
}

const first = (selector: string): HTMLElement | null => document.querySelector<HTMLElement>(selector)

function restore(anchor: FocusAnchor): void {
  const row = anchor.run
    ? [...document.querySelectorAll<HTMLElement>('[data-run]')].find(holder => holder.dataset.run === anchor.run)
    : undefined

  const target =
    (anchor.inInspector ? first('.icont__inspector-head') : row?.querySelector<HTMLElement>('.e-row')) ??
    first('.icont__list .e-row') ??
    first('.icont')

  target?.focus()
}

/**
 * A run that ends moves its row between lists and takes its Stop with it, so the element holding focus leaves the
 * document on a read nobody asked for, and the keyboard (Up/Down, the inspector's Escape) would go with it. After each
 * render this puts focus on the same run's row, or the inspector's head. It only acts when the holder really left:
 * a pointer press first forgets the anchor, so clicking away from the pane is never undone by the next read.
 */
export function useKeepFocus(): (event: FocusEvent<HTMLElement>) => void {
  const anchor = useRef<FocusAnchor | null>(null)

  const forget = useCallback(() => {
    anchor.current = null
  }, [])

  useEffect(() => {
    window.addEventListener('pointerdown', forget, true)

    return () => window.removeEventListener('pointerdown', forget, true)
  }, [forget])

  useLayoutEffect(() => {
    const held = anchor.current
    const active = document.activeElement

    if (held && !held.element.isConnected && (active === null || active === document.body)) {
      restore(held)
    }
  })

  return useCallback((event: FocusEvent<HTMLElement>) => {
    const element = event.target

    anchor.current = {
      element,
      run: element.closest<HTMLElement>('[data-run]')?.dataset.run ?? null,
      inInspector: element.closest('.icont__inspector') !== null
    }
  }, [])
}
