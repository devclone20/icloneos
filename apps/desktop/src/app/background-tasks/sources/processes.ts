/**
 * Shell jobs the agent started with `terminal(background=true)` — the gateway's process registry, as the composer
 * stack already mirrors it (`$backgroundStatusBySession`, keyed by RUNTIME session id). Only agent-started work is
 * here: a command the owner types in iT never enters that registry (owner decision O3).
 *
 * Stop is real: `process.kill` on the gateway. It deliberately does NOT go through `stopBackgroundProcess`, which
 * drops the row as soon as the gateway acknowledges — a gateway that acknowledged without killing would then read
 * as stopped. Here the row stays until the registry itself says the process exited.
 *
 * A job leaves this list without dying in three ways, and each is named, never called a death: the composer stack's X
 * killed it (owner), a rewind dropped it, or its session was lost (4001) — that session is never polled again, so its
 * rows would otherwise read "running" forever.
 *
 * The X and a rewind name an intent, not an effect: their row leaves the stack as soon as the kill is sent. While the
 * registry still reports that process running it stays here, `running` with `externalStop` ("Stopping…", then "Did
 * not stop" once it outlives the kill, or "Can't confirm" when no reading comes), and only its exit reads "Stopped by
 * you" / "Removed by rewind" — however late that exit comes.
 */
import { errorMessage } from '@/iclone-shared/errors'
import type { BgTask, TaskEndReason, TaskSource } from '@/store/background-tasks'
import {
  $backgroundGoneSessions,
  $backgroundStatusBySession,
  $backgroundStopWatch,
  backgroundDismissalOf,
  type BackgroundStopWatch,
  type ComposerStatusItem,
  readBackgroundProcesses,
  refreshBackgroundProcesses
} from '@/store/composer-status'
import { $gateway } from '@/store/gateway'

const PROCESSES_SOURCE_ID = 'shell'

/** Re-read the registry this long after a kill, inside the registry's 3 s verdict window. */
const STOP_RECHECK_MS = 2_000

const SIGNALS: Readonly<Record<number, string>> = { 1: 'SIGHUP', 2: 'SIGINT', 9: 'SIGKILL', 15: 'SIGTERM' }

const lastLineOf = (output: string | undefined): string | null =>
  output
    ?.split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .at(-1) ?? null

/** Python reports a child killed by signal N as returncode -N. */
function exitOf(item: ComposerStatusItem): BgTask['exit'] {
  if (item.state === 'running' || item.exitCode === undefined) {
    return item.state === 'done' ? { code: 0 } : undefined
  }

  return item.exitCode < 0 ? { signal: SIGNALS[-item.exitCode] ?? `signal ${-item.exitCode}` } : { code: item.exitCode }
}

const externalStopOf = (watch: BackgroundStopWatch): NonNullable<BgTask['externalStop']> =>
  watch.failed ? 'failed' : watch.unconfirmed ? 'unconfirmed' : 'pending'

function toTask(sid: string, item: ComposerStatusItem, watch?: BackgroundStopWatch): BgTask {
  const running = item.state === 'running'

  return {
    ...(watch && running ? { externalStop: externalStopOf(watch) } : {}),
    exit: exitOf(item),
    id: `${PROCESSES_SOURCE_ID}:${sid}/${item.id}`,
    kind: 'shell',
    lastLine: lastLineOf(item.output),
    lastLineAt: null,
    seen: true,
    sessionId: sid,
    source: PROCESSES_SOURCE_ID,
    // The registry carries no start time (contract R1): unknown stays unknown.
    startedAt: null,
    state: running ? 'running' : item.state === 'failed' ? 'failed' : 'done',
    stop: running ? 'real' : 'none',
    title: item.title
  }
}

const splitNativeId = (nativeId: string): { sid: string; processId: string } | null => {
  const slash = nativeId.indexOf('/')

  return slash < 1 || slash === nativeId.length - 1
    ? null
    : { processId: nativeId.slice(slash + 1), sid: nativeId.slice(0, slash) }
}

function endReason(nativeId: string): TaskEndReason | null {
  const target = splitNativeId(nativeId)

  if (!target) {
    return null
  }

  if ($backgroundGoneSessions.get().has(target.sid)) {
    return 'session'
  }

  return backgroundDismissalOf(target.sid, target.processId)
}

export function processesSource(schedule: (fn: () => void, ms: number) => void = setTimeout): TaskSource {
  return {
    id: PROCESSES_SOURCE_ID,
    endReason,
    snapshot() {
      const gone = $backgroundGoneSessions.get()
      const bySession = $backgroundStatusBySession.get()
      const watched = $backgroundStopWatch.get()
      const sids = new Set([...Object.keys(bySession), ...Object.keys(watched)])

      return [...sids]
        .filter(sid => !gone.has(sid))
        .flatMap(sid => {
          const items = (bySession[sid] ?? []).filter(item => item.id)
          const listed = new Set(items.map(item => item.id))
          const leaving = Object.values(watched[sid] ?? {}).filter(watch => !listed.has(watch.item.id))

          return [...items.map(item => toTask(sid, item)), ...leaving.map(watch => toTask(sid, watch.item, watch))]
        })
    },
    async stop(nativeId) {
      const target = splitNativeId(nativeId)
      const gateway = $gateway.get()

      if (!target || !gateway) {
        return { detail: gateway ? 'unknown process' : 'not connected', effect: 'killed', ok: false }
      }

      const { processId, sid } = target

      try {
        await gateway.request('process.kill', { process_id: processId, session_id: sid })
      } catch (error) {
        return { detail: errorMessage(error), effect: 'killed', ok: false }
      }

      void refreshBackgroundProcesses(sid)
      schedule(() => void refreshBackgroundProcesses(sid), STOP_RECHECK_MS)

      return { effect: 'killed', ok: true }
    },
    reread(nativeId) {
      const target = splitNativeId(nativeId)

      return target ? readBackgroundProcesses(target.sid) : Promise.resolve(true)
    },
    subscribe(cb) {
      const offs = [
        $backgroundStatusBySession.listen(cb),
        $backgroundGoneSessions.listen(cb),
        $backgroundStopWatch.listen(cb)
      ]

      return () => offs.forEach(off => off())
    }
  }
}
