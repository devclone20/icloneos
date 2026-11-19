/**
 * v0.0.9 F6 — the preload door to the 3D iNFT's own window: `window.hermesDesktop.stage3dWindow`.
 *
 * The preload is not this front's file: the bridge methods are requested in v009-requests.md (F1-S) with this exact
 * shape. Until they land the door reads as absent and "Open in new window" stays out of the 3D menu — nothing breaks.
 *
 *   open()     main opens (or focuses) the stage window; it reads the iNFT from the hand-off record (handoff.ts)
 *   close()    main closes it (Bring back, from the main window)
 *   onClosed() main says the stage window is gone, whoever closed it
 */
export interface Stage3dWindowBridge {
  open: () => Promise<{ ok: boolean; error?: string }>
  close: () => Promise<void>
  onClosed: (callback: () => void) => () => void
}

interface HermesDesktopWithStage {
  hermesDesktop?: { stage3dWindow?: Stage3dWindowBridge }
}

export function stage3dWindowBridge(): null | Stage3dWindowBridge {
  if (typeof window === 'undefined') {
    return null
  }

  const bridge = (window as unknown as HermesDesktopWithStage).hermesDesktop?.stage3dWindow

  return bridge && typeof bridge.open === 'function' && typeof bridge.onClosed === 'function' ? bridge : null
}

/** This renderer IS the 3D iNFT's own window (`?win=stage3d`). */
export function isStage3dWindow(search: string = typeof window === 'undefined' ? '' : window.location.search): boolean {
  try {
    return new URLSearchParams(search).get('win') === 'stage3d'
  } catch {
    return false
  }
}
