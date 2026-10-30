import { useCallback, useEffect, useState } from 'react'

import { getComputerUseStatus, grantComputerUsePermissions } from '@/api/toolsets'

import { packageRowsOf, setupAgentRuntime } from './agent-runtime'
import type { ComputerUseState } from './copy'
import { setupBridge } from './store'
import type { SetupPackage, SetupSystemItem, SetupSystemRow } from './types'

/** Re-read when the user comes back from System Settings (the window regains focus or becomes visible). */
function useOnReturn(refresh: () => void) {
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        refresh()
      }
    }

    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refresh])
}

/** Main's rows (live macOS status + the one action main picked), refreshed on return. */
export function useSetupSystem() {
  const [rows, setRows] = useState<SetupSystemRow[] | null>(null)
  const [pending, setPending] = useState<SetupSystemItem | null>(null)

  const refresh = useCallback(() => {
    void setupBridge()
      ?.system()
      .then(
        next => setRows(next ?? []),
        () => setRows([])
      )
  }, [])

  useEffect(refresh, [refresh])
  useOnReturn(refresh)

  const act = useCallback((item: SetupSystemItem, words?: { title: string; body: string }) => {
    const bridge = setupBridge()

    if (!bridge) {
      return
    }

    setPending(item)
    void bridge
      .act({ item, ...words })
      .then(
        next => next && setRows(next),
        () => undefined
      )
      .finally(() => setPending(null))
  }, [])

  return { rows, pending, act }
}

/**
 * The packages' state from V3-RT-B's `agentRuntime` (null until it is wired: the section is then never shown). Its
 * `onChange` pushes every change, so nothing polls. "Install again" is RT-B's `installAgain` (the run resumes: what is
 * installed is reused), offered only on a failed or skipped line.
 */
export function useSetupPackages() {
  const [packages, setPackages] = useState<SetupPackage[] | null>(null)
  const [retrying, setRetrying] = useState<string | null>(null)

  const refresh = useCallback(() => {
    void setupAgentRuntime()
      ?.status()
      .then(
        status => setPackages(packageRowsOf(status)),
        () => setPackages(null)
      )
  }, [])

  useEffect(() => {
    refresh()

    return setupAgentRuntime()?.onChange(status => setPackages(packageRowsOf(status)))
  }, [refresh])
  useOnReturn(refresh)

  const retry = useCallback(
    (id: string) => {
      const runtime = setupAgentRuntime()
      const line = packages?.find(one => one.id === id)

      if (!runtime || !line || (line.state !== 'failed' && line.state !== 'skipped')) {
        return
      }

      setRetrying(id)
      void runtime
        .installAgain()
        .catch(() => undefined)
        .finally(() => {
          setRetrying(null)
          refresh()
        })
    },
    [packages, refresh]
  )

  return { packages, retrying, retry }
}

/** Computer use's grants live on CuaDriver (not the app): read through the backend's existing route. */
export function useComputerUse(enabled: boolean) {
  const [state, setState] = useState<ComputerUseState | null>(null)
  const [granting, setGranting] = useState(false)

  const refresh = useCallback(() => {
    if (!enabled) {
      return
    }

    void getComputerUseStatus().then(
      status =>
        setState(
          !status.platform_supported || !status.can_grant
            ? null
            : !status.installed
              ? 'notInstalled'
              : status.ready
                ? 'granted'
                : 'needs'
        ),
      () => setState('unavailable')
    )
  }, [enabled])

  useEffect(refresh, [refresh])
  useOnReturn(refresh)

  const grant = useCallback(() => {
    setGranting(true)
    void grantComputerUsePermissions()
      .catch(() => undefined)
      .finally(() => {
        setGranting(false)
        refresh()
      })
  }, [refresh])

  return { state, granting, grant }
}
