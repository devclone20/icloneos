import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { IcAction, IcIconAction, IcSearchInput, IcSegmented } from './controls'
import { IcDot, IcEmpty, IcNote, IcSkeleton } from './feedback'
import { IcStat } from './layout'
import { IcMonoLines } from './mono'
import { IcRow, IcRows } from './rows'

// Our primitives replace the upstream Button/Input/Panel set. These pin what
// the pages depend on: the accessible name, the state attribute our CSS reads,
// and the empty/loading/error shapes.

afterEach(cleanup)

describe('ic-ui primitives', () => {
  it('opens a row and exposes its actions', () => {
    const onOpen = vi.fn()
    const onAct = vi.fn()

    render(
      <IcRows>
        <IcRow
          actions={<IcAction onClick={onAct}>Act</IcAction>}
          meta="yesterday"
          onOpen={onOpen}
          status={<IcDot label="running" tone="live" />}
          title="A session"
        />
      </IcRows>
    )

    fireEvent.click(screen.getByRole('button', { name: /A session/ }))
    expect(onOpen).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Act' }))
    expect(onAct).toHaveBeenCalledTimes(1)

    expect(screen.getByText('yesterday')).toBeTruthy()
    expect(screen.getByRole('img', { name: 'running' }).getAttribute('data-tone')).toBe('live')
  })

  it('renders a row without an open handler as plain text', () => {
    render(
      <IcRows>
        <IcRow title="Static" />
      </IcRows>
    )

    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText('Static')).toBeTruthy()
  })

  it('reports every keystroke of the search field', () => {
    const onChange = vi.fn()

    render(<IcSearchInput onChange={onChange} placeholder="Search" value="" width="10rem" />)
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), { target: { value: 'ab' } })
    expect(onChange).toHaveBeenCalledWith('ab')
  })

  it('presses exactly one segment', () => {
    const onChange = vi.fn()

    render(
      <IcSegmented
        onChange={onChange}
        options={[
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' }
        ]}
        value="a"
      />
    )

    expect(screen.getByRole('button', { name: 'A' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'B' }).getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(screen.getByRole('button', { name: 'B' }))
    expect(onChange).toHaveBeenCalledWith('b')
  })

  it('disables an action and never fires it', () => {
    const onClick = vi.fn()

    render(
      <IcAction disabled onClick={onClick}>
        Go
      </IcAction>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Go' }))
    expect(onClick).not.toHaveBeenCalled()
  })

  it('shows a loading tail, an empty tail and the lines themselves', () => {
    const { rerender } = render(<IcMonoLines emptyLabel="No logs" lines={null} />)

    expect(screen.getByRole('status', { name: 'No logs' })).toBeTruthy()

    rerender(<IcMonoLines emptyLabel="No logs" lines={[]} />)
    expect(screen.getByText('No logs')).toBeTruthy()

    rerender(<IcMonoLines emptyLabel="No logs" lines={['one', 'two']} />)
    expect(globalThis.document.querySelector('.icui-mono')?.textContent).toBe('one\ntwo')
  })

  it('announces an error note and labels a busy skeleton', () => {
    render(
      <>
        <IcNote tone="danger">Broke</IcNote>
        <IcSkeleton label="Loading" rows={3} />
      </>
    )

    expect(screen.getByRole('alert').textContent).toContain('Broke')

    const busy = screen.getByRole('status', { name: 'Loading' })

    expect(busy.getAttribute('aria-busy')).toBe('true')
    expect(busy.querySelectorAll('span')).toHaveLength(3)
  })

  it('renders an empty state with its action and a stat with its label', () => {
    const onClick = vi.fn()

    render(
      <>
        <IcEmpty action={<IcAction onClick={onClick}>Retry</IcAction>} description="Nothing yet." title="IcEmpty" />
        <IcStat label="Sessions" value="12" />
      </>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(screen.getByText('IcEmpty')).toBeTruthy()
    expect(screen.getByText('Nothing yet.')).toBeTruthy()
    expect(screen.getByText('Sessions')).toBeTruthy()
    expect(screen.getByText('12')).toBeTruthy()
  })

  // The move into src/components/ic brought this button under the renderer's
  // no-native-title guard: the name must stay, the OS tooltip must not come back.
  it('names an icon action without a native tooltip', () => {
    render(
      <IcIconAction label="Refresh" onClick={vi.fn()}>
        <svg />
      </IcIconAction>
    )
    const button = screen.getByRole('button', { name: 'Refresh' })

    expect(button.getAttribute('title')).toBeNull()
    expect(button.className).toBe('icui-icon')
  })
})
