import './it-terminal.css'

/**
 * The Message sidebar's iT section (contract §12): one row per open iT
 * session (an it-store workspace) and nothing else. Picking a row shows that
 * session; `+` in the sidebar head adds one; rename (F2, double-click, the
 * pencil) and close (✕, Delete) live on the row, and the busy-close prompt
 * the terminal's own tab rail used to carry shows on the row it concerns.
 * The pane tools (split, zoom) of that hidden rail sit under the rows.
 *
 * `SideButton` — the sidebar's icon button — lives here, the leaf, so the nav
 * (msg-sidebar.tsx) and the pane tools share one without a module cycle.
 */
import { useStore } from '@nanostores/react'
import { Columns2, Maximize2, Pencil, Rows2, X } from 'lucide-react'
import type { ComponentProps, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { Fragment, useCallback, useId, useRef, useState } from 'react'

import { SidebarPanelLabel } from '@/app/shell/sidebar-label'
import { Tip } from '@/components/ui/tooltip'

import { $itClosePrompt, confirmItClose, dismissItClose, requestCloseItWorkspace } from './it-keys'
import { type ItWorkspace, listPanes } from './it-layout'
import {
  $itActiveId,
  $itBodySize,
  $itSurfaceOpen,
  $itWorkspaces,
  canSplitItPane,
  renameItWorkspace,
  setItActive,
  splitItPane,
  toggleItZoom
} from './it-store'
import { useVisiblePaneProbe } from './it/bus/facts'
import { ItPaneLines } from './it/bus/pane-lines'

const LABELS = {
  itSessions: 'iT sessions',
  panes: 'Panes',
  splitRight: 'Split right (⌘D)',
  splitDown: 'Split down (⌘⇧D)',
  zoom: 'Zoom pane (⌘⇧Return)',
  rename: 'Rename',
  close: 'Close',
  keep: 'Keep'
}

/** The row's main button (not its hover actions): where focus returns after a rename. */
const ROW_OPEN = '.imsg-it-row__open'

export function SideButton({
  children,
  label,
  ref,
  ...props
}: Omit<ComponentProps<'button'>, 'aria-label' | 'type'> & { label: string; children: ReactNode }) {
  return (
    <Tip label={label}>
      <button aria-label={label} className="imsg-side__btn" ref={ref} type="button" {...props}>
        {children}
      </button>
    </Tip>
  )
}

/**
 * iT view: one row per open iT session (it-store workspace) and nothing else.
 * Picking a row shows that session; `+` above adds one; rename and close live
 * on the row. The busy-close prompt shows on the row it concerns.
 */
export function ItSessionList() {
  const headingId = useId()
  const listRef = useRef<HTMLDivElement>(null)
  const workspaces = useStore($itWorkspaces)
  const activeId = useStore($itActiveId)
  const prompt = useStore($itClosePrompt)
  const surfaceOpen = useStore($itSurfaceOpen)
  const [editing, setEditing] = useState<null | string>(null)
  const activeWorkspace = workspaces.find(workspace => workspace.id === activeId)

  useVisiblePaneProbe(activeWorkspace ? listPanes(activeWorkspace.layout) : [], surfaceOpen)

  const finishEdit = useCallback((id: string) => {
    setEditing(null)
    requestAnimationFrame(() =>
      listRef.current
        ?.querySelector<HTMLElement>(`[data-it-workspace-id="${CSS.escape(id)}"] ${ROW_OPEN}`)
        ?.focus({ preventScroll: true })
    )
  }, [])

  return (
    <div aria-labelledby={headingId} className="imsg-side__group" data-group="it" ref={listRef} role="group">
      <h3 className="imsg-side__heading" id={headingId}>
        <span className="imsg-side__label">
          <SidebarPanelLabel>{LABELS.itSessions}</SidebarPanelLabel>
        </span>
      </h3>
      <div className="imsg-side__rows">
        {workspaces.map(workspace => (
          <Fragment key={workspace.id}>
            <ItRow
              active={workspace.id === activeId}
              closable={workspaces.length > 1}
              editing={editing === workspace.id}
              onEdit={setEditing}
              onEdited={finishEdit}
              prompt={prompt?.workspaceId === workspace.id ? prompt : null}
              workspace={workspace}
            />
            <ItPaneLines workspace={workspace} />
          </Fragment>
        ))}
      </div>
      <ItPaneTools workspaceId={activeId} />
    </div>
  )
}

interface ItRowProps {
  workspace: ItWorkspace
  active: boolean
  /** The last session never closes — the surface always has a live shell. */
  closable: boolean
  editing: boolean
  prompt: ReturnType<typeof $itClosePrompt.get>
  onEdit: (id: string) => void
  onEdited: (id: string) => void
}

function ItRow({ workspace, active, closable, editing, prompt, onEdit, onEdited }: ItRowProps) {
  const panes = listPanes(workspace.layout).length

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement

    if (
      event.defaultPrevented ||
      !event.currentTarget.contains(target) ||
      target.closest('input, [role=alertdialog]')
    ) {
      return
    }

    if (event.key === 'F2') {
      event.preventDefault()
      onEdit(workspace.id)
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && closable) {
      event.preventDefault()
      requestCloseItWorkspace(workspace.id)
    }
  }

  return (
    <div
      className="imsg-row imsg-it-row"
      data-it-workspace-id={workspace.id}
      data-selected={active ? '' : undefined}
      onKeyDown={onKeyDown}
    >
      {editing ? (
        <ItRenameField onDone={() => onEdited(workspace.id)} workspace={workspace} />
      ) : (
        <button
          aria-current={active ? 'true' : undefined}
          className="imsg-it-row__open"
          onClick={() => setItActive(workspace.id)}
          onDoubleClick={() => onEdit(workspace.id)}
          type="button"
        >
          <i aria-hidden className="imsg-it-row__light" data-unread={workspace.unread ? '' : undefined} />
          <span className="imsg-it-row__title">{workspace.title}</span>
          {panes > 1 && <em className="imsg-it-row__panes">{panes}</em>}
        </button>
      )}
      {!editing && (
        <div className="imsg-it-row__actions" data-row-actions>
          <RowAction label={`${LABELS.rename} ${workspace.title}`} onClick={() => onEdit(workspace.id)}>
            <Pencil size={12} strokeWidth={1.75} />
          </RowAction>
          {closable && (
            <RowAction
              danger
              label={`${LABELS.close} ${workspace.title}`}
              onClick={() => requestCloseItWorkspace(workspace.id)}
            >
              <X size={13} strokeWidth={1.75} />
            </RowAction>
          )}
        </div>
      )}
      {prompt && <ItClosePromptRow busy={prompt.busy} pane={prompt.terminalId !== null} />}
    </div>
  )
}

