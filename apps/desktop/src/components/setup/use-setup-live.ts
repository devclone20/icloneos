import { useCallback, useEffect, useState } from 'react'

import { packageRowsOf, setupAgentRuntime } from './agent-runtime'
import { useComputerUseFlow } from './computer-use-flow'
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

/** Computer use's grants live on CuaDriver (not the app): read through the backend's existing route, on return too. */
export function useComputerUse(enabled: boolean) {
  const flow = useComputerUseFlow(enabled)
  const { refresh } = flow

  useOnReturn(useCallback(() => void refresh(), [refresh]))

  return flow
}
