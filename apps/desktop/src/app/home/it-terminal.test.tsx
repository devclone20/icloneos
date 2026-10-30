import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { IT_MESSAGE_INSTANCE, listPanes } from './it-layout'
import { $itBodySize, activeItWorkspace, setItInstancesForTests } from './it-store'
import { ItTerminal } from './it-terminal'
import { $terminals, createTerminal, type TerminalEntry } from './it/engine/terminals'

function reset(): void {
  const id = createTerminal('/tmp')

  $terminals.set([$terminals.get().find(term => term.id === id) as TerminalEntry])
  setItInstancesForTests([
    {
      activeId: 'ws-test',
      id: IT_MESSAGE_INSTANCE,
      n: 1,
      named: false,
      open: true,
      title: 'iT',
      workspaces: [
        {
          focusTerminalId: id,
          id: 'ws-test',
          layout: { type: 'leaf', terminalId: id },
          named: true,
          title: 'test',
          unread: false,
          zoomedTerminalId: null
        }
      ]
    }
  ])
}

const panes = () => listPanes(activeItWorkspace()!.layout).length

describe('U4p1-T4 — the split buttons say when the focused pane is too small', () => {
  beforeEach(() => {
    reset()
    $itBodySize.set({ height: 400, width: 580 })
  })

  afterEach(() => {
    cleanup()
    $itBodySize.set(null)
  })

  const splitRight = () => screen.getByRole('button', { name: 'Split right (⌘D)' }) as HTMLButtonElement
  const splitDown = () => screen.getByRole('button', { name: 'Split down (⌘⇧D)' }) as HTMLButtonElement

  // A disabled button fires no pointer events: ButtonTip hangs its reason on a wrapper.
  // The pointer leaves first, as a real one does: a trigger opens once per hover.
  async function expectTip(button: HTMLButtonElement, text: string) {
    const trigger = button.disabled ? (button.parentElement as HTMLElement) : button

    fireEvent.pointerLeave(trigger, { pointerType: 'mouse' })
    fireEvent.pointerMove(trigger, { pointerType: 'mouse' })
    await waitFor(() => expect(screen.getByRole('tooltip').textContent).toContain(text))
  }

  it('Split right disables itself with the reason once the halves would fall under the floor', async () => {
    render(<ItTerminal open />)

    expect(splitRight().hasAttribute('aria-disabled')).toBe(false)
    await expectTip(splitRight(), 'Split right — ⌘D')

    act(() => {
      fireEvent.click(splitRight())
    })
    expect(panes()).toBe(2)

    // 580 / 2 = 290 px per pane; halving again would leave 145 px < 150.
    expect(splitRight().getAttribute('aria-disabled')).toBe('true')
    await expectTip(splitRight(), 'The focused pane is too small to split right')
    expect(splitDown().hasAttribute('aria-disabled')).toBe(false)

    act(() => {
      fireEvent.click(splitRight())
    })
    expect(panes()).toBe(2)
  })

  it('re-enables when the measured body grows', async () => {
    render(<ItTerminal open />)

    act(() => {
      fireEvent.click(splitRight())
    })
    expect(splitRight().getAttribute('aria-disabled')).toBe('true')

    act(() => {
      $itBodySize.set({ height: 400, width: 1200 })
    })
    expect(splitRight().hasAttribute('aria-disabled')).toBe(false)
    await expectTip(splitRight(), 'Split right — ⌘D')
  })
})
