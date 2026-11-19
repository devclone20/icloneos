/**
 * v0.0.9 F4 — gate N6 (X6): the decision dialog never confirms from Space, and never from Enter outside the focused
 * confirm button (another button, or the dialog body — Q renderer 5).
 * On the old handlers both ConfirmDialog and IcConfirmDialog confirmed on Enter OR Space from anywhere inside —
 * focus on Cancel + Space ran a destructive confirm.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { IcConfirmDialog } from '@/components/ic/ic-page'

import { ConfirmDialog } from './confirm-dialog'

afterEach(cleanup)

const flush = () =>
  act(async () => {
    await Promise.resolve()
  })

describe('ConfirmDialog keys', () => {
  function renderConfirm() {
    const onConfirm = vi.fn()
    const onClose = vi.fn()

    render(
      <ConfirmDialog
        cancelLabel="Cancel"
        confirmLabel="Delete"
        destructive
        onClose={onClose}
        onConfirm={onConfirm}
        open
        title="Delete worktree?"
      />
    )

    return { onClose, onConfirm }
  }

  it('Space with focus on Cancel does not confirm', async () => {
    const { onConfirm } = renderConfirm()
    const cancel = await screen.findByRole('button', { name: 'Cancel' })

    cancel.focus()
    fireEvent.keyDown(cancel, { key: ' ' })
    await flush()

    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('Enter with focus on Cancel does not confirm', async () => {
    const { onConfirm } = renderConfirm()
    const cancel = await screen.findByRole('button', { name: 'Cancel' })

    cancel.focus()
    fireEvent.keyDown(cancel, { key: 'Enter' })
    await flush()

    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('Space on the dialog body does not confirm', async () => {
    const { onConfirm } = renderConfirm()

    fireEvent.keyDown(await screen.findByRole('dialog'), { key: ' ' })
    await flush()

    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('Enter on the dialog body (focus left on text) does not confirm (Q renderer 5)', async () => {
    const { onConfirm } = renderConfirm()
    const dialog = await screen.findByRole('dialog')
    const title = screen.getByText('Delete worktree?')

    fireEvent.keyDown(dialog, { key: 'Enter' })
    fireEvent.keyDown(title, { key: 'Enter' })
    await flush()

    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('Enter on the focused confirm still confirms', async () => {
    const { onConfirm } = renderConfirm()
    const dialog = await screen.findByRole('dialog')

    // eslint-disable-next-line no-restricted-globals -- asserting real focus requires the live document
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))
    // eslint-disable-next-line no-restricted-globals -- asserting real focus requires the live document
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' })

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1))
  })
})

describe('IcConfirmDialog keys', () => {
  const COPY = {
    busyLabel: 'Signing out…',
    cancelLabel: 'Cancel',
    confirmLabel: 'Sign out',
    doneLabel: 'Signed out',
    errorFallback: 'It failed'
  }

  it('Space anywhere — Cancel or the dialog — never confirms', async () => {
    const onConfirm = vi.fn()

    render(<IcConfirmDialog {...COPY} onClose={vi.fn()} onConfirm={onConfirm} open title="Sign out?" tone="danger" />)

    const cancel = screen.getByRole('button', { name: 'Cancel' })

    fireEvent.keyDown(cancel, { key: ' ' })
    fireEvent.keyDown(screen.getByRole('dialog'), { key: ' ' })
    await flush()

    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('Enter on Cancel does not confirm', async () => {
    const onConfirm = vi.fn()

    render(<IcConfirmDialog {...COPY} onClose={vi.fn()} onConfirm={onConfirm} open title="Sign out?" tone="danger" />)

    fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: 'Enter' })
    await flush()

    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('Enter on the dialog body does not confirm (Q renderer 5: never Enter outside the focused button)', async () => {
    const onConfirm = vi.fn(async () => {})

    render(<IcConfirmDialog {...COPY} onClose={vi.fn()} onConfirm={onConfirm} open title="Sign out?" tone="danger" />)

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' })
    fireEvent.keyDown(screen.getByText('Sign out?'), { key: 'Enter' })
    await flush()

    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('opens focused on the action, so the key Enter natively presses is the one that says what it does', () => {
    render(<IcConfirmDialog {...COPY} onClose={vi.fn()} onConfirm={vi.fn()} open title="Sign out?" tone="danger" />)

    expect(globalThis.document.activeElement).toBe(screen.getByRole('button', { name: 'Sign out' }))
  })
})
