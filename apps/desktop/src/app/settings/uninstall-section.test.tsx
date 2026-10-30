// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { settings } from '@/i18n/en/settings'

import { UninstallSection } from './uninstall-section'

vi.mock('@/i18n', () => ({ useI18n: () => ({ locale: 'en', t: { settings } }) }))

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'hermesDesktop')
})

function mount(agentInstalled: boolean) {
  const run = vi.fn(async () => ({ ok: true }))

  const summary = vi.fn(async () => ({
    agent_installed: agentInstalled,
    running_app_path: '/Applications/iclone os.app'
  }))

  Object.assign(window, { hermesDesktop: { uninstall: { run, summary } } })

  return { run, ...render(<UninstallSection />) }
}

describe('Settings › About › Uninstall', () => {
  it('offers each removal as a row with its sentence, and the agent removals only when an agent is installed', async () => {
    const { container } = mount(true)

    expect(await screen.findByText('Remove the app and keep the agent')).toBeTruthy()
    expect(screen.getByText('Remove the app and the agent, keep your data')).toBeTruthy()
    expect(screen.getByText('Remove the app, the agent and all your data')).toBeTruthy()
    expect([...container.querySelectorAll('button')].every(button => button.closest('[data-setting-row]'))).toBe(true)
  })

  it('without an agent offers only the app removal', async () => {
    mount(false)

    expect(await screen.findByText('Remove the app and keep the agent')).toBeTruthy()
    expect(screen.queryByText('Remove the app, the agent and all your data')).toBeNull()
  })

  it('confirms before removing and runs the chosen mode', async () => {
    const { run } = mount(true)

    fireEvent.click((await screen.findAllByRole('button', { name: 'Choose' }))[2])
    expect(screen.getByText(/It cannot be undone\./)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Yes, remove it' }))
    expect(run).toHaveBeenCalledWith('full')
  })
})
