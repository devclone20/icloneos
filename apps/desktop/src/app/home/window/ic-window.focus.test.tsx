import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { stubMenuDomApis, stubResizeObserver } from '@/test/jsdom'

import { IcWindow } from './ic-window'

const LABELS = { close: 'Close', expand: 'Expand', retract: 'Retract', opacity: 'Opacity' }

function renderSelf(children: React.ReactNode) {
  return render(
    <IcWindow
      expanded={false}
      head={<h2>wallet</h2>}
      id="wallet"
      label="Wallet"
      labels={LABELS}
      onClose={vi.fn()}
      onToggleExpanded={vi.fn()}
      placement="self"
    >
      {children}
    </IcWindow>
  )
}

beforeAll(() => {
  stubResizeObserver()
  stubMenuDomApis()
})

afterEach(cleanup)

describe('IcWindow focus on open (U2-p2-09, U4-p2-09)', () => {
  it('moves focus into the window when the app claims none', () => {
    renderSelf(<p>balances</p>)

    const root = window.document.querySelector('[data-ic-window="wallet"]')

    expect(root).toBeTruthy()
    expect(window.document.activeElement).toBe(root)
  })

  it('leaves focus with a control the app focused itself', () => {
    renderSelf(<input aria-label="Search" autoFocus />)

    expect(window.document.activeElement).toBe(window.document.querySelector('input'))
  })

  it('puts the control column before the content in tree order, LTR whatever the page direction', () => {
    renderSelf(<p>balances</p>)

    const controls = window.document.querySelector('.ic-win__controls')
    const head = window.document.querySelector('.ic-win__head')

    expect(controls?.getAttribute('dir')).toBe('ltr')
    expect(controls!.compareDocumentPosition(head!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
