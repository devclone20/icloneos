import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { IcConfirmDialog, IcDialog, IcPage, IcPageButton } from './ic-page'

afterEach(cleanup)

const CONFIRM_COPY = {
  busyLabel: 'Deleting…',
  cancelLabel: 'Cancel',
  confirmLabel: 'Delete',
  doneLabel: 'Deleted',
  errorFallback: 'It failed'
}

describe('IcDialog', () => {
  it('names itself for the reader and is modal', () => {
    render(
      <IcDialog
        description="What this does"
        footer={<button type="button">Cancel</button>}
        onClose={vi.fn()}
        open
        title="Rename profile"
      >
        <input aria-label="Name" />
      </IcDialog>
    )

    const dialog = screen.getByRole('dialog')

    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(screen.getByRole('heading', { name: 'Rename profile' })).toBeTruthy()
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy()
    // The live gate asserts the same thing on screen: a Radix `data-slot`
    // inside our page would be the old design painting again.
    expect(dialog.querySelector('[data-slot]')).toBeNull()
  })

  it('Escape closes the dialog and never reaches the page under it', () => {
    const closePage = vi.fn()
    const closeDialog = vi.fn()

    render(
      <IcPage onClose={closePage} title="Profiles">
        <IcDialog footer={null} onClose={closeDialog} open title="Rename profile">
          <input aria-label="Name" />
        </IcDialog>
      </IcPage>
    )

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })

    expect(closeDialog).toHaveBeenCalledTimes(1)
    expect(closePage).not.toHaveBeenCalled()
  })

  it('while busy Escape neither closes the dialog nor the page', () => {
    const closePage = vi.fn()
    const closeDialog = vi.fn()

    render(
      <IcPage onClose={closePage} title="Profiles">
        <IcDialog busy footer={null} onClose={closeDialog} open title="Rename profile">
          <input aria-label="Name" />
        </IcDialog>
      </IcPage>
    )

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })

    expect(closeDialog).not.toHaveBeenCalled()
    expect(closePage).not.toHaveBeenCalled()
  })

  it('a click on the scrim keeps the work on screen', () => {
    const onClose = vi.fn()

    const { container } = render(
      <IcDialog footer={null} onClose={onClose} open title="Rename profile">
        <input aria-label="Name" />
      </IcDialog>
    )

    const scrim = container.querySelector('.icdlg-scrim')

    expect(scrim).toBeTruthy()
    fireEvent.click(scrim as Element)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('opens on the marked control and hands focus back to the opener', () => {
    const opener = globalThis.document.createElement('button')

    globalThis.document.body.append(opener)
    opener.focus()

    const view = render(
      <IcDialog footer={<IcPageButton onClick={vi.fn()}>Cancel</IcPageButton>} onClose={vi.fn()} open title="Rename">
        <input aria-label="Name" data-ic-autofocus="" />
      </IcDialog>
    )

    expect(globalThis.document.activeElement).toBe(screen.getByLabelText('Name'))

    view.unmount()
    expect(globalThis.document.activeElement).toBe(opener)
    opener.remove()
  })

  it('Tab out of the last control wraps back into the dialog', () => {
    render(
      <IcDialog footer={<IcPageButton onClick={vi.fn()}>Cancel</IcPageButton>} onClose={vi.fn()} open title="Rename">
        <input aria-label="Name" data-ic-autofocus="" />
      </IcDialog>
    )

    const cancel = screen.getByRole('button', { name: 'Cancel' })

    cancel.focus()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' })
    expect(globalThis.document.activeElement).toBe(screen.getByLabelText('Name'))

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab', shiftKey: true })
    expect(globalThis.document.activeElement).toBe(cancel)
  })

  it('renders nothing while closed', () => {
    const { container } = render(
      <IcDialog footer={null} onClose={vi.fn()} open={false} title="Rename">
        <input aria-label="Name" />
      </IcDialog>
    )

    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })
})

describe('IcConfirmDialog', () => {
  it('confirms from Enter anywhere inside and closes after the done beat', async () => {
    vi.useFakeTimers()

    try {
      const onConfirm = vi.fn(async () => {})
      const onClose = vi.fn()

      render(<IcConfirmDialog {...CONFIRM_COPY} onClose={onClose} onConfirm={onConfirm} open title="Delete profile?" />)

      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' })

      await act(async () => {
        await Promise.resolve()
      })

      expect(onConfirm).toHaveBeenCalledTimes(1)
      expect(screen.getByText('Deleted')).toBeTruthy()
      expect(onClose).not.toHaveBeenCalled()

      act(() => {
        vi.advanceTimersByTime(600)
      })

      expect(onClose).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the dialog open and says why when the work throws', async () => {
    const onClose = vi.fn()

    render(
      <IcConfirmDialog
        {...CONFIRM_COPY}
        onClose={onClose}
        onConfirm={() => {
          throw new Error('Gateway is gone')
        }}
        open
        title="Delete profile?"
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Gateway is gone'))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy()
  })

  it('opens focused on the action so Enter is unambiguous', () => {
    render(<IcConfirmDialog {...CONFIRM_COPY} onClose={vi.fn()} onConfirm={vi.fn()} open title="Delete profile?" />)

    expect(globalThis.document.activeElement).toBe(screen.getByRole('button', { name: 'Delete' }))
  })

  it('Cancel is the way out and does not run the work', () => {
    const onConfirm = vi.fn()
    const onClose = vi.fn()

    render(<IcConfirmDialog {...CONFIRM_COPY} onClose={onClose} onConfirm={onConfirm} open title="Delete profile?" />)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
