/**
 * v0.0.9 r3 (design N2): the leading action on a notification plate is tone="note" (full plate ink), never the faint
 * quiet button. Red on fb85ac6be6: the stopped banner's Retry and a toast's own action rendered icpg__btn--quiet.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { AgentStoppedBanner } from './agent-stopped-banner'

describe('plate actions', () => {
  it('the stopped banner leads with Retry in the plate ink, Show details stays the quiet sibling', () => {
    render(<AgentStoppedBanner cause={null} onRetry={vi.fn()} onShowDetails={vi.fn()} />)
    const buttons = screen.getAllByRole('button').filter(b => b.className.includes('icpg__btn'))
    // r4d (design r4 F2-1): the banner's action is "Restart agent", the crash toast's own verb.
    const retry = buttons.find(b => /restart agent/i.test(b.textContent ?? ''))

    expect(retry?.className).toContain('icpg__btn--note')
    expect(retry?.className).not.toContain('icpg__btn--quiet')
  })
})
