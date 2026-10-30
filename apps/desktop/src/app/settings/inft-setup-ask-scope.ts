/**
 * iclone os — the "ask Hermes" fill is one-shot. It belongs to the new-chat
 * draft it landed in and to the iNFT that was on stage at that moment; any
 * move away (a navigation, a stage switch, a reload or restart) withdraws it
 * from the draft, so it never rides into another conversation or another
 * iNFT's first message. Whatever the owner typed around it stays.
 */
import { readJson, writeJson } from '@/lib/storage'
import { requestComposerDraftSync, stashSessionDraft, takeSessionDraft } from '@/store/composer'

/** Persisted so the reload or restart that must retire the fill can find it. */
export const ASK_FILL_STORAGE_KEY = 'iclone:ask-hermes-fill:v1'

interface AskFill {
  stage: string | null
  text: string
}

let pending: AskFill | null = null
let stage: string | null = null
let disarm: (() => void) | null = null

function recalled(): AskFill | null {
  const stored = readJson<Partial<AskFill>>(ASK_FILL_STORAGE_KEY)

  return typeof stored?.text === 'string' && stored.text ? { stage: null, text: stored.text } : null
}

/** Records the fill just inserted into the main composer's new-chat draft.
 *  Call it after the insert has landed: the navigation that opened the
 *  composer must not count as leaving it. */
export function armAskFill(text: string): void {
  withdrawAskFill()

  const fill = { stage, text: text.trim() }

  if (!fill.text) {
    return
  }

  pending = fill
  writeJson(ASK_FILL_STORAGE_KEY, { text: fill.text })

  const moves = typeof window === 'undefined' ? undefined : (window.navigation as Navigation | undefined)
  const onMove = () => withdrawAskFill()

  moves?.addEventListener('currententrychange', onMove)
  disarm = () => moves?.removeEventListener('currententrychange', onMove)
}

/** Removes the fill from the new-chat draft if it is still there verbatim — an
 *  edited fill is the owner's own text now. */
export function withdrawAskFill(): void {
  const fill = pending ?? recalled()

  pending = null
  disarm?.()
  disarm = null

  if (!fill) {
    return
  }

  writeJson(ASK_FILL_STORAGE_KEY, null)
  // The live editor's latest keystrokes first, or a pending debounce is lost.
  requestComposerDraftSync('flush')

  const draft = takeSessionDraft(null)
  const at = draft.text.indexOf(fill.text)

  if (at < 0) {
    return
  }

  const rest = `${draft.text.slice(0, at)}${draft.text.slice(at + fill.text.length)}`.trim()

  stashSessionDraft(null, rest, draft.attachments)
  requestComposerDraftSync('reload')
}

/** The stage's one door reports every summon/dismiss here. */
export function noteAskStage(inftId: string | null): void {
  stage = inftId

  if (pending && pending.stage !== inftId) {
    withdrawAskFill()
  }
}

// A fill recorded by an earlier page life is stale the moment this one boots.
if (typeof window !== 'undefined') {
  withdrawAskFill()
}
