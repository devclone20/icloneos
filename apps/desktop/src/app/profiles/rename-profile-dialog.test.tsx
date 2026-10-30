import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { renameProfile } from '@/hermes'
import { retireLocalProfileGateways } from '@/store/gateway'

import { RenameProfileDialog } from './rename-profile-dialog'

// Pins the rename half of the deleted-profile-resurrection class (#88638 fixed
// the delete half): a retained renderer socket for the OLD profile name must be
// retired BEFORE the rename PATCH tears down its backend, or the socket's
// reconnect loop respawns the old-name backend and recreates the directory the
// rename just moved.

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

vi.mock('@/hermes', () => ({
  renameProfile: vi.fn(async () => ({ name: 'renamed', ok: true, path: '/x' }))
}))

vi.mock('@/store/gateway', () => ({
  retireLocalProfileGateways: vi.fn()
}))

it('retires the old-name local gateways before issuing the rename', async () => {
  const order: string[] = []

  vi.mocked(retireLocalProfileGateways).mockImplementationOnce(() => {
    order.push('retire')
  })
  vi.mocked(renameProfile).mockImplementationOnce(async () => {
    order.push('rename')

    return { name: 'renamed', ok: true, path: '/x' }
  })

  render(<RenameProfileDialog currentName="selena" onClose={vi.fn()} open />)

  fireEvent.change(screen.getByLabelText(/new name/i), { target: { value: 'renamed' } })
  fireEvent.click(screen.getByRole('button', { name: /^rename$/i }))

  await waitFor(() => expect(renameProfile).toHaveBeenCalledWith('selena', 'renamed'))
  expect(retireLocalProfileGateways).toHaveBeenCalledWith('selena')
  expect(order).toEqual(['retire', 'rename'])
})

it('does not retire gateways when validation rejects the submit', async () => {
  render(<RenameProfileDialog currentName="selena" onClose={vi.fn()} open />)

  fireEvent.change(screen.getByLabelText(/new name/i), { target: { value: '' } })
  fireEvent.click(screen.getByRole('button', { name: /^rename$/i }))

  await waitFor(() => expect(screen.getByText('Name is required.')).toBeTruthy())
  expect(retireLocalProfileGateways).not.toHaveBeenCalled()
  expect(renameProfile).not.toHaveBeenCalled()
})

it('an unchanged name closes without touching the backend', async () => {
  const onClose = vi.fn()

  render(<RenameProfileDialog currentName="selena" onClose={onClose} open />)

  // The submit button is disabled while the name is unchanged, so this is the
  // guard behind it: a submit that still arrives must close, never rename.
  const field = screen.getByLabelText(/new name/i)

  expect(screen.getByRole('button', { name: /^rename$/i }).hasAttribute('disabled')).toBe(true)
  fireEvent.submit(field.closest('form') as HTMLFormElement)

  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  expect(renameProfile).not.toHaveBeenCalled()
  expect(retireLocalProfileGateways).not.toHaveBeenCalled()
})

it('the default profile is named, not renamed: the field starts blank and no backend is retired', async () => {
  render(<RenameProfileDialog currentName="default" isDefault onClose={vi.fn()} open />)

  const field = screen.getByLabelText(/display name/i) as HTMLInputElement

  expect(field.value).toBe('')
  expect(screen.getByRole('heading', { name: /name this agent/i })).toBeTruthy()

  // Display names are free text: the slug sanitizer must not touch them.
  fireEvent.change(field, { target: { value: 'Séléna Pat' } })
  expect(field.value).toBe('Séléna Pat')

  fireEvent.click(screen.getByRole('button', { name: /^rename$/i }))

  await waitFor(() => expect(renameProfile).toHaveBeenCalledWith('default', 'Séléna Pat'))
  expect(retireLocalProfileGateways).not.toHaveBeenCalled()
})
