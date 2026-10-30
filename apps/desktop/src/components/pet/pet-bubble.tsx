import { type CSSProperties, useEffect, useState } from 'react'

import type { Translations } from '@/i18n'
import { AlertCircle, Clock, type IconComponent } from '@/lib/icons'
import { scaledFontPx } from '@/lib/text-size'

import type { PetState } from './pet-states'

/**
 * The pet's speech bubble (the old `pet-bubble`, same moods, its copy now in i18n): it says what the agent is
 * doing so a glance at the desktop pet replaces switching back to the app. It speaks only when there is something
 * to say — working, thinking, a snag, your turn — and is silent at idle and on the finish beats (the jump and the
 * unread marker carry those). Shown by the popped-out pet, as before: inside the app, the app is the surface.
 */

type Mood = keyof Translations['commandCenter']['pets']['bubble']

const MOOD_OF: Partial<Record<PetState, Mood>> = { failed: 'failed', review: 'review', run: 'run', waiting: 'waiting' }

const GLYPH: Partial<Record<Mood, { icon: IconComponent; color: string }>> = {
  failed: { color: 'var(--ui-red)', icon: AlertCircle },
  waiting: { color: 'var(--ui-yellow)', icon: Clock }
}

const ROTATE_MS = 2600

/** A random line that is never the one already showing. */
export function pickLine(lines: readonly string[], prev: string, rng: () => number = Math.random): string {
  if (lines.length <= 1) {
    return lines[0] ?? ''
  }

  let next = prev

  while (next === prev) {
    next = lines[Math.floor(rng() * lines.length)] ?? ''
  }

  return next
}

export function petMood(state: PetState, awaitingInput: boolean): Mood | null {
  return MOOD_OF[state] ?? (state === 'idle' && awaitingInput ? 'waiting' : null)
}

interface PetBubbleProps {
  state: PetState
  awaitingInput: boolean
  words: Translations['commandCenter']['pets']['bubble']
}

export function PetBubble({ state, awaitingInput, words }: PetBubbleProps) {
  const mood = petMood(state, awaitingInput)
  const lines = mood ? words[mood] : null
  const [line, setLine] = useState('')

  useEffect(() => {
    if (!lines) {
      setLine('')

      return
    }

    setLine(prev => pickLine(lines, prev))

    if (mood !== 'run' && mood !== 'review') {
      return
    }

    const id = window.setInterval(() => setLine(prev => pickLine(lines, prev)), ROTATE_MS)

    return () => window.clearInterval(id)
  }, [mood, lines])

  if (!mood || !lines) {
    return null
  }

  const glyph = GLYPH[mood]
  const Glyph = glyph?.icon
  const text = line || lines[0]

  return (
    <div data-pet-bubble={mood} role="status" style={bubbleStyle()}>
      {Glyph && <Glyph style={{ color: glyph.color, height: 13, width: 13 }} />}
      {text}
    </div>
  )
}

/** The bubble's own look: the app's elevated surface, one line. */
function bubbleStyle(): CSSProperties {
  return {
    alignItems: 'center',
    background: 'var(--ui-bg-elevated)',
    border: '1px solid var(--ui-stroke-secondary)',
    borderRadius: 10,
    color: 'var(--foreground)',
    display: 'inline-flex',
    fontSize: scaledFontPx(11),
    fontWeight: 500,
    gap: 5,
    lineHeight: 1,
    padding: '5px 8px',
    pointerEvents: 'none',
    whiteSpace: 'nowrap'
  }
}

/** One line in the bubble's look, above the prompt box: why a message was not sent (the text stays in the box). */
export function PetPromptNote({ text }: { text: string }) {
  return (
    <div data-pet-prompt-note="" role="status" style={{ ...bubbleStyle(), marginBottom: 4 }}>
      <AlertCircle style={{ color: 'var(--ui-yellow)', height: 13, width: 13 }} />
      {text}
    </div>
  )
}
