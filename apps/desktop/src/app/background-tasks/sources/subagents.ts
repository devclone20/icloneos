/**
 * Sub-agents (`delegate_task` children), as the message stream already folds them into `$subagentsBySession`.
 *
 * Stop is `unsupported`, said out loud: the only verb the gateway lock has is `session.interrupt`, which cancels a
 * CLAIMED chat session's turn; a child's `sessionId` is its stored mirror id, not a claimed runtime, and no test has
 * shown the call ending a child (contract §2.7 / R2). Until one does, the panel says so instead of offering a button
 * that might do nothing.
 *
 * Labels stay "agent": nothing in the progress payload carries a profile or role tag, and a role is never inferred
 * from the goal text (owner decision O4).
 */
import type { BgTask, TaskSource, TaskState } from '@/store/background-tasks'
import { $subagentsBySession, type SubagentProgress, type SubagentStatus } from '@/store/subagents'

const SUBAGENTS_SOURCE_ID = 'agent'

/** Placeholder rows the stream swaps for the real child once its first native event lands — never a death. */
const PLACEHOLDER_PREFIX = 'delegate-tool:'

/**
 * The chat's own Stop drops a session's sub-agents all at once (`clearSessionSubagents`): those children were
 * cancelled by the owner, so for this long they are reported `stopped` instead of vanishing (which reads as died).
 */
const CLEARED_TOMBSTONE_MS = 60_000

const STATE: Record<SubagentStatus, TaskState> = {
  completed: 'done',
  failed: 'failed',
  interrupted: 'stopped',
  queued: 'running',
  running: 'running'
}

function toTask(parentSid: string, agent: SubagentProgress): BgTask {
  const last = agent.stream.at(-1)

  return {
    id: `${SUBAGENTS_SOURCE_ID}:${parentSid}/${agent.id}`,
    kind: 'agent',
    lastLine: last?.text ?? agent.currentTool ?? null,
    lastLineAt: last?.at ?? agent.updatedAt,
    seen: true,
    sessionId: agent.sessionId,
    source: SUBAGENTS_SOURCE_ID,
    startedAt: agent.startedAt,
    state: STATE[agent.status],
    stop: 'none',
    title: agent.goal
  }
}

export function subagentsSource(now: () => number = Date.now): TaskSource {
  let lastSessions = new Map<string, BgTask[]>()
  const tombstones = new Map<string, { at: number; task: BgTask }>()

  return {
    id: SUBAGENTS_SOURCE_ID,
    snapshot() {
      const bySession = $subagentsBySession.get()
      const at = now()

      const sessions = new Map(
        Object.entries(bySession).map(([sid, agents]) => [
          sid,
          agents.filter(agent => !agent.id.startsWith(PLACEHOLDER_PREFIX)).map(agent => toTask(sid, agent))
        ])
      )

      for (const [sid, tasks] of lastSessions) {
        if (sessions.has(sid)) {
          continue
        }

        for (const task of tasks.filter(candidate => candidate.state === 'running')) {
          tombstones.set(task.id, { at, task: { ...task, state: 'stopped' } })
        }
      }

      lastSessions = sessions

      for (const [id, stone] of tombstones) {
        if (at - stone.at > CLEARED_TOMBSTONE_MS) {
          tombstones.delete(id)
        }
      }

      const live = [...sessions.values()].flat()
      const liveIds = new Set(live.map(task => task.id))

      return [...live, ...[...tombstones.values()].filter(s => !liveIds.has(s.task.id)).map(s => s.task)]
    },
    stop: () =>
      Promise.resolve({
        detail: 'session.interrupt is not proven to end a sub-agent',
        effect: 'unsupported',
        ok: false
      }),
    subscribe: cb => $subagentsBySession.listen(cb)
  }
}
