import { sleep as defaultSleep } from '@/iclone-shared/async'
import { errorMessage } from '@/iclone-shared/errors'

/**
 * iclone os — (re)sign in to one iNFT's Virtuals ACP session, from anywhere.
 *
 * The same split flow the wizard runs (`acp auth configure start` → the
 * browser → `configure complete` polled until `authenticated`), but as a
 * framework-free handle so Settings → iNFT can offer it for ANY token, even
 * when the cached status still says "authenticated" (a session can expire
 * while the cache does not). Dependencies are injected so unit tests never
 * touch the CLI, the browser or the clock.
 */
import { type AcpRunResult, refreshAcpStatus, runAcp } from '../home/acp-setup'
import { openExternal } from '../home/lib/external'

import { cliJson, pickString } from './inft-setup-runner'

type AcpSignInPhase = 'starting' | 'waiting' | 'done' | 'error' | 'cancelled'

export interface AcpSignInState {
  phase: AcpSignInPhase
  /** The sign-in link, kept from `waiting` on so the UI can open it again. */
  url?: string
  /** Why the sign-in ended in `error`. */
  error?: string
}

export interface AcpSignInHandle {
  readonly state: AcpSignInState
  subscribe: (listener: (state: AcpSignInState) => void) => () => void
  /** Open the sign-in link again (no-op before `waiting`). */
  openLink: () => void
  /** Stop polling; settles the state to `cancelled`. */
  cancel: () => void
  /** Resolves with the terminal state (never rejects). */
  finished: Promise<AcpSignInState>
}

interface AcpSignInDeps {
  run?: (inftId: string, argv: string[], timeoutMs?: number) => Promise<AcpRunResult>
  open?: (url: string) => void
  refresh?: (inftId: string) => Promise<unknown>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

const SIGN_IN_POLL_MS = 4_000
export const SIGN_IN_CAP_MS = 5 * 60_000

const START_ARGV = ['configure', 'start', '--json']
const completeArgv = (requestId: string) => ['configure', 'complete', '--request-id', requestId, '--json']

function failure(result: AcpRunResult): string {
  return result.error ?? (result.stderr.trim() || `exit ${result.code ?? '?'}`)
}

export function startAcpSignIn(inftId: string, deps: AcpSignInDeps = {}): AcpSignInHandle {
  const { run = runAcp, open = openExternal, refresh = refreshAcpStatus, now = Date.now, sleep = defaultSleep } = deps
  const listeners = new Set<(state: AcpSignInState) => void>()
  let state: AcpSignInState = { phase: 'starting' }
  let cancelled = false
  let releaseWait: (() => void) | null = null

  const settle = (next: AcpSignInState) => {
    state = next
    listeners.forEach(listener => listener(state))
  }

  // A wait that cancel() can cut short, so the row answers at once instead
  // of after the next 4 s tick.
  const wait = (ms: number) =>
    new Promise<void>(resolve => {
      releaseWait = resolve
      void sleep(ms).then(resolve)
    }).finally(() => {
      releaseWait = null
    })

  const flow = async (): Promise<AcpSignInState> => {
    let started: AcpRunResult

    try {
      started = await run(inftId, START_ARGV)
    } catch (error) {
      return { phase: 'error', error: errorMessage(error) }
    }

    if (cancelled) {
      return { phase: 'cancelled' }
    }

    if (!started.ok) {
      return { phase: 'error', error: `acp configure start failed — ${failure(started)}` }
    }

    const json = cliJson(started)
    const url = pickString(json, ['url', 'authUrl'])
    const requestId = pickString(json, ['requestId', 'request_id'])

    if (!url || !requestId) {
      return { phase: 'error', error: 'could not read the sign-in URL from the CLI output — try again' }
    }

    open(url)
    settle({ phase: 'waiting', url })

    const openedAt = now()

    for (;;) {
      await wait(SIGN_IN_POLL_MS)

      if (cancelled) {
        return { phase: 'cancelled' }
      }

      if (now() - openedAt >= SIGN_IN_CAP_MS) {
        return { phase: 'error', url, error: 'sign-in timed out after 5 minutes — start again' }
      }

      const result = await run(inftId, completeArgv(requestId)).catch(() => null)

      if (cancelled) {
        return { phase: 'cancelled' }
      }

      if (result && pickString(cliJson(result), ['status']) === 'authenticated') {
        void refresh(inftId).catch(() => undefined)

        return { phase: 'done', url }
      }
    }
  }

  const finished = flow().then(terminal => {
    settle(terminal)

    return terminal
  })

  return {
    get state() {
      return state
    },
    subscribe: listener => {
      listeners.add(listener)

      return () => {
        listeners.delete(listener)
      }
    },
    openLink: () => {
      if (state.url) {
        open(state.url)
      }
    },
    cancel: () => {
      if (state.phase === 'starting' || state.phase === 'waiting') {
        cancelled = true
        releaseWait?.()
      }
    },
    finished
  }
}
