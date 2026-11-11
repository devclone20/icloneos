import { useCallback, useEffect, useRef, useState } from 'react'

import { getActionStatus } from '@/api/system'
import { getComputerUseStatus, grantComputerUsePermissions, runToolsetPostSetup } from '@/api/toolsets'
import { sleep } from '@/iclone-shared/async'
import type { ComputerUseStatus } from '@/types/hermes'

import type { ComputerUseState } from './copy'
import { setupBridge } from './store'
import type { CuaDriverPane } from './types'

/**
 * G-99 — one flow behind the Set up row and the Settings card, so "Allow…" does the same thing in both and always
 * shows something. The cause it fixes (11-05): the row set `granting` back the moment the POST answered, in
 * milliseconds, while `permissions grant` was only starting; macOS raises its dialog once per identity, so a later
 * press looked like nothing at all; and a failure was swallowed.
 */
const POLL_MS = 3_000
const POLL_LIMIT = 60

export type ComputerUsePhase = 'failed' | 'idle' | 'installFailed' | 'installing' | 'notAsked' | 'waiting'

/** Pure: what a status means. `ready: null` is "could not be read", never "not allowed" (no daemon, no answer). */
export function computerUseState(status: ComputerUseStatus): ComputerUseState | null {
  if (!status.platform_supported || !status.can_grant) {
    return null
  }

  if (!status.installed) {
    return 'notInstalled'
  }

  return status.ready === true ? 'granted' : status.ready === false ? 'needs' : 'unknown'
}

/** Pure: the panes still to open, in the order macOS needs them. Unknown counts as still to open. */
export function missingPanes(status: ComputerUseStatus | null): CuaDriverPane[] {
  if (!status || status.ready === true) {
    return []
  }

  return [
    ...(status.accessibility === true ? [] : (['cua:accessibility'] as const)),
    ...(status.screen_recording === true ? [] : (['cua:screen'] as const))
  ]
}

export function openCuaPane(pane: CuaDriverPane) {
  void setupBridge()
    ?.act({ item: pane })
    .catch(() => undefined)
}

export function useComputerUseFlow(enabled: boolean, onChange?: () => void) {
  const [status, setStatus] = useState<ComputerUseStatus | null>(null)
  const [state, setState] = useState<ComputerUseState | null>(null)
  const [phase, setPhase] = useState<ComputerUsePhase>('idle')
  const [reason, setReason] = useState('')
  const [loaded, setLoaded] = useState(false)
  const alive = useRef(false)

  const read = useCallback(async (): Promise<ComputerUseStatus | null> => {
    if (!enabled) {
      return null
    }

    try {
      const next = await getComputerUseStatus()

      if (alive.current) {
        setStatus(next)
        setState(computerUseState(next))
      }

      return next
    } catch {
      if (alive.current) {
        setStatus(null)
        setState('unavailable')
      }

      return null
    } finally {
      if (alive.current) {
        setLoaded(true)
      }
    }
  }, [enabled])

  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (see eslint rule comment)
  useEffect(() => {
    alive.current = true
    void read()

    return () => void (alive.current = false)
  }, [read])

  /** Polls an action until it ends or the state settles; true when the status reads ready. */
  const watch = useCallback(
    async (name: string): Promise<ComputerUseStatus | null> => {
      for (let attempt = 0; attempt < POLL_LIMIT && alive.current; attempt += 1) {
        await sleep(POLL_MS)

        if (!alive.current) {
          return null
        }

        const running = await getActionStatus(name, 50).then(
          action => action.running,
          () => false
        )

        const next = await read()

        if (!running || next?.ready === true) {
          return next
        }
      }

      return read()
    },
    [read]
  )

  const grant = useCallback(async () => {
    setPhase('waiting')
    setReason('')

    try {
      const started = await grantComputerUsePermissions()

      if (!started.ok) {
        throw new Error('the request was refused')
      }

      const next = await watch(started.name)

      if (!alive.current) {
        return
      }

      onChange?.()

      if (next?.ready === true) {
        setPhase('idle')

        return
      }

      // macOS asks once per identity: after that the switch is the only way, so the press ends at the right pane.
      setPhase('notAsked')
      const [first] = missingPanes(next)

      if (first) {
        openCuaPane(first)
      }
    } catch (error) {
      if (alive.current) {
        setReason(error instanceof Error ? error.message : String(error))
        setPhase('failed')
      }
    }
  }, [onChange, watch])

  const install = useCallback(async () => {
    setPhase('installing')

    try {
      const started = await runToolsetPostSetup('computer_use', 'cua_driver')

      if (!started.ok) {
        throw new Error('refused')
      }

      const next = await watch(started.name)

      if (alive.current) {
        onChange?.()
        setPhase(next?.installed ? 'idle' : 'installFailed')
      }
    } catch {
      if (alive.current) {
        setPhase('installFailed')
      }
    }
  }, [onChange, watch])

  return { status, state, phase, reason, loaded, refresh: read, grant, install }
}
