import './agents.css'

import { useStore } from '@nanostores/react'
import { useEffect, useMemo, useState } from 'react'

import { useI18n } from '@/i18n'
import { $subagentsBySession, allSubagents, buildSubagentTree, type SubagentNode } from '@/store/subagents'

import { PageFrame } from '../command-center/page-frame'
import { IcDot, IcEmpty } from '../command-center/ui/feedback'
import { IcEyebrow, IcMeta, IcScroll, IcStack } from '../command-center/ui/layout'

import {
  type DelegationGroup,
  FILE_LINES_SHOWN,
  fileLines,
  flattenNodes,
  groupDelegations,
  isActive,
  nodeSubtitle,
  statusLabel,
  statusTone,
  streamTone,
  treeSummary,
  treeTotals
} from './subagent-view-model'

const TICK_MS = 500

/** The live clock only runs while something is actually running AND this window
 *  is visible: a hidden window ticking 2×/s is a battery bug, and the ages are
 *  recomputed on the next paint anyway. */
function useLiveClock(active: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    if (!active || typeof document === 'undefined') {
      return
    }

    let timer = 0

    const stop = () => {
      if (timer) {
        window.clearInterval(timer)
        timer = 0
      }
    }

    const sync = () => {
      if (document.hidden) {
        stop()

        return
      }

      setNowMs(Date.now())

      if (!timer) {
        timer = window.setInterval(() => setNowMs(Date.now()), TICK_MS)
      }
    }

    sync()
    document.addEventListener('visibilitychange', sync)

    return () => {
      stop()
      document.removeEventListener('visibilitychange', sync)
    }
  }, [active])

  return nowMs
}

export function AgentsView({ onClose }: { onClose: () => void }) {
  const { t } = useI18n()
  const a = t.agents
  const subagentsBySession = useStore($subagentsBySession)

  // Every session is aggregated, matching the global running indicator — a
  // subagent running in a background session must still show here, or the two
  // desync ("N running" over an empty tree).
  const tree = useMemo(() => buildSubagentTree(allSubagents(subagentsBySession)), [subagentsBySession])
  const flat = useMemo(() => flattenNodes(tree), [tree])
  const groups = useMemo(() => groupDelegations(tree), [tree])
  const totals = useMemo(() => treeTotals(flat), [flat])
  const nowMs = useLiveClock(totals.active > 0)

  return (
    <PageFrame closeLabel={a.close} hint={tree.length > 0 ? a.subtitle : undefined} onClose={onClose} title={a.title}>
      {tree.length === 0 ? (
        <IcEmpty description={a.emptyDesc} title={a.emptyTitle} />
      ) : (
        <IcStack>
          <IcMeta>{treeSummary(totals, a)}</IcMeta>
          <IcScroll>
            <div className="icag-tree">
              {groups.map(group => (
                <Delegation group={group} key={group.id} nowMs={nowMs} />
              ))}
            </div>
          </IcScroll>
        </IcStack>
      )}
    </PageFrame>
  )
}

function Delegation({ group, nowMs }: { group: DelegationGroup; nowMs: number }) {
  const { t } = useI18n()
  const a = t.agents

  if (group.nodes.length === 1 && group.taskCount <= 1) {
    return <AgentNode node={group.nodes[0]!} nowMs={nowMs} />
  }

  const activeWorkers = group.nodes.filter(node => isActive(node.status)).length

  return (
    <section className="icag-group">
      <p className="icag-group__label">
        {group.delegationIndex > 0 ? a.delegation(group.delegationIndex) : null}
        <span aria-hidden>·</span>
        {a.workers(group.nodes.length)}
        {activeWorkers > 0 ? <span className="icag-group__active">· {a.workersActive(activeWorkers)}</span> : null}
      </p>
      <div className="icag-tree">
        {group.nodes.map(node => (
          <AgentNode key={node.id} node={node} nowMs={nowMs} />
        ))}
      </div>
    </section>
  )
}

const STREAM_ROWS_OPEN = 10
const STREAM_ROWS_CLOSED = 2

function AgentNode({ depth = 0, node, nowMs }: { depth?: number; node: SubagentNode; nowMs: number }) {
  const { t } = useI18n()
  const a = t.agents
  const running = isActive(node.status)

  // A finished node reports its own duration; a running one is measured from
  // its start against the live clock, so the number never freezes mid-run.
  const durationSeconds =
    typeof node.durationSeconds === 'number'
      ? Math.max(0, Math.round(node.durationSeconds))
      : Math.max(0, Math.round((nowMs - node.startedAt) / 1000))

  const [open, setOpen] = useState(() => running || depth < 2)

  useEffect(() => {
    if (running) {
      setOpen(true)
    }
  }, [running])

  const rows = node.stream.slice(open ? -STREAM_ROWS_OPEN : -STREAM_ROWS_CLOSED)
  const files = fileLines(node)

  return (
    <div className="icag-node" data-depth={depth}>
      <button aria-expanded={open} className="icag-node__head" onClick={() => setOpen(value => !value)} type="button">
        <span className="icag-node__status">
          <IcDot label={statusLabel(node.status, a)} tone={statusTone(node.status)} />
        </span>
        <span className="icag-node__ident">
          <span className="icag-node__goal" data-running={running}>
            {node.goal}
          </span>
          <span className="icag-node__sub">{nodeSubtitle(node, durationSeconds, nowMs, a)}</span>
        </span>
        {running ? <span className="icag-node__elapsed">{durationSeconds}s</span> : null}
      </button>

      {rows.length > 0 ? (
        <div className="icag-stream" data-selectable-text="true">
          {rows.map((entry, index) => (
            <div className="icag-stream__line" key={`${entry.kind}:${entry.at}:${index}`}>
              <IcDot tone={streamTone(entry)} />
              <span className="icag-stream__text" data-kind={entry.kind} data-tone={streamTone(entry)}>
                {entry.text}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {open && files.length > 0 ? (
        <div className="icag-files" data-selectable-text="true">
          <IcEyebrow>{a.files}</IcEyebrow>
          {files.slice(0, FILE_LINES_SHOWN).map(line => (
            <p key={line}>{line}</p>
          ))}
          {files.length > FILE_LINES_SHOWN ? <p>{a.moreFiles(files.length - FILE_LINES_SHOWN)}</p> : null}
        </div>
      ) : null}

      {node.children.length > 0 ? (
        <div className="icag-children">
          {node.children.map(child => (
            <AgentNode depth={depth + 1} key={child.id} node={child} nowMs={nowMs} />
          ))}
        </div>
      ) : null}
    </div>
  )
}
