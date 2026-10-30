/**
 * Starts the built-in sources and the all-session poller while at least one background-tasks door is mounted (the
 * Message band carries it in chat AND iT, so in practice: for the window's life). Ref-counted, so a remount or a
 * second surface never registers a source twice.
 */
import { useEffect } from 'react'

import { useI18n } from '@/i18n'
import { registerTaskSource } from '@/store/background-tasks'

import { startBackgroundPoller } from './poller'
import { actionsSource } from './sources/actions'
import { cronSource } from './sources/cron'
import { permissionsSource, setPermissionWords } from './sources/permissions'
import { processesSource } from './sources/processes'
import { subagentsSource } from './sources/subagents'

let users = 0
let stopRuntime: (() => void) | null = null

function start(): () => void {
  const permissions = permissionsSource()

  const offs = [
    registerTaskSource(subagentsSource()),
    registerTaskSource(processesSource()),
    registerTaskSource(cronSource()),
    registerTaskSource(actionsSource()),
    ...(permissions ? [registerTaskSource(permissions)] : []),
    startBackgroundPoller()
  ]

  return () => offs.forEach(off => off())
}

export function useBackgroundTasksRuntime(): void {
  const permissionWords = useI18n().t.settings.permissions

  // V3-T3: a permission task's lines are said in the reader's words; a locale change re-folds them.
  useEffect(() => setPermissionWords(permissionWords), [permissionWords])

  useEffect(() => {
    users += 1
    stopRuntime ??= start()

    return () => {
      users -= 1

      if (users === 0) {
        stopRuntime?.()
        stopRuntime = null
      }
    }
  }, [])
}
