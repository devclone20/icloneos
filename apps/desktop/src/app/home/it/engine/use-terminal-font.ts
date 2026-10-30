import { useStore } from '@nanostores/react'
import type { Terminal } from '@xterm/xterm'
import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'

import { requestAtlasRebuild } from './atlas'
import { $terminalFontFamily, applyTerminalFontFamily, resolveTerminalFontFamily } from './terminal-font'

interface TerminalFontControllerOptions {
  fitRef: RefObject<((visible: boolean) => void) | null>
  termRef: RefObject<Terminal | null>
}

/**
 * Share profile-backed font state across user and agent terminals. The owner
 * flips mountedRef only after term.open(); before then, its mount path reads
 * latestFontFamilyRef and warms the newest value itself.
 */
export function useTerminalFontController({ fitRef, termRef }: TerminalFontControllerOptions) {
  const configured = useStore($terminalFontFamily)
  const fontFamily = resolveTerminalFontFamily(configured)
  const latestFontFamilyRef = useRef(fontFamily)
  const mountedRef = useRef(false)
  const generationRef = useRef(0)

  latestFontFamilyRef.current = fontFamily

  useEffect(() => {
    const term = termRef.current

    if (!mountedRef.current || !term || term.options.fontFamily === fontFamily) {
      return
    }

    const generation = ++generationRef.current
    let cancelled = false

    void applyTerminalFontFamily({
      // New faces are rasterized into the shared atlas: rebuild it for every pane.
      clearTextureAtlas: requestAtlasRebuild,
      fit: () => fitRef.current?.(true),
      fontFamily,
      isCurrent: () => !cancelled && generationRef.current === generation,
      term
    })

    return () => {
      cancelled = true
    }
  }, [fitRef, fontFamily, termRef])

  return { latestFontFamilyRef, mountedRef }
}
