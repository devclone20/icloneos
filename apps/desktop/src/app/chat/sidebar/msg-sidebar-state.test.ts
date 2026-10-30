import { afterEach, describe, expect, it, vi } from 'vitest'

import { requestComposerFocus } from '@/app/chat/composer/focus'
import { toggleItSurface } from '@/app/home/it-store'
import { shellViewHandlers } from '@/app/hooks/use-keybinds'
import { NEW_CHAT_ROUTE, SETTINGS_ROUTE } from '@/app/routes'

import { $msgSidebarOpen, setMsgSidebarOpen, toggleMsgSidebar } from './msg-sidebar-state'

vi.mock('@/app/home/it-store', async importOriginal => ({
  ...(await importOriginal<object>()),
  toggleItSurface: vi.fn()
}))
vi.mock('@/app/chat/composer/focus', async importOriginal => ({
  ...(await importOriginal<object>()),
  requestComposerFocus: vi.fn()
}))

afterEach(() => {
  vi.clearAllMocks()
  setMsgSidebarOpen(false)
})

describe('msg sidebar state (U2-p2-01)', () => {
  it('toggles and sets the D3 sidebar flag', () => {
    setMsgSidebarOpen(false)
    toggleMsgSidebar()
    expect($msgSidebarOpen.get()).toBe(true)
    toggleMsgSidebar()
    expect($msgSidebarOpen.get()).toBe(false)
    setMsgSidebarOpen(true)
    expect($msgSidebarOpen.get()).toBe(true)
  })

  it('⌘B on the chat toggles the sessions sidebar and never navigates to Settings', () => {
    const navigate = vi.fn()
    const handlers = shellViewHandlers(NEW_CHAT_ROUTE, navigate)

    handlers['view.toggleSidebar']()
    expect($msgSidebarOpen.get()).toBe(true)
    expect(requestComposerFocus).toHaveBeenCalledWith('active')

    handlers['view.toggleSidebar']()
    expect($msgSidebarOpen.get()).toBe(false)
    expect(navigate).not.toHaveBeenCalled()
  })

  it('⌘B off the chat opens the Message window with the sidebar expanded, not Settings › Sessions & Bots', () => {
    const navigate = vi.fn()

    shellViewHandlers(SETTINGS_ROUTE, navigate)['view.toggleSidebar']()
    expect($msgSidebarOpen.get()).toBe(true)
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenCalledWith(NEW_CHAT_ROUTE)
    expect(navigate).not.toHaveBeenCalledWith(expect.stringContaining(SETTINGS_ROUTE))
  })

  it('⌃` opens the same door as the palette toggle (iT surface), not the hidden legacy pane (U2-p2-05)', () => {
    shellViewHandlers(NEW_CHAT_ROUTE, vi.fn())['view.showTerminal']()
    expect(toggleItSurface).toHaveBeenCalledTimes(1)
  })
})
