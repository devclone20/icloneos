import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SESSION_DRAFTS_STORAGE_KEY, stashSessionDraft, takeSessionDraft } from '@/store/composer'

import { dropAskHermes } from './inft-setup-ask'
import { armAskFill, ASK_FILL_STORAGE_KEY, noteAskStage, withdrawAskFill } from './inft-setup-ask-scope'

const FILL = 'I am configuring my iNFT "#7" in iclone os with the Virtuals ACP CLI.\n\nLast error: boom'
const TYPED = 'Reply with the single word OK'

// The composer bus (and the arming after it) defers by one task.
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('the one-shot ask-Hermes fill', () => {
  let moves: EventTarget

  const move = () => moves.dispatchEvent(new Event('currententrychange'))

  beforeEach(() => {
    moves = new EventTarget()
    vi.stubGlobal('navigation', moves)
    noteAskStage('7')
  })

  afterEach(() => {
    withdrawAskFill()
    stashSessionDraft(null, '', [])
    vi.unstubAllGlobals()
  })

  it('leaves the new-chat draft on the next navigation (New conversation), keeping what the owner typed', () => {
    stashSessionDraft(null, `${FILL}${TYPED}`, [])
    armAskFill(FILL)

    move()

    expect(takeSessionDraft(null).text).toBe(TYPED)
    expect(localStorage.getItem(ASK_FILL_STORAGE_KEY)).toBeNull()
  })

  it('is withdrawn when another iNFT takes the stage, not when the same one is re-presented', () => {
    stashSessionDraft(null, FILL, [])
    armAskFill(FILL)

    noteAskStage('7')
    expect(takeSessionDraft(null).text).toBe(FILL)

    noteAskStage('6')
    expect(takeSessionDraft(null).text).toBe('')
    expect(localStorage.getItem(SESSION_DRAFTS_STORAGE_KEY)).toBeNull()
  })

  it('leaves a fill the owner rewrote alone', () => {
    const edited = FILL.replace('boom', 'it timed out')
    stashSessionDraft(null, edited, [])
    armAskFill(FILL)

    move()

    expect(takeSessionDraft(null).text).toBe(edited)
  })

  it('does not count the navigation that opened the composer, only later ones', async () => {
    const navigate = vi.fn(() => move())

    dropAskHermes(FILL, navigate)
    stashSessionDraft(null, FILL, [])
    expect(localStorage.getItem(ASK_FILL_STORAGE_KEY)).toBeNull()

    await flush()
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(ASK_FILL_STORAGE_KEY)).toContain('#7')
    expect(takeSessionDraft(null).text).toBe(FILL)

    move()
    expect(takeSessionDraft(null).text).toBe('')
  })

  it('is retired by the next boot (reload or restart)', async () => {
    stashSessionDraft(null, `${FILL}\n${TYPED}`, [])
    armAskFill(FILL)

    vi.resetModules()
    const composer = await import('@/store/composer')
    await import('./inft-setup-ask-scope')

    expect(composer.takeSessionDraft(null).text).toBe(TYPED)
    expect(localStorage.getItem(ASK_FILL_STORAGE_KEY)).toBeNull()
  })
})
