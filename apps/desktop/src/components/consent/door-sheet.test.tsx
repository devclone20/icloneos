import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { PrivacySettings } from '@/app/settings/privacy-settings'
import { enConsent } from '@/i18n/en'
import { enPermissions } from '@/i18n/en/enPermissions'

import { ConsentDoorSheet } from './door-sheet'
import { accepted, fakeConsentBridge } from './fixtures'
import { resetConsentStore } from './store'
import type { ConsentDoorRequest } from './types'

afterEach(() => resetConsentStore())

const request = (over: Partial<ConsentDoorRequest> = {}): ConsentDoorRequest => ({
  id: 'door-1',
  key: 'terminal',
  reason: 'Run the test suite for the repo you opened',
  inft: 'inft-6',
  at: '2026-10-17T10:00:00.000Z',
  expiresAt: '2026-10-17T10:02:00.000Z',
  ...over
})

describe('ConsentDoorSheet', () => {
  it('shows which iNFT asks, the permission and the reason verbatim; Allow once answers main', async () => {
    const fake = fakeConsentBridge(accepted({}))

    render(<ConsentDoorSheet />)
    expect(window.document.querySelector('[data-consent-door]')).toBeNull()
    act(() => fake.showDoor(request()))
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    expect(screen.getByText(enConsent.door.title('Terminal commands'))).toBeTruthy()
    expect(screen.getByText(enConsent.door.eyebrow('inft-6'))).toBeTruthy()
    expect(window.document.querySelector('[data-consent-door-reason]')?.textContent).toBe(
      'Run the test suite for the repo you opened'
    )
    // Deny has the focus: Return never grants by accident.
    expect(window.document.activeElement?.getAttribute('data-consent-door-answer')).toBe('deny')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: enConsent.door.once }))
    })
    expect(fake.bridge.doorAnswer).toHaveBeenCalledWith({ id: 'door-1', choice: 'once' })
    expect(window.document.querySelector('[data-consent-door]')).toBeNull()
  })

  it('one sheet at a time: the next request replaces the answered one', async () => {
    const fake = fakeConsentBridge(accepted({}))

    render(<ConsentDoorSheet />)
    act(() => fake.showDoor(request()))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: enConsent.door.deny }))
    })
    act(() => fake.showDoor(request({ id: 'door-2', key: 'spendTrade', reason: 'Pay for the dataset' })))
    expect(window.document.querySelectorAll('[data-consent-door]')).toHaveLength(1)
    expect(screen.getByText(enConsent.door.title('Spend & trade'))).toBeTruthy()
    expect(fake.bridge.doorAnswer).toHaveBeenCalledWith({ id: 'door-1', choice: 'deny' })
  })

  it('a request already waiting when the app opens is shown', async () => {
    const fake = fakeConsentBridge(accepted({}))

    fake.showDoor(request({ key: 'clipboard' }))
    render(<ConsentDoorSheet />)
    await waitFor(() => expect(window.document.querySelector('[data-consent-door="clipboard"]')).toBeTruthy())
  })

  it('Settings › Privacy lists recent requests with key, reason, answer and time', async () => {
    const fake = fakeConsentBridge(accepted({ permissions: {}, permissionsDecidedAt: '2026-10-17T10:00:00.000Z' }))

    render(
      <>
        <ConsentDoorSheet />
        <PrivacySettings />
      </>
    )
    await waitFor(() => expect(screen.getByText(enConsent.settings.requestsEmpty)).toBeTruthy())
    act(() => fake.showDoor(request()))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: enConsent.door.always }))
    })
    await waitFor(() => expect(window.document.querySelector('[data-privacy-request="terminal"]')).toBeTruthy())
    const row = window.document.querySelector('[data-privacy-request="terminal"]')!

    expect(row.textContent).toContain('Run the test suite for the repo you opened')
    expect(row.textContent).toContain(enConsent.settings.requestAnswer.always)
    expect(row.textContent).toContain('inft-6')
  })

  it('V3-F: a permission ask shows who, the class, the literal target, why and what happens; Deny is focused', async () => {
    const fake = fakeConsentBridge(accepted({}))

    render(<ConsentDoorSheet />)
    act(() =>
      fake.showDoor(
        request({
          id: 'perm-1',
          key: 'fileWriting',
          reason: 'Save the report next to your notes',
          permission: {
            cls: 'Wo',
            tool: 'write_file',
            target: '/Users/me/Documents/report.md',
            mode: 'manual',
            project: '/Users/me/proj',
            session: 'sess-1234567890abcdef',
            subagent: null,
            scopes: ['once', 'session', 'project', 'standing']
          }
        })
      )
    )
    expect(screen.getByText(enPermissions.ask.title(enPermissions.classes.Wo))).toBeTruthy()
    expect(window.document.querySelector('[data-permission-target]')?.textContent).toBe('/Users/me/Documents/report.md')
    expect(screen.getByText(enPermissions.ask.effects.Wo)).toBeTruthy()
    expect(screen.getByText('Save the report next to your notes')).toBeTruthy()
    expect(window.document.activeElement?.getAttribute('data-consent-door-answer')).toBe('deny')
    // nothing outside the sheet's own buttons answers: the always/once consent buttons are not there
    expect(screen.queryByRole('button', { name: enConsent.door.always })).toBeNull()

    fireEvent.click(screen.getByRole('radio', { name: enPermissions.ask.scopes.session }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: enPermissions.ask.allow }))
    })
    expect(fake.bridge.doorAnswer).toHaveBeenCalledWith({ id: 'perm-1', choice: 'session' })
  })

  it('V3-F: spending offers no scope but once', () => {
    const fake = fakeConsentBridge(accepted({}))

    render(<ConsentDoorSheet />)
    act(() =>
      fake.showDoor(
        request({
          id: 'perm-2',
          key: 'spendTrade',
          permission: {
            cls: '$',
            tool: 'terminal',
            target: 'acp wallet send-transaction 0.01 USDC',
            mode: 'ignore',
            project: null,
            session: null,
            subagent: null,
            scopes: ['once']
          }
        })
      )
    )
    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(window.document.querySelector('[data-consent-door-answer="once"]')).toBeTruthy()
  })
})