function RowAction({
  children,
  danger,
  label,
  onClick
}: {
  children: ReactNode
  danger?: boolean
  label: string
  onClick: () => void
}) {
  return (
    <button
      aria-label={label}
      className="imsg-it-row__action"
      data-danger={danger ? '' : undefined}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  )
}

/** Enter or leaving the field renames; Escape keeps the old title. */
function ItRenameField({ workspace, onDone }: { workspace: ItWorkspace; onDone: () => void }) {
  const [value, setValue] = useState(workspace.title)
  // Unmounting blurs the field; a finished edit must not run twice.
  const done = useRef(false)

  const finish = (commit: boolean) => {
    if (done.current) {
      return
    }

    done.current = true

    if (commit && value.trim() !== workspace.title) {
      renameItWorkspace(workspace.id, value)
    }

    onDone()
  }

  return (
    <input
      aria-label={`${LABELS.rename} ${workspace.title}`}
      autoFocus
      className="imsg-it-row__field"
      onBlur={() => finish(true)}
      onChange={event => setValue(event.target.value)}
      onFocus={event => event.currentTarget.select()}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === 'Escape') {
          event.preventDefault()
          finish(event.key === 'Enter')
        }
      }}
      spellCheck={false}
      value={value}
    />
  )
}

/** The busy prompt of a pending close (it-keys), on the row it concerns. */
function ItClosePromptRow({ busy, pane }: { busy: number; pane: boolean }) {
  const shells = busy === 1 ? '1 shell is busy' : `${busy} shells are busy`
  const text = `${shells} — close the ${pane ? 'pane' : 'session'} anyway?`

  return (
    <div aria-label={text} className="imsg-it-row__prompt" role="alertdialog">
      <span>{text}</span>
      <button onClick={() => confirmItClose()} type="button">
        {LABELS.close}
      </button>
      <button autoFocus onClick={() => dismissItClose()} type="button">
        {LABELS.keep}
      </button>
    </div>
  )
}

/** The pane tools of the terminal's tab rail (hidden in this window): split and zoom. */
function ItPaneTools({ workspaceId }: { workspaceId: string }) {
  // canSplitItPane reads the measured body; a resize can change the answer.
  useStore($itBodySize)
  const canRight = canSplitItPane(workspaceId, 'h')
  const canDown = canSplitItPane(workspaceId, 'v')

  return (
    <div aria-label={LABELS.panes} className="imsg-it-tools" role="toolbar">
      <SideButton disabled={!canRight} label={LABELS.splitRight} onClick={() => splitItPane(workspaceId, 'h')}>
        <Columns2 size={14} strokeWidth={1.75} />
      </SideButton>
      <SideButton disabled={!canDown} label={LABELS.splitDown} onClick={() => splitItPane(workspaceId, 'v')}>
        <Rows2 size={14} strokeWidth={1.75} />
      </SideButton>
      <SideButton label={LABELS.zoom} onClick={() => toggleItZoom(workspaceId)}>
        <Maximize2 size={13} strokeWidth={1.75} />
      </SideButton>
    </div>
  )
}
