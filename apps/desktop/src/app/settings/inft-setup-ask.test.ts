import { afterEach, describe, expect, it, vi } from 'vitest'

import { NEW_CHAT_ROUTE } from '@/app/routes'

import { onComposerFocusRequest, onComposerInsertRequest, onComposerSubmitRequest } from '../chat/composer/focus'
import { $msgView, setMsgView } from '../home/it-store'

import { dropAskHermes } from './inft-setup-ask'

// The composer bus defers insert/focus by one task.
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('dropAskHermes', () => {
  const offs: (() => void)[] = []

  afterEach(async () => {
    await flush()
    offs.splice(0).forEach(off => off())
    setMsgView('chat')
  })

  it('opens Message on the chat view even when the window was left on iT', () => {
    setMsgView('it')
    const seen: string[] = []

    const navigate = vi.fn(() => {
      seen.push($msgView.get())
    })

    dropAskHermes('I am configuring my iNFT "#7"', navigate)

    expect(navigate).toHaveBeenCalledWith(NEW_CHAT_ROUTE)
    // The window mounts on navigate: the chat view must already be chosen.
    expect(seen).toEqual(['chat'])
    expect($msgView.get()).toBe('chat')
  })

  it('fills and focuses the main composer without sending', async () => {
    const inserts: unknown[] = []
    const focuses: unknown[] = []
    const submits: unknown[] = []
    offs.push(onComposerInsertRequest(detail => inserts.push(detail)))
    offs.push(onComposerFocusRequest(detail => focuses.push(detail.target)))
    offs.push(onComposerSubmitRequest(detail => submits.push(detail)))

    dropAskHermes('briefing for the cli step', () => undefined)
    await flush()

    expect(inserts).toEqual([{ mode: 'block', target: 'main', text: 'briefing for the cli step' }])
    expect(focuses).toEqual(['main'])
    expect(submits).toEqual([])
  })
})
