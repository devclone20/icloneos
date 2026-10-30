import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ErrorBoundary } from '@/components/error-boundary'

import { $itCrashProbe, ItCrashProbe, ItPaneCrashCard } from './it-cards'

describe('the per-pane crash card', () => {
  afterEach(() => {
    cleanup()
    $itCrashProbe.set(null)
  })

  it('a throw in one pane shows Retry · Close pane in that pane only; Retry brings the shell back', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const onClose = vi.fn()

    const pane = (id: string) => (
      <div data-testid={id}>
        <ErrorBoundary
          fallback={({ reset }) => (
            <ItPaneCrashCard
              onClose={onClose}
              onRetry={() => {
                $itCrashProbe.set(null)
                reset()
              }}
            />
          )}
          label={`it-shell:${id}`}
        >
          <ItCrashProbe target={id} />
          <span>shell {id}</span>
        </ErrorBoundary>
      </div>
    )

    render(
      <>
        {pane('a')}
        {pane('b')}
      </>
    )
    act(() => $itCrashProbe.set('a'))

    expect(screen.getByTestId('a').textContent).toContain('shell failed')
    expect(screen.getByTestId('b').textContent).toBe('shell b')
    fireEvent.click(screen.getByRole('button', { name: 'Close pane' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(screen.getByTestId('a').textContent).toBe('shell a')
    quiet.mockRestore()
  })
})

describe('the crash card of a pane that can never close', () => {
  afterEach(cleanup)

  it('offers Retry only — no Close button that would do nothing', () => {
    render(<ItPaneCrashCard onRetry={() => undefined} />)
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Close pane' })).toBeNull()
  })
})
