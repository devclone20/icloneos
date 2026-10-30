// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { translateNow } from '@/i18n'
import { emptyAgentRuntimeStatus } from '@/iclone-shared/agent-runtime-status'
import { initialPackages, reducePackageLine, settlePackages } from '@/iclone-shared/install-packages'

import { AgentRuntimeSection } from './agent-runtime-settings'

function install(status: ReturnType<typeof emptyAgentRuntimeStatus>) {
  const api = {
    installAgain: vi.fn().mockResolvedValue({ ok: true }),
    onChange: vi.fn(() => () => undefined),
    openFix: vi.fn(),
    skip: vi.fn(),
    status: vi.fn().mockResolvedValue({ ...status, skippedThisRun: false })
  }

  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { agentRuntime: api } })
  const reload = vi.fn()
  Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, reload } })

  return { api, reload }
}

afterEach(cleanup)

describe('Settings > Machine > Agent runtime (RTB-6)', () => {
  it('an incomplete runtime names what is missing and offers Install again, which resumes the install', async () => {
    let packages = initialPackages(['node', 'cua-driver'])
    packages = reducePackageLine(packages, '✓ node', 1)
    packages = reducePackageLine(packages, '  cua-driver:  18.9%  12.0 MiB / 63.6 MiB', 2)
    packages = reducePackageLine(packages, '⚠ optional cua-driver was not installed', 3)
    packages = settlePackages(packages, 'succeeded', 4)

    const { api, reload } = install({
      ...emptyAgentRuntimeStatus(),
      packages: packages.packages,
      skipCount: 1,
      state: 'incomplete'
    })

    render(<AgentRuntimeSection />)
    const title = `${translateNow('settings.agentRuntime.title')} — ${translateNow('settings.agentRuntime.incompleteWhat', 'cua-driver')}`
    await screen.findByText(title)
    expect(screen.getByText(translateNow('settings.agentRuntime.skipped'))).toBeTruthy()
    expect(screen.getByText(`cua-driver — ${translateNow('install.recovery.packageStates.failed')}`)).toBeTruthy()
    fireEvent.click(screen.getByText(translateNow('settings.agentRuntime.installAgain')))
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    expect(api.installAgain).toHaveBeenCalledTimes(1)
  })

  it('an installed runtime has no Install again button', async () => {
    install({ ...emptyAgentRuntimeStatus(), state: 'installed' })
    render(<AgentRuntimeSection />)
    await screen.findByText(
      `${translateNow('settings.agentRuntime.title')} — ${translateNow('settings.agentRuntime.installed')}`
    )
    expect(screen.queryByText(translateNow('settings.agentRuntime.installAgain'))).toBeNull()
  })
})
