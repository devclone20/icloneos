import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ComputerUsePanel } from '@/app/settings/computer-use-panel'

import { computerUseState, missingPanes } from './computer-use-flow'
import { CUA_DRIVER_WORDS as W } from './copy'
import { SetupSystemRows } from './rows'

const api = vi.hoisted(() => ({
  status: vi.fn(),
  grant: vi.fn(),
  install: vi.fn(),
  action: vi.fn(),
  act: vi.fn(async () => [])
}))

vi.mock('@/api/toolsets', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getComputerUseStatus: api.status,
  grantComputerUsePermissions: api.grant,
  runToolsetPostSetup: api.install
}))
vi.mock('@/api/system', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getActionStatus: api.action
}))
vi.mock('@/iclone-shared/async', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sleep: () => Promise.resolve()
}))

const mac = (over: Record<string, unknown> = {}) => ({
  platform: 'darwin',
  platform_supported: true,
  installed: true,
  version: 'cua-driver 0.28.2',
  ready: false,
  can_grant: true,
  checks: [],
  source: null,
  error: null,
  accessibility: false,
  screen_recording: false,
  screen_recording_capturable: null,
  ...over
})

const GRANTED = { ready: true, accessibility: true, screen_recording: true }
const FRESH = { installed: false, ready: null, accessibility: null, screen_recording: null }
const REVOKED = { ready: false, accessibility: true, screen_recording: false }
const UNKNOWN = { ready: null, accessibility: null, screen_recording: null }

beforeEach(() => {
  vi.clearAllMocks()
  api.action.mockResolvedValue({ running: false, name: 'computer-use-grant', lines: [] })
  api.grant.mockResolvedValue({ ok: true, name: 'computer-use-grant', pid: 1 })
  Object.assign(window, {
    hermesDesktop: {
      icloneSetup: { system: vi.fn(async () => [{ id: 'microphone', status: 'granted', action: 'none' }]), act: api.act }
    }
  })
})

afterEach(cleanup)

describe('computer use: each state, from what CuaDriver reported', () => {
  it.each([
    ['granted', GRANTED, 'granted', []],
    ['denied', {}, 'needs', ['cua:accessibility', 'cua:screen']],
    ['revoked', REVOKED, 'needs', ['cua:screen']],
    ['fresh install', FRESH, 'notInstalled', ['cua:accessibility', 'cua:screen']],
    ['no answer', UNKNOWN, 'unknown', ['cua:accessibility', 'cua:screen']]
  ])('%s', (_name, over, state, panes) => {
    const status = mac(over) as never

    expect(computerUseState(status)).toBe(state)
    expect(missingPanes(status)).toEqual(panes)
  })

  it('another driver selected or no macOS: no row', () => {
    expect(computerUseState(mac({ can_grant: false }) as never)).toBeNull()
  })
})

describe.each([
  ['Set up row', () => render(<SetupSystemRows />)],
  ['Settings card', () => render(<ComputerUsePanel />)]
])('Allow… reacts every time: %s', (_name, mount) => {
  const allow = async () => screen.findByRole('button', { name: 'Allow…' })

  it('shows the wait at once, before the backend has answered', async () => {
    api.status.mockResolvedValue(mac())
    let answer: (value: unknown) => void = () => undefined
    api.grant.mockReturnValue(new Promise(resolve => (answer = resolve)))
    mount()
    fireEvent.click(await allow())
    expect((await screen.findByRole('button', { name: W.waiting })).hasAttribute('disabled')).toBe(true)
    expect(api.grant).toHaveBeenCalledTimes(1)
    await act(async () => answer({ ok: false, name: 'computer-use-grant' }))
  })

  it('macOS does not ask again: the press ends at the exact pane, says so, and a second press works too', async () => {
    api.status.mockResolvedValue(mac())
    mount()
    fireEvent.click(await allow())
    expect(await screen.findByText(W.notAsked)).toBeTruthy()
    expect(api.act).toHaveBeenCalledWith({ item: 'cua:accessibility' })
    fireEvent.click(await allow())
    await waitFor(() => expect(api.grant).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(api.act).toHaveBeenCalledTimes(2))
  })

  it('revoked: the pane that opens is the one that is off', async () => {
    api.status.mockResolvedValue(mac(REVOKED))
    mount()
    fireEvent.click(await allow())
    await screen.findByText(W.notAsked)
    expect(api.act).toHaveBeenCalledWith({ item: 'cua:screen' })
    expect(api.act).not.toHaveBeenCalledWith({ item: 'cua:accessibility' })
  })

  it('granted while waiting: the wait ends, no pane opens, the button goes', async () => {
    api.status.mockResolvedValueOnce(mac()).mockResolvedValue(mac(GRANTED))
    mount()
    fireEvent.click(await allow())
    await waitFor(() => expect(screen.queryByRole('button', { name: /Allow…|Waiting/ })).toBeNull())
    expect(api.act).not.toHaveBeenCalled()
  })

  it('a refusal is shown with its reason, never swallowed', async () => {
    api.status.mockResolvedValue(mac())
    api.grant.mockRejectedValue(new Error('backend said 500'))
    mount()
    fireEvent.click(await allow())
    expect(await screen.findByText(W.failed('backend said 500'))).toBeTruthy()
    expect(await allow()).toBeTruthy()
  })

  it('a pane button opens that pane by name, and only that', async () => {
    api.status.mockResolvedValue(mac(REVOKED))
    mount()
    fireEvent.click(await screen.findByRole('button', { name: W.openScreen }))
    expect(api.act).toHaveBeenCalledWith({ item: 'cua:screen' })
    expect(screen.queryByRole('button', { name: W.openAccessibility })).toBeNull()
  })

  it('no answer from CuaDriver: says it could not be read, offers Allow, never claims "not allowed"', async () => {
    api.status.mockResolvedValue(mac(UNKNOWN))
    mount()
    expect(await screen.findByText(W.unreadable)).toBeTruthy()
    expect(await allow()).toBeTruthy()
  })

  it('fresh install: explains itself and installs through the provider route', async () => {
    api.status.mockResolvedValueOnce(mac(FRESH)).mockResolvedValue(mac())
    api.install.mockResolvedValue({ ok: true, name: 'tools-post-setup-cua_driver', key: 'cua_driver' })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: W.disclose }))
    expect(await screen.findByText(W.what)).toBeTruthy()
    expect(screen.getByText(W.identity)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: W.installAction }))
    await waitFor(() => expect(api.install).toHaveBeenCalledWith('computer_use', 'cua_driver'))
    expect(await allow()).toBeTruthy()
    expect(api.grant).not.toHaveBeenCalled()
  })
})

describe('the words stay short and plain', () => {
  it('no sentence of the explanation runs past 30 words', () => {
    for (const line of [W.what, W.accessibility, W.screen, W.identity, W.install, W.grant]) {
      for (const sentence of line.split('. ')) {
        expect(sentence.split(/\s+/).length).toBeLessThanOrEqual(30)
      }
    }
  })
})
