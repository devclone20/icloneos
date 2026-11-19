/**
 * v0.0.9 G re-shoot at 4c8fe2af69 (G-refused-tool-row): a refused terminal call showed no reason. Then the design delta
 * at 3112b338f3 (GF-M2, MAJOR): the reason it showed was the raw tool result written to the AGENT ("BLOCKED by icloneOS
 * permissions … What to do: tell the owner …"), in ink under AA. The collapsed row now says, to the owner, what did not
 * run and why, with the chat's mode picker one click away; the raw text is only in the expanded detail.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { over, ratio, read, skinColors, SKINS } from '@/test/token-contrast'

vi.mock('@assistant-ui/react', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAuiState: (select: (state: unknown) => unknown) =>
    select({ message: { id: 'msg-1', status: { type: 'complete' } }, thread: { isRunning: false } })
}))

const { ToolFallback } = await import('./fallback')

// The shape the permission plugin really writes (plugins/iclone-permissions/__init__.py _refusal).
const RAW =
  'BLOCKED by icloneOS permissions: running sleep needs an answer the owner has not given. Mode: Manual. What to do: tell ' +
  'the owner what you need and why, then wait. Do not try another route to the same effect.'

const props = () =>
  ({
    args: { command: 'sleep 5' },
    isError: true,
    result: { error: RAW, refused: true, summary: `Refused: ${RAW}` },
    toolCallId: 'call_refused',
    toolName: 'terminal'
  }) as unknown as ComponentProps<typeof ToolFallback>

afterEach(cleanup)

describe('a refused terminal tool row', () => {
  it('says to the owner what did not run and why, and the agent-directed text is not in the collapsed row', () => {
    const { container } = render(<ToolFallback {...props()} />)
    const line = container.querySelector('[data-slot="tool-refusal-reason"]')!

    expect(screen.getByText('Refused · Terminal')).toBeTruthy()
    expect(line.textContent).toContain("Terminal didn't run: this chat's permission mode (Manual) doesn't allow it.")
    expect(container.textContent).not.toMatch(/BLOCKED|tell the owner/)
  })

  it('the link opens the chat permission mode picker', () => {
    const opened = vi.fn()

    window.addEventListener('hermes:open-permissions', opened)
    render(<ToolFallback {...props()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Change permission mode' }))
    window.removeEventListener('hermes:open-permissions', opened)

    expect(opened).toHaveBeenCalledTimes(1)
  })

  it('keeps the raw refusal, as the agent read it, in the expanded detail only', () => {
    const { container } = render(<ToolFallback {...props()} />)

    fireEvent.click(screen.getByText('Refused · Terminal'))

    const raw = container.querySelector('[data-slot="tool-refusal-raw"]')!

    expect(raw.textContent).toContain('Sent to the agent')
    expect(raw.textContent).toContain(RAW)
    expect(container.querySelector('[data-slot="tool-refusal-reason"]')!.textContent).not.toMatch(/BLOCKED/)
  })

  it('the owner line ink holds AA (>= 4.5:1) on the chat surface in every skin', () => {
    const tsx = read('components/assistant-ui/tool/fallback.tsx')
    const ink = /text-\((--ic-[\w-]+)\) wrap-anywhere" data-slot="tool-refusal-reason"/.exec(tsx)?.[1]

    expect(ink).toBeDefined()

    for (const [name, foreground, skin] of SKINS) {
      const color = skinColors(foreground, skin)
      const surface = color('var(--ic-surface)')
      const glass = over(color('var(--ic-surface-glass)'), surface)
      // The thread is glass over the stage: the shot measured 2.9:1 there for the old ink, not on a flat surface.
      // A mid-grey stage under the glass is the conservative case.
      const overStage = over(color('var(--ic-surface-glass)'), [128, 128, 128, 1])

      for (const under of [surface, glass, overStage]) {
        expect(ratio(over(color(`var(${ink})`), under), under), `${name}: ${ink}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  // v0.0.9 G UI lens at 15017e6d54.
  it('names the tool by its display name and the mode by its picker label', () => {
    const raw = 'BLOCKED by icloneOS permissions: running code needs an answer. Mode: Acceptedits. What to do: tell the owner.'

    const { container } = render(
      <ToolFallback
        {...({
          args: { code: 'print(1)' },
          isError: true,
          result: { error: raw, refused: true },
          toolCallId: 'call_code',
          toolName: 'execute_code'
        } as unknown as ComponentProps<typeof ToolFallback>)}
      />
    )

    expect(screen.getByText('Refused · Code')).toBeTruthy()
    expect(container.querySelector('[data-slot="tool-refusal-reason"]')!.textContent).toContain(
      "Code didn't run: this chat's permission mode (Accept edits) doesn't allow it."
    )
  })

  it('the link cue holds 3:1 in every skin, and hover never moves the ink to accent', () => {
    const tsx = read('components/assistant-ui/tool/fallback.tsx')
    const link = /className="([^"]*)"\s*data-slot="tool-refusal-change-mode"|data-slot="tool-refusal-change-mode"[\s\S]*?className="([^"]*)"/.exec(tsx)
    const classes = (link?.[1] ?? link?.[2] ?? '') || /className="(underline [^"]*)"/.exec(tsx)?.[1] || ''
    const cue = /decoration-\((--ic-[\w-]+)\)/.exec(classes)?.[1]

    expect(cue).toBeDefined()
    expect(classes).not.toMatch(/hover:text-/)

    for (const [name, foreground, skin] of SKINS) {
      const color = skinColors(foreground, skin)
      const surface = color('var(--ic-surface)')

      for (const under of [surface, over(color('var(--ic-surface-glass)'), surface), over(color('var(--ic-surface-glass)'), [128, 128, 128, 1])]) {
        expect(ratio(over(color(`var(${cue})`), under), under), `${name}: ${cue}`).toBeGreaterThanOrEqual(3)
      }
    }
  })
})
