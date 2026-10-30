import { describe, expect, it } from 'vitest'

import { translateNow } from '@/i18n'

import { $desktopBoot, applyDesktopBootProgress } from './boot'

describe('main boot steps the user must understand are localized by phase (RTB-2)', () => {
  it('backend.dependencies shows the localized "preparing the agent\'s dependencies" step', () => {
    applyDesktopBootProgress({
      error: null,
      fakeMode: false,
      message: "Preparing the agent's dependencies…",
      phase: 'backend.dependencies',
      progress: 88,
      running: true,
      timestamp: Date.now()
    })

    expect($desktopBoot.get().message).toBe(translateNow('boot.steps.preparingAgentDependencies'))
    expect($desktopBoot.get().phase).toBe('backend.dependencies')
  })

  it('RTB-6: main reporting the skipped install is not a failure: no error, the boot ends without the agent', () => {
    applyDesktopBootProgress({
      error: '[agent-install-skipped] The agent runtime install was skipped; Settings installs it.',
      fakeMode: false,
      message: 'Desktop boot failed: [agent-install-skipped] …',
      phase: 'backend.error',
      progress: 28,
      running: false,
      timestamp: Date.now()
    })

    expect($desktopBoot.get()).toMatchObject({ error: null, phase: 'renderer.skipped', visible: false })
  })
})
