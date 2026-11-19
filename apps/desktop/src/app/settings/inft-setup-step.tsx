import { MessageSquare } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { Tip } from '@/components/ui/tooltip'

import type { StepNotesApi } from './inft-setup-notes'
import type { StepState } from './inft-setup-runner'
import { useInftWizardCopy } from './inft-setup-wizard-copy'
import { SettingRow } from './setting-row'

export interface StepKit {
  notes: StepNotesApi
  resume: (key: string) => void
}

/** The owner's own notes for one step: saved per iNFT (redacted by main), carried into "ask hermes". */
function StepNoteEditor({ kit, notesKey }: { kit: StepKit; notesKey: string }) {
  const copy = useInftWizardCopy().step
  const saved = kit.notes.notes[notesKey]?.text ?? ''
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(saved)

  if (!open) {
    return (
      <>
        {saved && <p className="iws__note">{copy.notes(saved)}</p>}
        <button
          className="iws__ask"
          onClick={() => {
            setDraft(saved)
            setOpen(true)
          }}
          type="button"
        >
          {saved ? copy.editNotes : copy.addNotes}
        </button>
      </>
    )
  }

  return (
    <>
      <textarea
        aria-label={copy.notesLabel}
        className="iws__input"
        maxLength={8192}
        onChange={e => setDraft(e.target.value)}
        placeholder={copy.notesPlaceholder}
        rows={3}
        value={draft}
      />
      <div className="iws__row">
        <button
          className="iws__btn"
          onClick={() => void kit.notes.saveNote(notesKey, draft).then(() => setOpen(false))}
          type="button"
        >
          {copy.saveNotes}
        </button>
        {saved && (
          <button
            className="iws__btn"
            onClick={() => void kit.notes.deleteNote(notesKey).then(() => setOpen(false))}
            type="button"
          >
            {copy.deleteNotes}
          </button>
        )}
        <button className="iws__btn" onClick={() => setOpen(false)} type="button">
          {copy.cancel}
        </button>
      </div>
      {kit.notes.masked && <p className="iws__note">{copy.masked}</p>}
      {kit.notes.error && <p className="iws__error">{kit.notes.error}</p>}
    </>
  )
}

/** DOM id of a wizard row: the target of a `?step=` deep link. */
export const stepRowId = (notesKey: string) => `iws-step-${notesKey}`

/**
 * One numbered wizard step on THE Settings row: the step's one sentence as the title (its number or a check in
 * front), the detail as the hint, and under it the step's main action, then everything else — status, secondary
 * actions, output, "ask hermes" and the owner's notes.
 */
export function Step({
  active = true,
  children,
  control,
  done,
  hint,
  index,
  kit,
  notesKey,
  onAskHermes,
  state,
  title
}: {
  /** v0.0.9 G GF-3: the step the owner is on. Only it offers "Ask the agent / Add notes"; others keep saved notes. */
  active?: boolean
  children?: ReactNode
  control?: ReactNode
  done: boolean
  hint?: ReactNode
  index: number
  kit: StepKit
  notesKey: string
  onAskHermes: () => void
  state?: StepState
  title: string
}) {
  const copy = useInftWizardCopy().step
  const hasSavedNotes = Boolean(kit.notes.notes[notesKey]?.text)

  return (
    <SettingRow
      below={
        <div className="iws__step-body">
          {/* v0.0.9 G GF-2: the step's main action sits under its text, like every other step action, never detached
              at the row's trailing edge. */}
          {control ? <div className="iws__row">{control}</div> : null}
          {children}
          {state?.note && <p className="iws__note">{state.note}</p>}
          {state?.stalled && (
            <div className="iws__row">
              <button className="iws__btn iws__btn--primary" onClick={() => kit.resume(notesKey)} type="button">
                {copy.resume}
              </button>
            </div>
          )}
          {state?.error && <p className="iws__error">{state.error}</p>}
          {state?.output && <pre className="iws__out">{state.output}</pre>}
          {(active || hasSavedNotes) && (
            <div className="iws__row">
              {active && (
                <Tip label={copy.askTip}>
                  <button className="iws__ask" onClick={onAskHermes} type="button">
                    <MessageSquare size={13} strokeWidth={1.8} /> {copy.ask}
                  </button>
                </Tip>
              )}
              <StepNoteEditor key={notesKey} kit={kit} notesKey={notesKey} />
            </div>
          )}
        </div>
      }
      // v0.0.9 G GF-9: the step's text sits in the title column, with its actions.
      hint={hint ? <span className="iws__step-hint">{hint}</span> : undefined}
      id={stepRowId(notesKey)}
      title={
        <span className="inline-flex items-center gap-2.5">
          <span className={done ? 'iws__step--done' : undefined}>
            <span aria-label={done ? copy.done : undefined} className="iws__dot">
              {done ? '✓' : index}
            </span>
          </span>
          <span>{title}</span>
        </span>
      }
    />
  )
}
