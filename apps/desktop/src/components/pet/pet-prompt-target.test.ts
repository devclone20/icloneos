/**
 * The pet box's target (R3b n-C): which ids are "the session on screen". The sender queues or sends by them, so a swap
 * (the stored id read as the runtime id) would aim the busy and parked checks at the wrong session.
 *
 * Rendering wiring.tsx means booting the whole desktop app in jsdom, so the wiring half reads the module source, as
 * app/contrib/wiring.test.tsx does: whitespace is collapsed, so only a change of meaning fails here.
 */
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { petPromptTargetOf } from './pet-prompt-target'

// A variable path keeps Vite from rewriting `new URL(literal, import.meta.url)` into an asset URL.
function moduleSource(file: string) {
  return readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\s+/g, ' ')
}

describe('the pet box aims at the session on screen (R3b n-C, gate P7)', () => {
  it('runtime id from the active session, stored id from the selected stored session, busy from the busy flag', () => {
    const activeSessionIdRef = { current: 'runtime-on-screen' as null | string }
    const selectedStoredSessionIdRef = { current: 'stored-on-screen' as null | string }
    const busyRef = { current: false }
    const refs = { activeSessionIdRef, busyRef, selectedStoredSessionIdRef }

    expect(petPromptTargetOf(refs)).toEqual({
      busy: false,
      runtimeId: 'runtime-on-screen',
      storedId: 'stored-on-screen'
    })

    // Read at the moment of the send, not when the callback was made.
    activeSessionIdRef.current = null
    selectedStoredSessionIdRef.current = 'stored-next'
    busyRef.current = true
    expect(petPromptTargetOf(refs)).toEqual({ busy: true, runtimeId: null, storedId: 'stored-next' })
  })

  it("the app wiring hands the pet the composer's own refs, and that target is the pet's promptTarget", () => {
    const wiring = moduleSource('../../app/contrib/wiring.tsx')

    expect(wiring).toContain("import { petPromptTargetOf } from '@/components/pet/pet-prompt-target'")
    expect(wiring).toContain(
      'const petPromptTarget = useCallback( () => petPromptTargetOf({ activeSessionIdRef, busyRef, selectedStoredSessionIdRef }),'
    )
    expect(wiring.match(/promptTarget=\{petPromptTarget\}/g)).toHaveLength(1)
    expect(wiring.match(/promptTarget=/g)).toHaveLength(1)

    // The very refs the composer's send reads: usePromptActions takes the same three, by the same names.
    const composer = wiring.slice(wiring.indexOf('} = usePromptActions({'))
    const args = composer.slice(0, composer.indexOf('})'))

    for (const ref of ['activeSessionIdRef,', 'busyRef,', 'selectedStoredSessionIdRef,']) {
      expect(args).toContain(` ${ref}`)
    }
  })
})
