// Save a diagnostics report (V3-FX FX-7) — rendered globally (wiring.tsx) and driven by $sendDiagnostics. The error
// card and Settings › Diagnostics open it. Nothing is uploaded: the dialog shows what the report contains (and the
// exact redacted text on request), main writes it to a file the owner chooses, and "Report an issue" opens the
// public repository's new-issue page with a title only.
import { useStore } from '@nanostores/react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { ExternalLink, Loader2Icon, Lock } from '@/lib/icons'
import { $sendDiagnostics, dismissSendDiagnostics, reportIssue, saveDiagnosticsReport } from '@/store/send-diagnostics'

export function SendDiagnosticsHost() {
  const { t } = useI18n()
  const copy = t.sendDiagnostics
  const state = useStore($sendDiagnostics)
  const [showText, setShowText] = useState(false)

  if (!state) {
    return null
  }

  const busy = state.phase === 'loading' || state.phase === 'saving'

  const issueButton = (
    <Tip label={copy.reportIssueHint}>
      <Button onClick={() => reportIssue(copy.issueTitle)} size="sm" variant="outline">
        <ExternalLink className="size-3" />
        {copy.reportIssue}
      </Button>
    </Tip>
  )

  return (
    <Dialog
      onOpenChange={open => {
        if (!open) {
          setShowText(false)
          dismissSendDiagnostics()
        }
      }}
      open
    >
      <DialogContent className="max-w-[30rem]" data-diagnostics-report={state.phase}>
        {state.phase === 'saved' ? (
          <>
            <DialogHeader>
              <DialogTitle>{copy.savedTitle}</DialogTitle>
              <DialogDescription className="text-left">
                {copy.savedDescription(state.savedName ?? '')}
              </DialogDescription>
            </DialogHeader>
            <p className="text-[0.8rem] text-(--ui-text-secondary)">{copy.reportIssueHint}</p>
            <DialogFooter>
              {issueButton}
              <Button onClick={dismissSendDiagnostics} variant="ghost">
                {copy.close}
              </Button>
            </DialogFooter>
          </>
        ) : state.phase === 'error' ? (
          <>
            <DialogHeader>
              <DialogTitle>{copy.failedTitle}</DialogTitle>
              <DialogDescription className="text-left">{state.error}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              {issueButton}
              <Button onClick={dismissSendDiagnostics} variant="ghost">
                {copy.close}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Lock className="size-4 text-(--ui-text-tertiary)" />
                {copy.title}
              </DialogTitle>
              <DialogDescription className="text-left">{copy.lead}</DialogDescription>
            </DialogHeader>
            {state.view ? (
              <ul className="text-[0.8rem] text-(--ui-text-secondary)" data-diagnostics-parts="">
                {state.view.parts.map(part => (
                  <li data-diagnostics-part={part.id} key={part.id}>
                    {copy.parts[part.id]} · {copy.lines(part.lines)}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="flex items-center gap-1.5 text-[0.8rem] text-(--ui-text-secondary)">
                <Loader2Icon className="size-3.5 animate-spin" />
                {copy.loading}
              </p>
            )}
            {state.view ? (
              showText ? (
                <pre
                  className="max-h-64 overflow-auto rounded-md border border-(--ui-stroke-tertiary) px-3 py-2 text-[0.72rem] whitespace-pre-wrap text-(--ui-text-secondary)"
                  data-diagnostics-text=""
                  data-selectable-text="true"
                >
                  {state.view.text}
                </pre>
              ) : (
                <div>
                  <Button onClick={() => setShowText(true)} size="sm" variant="text">
                    {copy.preview}
                  </Button>
                </div>
              )
            ) : null}
            <DialogFooter>
              {issueButton}
              <Button onClick={dismissSendDiagnostics} variant="ghost">
                {copy.cancel}
              </Button>
              <Button disabled={busy || !state.view} onClick={() => void saveDiagnosticsReport()}>
                {state.phase === 'saving' ? (
                  <span className="flex items-center gap-1.5">
                    <Loader2Icon className="size-3.5 animate-spin" />
                    {copy.saving}
                  </span>
                ) : (
                  copy.save
                )}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
