/**
 * v0.0.9 G design delta GF-7: a /compress refused because a turn is running read "error: session busy — Hermes is still
 * replying. Stop the current reply first (Stop button, or Ctrl+C in a terminal), then run /compress." in faint ink: a
 * lowercase "error:", the substrate's name, and a terminal shortcut in a Mac app with a Stop button. The owner reads
 * one plain line, and the chat's own system lines are set in AA secondary ink.
 */
import { describe, expect, it, vi } from 'vitest'

import { over, ratio, read, skinColors, SKINS } from '@/test/token-contrast'

import { compactCopy } from './compact.copy'
import { presentCompactionOutcome } from './present-compaction'

vi.mock('@/store/notifications', () => ({ dismissNotification: vi.fn(), notify: vi.fn() }))

describe('the busy /compress answer', () => {
  it('is one plain owner line: no "error:", no Hermes, no terminal shortcut', () => {
    const render = vi.fn()

    presentCompactionOutcome(
      { kind: 'busy', message: 'session busy — Hermes is still replying. Stop the current reply first (Stop button, or Ctrl+C in a terminal), then run /compress.', sessionId: 's1' },
      'n1',
      render
    )

    expect(render).toHaveBeenCalledWith('The agent is still replying. Stop it, then run /compress.')
    expect(compactCopy.busyLine).not.toMatch(/error:|Hermes|Ctrl\+C/)
  })

  it("the chat's plain system line is set in AA ink on the chat surface, its glass and glass over a grey stage", () => {
    const tsx = read('components/assistant-ui/thread/system-message.tsx')

    // Every line-level system message (the slash answer, the plain line) and the slash command token.
    const inks = [
      ...tsx.matchAll(/'w-\[60%\] max-w-\[44rem\] self-center [^']*text-\[color:var\((--ic-[\w-]+)\)\]'/g),
      ...tsx.matchAll(/font-mono text-\[color:var\((--ic-[\w-]+)\)\]">\{slashStatus/g)
    ].map(match => match[1])

    expect(inks.length).toBe(3)

    for (const ink of inks) {for (const [name, foreground, skin] of SKINS) {
      const color = skinColors(foreground, skin)
      const surface = color('var(--ic-surface)')

      for (const under of [surface, over(color('var(--ic-surface-glass)'), surface), over(color('var(--ic-surface-glass)'), [128, 128, 128, 1])]) {
        expect(ratio(over(color(`var(${ink})`), under), under), `${name}: ${ink}`).toBeGreaterThanOrEqual(4.5)
      }
    }}
  })
})
