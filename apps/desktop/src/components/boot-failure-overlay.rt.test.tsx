/**
 * V3-RT critic r2 m5: the gate-refused card holds a long, unbroken error (a dependency path, a list of files) inside
 * its own callout. The column under it never grows past the card, so the Repair install button stays where it is drawn
 * and takes the pointer. (jsdom has no layout: the classes that bound it are pinned here; the live run clicks it with a
 * trusted pointer event.)
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { translateNow } from '@/i18n'
import { ICLONE_GATE_MARK } from '@/iclone-shared/iclone-gate'
import { $desktopBoot } from '@/store/boot'
import { $desktopOnboarding } from '@/store/onboarding'

import { BootFailureOverlay } from './boot-failure-overlay'

const LONG =
  `${ICLONE_GATE_MARK} 1 file(s) of the Python environment changed or are missing ` +
  `(.iclone-deps/hermes/installs/412fe54e2f42c35c/environments/b65e04a7e6cb4ce4a58f1f73fb4ad269/venv/lib/python3.14/` +
  `site-packages/ruamel/yaml/__init__.py). Use Repair install to reinstall the runtime this release ships.`

beforeEach(() => {
  $desktopOnboarding.set({ configured: true, flow: { status: 'idle' }, mode: 'oauth', providers: null } as never)
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: { getConnectionConfig: async () => ({ mode: 'local' }), getRecentLogs: async () => ({ lines: [] }) }
  })
  $desktopBoot.set({
    error: LONG,
    fakeMode: false,
    message: 'boot failed',
    phase: 'renderer.error',
    progress: 40,
    running: false,
    timestamp: Date.now(),
    visible: true
  })
})

afterEach(() => cleanup())

describe('the gate-refused card keeps a long error inside its callout (critic r2 m5)', () => {
  it('wraps anywhere, scrolls past its cap, and sits in a column bounded by the card; Repair is not inside it', async () => {
    render(<BootFailureOverlay />)

    const repair = await screen.findByRole('button', { name: translateNow('boot.failure.repairInstall') })
    const callout = screen.getByTestId('boot-failure-error')

    expect(callout.textContent).toContain('ruamel/yaml/__init__.py')
    expect(callout.className.split(' ')).toEqual(
      expect.arrayContaining(['min-w-0', '[overflow-wrap:anywhere]', 'overflow-y-auto', 'max-h-40'])
    )
    expect((callout.parentElement as HTMLElement).className.split(' ')).toContain('grid-cols-[minmax(0,1fr)]')
    expect(callout.contains(repair)).toBe(false)
  })
})
