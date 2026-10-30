// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { McpRow, ServerIconActions, ServerSwitch } from './row'

afterEach(cleanup)

const noop = () => {}

// r4: the four native tooltips r3 introduced are gone (DESIGN.md forbids
// `title` outright) and no icon-only control lost its name — `aria-label` is
// the single source, which `.icsk__iconbtn::after` also draws on hover/focus.
describe('MCP row controls name themselves without a native tooltip', () => {
  it('keeps both icon actions named and title-free', () => {
    const { container } = render(<ServerIconActions onProbe={noop} onRemove={noop} probing={false} saving={false} />)

    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(2)

    for (const button of buttons) {
      expect(button.getAttribute('aria-label')).toBeTruthy()
      expect(button.hasAttribute('title')).toBe(false)
    }

    expect(container.querySelectorAll('.icsk__iconbtn')).toHaveLength(2)
  })

  it('names the switch through the control, not through its wrapper', () => {
    const { container } = render(<ServerSwitch disabled={false} enabled name="context7" onToggle={noop} />)

    expect(screen.getByRole('switch', { name: 'context7' })).toBeTruthy()
    expect(container.querySelector('[title]')).toBeNull()
  })
})

// r4 T1: the name's two rungs are page-local classes on --ic-* tokens, so no
// Tailwind alias of the old design can colour them any more.
describe('MCP row text rungs', () => {
  const row = (enabled: boolean) =>
    render(
      <McpRow
        active={false}
        busy={false}
        enabled={enabled}
        name="context7"
        onProbe={noop}
        onRemove={noop}
        onSelect={noop}
        onToggle={noop}
        status={enabled ? 'ok' : 'off'}
        statusText="Ready"
      />
    ).container

  it('paints an enabled server at the strongest rung', () => {
    const name = row(true).querySelector('.icsk__srv-name')
    expect(name?.textContent).toMatch(/context7/i)
    expect(name?.classList.contains('icsk__srv-name--off')).toBe(false)
  })

  it('drops a disabled server one rung quieter', () => {
    expect(row(false).querySelector('.icsk__srv-name--off')).not.toBeNull()
  })

  it('gives the status line its own quiet rung', () => {
    expect(row(true).querySelector('.icsk__srv-status')?.textContent).toBe('Ready')
  })
})
