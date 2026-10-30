import { afterEach, describe, expect, it } from 'vitest'

import type { AppView } from '@/app/routes'

import { legacyShellMode, sealAllBut, WINDOW_DRAG_BAND_PX } from './legacy-shell'
import { TITLEBAR_HEIGHT } from './titlebar'

describe('legacyShellMode', () => {
  const MAIN_WINDOW: Record<AppView, ReturnType<typeof legacyShellMode>> = {
    agents: 'covered',
    artifacts: 'covered',
    chat: 'chat',
    'command-center': 'covered',
    cron: 'covered',
    extension: 'live',
    home: 'covered',
    messaging: 'covered',
    profiles: 'covered',
    settings: 'covered',
    skills: 'covered',
    starmap: 'covered',
    webhooks: 'covered'
  }

  it.each(Object.entries(MAIN_WINDOW))('main window, %s → %s', (view, mode) => {
    expect(legacyShellMode(view as AppView, false)).toBe(mode)
  })

  it('keeps every auxiliary window (HUD, popped-out browser, secondary) live', () => {
    for (const view of Object.keys(MAIN_WINDOW) as AppView[]) {
      expect(legacyShellMode(view, true)).toBe('live')
    }
  })
})

describe('WINDOW_DRAG_BAND_PX', () => {
  it('is the old titlebar height, so the panes below keep their geometry', () => {
    expect(WINDOW_DRAG_BAND_PX).toBe(TITLEBAR_HEIGHT)
  })
})

describe('sealAllBut', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  // shell > [spacer, split > [zone > [tabstrip, body > chat], side]]
  function mountShell() {
    document.body.innerHTML = `
      <div id="shell">
        <div id="spacer" aria-hidden="true"></div>
        <style></style>
        <div id="split">
          <div id="zone">
            <div id="tabstrip"><button>Close</button></div>
            <div id="body"><div id="chat" data-chat-surface><textarea></textarea></div></div>
          </div>
          <div id="side"><button>Files</button></div>
          <div id="already" inert></div>
        </div>
      </div>`
    const byId = (id: string) => document.getElementById(id)!

    return { byId, shell: byId('shell') }
  }

  const sealed = (el: Element) => el.hasAttribute('inert') && el.getAttribute('aria-hidden') === 'true'

  it('seals every sibling off the path to the kept surface and nothing on it', () => {
    const { byId, shell } = mountShell()

    sealAllBut(shell, byId('chat'))

    expect(sealed(byId('tabstrip'))).toBe(true)
    expect(sealed(byId('side'))).toBe(true)
    expect(sealed(byId('spacer'))).toBe(true)

    for (const id of ['chat', 'body', 'zone', 'split']) {
      expect(byId(id).hasAttribute('inert')).toBe(false)
      expect(byId(id).hasAttribute('aria-hidden')).toBe(false)
    }

    expect(shell.querySelector('style')!.hasAttribute('inert')).toBe(false)
  })

  it('undo restores exactly what it changed', () => {
    const { byId, shell } = mountShell()

    const undo = sealAllBut(shell, byId('chat'))

    undo()

    expect(byId('tabstrip').hasAttribute('inert')).toBe(false)
    expect(byId('tabstrip').hasAttribute('aria-hidden')).toBe(false)
    expect(byId('side').hasAttribute('inert')).toBe(false)
    // Pre-existing state survives the round trip.
    expect(byId('spacer').getAttribute('aria-hidden')).toBe('true')
    expect(byId('already').hasAttribute('inert')).toBe(true)
  })

  it('seals every child of the root when there is no surface to keep', () => {
    const { byId, shell } = mountShell()

    sealAllBut(shell, null)

    expect(sealed(byId('split'))).toBe(true)
    expect(sealed(byId('spacer'))).toBe(true)
  })

  it('treats a surface outside the root as absent', () => {
    const { byId, shell } = mountShell()
    const stray = document.createElement('div')

    document.body.append(stray)
    sealAllBut(shell, stray)

    expect(sealed(byId('split'))).toBe(true)
    expect(stray.hasAttribute('inert')).toBe(false)
  })
})
