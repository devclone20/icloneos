import '../home.css'
import './stage3d-window.css'

/**
 * v0.0.9 F6 — the 3D iNFT in its own window (`?win=stage3d`, electron/main/windows.ts createStage3dWindow).
 *
 * Loaded by the same bundle as the app, mounted like Quick Entry: no app shell, no gateway, no router — a field, the
 * live stage and the iNFT's name. Which iNFT, its field and the owner's camera come from the hand-off record the main
 * window wrote just before it asked main for this window (handoff.ts). The main window's stage released its WebGL
 * context before this one reserves its own (handover.ts): one live 3D context across the app.
 *
 * Closing (the traffic light, ⌘W, or Bring back in the main window) hands the camera back through storage; main tells
 * the main window, which mounts its stage again on that camera.
 */
import { type CSSProperties, StrictMode, useCallback, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'

import { ErrorBoundary } from '@/components/error-boundary'
import { f6Stage } from '@/i18n/en/v009-f6'
import { ThemeProvider } from '@/themes/context'

import { Stage3D } from '../stage3d'

import { onStageCamera, readStageHandoff, receiveHandedCamera, writeHandedCamera } from './handoff'

function Stage3dWindowApp() {
  // Read once: the record is this window's whole brief.
  const handoff = useMemo(() => {
    const record = readStageHandoff()

    // Queued for this stage AND handed straight back: an untouched window returns the camera it received.
    if (record) {
      receiveHandedCamera(record.modelUrl)
    }

    return record
  }, [])

  const [error, setError] = useState<null | string>(null)
  const [backdrop, setBackdrop] = useState<null | string>(handoff?.field ?? null)

  useEffect(() => {
    if (handoff) {
      document.title = f6Stage.windowTitle(handoff.name)
    }
  }, [handoff])

  // The owner's camera here is the camera the main window gets back.
  useEffect(() => {
    if (!handoff) {
      return
    }

    return onStageCamera((modelUrl, pose) => {
      if (modelUrl === handoff.modelUrl) {
        writeHandedCamera(modelUrl, pose)
      }
    })
  }, [handoff])

  // The main window's field is already the DISPLAYED one (brightness-capped, home-view.tsx): it wins over the raw
  // scenery colour the model reports, so both windows paint the same field.
  const onBackdrop = useCallback((color: null | string) => {
    if (color) {
      setBackdrop(current => current ?? color)
    }
  }, [])

  const onError = useCallback((message: string) => setError(message), [])

  return (
    <main
      className="istage-window"
      style={backdrop ? ({ '--istage-window-field': backdrop } as CSSProperties) : undefined}
    >
      <div aria-hidden className="istage-window__drag" />
      {!handoff ? (
        <p className="istage-window__note" role="status">
          {f6Stage.noInft}
        </p>
      ) : error ? (
        <p className="istage-window__note" role="status">
          {error}
        </p>
      ) : (
        <Stage3D modelUrl={handoff.modelUrl} onBackdrop={onBackdrop} onError={onError} />
      )}
      {handoff && <p className="istage-window__name">{handoff.name.toLowerCase()}</p>}
    </main>
  )
}

export function mountStage3dWindow(): void {
  const root = document.getElementById('root')

  if (!root) {
    return
  }

  createRoot(root).render(
    <StrictMode>
      <ErrorBoundary label="stage3d-window">
        <ThemeProvider>
          <Stage3dWindowApp />
        </ThemeProvider>
      </ErrorBoundary>
    </StrictMode>
  )
}
