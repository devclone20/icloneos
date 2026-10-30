/**
 * The per-pane line under a sidebar iT row: name · branch · directory · ports ·
 * last signal and its age. Facts come from main (facts.ts); the directory is
 * the session's own; the signal is the bus's.
 */
import { useStore } from '@nanostores/react'

import { useI18n } from '@/i18n'

import { type ItWorkspace, listPanes } from '../../it-layout'
import { $terminals } from '../engine/terminals'

import { $paneStates } from './attention'
import type { PaneSignal } from './bridge'
import { IT_PANES_COPY } from './copy'
import { $paneFacts } from './facts'

function ageText(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))

  if (seconds < 60) {
    return `${seconds}s`
  }

  return seconds < 3600 ? `${Math.round(seconds / 60)}m` : `${Math.round(seconds / 3600)}h`
}

const baseName = (dir: string) =>
  dir
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() || dir

export function ItPaneLines({ workspace }: { workspace: ItWorkspace }) {
  const { locale } = useI18n()
  const copy = IT_PANES_COPY[locale]
  const states = useStore($paneStates)
  const facts = useStore($paneFacts)
  const pool = useStore($terminals)
  const panes = listPanes(workspace.layout)

  const signalText = (signal: PaneSignal) => {
    const word =
      signal.text ||
      (signal.source === 'bell'
        ? copy.signals.bell
        : signal.source === 'attention'
          ? copy.signals.attention
          : copy.signals.notification)

    return `${word} · ${copy.ago(ageText(signal.at))}`
  }

  return (
    <ul aria-label={copy.linesLabel(workspace.title)} className="itwin__pane-lines">
      {panes.map(terminalId => {
        const term = pool.find(entry => entry.id === terminalId)
        const state = states[terminalId]
        const fact = facts[terminalId]
        const dir = term?.restoreCwd || term?.cwd || ''
        const attention = state?.state === 'needs-input'

        return (
          <li className="itwin__pane-line" data-attention={attention ? '' : undefined} key={terminalId}>
            <span>{state?.name ?? term?.title ?? ''}</span>
            <span>{fact ? (fact.branch ?? copy.noBranch) : ''}</span>
            {dir && <span title={dir}>{baseName(dir)}</span>}
            {fact && fact.ports.length > 0 && <span>{copy.ports(fact.ports.join(' '))}</span>}
            {state?.signal && (
              <span>
                {attention ? `${copy.states['needs-input']} · ${signalText(state.signal)}` : signalText(state.signal)}
              </span>
            )}
          </li>
        )
      })}
    </ul>
  )
}
