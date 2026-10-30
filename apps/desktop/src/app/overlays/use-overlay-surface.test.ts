import { cleanup, fireEvent, render } from '@testing-library/react'
import { createElement, type RefObject, useRef } from 'react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { ESCAPE_PRIORITY, pushEscapeLayer } from '@/lib/escape-layers'
import { composerFocusBlockedBySurface } from '@/lib/keybinds/composer-focus-keys'

import { OVERLAY_SURFACE_MARKER, useOverlaySurface } from './use-overlay-surface'

// jsdom lays nothing out, so `offsetParent` is always null; give rendered
// elements their parent and hidden ones null, as a browser would.
const offsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent')

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get(this: HTMLElement) {
      return this.closest('[hidden]') ? null : this.parentElement
    }
  })
})

afterAll(() => {
  if (offsetParent) {
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', offsetParent)
  }
})

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

interface HarnessProps {
  onClose: () => void
  withFocusTarget?: boolean
}

function Harness({ onClose, withFocusTarget = false }: HarnessProps) {
  const focusRef = useRef<HTMLDivElement>(null)
  const scopeRef = useOverlaySurface<HTMLDivElement>(onClose, withFocusTarget ? { focusRef } : undefined)

  return createElement(
    'div',
    { 'data-testid': 'scope', ref: scopeRef, tabIndex: -1, ...OVERLAY_SURFACE_MARKER },
    createElement('div', { 'data-testid': 'body', ref: focusRef as RefObject<HTMLDivElement>, tabIndex: -1 }),
    createElement('button', { type: 'button' }, 'First'),
    createElement('button', { disabled: true, type: 'button' }, 'Disabled'),
    createElement('div', { hidden: true }, createElement('button', { type: 'button' }, 'Hidden')),
    createElement('input', { 'aria-label': 'Field' }),
    createElement('button', { type: 'button' }, 'Last')
  )
}

function mount(props: Partial<HarnessProps> = {}) {
  const onClose = props.onClose ?? vi.fn()
  const opener = document.createElement('button')

  opener.textContent = 'Opener'
  document.body.append(opener)
  opener.focus()

  const view = render(createElement(Harness, { ...props, onClose }))
  const byText = (text: string) => view.getByText(text) as HTMLElement

  return { ...view, byText, onClose, opener }
}

function tab(shiftKey = false) {
  return fireEvent.keyDown(window, { key: 'Tab', shiftKey })
}

describe('useOverlaySurface focus contract', () => {
  it('moves focus into the scope on mount', () => {
    const { getByTestId } = mount()

    expect(document.activeElement).toBe(getByTestId('scope'))
  })

  it('moves focus to the focus target when the scope has no box of its own', () => {
    const { getByTestId } = mount({ withFocusTarget: true })

    expect(document.activeElement).toBe(getByTestId('body'))
  })

  it('wraps Tab from the last focusable to the first', () => {
    const { byText } = mount()

    byText('Last').focus()
    tab()

    expect(document.activeElement).toBe(byText('First'))
  })

  it('wraps Shift+Tab from the first focusable to the last', () => {
    const { byText } = mount()

    byText('First').focus()
    tab(true)

    expect(document.activeElement).toBe(byText('Last'))
  })

  it('wraps Shift+Tab from the scope itself and from the focus target to the last', () => {
    const { byText, unmount } = mount()

    tab(true)
    expect(document.activeElement).toBe(byText('Last'))
    unmount()

    const second = mount({ withFocusTarget: true })

    tab(true)
    expect(document.activeElement).toBe(second.byText('Last'))
  })

  it('skips disabled and hidden controls when it picks the ends', () => {
    const { byText, getByLabelText } = mount()

    getByLabelText('Field').focus()
    tab()
    // The browser moves focus itself; the trap only steps in at the ends.
    expect(document.activeElement).toBe(getByLabelText('Field'))

    byText('Last').focus()
    tab()
    expect(document.activeElement).toBe(byText('First'))
  })

  it('reels focus back in when it escaped the scope', () => {
    const { byText, opener } = mount()

    opener.focus()
    tab()

    expect(document.activeElement).toBe(byText('First'))
  })

  it('leaves keys other than Tab alone', () => {
    const { byText } = mount()

    byText('Last').focus()
    fireEvent.keyDown(window, { key: 'ArrowDown' })

    expect(document.activeElement).toBe(byText('Last'))
  })

  it('returns focus to the opener on unmount', () => {
    const { opener, unmount } = mount()

    unmount()

    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  it('does not reach for an opener that left the document', () => {
    const { opener, unmount } = mount()

    opener.remove()

    expect(() => unmount()).not.toThrow()
    expect(document.activeElement).toBe(document.body)
  })
})

describe('useOverlaySurface Escape', () => {
  it('closes once on Escape and claims the key', () => {
    const { onClose } = mount()
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' })

    window.dispatchEvent(event)

    expect(onClose).toHaveBeenCalledOnce()
    expect(event.defaultPrevented).toBe(true)
  })

  it('ignores an Escape a nested layer already handled', () => {
    const { onClose } = mount()
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' })

    event.preventDefault()
    window.dispatchEvent(event)

    expect(onClose).not.toHaveBeenCalled()
  })

  it('yields Escape to a higher layer (a drag) and takes it back once that layer closes', () => {
    const { onClose } = mount()
    const release = pushEscapeLayer(ESCAPE_PRIORITY.drag)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()

    release()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('outranks the home stage beneath it', () => {
    const { onClose } = mount()
    const release = pushEscapeLayer(ESCAPE_PRIORITY.homeStage)

    fireEvent.keyDown(window, { key: 'Escape' })
    release()

    expect(onClose).toHaveBeenCalledOnce()
  })

  it('stops listening once unmounted', () => {
    const { onClose, unmount } = mount()

    unmount()
    fireEvent.keyDown(window, { key: 'Escape' })

    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('OVERLAY_SURFACE_MARKER', () => {
  it('stands the composer type-to-focus down while a surface is mounted, and only then', () => {
    const { unmount } = mount()

    expect(composerFocusBlockedBySurface()).toBe(true)
    unmount()
    expect(composerFocusBlockedBySurface()).toBe(false)
  })
})
