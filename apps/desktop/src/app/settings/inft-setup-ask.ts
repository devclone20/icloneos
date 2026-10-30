/**
 * iclone os — the "ask Hermes" briefing of one wizard step: the topic, the
 * owner's saved notes and the step's last CLI output, all redacted. It is
 * only inserted into the composer — the owner reviews it before anything is
 * sent.
 */
import { NEW_CHAT_ROUTE } from '@/app/routes'
import { redactSecrets } from '@/iclone-shared/redact'

import { requestComposerFocus, requestComposerInsert } from '../chat/composer/focus'
import { setMsgView } from '../home/it-store'

import { armAskFill } from './inft-setup-ask-scope'
import type { StepState } from './inft-setup-runner'

const ASK_OUTPUT_CAP = 2_000

export function composeAskHermes(input: { name: string; topic: string; notes?: string; step?: StepState }): string {
  const { name, topic, notes, step } = input

  const parts = [
    `I am configuring my iNFT "${name}" in iclone os with the Virtuals ACP CLI. Help me with this step: ${topic}. Explain what it does, what I should choose, and walk me through it step by step.`
  ]

  if (notes?.trim()) {
    parts.push(`My saved notes for this step:\n${notes.trim()}`)
  }

  const last = step?.last
  const output = (last?.stdout || last?.stderr || '').trim()

  if (output) {
    parts.push(`Last CLI output (redacted):\n${output.slice(0, ASK_OUTPUT_CAP)}`)
  }

  const error = step?.error ?? last?.error

  if (error) {
    parts.push(`Last error: ${error}`)
  }

  return redactSecrets(parts.join('\n\n'))
}

/** Lands the briefing in the Message window's composer — never sent. The
 *  window reopens on its last tab, and on iT the filled composer is hidden,
 *  so the chat view is chosen before the window mounts. The fill is armed
 *  one-shot only after the deferred insert lands (see inft-setup-ask-scope). */
export function dropAskHermes(text: string, navigate: (route: string) => void): void {
  setMsgView('chat')
  navigate(NEW_CHAT_ROUTE)
  requestComposerInsert(text, { mode: 'block', target: 'main' })
  requestComposerFocus('main')
  window.setTimeout(() => armAskFill(text), 0)
}
