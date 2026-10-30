/**
 * Desktop actions (`store/activity.ts`): the maintenance and settings jobs the app runs through the dashboard
 * (update, toolset install, computer-use setup), as their pollers last reported them. The store keeps the newest 8
 * and lets a finished one go after 5 minutes, so a finished action leaves the list on its own — only a RUNNING one
 * that vanishes is a death.
 *
 * Stop is `unsupported`: the action status carries a pid, but no RPC kills an action, and the app does not signal
 * processes it did not spawn.
 */
import { $desktopActionTasks } from '@/store/activity'
import type { BgTask, TaskSource } from '@/store/background-tasks'

const ACTIONS_SOURCE_ID = 'action'

export function actionsSource(): TaskSource {
  return {
    id: ACTIONS_SOURCE_ID,
    snapshot: () =>
      Object.values($desktopActionTasks.get()).map(({ status, updatedAt }): BgTask => {
        const code = status.exit_code
        const failed = !status.running && code !== null && code !== 0

        return {
          ...(status.running || code === null ? {} : { exit: { code } }),
          id: `${ACTIONS_SOURCE_ID}:${status.name}`,
          kind: 'action',
          lastLine: status.lines.at(-1)?.trim() || null,
          lastLineAt: status.lines.length > 0 ? updatedAt : null,
          seen: true,
          source: ACTIONS_SOURCE_ID,
          // The status reports no start time: unknown stays unknown.
          startedAt: null,
          state: status.running ? 'running' : failed ? 'failed' : 'done',
          stop: 'none',
          title: status.name
        }
      }),
    stop: () => Promise.resolve({ detail: 'no RPC ends a desktop action', effect: 'unsupported', ok: false }),
    subscribe: cb => $desktopActionTasks.listen(cb)
  }
}
