// Real session-states and real open-session: no pane renders tiles, so the doors act on the main chat
// and a stored tile never reads as on screen. Only the pop-out bridge is stubbed.
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as WindowsStore from '@/store/windows'

import { sessionRoute } from './routes'

const openSessionInNewWindow = vi.fn()

vi.mock('@/store/windows', async importOriginal => ({
  ...(await importOriginal<typeof WindowsStore>()),
  canOpenSessionWindow: () => true,
  openSessionInNewWindow: (...args: unknown[]) => openSessionInNewWindow(...args)
}))

const TILES_KEY = 'hermes.desktop.sessionTiles.v2'

// The shape 6d58019f78 wrote after a cmd-click (work/g6/run1/log-tg.txt).
const STORED_TILE = { anchor: 'workspace', dir: 'center', storedSessionId: 'bee', workspaceMode: 'sessions' }

async function load() {
  vi.resetModules()
  const { openSession } = await import('./open-session')
  const { $sessionTiles } = await import('@/store/session-states')

  return { $sessionTiles, openSession }
}

describe('a tile nothing renders', () => {
  beforeEach(() => {
    localStorage.clear()
    openSessionInNewWindow.mockClear()
  })

  it('cmd-click opens the chat in place and adds no tile; a plain click then opens it', async () => {
    const { $sessionTiles, openSession } = await load()
    const navigate = vi.fn()

    openSession('bee', navigate, 'tab')
    expect(navigate).toHaveBeenLastCalledWith(sessionRoute('bee'))
    expect($sessionTiles.get()).toEqual([])

    navigate.mockClear()
    openSession('bee', navigate)
    expect(navigate).toHaveBeenLastCalledWith(sessionRoute('bee'))
  })

  it('a tile restored from localStorage does not block a plain click on its row', async () => {
    localStorage.setItem(TILES_KEY, JSON.stringify({ default: [STORED_TILE] }))
    const { $sessionTiles, openSession } = await load()
    const navigate = vi.fn()

    expect($sessionTiles.get().map(t => t.storedSessionId)).toEqual(['bee'])
    openSession('bee', navigate)
    expect(navigate).toHaveBeenLastCalledWith(sessionRoute('bee'))
  })

  it('a stored tile does not make cmd-click a dead jump either', async () => {
    localStorage.setItem(TILES_KEY, JSON.stringify({ default: [STORED_TILE] }))
    const { openSession } = await load()
    const navigate = vi.fn()

    openSession('bee', navigate, 'tab')
    expect(navigate).toHaveBeenLastCalledWith(sessionRoute('bee'))
  })

  it('shift-cmd-click keeps its second window', async () => {
    const { $sessionTiles, openSession } = await load()
    const navigate = vi.fn()

    openSession('bee', navigate, 'window')
    expect(openSessionInNewWindow).toHaveBeenCalledWith('bee')
    expect(navigate).not.toHaveBeenCalled()
    expect($sessionTiles.get()).toEqual([])
  })
})
