import { atom } from 'nanostores'

import type { DiagnosticsFileView } from '@/iclone-shared/diagnostics-file'
import { reportIssueUrl } from '@/iclone-shared/diagnostics-file'
import { errorMessage } from '@/iclone-shared/errors'
import { openExternalLink } from '@/lib/external-link'

// V3-FX FX-7 — "Save a diagnostics report": the error card and Settings › Diagnostics open it. In 0.0.3 icloneOS never
// uploads diagnostics to any third party. Main composes and redacts the report (src/iclone-shared/diagnostics-file.ts),
// the dialog shows what it contains, and main writes it only to a file the owner chooses in a native save dialog.
// "Report an issue" opens the public repository's new-issue page with a title only. Nothing here makes a network
// call: no gateway request, no fetch.

interface DiagnosticsReportState {
  /** Short text describing the failure that prompted the report (main redacts it with the rest). */
  errorContext?: string
  error?: string
  phase: 'error' | 'loading' | 'preview' | 'saved' | 'saving'
  savedName?: string
  view?: DiagnosticsFileView
}

export const $sendDiagnostics = atom<DiagnosticsReportState | null>(null)

// Bumped on every open and every dismiss: a preview or save that finishes after its dialog closed writes nothing.
let generation = 0

const doctor = () => window.hermesDesktop?.icloneDoctor

const contextInput = (errorContext?: string) => (errorContext ? { errorContext } : {})

/** Open the dialog and ask main for the redacted report it would save. */
export function requestSendDiagnostics(errorContext?: string): void {
  generation += 1
  const mine = generation

  $sendDiagnostics.set({ errorContext, phase: 'loading' })

  void (async () => {
    try {
      const view = await doctor()?.diagnosticsPreview?.(contextInput(errorContext))

      if (mine !== generation) {
        return
      }

      $sendDiagnostics.set(
        view ? { errorContext, phase: 'preview', view } : { errorContext, phase: 'error', error: 'unavailable' }
      )
    } catch (error) {
      if (mine === generation) {
        $sendDiagnostics.set({ errorContext, phase: 'error', error: errorMessage(error) })
      }
    }
  })()
}

export function dismissSendDiagnostics(): void {
  generation += 1
  $sendDiagnostics.set(null)
}

/** The owner clicked Save: main shows the save dialog and writes the file. Cancelling the dialog keeps the preview. */
export async function saveDiagnosticsReport(): Promise<void> {
  const current = $sendDiagnostics.get()

  if (!current || current.phase !== 'preview') {
    return
  }

  const mine = generation

  $sendDiagnostics.set({ ...current, phase: 'saving' })

  try {
    const result = await doctor()?.diagnosticsSave?.(contextInput(current.errorContext))

    if (mine !== generation) {
      return
    }

    if (result?.ok) {
      $sendDiagnostics.set({ ...current, phase: 'saved', savedName: result.name })
    } else if (result && result.canceled) {
      $sendDiagnostics.set({ ...current, phase: 'preview' })
    } else {
      $sendDiagnostics.set({ ...current, phase: 'error', error: result && !result.ok ? result.error : 'unavailable' })
    }
  } catch (error) {
    if (mine === generation) {
      $sendDiagnostics.set({ ...current, phase: 'error', error: errorMessage(error) })
    }
  }
}

/** The public repository's new-issue page, with a title only (never any report content). */
export function reportIssue(title: string): void {
  openExternalLink(reportIssueUrl(title))
}
