import { useStore } from '@nanostores/react'
import type { ComponentType } from 'react'

import { formatDurationSeconds } from '@/components/assistant-ui/tool/fallback-model/format'
import { IcAction } from '@/components/ic/controls'
import { IcDot, IcNote, type IcTone } from '@/components/ic/feedback'
import { IcTip } from '@/components/ic/ic-system'
import { IcMonoLines } from '@/components/ic/mono'
import type { Translations } from '@/i18n'
import { Brain, Clock, PanelTop, Terminal, XIcon, Zap } from '@/lib/icons'
import {
  $stopAttempts,
  type BgTask,
  dismissTask,
  markTaskSeen,
  stopTask,
  type TaskKind,
  type TaskState
} from '@/store/background-tasks'

/** Unknown start time: a dash, never a guess (contract R1). */
const NO_ELAPSED = '—'

const KIND_GLYPH: Record<TaskKind, ComponentType<{ size?: number }>> = {
  action: Zap,
  agent: Brain,
  cron: Clock,
  pane: PanelTop,
  shell: Terminal
}

const STATE_TONE: Record<TaskState, IcTone> = {
  died: 'danger',
  done: 'done',
  failed: 'danger',
  running: 'live',
  stopped: 'muted',
  waiting: 'warn'
}

type Copy = Translations['backgroundTasks']

function exitText(task: BgTask, copy: Copy): string | null {
  if (task.exit?.signal) {
    return copy.signal(task.exit.signal)
  }

  return task.exit?.code !== undefined && task.exit.code !== 0 ? copy.exitCode(task.exit.code) : null
}

/** The state word, or the reason a remembered task ended when the registry knows it ("Stopped by you", …). */
const stateText = (task: BgTask, copy: Copy): string =>
  task.endedBy ? copy.endedBy[task.endedBy] : copy.states[task.state]

function elapsedText(task: BgTask, now: number): string {
  return task.startedAt === null ? NO_ELAPSED : formatDurationSeconds(Math.max(0, now - task.startedAt) / 1000)
}

function StopControl({ copy, task }: { copy: Copy; task: BgTask }) {
  const attempt = useStore($stopAttempts)[task.id]

  if (task.state !== 'running' && task.state !== 'waiting') {
    return null
  }

  if (task.stop !== 'real') {
    const reason = task.state === 'waiting' ? copy.cannotStop.waiting : copy.cannotStop[task.kind]

    return (
      <span className="ibg-row__reason" data-testid="bg-task-cannot-stop">
        {reason}
      </span>
    )
  }

  // A press in this panel wins; otherwise a stop asked elsewhere (the composer's X, a rewind) shows its own state.
  const phase = attempt?.phase ?? task.externalStop

  if (phase === 'failed') {
    return (
      <span className="ibg-row__stop" data-testid="bg-task-did-not-stop">
        <IcNote tone="danger">{copy.didNotStop(attempt?.detail ?? '')}</IcNote>
        <span data-testid="bg-task-retry">
          <IcAction onClick={() => void stopTask(task.id)} tone="danger">
            {copy.retryStop}
          </IcAction>
        </span>
      </span>
    )
  }

  // No reading came: neither verdict is known, so neither is shown. A reading that lands later still decides.
  if (phase === 'unconfirmed') {
    return (
      <span className="ibg-row__stop" data-testid="bg-task-cannot-confirm">
        <IcNote>{copy.cannotConfirm}</IcNote>
        <span data-testid="bg-task-retry">
          <IcAction onClick={() => void stopTask(task.id)}>{copy.retryStop}</IcAction>
        </span>
      </span>
    )
  }

  return (
    <span data-testid="bg-task-stop">
      <IcAction disabled={phase === 'pending'} onClick={() => void stopTask(task.id)} tone="danger">
        {phase === 'pending' ? copy.stopping : copy.stop}
      </IcAction>
    </span>
  )
}

export function TaskRow({
  copy,
  now,
  onToggle,
  open,
  task
}: {
  copy: Copy
  now: number
  onToggle: () => void
  open: boolean
  task: BgTask
}) {
  const Glyph = KIND_GLYPH[task.kind]
  const remembered = task.state === 'died' || task.state === 'stopped'
  const exit = exitText(task, copy)

  const state = stateText(task, copy)
  const meta = [copy.kinds[task.kind], state, elapsedText(task, now), exit].filter(Boolean).join(' · ')

  const toggle = () => {
    if (!open) {
      markTaskSeen(task.id)
    }

    onToggle()
  }

  return (
    <li
      className="icui-row ibg-row"
      data-ended-by={task.endedBy}
      data-seen={task.seen ? '' : undefined}
      data-state={task.state}
      data-testid="bg-task-row"
    >
      <IcDot label={state} tone={STATE_TONE[task.state]} />
      <span aria-hidden className="ibg-row__glyph">
        <Glyph size={14} />
      </span>
      <div className="ibg-row__body">
        <IcTip label={task.startedAt === null ? copy.startUnknown : null}>
          <button aria-expanded={open} className="icui-row__open" onClick={toggle} type="button">
            <span className="icui-row__title">{task.title}</span>
            <span className="icui-row__meta">{meta}</span>
            <span className="icui-row__meta ibg-row__last">{task.lastLine ?? copy.noOutput}</span>
          </button>
        </IcTip>
        {open ? <IcMonoLines emptyLabel={copy.noOutput} lines={task.lastLine ? [task.lastLine] : []} /> : null}
        <StopControl copy={copy} task={task} />
      </div>
      {remembered ? (
        <button
          aria-label={copy.dismiss}
          className="icui-icon ibg-row__dismiss"
          onClick={() => dismissTask(task.id)}
          type="button"
        >
          <XIcon size={12} />
        </button>
      ) : null}
    </li>
  )
}
