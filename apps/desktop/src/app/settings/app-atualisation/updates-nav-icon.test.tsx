import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { __resetAgentUpdate } from '@/store/agent-update'

import { UpdatesNavIcon } from './updates-nav-icon'

type Flag = { at: string; red: boolean; verdict: 'GREEN' | 'RED' }

function installCompat(initial: Flag | null) {
  let push: (flag: Flag) => void = () => undefined

  const off = vi.fn()

  ;(window as unknown as { hermesDesktop: Record<string, unknown> }).hermesDesktop = {
    icloneUpdates: {
      compat: {
        flag: vi.fn(async () => initial),
        onFlag: vi.fn((cb: (flag: Flag) => void) => {
          push = cb

          return off
        })
      }
    }
  }

  return { off, push: (flag: Flag) => push(flag) }
}

describe('Settings nav › Updates icon', () => {
  afterEach(() => {
    cleanup()
    __resetAgentUpdate()
    Reflect.deleteProperty(window, 'hermesDesktop')
  })

  it('shows the passive RED dot from main’s compat flag, and nothing otherwise', async () => {
    const compat = installCompat(null)
    const { container, unmount } = render(<UpdatesNavIcon className="size-4" />)
    await act(async () => undefined)

    expect(container.querySelector('[data-agent-compat-red]')).toBeNull()

    act(() => compat.push({ at: 'now', red: true, verdict: 'RED' }))
    expect(container.querySelector('[data-agent-compat-red]')).not.toBeNull()

    unmount()
    expect(compat.off).toHaveBeenCalled()
  })
})
