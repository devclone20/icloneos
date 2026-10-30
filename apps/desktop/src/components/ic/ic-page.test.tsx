import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { IcPage, IcPageRail, IcPageRow, IcPageState } from './ic-page'

afterEach(cleanup)

describe('IcPage frame', () => {
  it('our own card owns Esc and the close control', () => {
    const onClose = vi.fn()

    render(
      <IcPage closeLabel="Close profiles" onClose={onClose} title="Profiles">
        <p>body</p>
      </IcPage>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Close profiles' }))
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(globalThis.window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('a bare page leaves Esc and the close control to the shell that framed it', () => {
    const onClose = vi.fn()

    render(
      <IcPage frame="bare" onClose={onClose} title="Skills">
        <p>body</p>
      </IcPage>
    )

    fireEvent.keyDown(globalThis.window, { key: 'Escape' })

    expect(onClose).not.toHaveBeenCalled()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('an Escape another handler already took is not a second close', () => {
    const onClose = vi.fn()

    render(
      <IcPage onClose={onClose} title="Profiles">
        <p>body</p>
      </IcPage>
    )

    const event = new KeyboardEvent('keydown', { cancelable: true, key: 'Escape' })

    event.preventDefault()
    globalThis.window.dispatchEvent(event)

    expect(onClose).not.toHaveBeenCalled()
  })

  it('gives the caller its focus back when the page closes', () => {
    const opener = globalThis.document.createElement('button')

    globalThis.document.body.append(opener)
    opener.focus()

    const view = render(
      <IcPage onClose={vi.fn()} title="Profiles">
        <p>body</p>
      </IcPage>
    )

    expect(globalThis.document.activeElement).toBe(screen.getByRole('region', { name: 'Profiles' }))

    view.unmount()

    expect(globalThis.document.activeElement).toBe(opener)
    opener.remove()
  })

  it('names itself for the reader and takes a subtitle', () => {
    render(
      <IcPage label="Profiles" onClose={vi.fn()} subtitle="2 profiles" title="Profiles">
        <p>body</p>
      </IcPage>
    )

    expect(screen.getByRole('region', { name: 'Profiles' })).toBeTruthy()
    expect(screen.getByText('2 profiles')).toBeTruthy()
  })
})

describe('IcPageState', () => {
  it('loading is a busy live region', () => {
    render(<IcPageState kind="loading" title="Loading profiles..." />)

    const state = screen.getByRole('status')

    expect(state.getAttribute('aria-busy')).toBe('true')
    expect(state.getAttribute('data-ic-state')).toBe('loading')
  })

  it('error is an alert and carries its own way out', () => {
    render(<IcPageState action={<button type="button">Retry</button>} description="boom" kind="error" title="Failed" />)

    expect(screen.getByRole('alert').getAttribute('data-ic-state')).toBe('error')
    expect(screen.getByText('boom')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  })

  it('empty states say what to do next', () => {
    render(<IcPageState description="Profiles are independent environments." kind="empty" title="No profiles yet." />)

    expect(screen.getByText('No profiles yet.')).toBeTruthy()
    expect(screen.getByText('Profiles are independent environments.')).toBeTruthy()
  })
})

describe('IcPageRail', () => {
  it('marks the selected row and reports selection', () => {
    const onSelect = vi.fn()

    render(
      <IcPageRail label="Profiles" search={{ label: 'Search profiles...', onChange: vi.fn(), value: '' }}>
        <IcPageRow active meta="sonnet" onSelect={vi.fn()} title="default" />
        <IcPageRow active={false} onSelect={onSelect} title="work" />
      </IcPageRail>
    )

    expect(screen.getByRole('button', { name: /default/ }).getAttribute('aria-current')).toBe('true')
    expect(screen.getByRole('searchbox', { name: 'Search profiles...' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'work' }))
    expect(onSelect).toHaveBeenCalledTimes(1)
  })
})
