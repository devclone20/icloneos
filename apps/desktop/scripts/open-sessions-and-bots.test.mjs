// v0.0.9 pass 4 (fleet tracer, v009-fleet-trace.md): openSessionsAndBots returned as soon as ANY sidebar was visible.
// The chat route has one too, and a gateway re-home lands with requestFreshSession(), navigating back to the chat and
// closing Settings, so the helper returned on the chat route. Red before: it returned after the first write while the
// route then reverted. A fake page: the first open is overwritten by the re-home 50 ms later; the second holds.
import { describe, expect, it } from 'vitest'

import { openSessionsAndBots } from '../e2e/settings-door.ts'

function fakePage() {
  const state = { hash: '#/', railVisible: false, writes: 0 }

  const page = {
    evaluate: async (fn, arg) => {
      const location = {
        get hash() {
          return state.hash
        },
        set hash(value) {
          state.hash = `#${value}`
          state.writes += 1

          if (state.writes === 1) {
            // The re-home lands: back on the chat, whose own sidebar stays visible, Settings and its rail gone.
            state.railVisible = true
            setTimeout(() => {
              state.hash = '#/'
              state.railVisible = false
            }, 50)
          } else {
            state.railVisible = true
          }
        }
      }

      globalThis.window = { location }

      return fn(arg)
    },
    locator: selector => ({
      first: () => ({
        waitFor: async () => {
          // The chat route's sidebar is always there; only the rail says Settings holds.
          if (selector.includes('profile-rail') && !state.railVisible) {
            throw new Error('timeout')
          }
        }
      })
    }),
    waitForTimeout: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 100)))
  }

  return { page, state }
}

describe('openSessionsAndBots', () => {
  it('returns only once Settings, not the chat route, holds', async () => {
    const { page, state } = fakePage()

    await openSessionsAndBots(page, 5_000)
    await new Promise(resolve => setTimeout(resolve, 100))

    expect(state.hash).toBe('#/settings?tab=sessions-bots')
    expect(state.railVisible).toBe(true)
    expect(state.writes).toBe(2)
  })
})
