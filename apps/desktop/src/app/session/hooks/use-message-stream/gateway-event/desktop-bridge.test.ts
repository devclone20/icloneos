import { describe, expect, it } from 'vitest'

import { DESKTOP_BRIDGE_HANDLERS, DESKTOP_BRIDGE_NOT_SHOWN, type DesktopBridgeMethod } from './desktop-bridge'

const WINDOW_OWNED = Object.keys(DESKTOP_BRIDGE_HANDLERS) as DesktopBridgeMethod[]

describe('window-owned desktop bridges', () => {
  it('covers every bridge the agent blocks on', () => {
    expect([...WINDOW_OWNED].sort()).toEqual(['preview.act', 'preview.read', 'terminal.read', 'tour', 'window.read'])
  })

  it.each(WINDOW_OWNED)('%s declines with 4404 in a window that does not show the session', async method => {
    await expect(DESKTOP_BRIDGE_HANDLERS[method]({}, { showsSession: false })).rejects.toMatchObject({
      code: DESKTOP_BRIDGE_NOT_SHOWN
    })
  })

  it('reads the window below for the shown session, empty without the native bridge', async () => {
    await expect(DESKTOP_BRIDGE_HANDLERS['window.read']({}, { showsSession: true })).resolves.toEqual({ value: '' })
  })
})
