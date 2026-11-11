// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fixtureState } from '@/app/home/containers/containers-fixtures'
import { getTerminalBackends, selectTerminalBackend } from '@/hermes'
import { $confinement } from '@/store/confinement'

import { IsolationComposerNote, IsolationControl, WhereCommandsRun } from './isolation-control'

vi.mock('@/hermes', () => ({ getTerminalBackends: vi.fn(), selectTerminalBackend: vi.fn() }))

const setIsolation = vi.fn()
const restartBackend = vi.fn(async () => ({ ok: true }))

function seat(on: boolean) {
  const state = fixtureState({ enabled: on, isolation: { on, available: true, persists: true, runningDiffers: false } })

  $confinement.set({ status: 'ready', state, error: null })

  return state
}

beforeEach(() => {
  vi.mocked(getTerminalBackends).mockResolvedValue({ active: 'local', backends: [] } as never)
  vi.mocked(selectTerminalBackend).mockResolvedValue(undefined as never)
  setIsolation.mockReset()
  restartBackend.mockClear()
  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = {
    restartBackend,
    icloneConfinement: { setIsolation, onChanged: () => () => undefined, state: async () => null }
  }
})

afterEach(() => {
  cleanup()
  $confinement.set({ status: 'loading', state: null, error: null })
})

describe('the isolation control', () => {
  it('asks main inside the click, carries the mark, and says what main answered', async () => {
    seat(true)
    setIsolation.mockResolvedValue({ ok: true, on: false, restart: 'done' })
    render(<IsolationControl />)

    const button = screen.getByRole('button', { name: 'Turn off…' })

    expect(button.hasAttribute('data-confinement-confirm')).toBe(true)
    fireEvent.click(button)
    expect(setIsolation).toHaveBeenCalledExactlyOnceWith(false)
    await screen.findByText(/Isolation is off\. The agent restarted with no sandbox/)
  })

  it('Cancel at the native dialog leaves no words and no change', async () => {
    seat(true)
    setIsolation.mockResolvedValue({ ok: false, on: true, reason: 'cancelled' })
    const { container } = render(<IsolationControl />)

    fireEvent.click(screen.getByRole('button', { name: 'Turn off…' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Turn off…' }).hasAttribute('disabled')).toBe(false))
    expect(container.querySelector('[data-isolation-result]')).toBeNull()
  })

  it('a red verdict: the card never says the kernel holds every command, and keeps Turn off', () => {
    const state = seat(true)

    $confinement.set({ status: 'ready', state: { ...state, verdict: 'red' }, error: null })

    const { container } = render(<IsolationControl />)

    expect(container.textContent).not.toMatch(/holds every|write only where/)
    expect(container.textContent).toContain('Confinement is not verified.')
    expect(screen.getByRole('button', { name: /Turn off/ })).toBeTruthy()
  })

  it('a green verdict: the card says the kernel holds them', () => {
    const state = seat(true)

    $confinement.set({ status: 'ready', state: { ...state, verdict: 'green' }, error: null })

    const { container } = render(<IsolationControl />)

    expect(container.textContent).toContain('holds the agent’s commands in a sandbox, except one you approve')
  })

  it('off: the fact stands once, with no way to the place it already is, and the same button turns it on', async () => {
    seat(false)
    setIsolation.mockResolvedValue({ ok: true, on: true, restart: 'done' })
    render(<IsolationControl />)

    expect(screen.getByText(/full user rights/)).toBeTruthy()
    expect(screen.queryByText(/Turn it on in/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }))
    expect(setIsolation).toHaveBeenCalledExactlyOnceWith(true)
    await screen.findByText(/restarted inside the sandbox/)
    expect(selectTerminalBackend).not.toHaveBeenCalled()
  })

  it('turning on with docker picked: it goes back to the default and the runtime restarts, so one click works', async () => {
    seat(false)
    setIsolation.mockResolvedValue({ ok: true, on: true, restart: 'done' })
    vi.mocked(getTerminalBackends).mockResolvedValue({ active: 'docker', backends: [] } as never)
    render(<IsolationControl />)

    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }))
    await screen.findByText(/went back to the default/)
    expect(selectTerminalBackend).toHaveBeenCalledExactlyOnceWith('local')
    expect(restartBackend).toHaveBeenCalledOnce()
  })

  it('a running agent under the other state is said, with its restart', () => {
    $confinement.set({
      status: 'ready',
      error: null,
      state: fixtureState({ isolation: { on: true, available: true, persists: true, runningDiffers: true } })
    })
    render(<IsolationControl />)
    fireEvent.click(screen.getByRole('button', { name: 'Restart the agent' }))
    expect(restartBackend).toHaveBeenCalledOnce()
  })

  it('not on macOS there is no control', () => {
    $confinement.set({
      status: 'ready',
      error: null,
      state: fixtureState({ isolation: { on: true, available: false, persists: true, runningDiffers: false } })
    })
    const { container } = render(<IsolationControl />)

    expect(container.querySelector('[data-isolation-control]')).toBeNull()
  })
})

describe('the composer note', () => {
  it('appears only when main says off', () => {
    seat(true)
    const { container, rerender } = render(<IsolationComposerNote />)

    expect(container.querySelector('[data-isolation-warning]')).toBeNull()
    seat(false)
    rerender(<IsolationComposerNote />)
    expect(container.querySelector('[data-isolation-warning]')?.textContent).toContain('commands run with no sandbox')
  })
})

describe('Settings › Advanced: where commands run', () => {
  const field = <div data-testid="old-list" />

  it('on: the sandbox, and the old list is not offered', () => {
    seat(true)
    render(<WhereCommandsRun field={field} onUseSandbox={() => undefined} value="local" />)

    expect(screen.queryByTestId('old-list')).toBeNull()
    screen.getByText(/In the Seatbelt sandbox, on this Mac/)
  })

  it('off: the old list is the real choice', () => {
    seat(false)
    render(<WhereCommandsRun field={field} onUseSandbox={() => undefined} value="local" />)

    screen.getByTestId('old-list')
    expect(screen.getByText(/Nothing holds your agent/)).toBeTruthy()
  })

  it('on with a file asking for docker: the truth and one click out', () => {
    seat(true)
    const out = vi.fn()

    render(<WhereCommandsRun field={field} onUseSandbox={out} value="docker" />)
    screen.getByText(/Your settings ask for docker/)
    fireEvent.click(screen.getByRole('button', { name: 'Use the sandbox' }))
    expect(out).toHaveBeenCalledOnce()
  })

  it('off macOS the row is the old row', () => {
    $confinement.set({
      status: 'ready',
      error: null,
      state: fixtureState({ isolation: { on: true, available: false, persists: true, runningDiffers: false } })
    })
    render(<WhereCommandsRun field={field} onUseSandbox={() => undefined} value="local" />)
    screen.getByTestId('old-list')
  })
})
