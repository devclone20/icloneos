import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { TRANSLATIONS } from '@/i18n/catalog'

import { PetBubble, petMood, pickLine } from './pet-bubble'

afterEach(cleanup)

describe('the speech bubble', () => {
  it('speaks for run, review, failed and waiting; silent at idle, wave and jump', () => {
    expect(['run', 'review', 'failed', 'waiting', 'idle', 'wave', 'jump'].map(s => petMood(s as never, false))).toEqual(
      ['run', 'review', 'failed', 'waiting', null, null, null]
    )
    expect(petMood('idle', true)).toBe('waiting')
  })

  it('never repeats the line it is showing', () => {
    const lines = ['a', 'b', 'c']
    let prev = 'a'
    let n = 0
    // A sequence that keeps offering the current line first: pickLine must draw again, never loop forever.
    const rng = () => (n++ % 4) / 4

    for (let i = 0; i < 30; i++) {
      const next = pickLine(lines, prev, rng)
      expect(next).not.toBe(prev)
      prev = next
    }
  })

  it('speaks the given language', () => {
    render(<PetBubble awaitingInput={false} state="waiting" words={TRANSLATIONS.ja.commandCenter.pets.bubble} />)
    expect(TRANSLATIONS.ja.commandCenter.pets.bubble.waiting).toContain(screen.getByRole('status').textContent)
  })
})
