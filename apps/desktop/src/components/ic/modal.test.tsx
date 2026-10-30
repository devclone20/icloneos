import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { IcConfirm, IcModal } from './modal'

afterEach(cleanup)

describe('IcModal', () => {
  it('is a modal dialog named by its title', () => {
    render(
      <IcModal description="what it does" onClose={vi.fn()} title="New cron">
        <p>body</p>
      </IcModal>
    )

    const dialog = screen.getByRole('dialog', { name: 'New cron' })

    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(screen.getByText('what it does')).toBeTruthy()
  })

  it('closes on Escape — at a rung ABOVE the page frame, so one Esc closes one thing', () => {
    const onClose = vi.fn()

    render(
      <IcModal onClose={onClose} title="New cron">
        <p>body</p>
      </IcModal>
    )

    const event = new KeyboardEvent('keydown', { cancelable: true, key: 'Escape' })

    window.dispatchEvent(event)

    expect(onClose).toHaveBeenCalledTimes(1)
    // defaultPrevented is what a page frame beneath checks before acting.
    expect(event.defaultPrevented).toBe(true)
  })

  it('moves focus into the plate so Tab cannot walk the page behind it', () => {
    render(
      <IcModal onClose={vi.fn()} title="New cron">
        <button type="button">inside</button>
      </IcModal>
    )

    expect(globalThis.document.querySelector('.icmodal__plate')?.contains(globalThis.document.activeElement)).toBe(true)
  })
})

describe('IcConfirm', () => {
  it('runs the destructive action and closes', async () => {
    const onClose = vi.fn()
    const onConfirm = vi.fn(async () => undefined)

    render(
      <IcConfirm
        busyLabel="Deleting…"
        cancelLabel="Cancel"
        confirmLabel="Delete"
        description="Delete Nightly?"
        onClose={onClose}
        onConfirm={onConfirm}
        title="Delete cron"
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(onConfirm).toHaveBeenCalled()
  })

  it('stays open and shows why when the action fails', async () => {
    const onClose = vi.fn()

    render(
      <IcConfirm
        busyLabel="Deleting…"
        cancelLabel="Cancel"
        confirmLabel="Delete"
        description="Delete Nightly?"
        onClose={onClose}
        onConfirm={vi.fn(async () => {
          throw new Error('job is running')
        })}
        title="Delete cron"
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    expect(await screen.findByText('job is running')).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Delete cron' })).toBeTruthy()
  })
})
