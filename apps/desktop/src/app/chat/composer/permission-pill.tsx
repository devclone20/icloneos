import { useStore } from '@nanostores/react'
import { useEffect, useId, useRef, useState } from 'react'

import { ModeResetNotice } from '@/components/permissions/mode-reset-notice'
import { Button } from '@/components/ui/button'
import { codiconIcon } from '@/components/ui/codicon'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { releaseTypingFocus } from '@/components/ui/keyboard-first'
import { useI18n } from '@/i18n'
import {
  PERMISSION_MODES,
  type PermissionMode,
  type PermissionStateView,
  type SetModeResultView
} from '@/iclone-shared/permissions'
import { triggerHaptic } from '@/lib/haptics'
import { ChevronDown } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { $confinement, readConfinementOnce } from '@/store/confinement'
import { $permissions, barMode, requestPermissionMode, watchPermissions } from '@/store/permissions'
import { $connection, $currentCwd, $selectedStoredSessionId } from '@/store/session'

import { useComposerScope } from './scope'

const ShieldIcon = codiconIcon('shield')
const CheckIcon = codiconIcon('check')

// L5-10: the menu's two sizes, named once. 13px for the header, 11px for every secondary line (shorts, keys, notes).
const TITLE_TEXT = 'text-[0.8125rem] leading-tight font-medium tracking-tight'
const META_TEXT = 'text-[0.6875rem] leading-snug'

/**
 * A choice main has not answered yet. `against` is the store state it was chosen from, `sessionId` the chat it was made
 * in (L5-08: it never shows in another chat), and `early` whether it may show before main answers: never for Ignore,
 * whose system alert is still asking (L5-02).
 */
interface OptimisticMode {
  answered: boolean
  against: PermissionStateView
  early: boolean
  mode: PermissionMode
  sessionId?: null | string
}

/**
 * F40 - the Message bar's permission mode: a view of the same store as Settings \u203a Agent \u203a Permissions, so a change in
 * either shows in the other when main announces it. Every row carries `data-perm-mode-confirm` and calls main
 * synchronously in its own select or key handler: main refuses without that click or key, and owns the one native alert for
 * Ignore. A remote session's tools do not pass this Mac's modes, so the selector does not claim them there.
 *
 * A1: which session it is comes from the composer it sits in: a tile's selector reads and changes that tile's session,
 * whatever the main pane holds, and is never the empty chat's. Only the main composer follows the selection.
 *
 * U-1: a click shows its mode at once and closes the menu. The shown mode is a guess until main answers: it holds while
 * the request is open and until the store moves past the state it was made against, and a refusal rolls it back and
 * reopens the menu on main's reason. Ignore is the exception (L5-02): main's system alert is asking, so the pill keeps
 * the current mode, marked busy, until the answer. A guess belongs to its chat and is dropped when the chat changes.
 * Rows carry the four-word `short`; the full account is Settings › Agent › Permissions'.
 */
export function PermissionPill({ compact = false, disabled = false }: { compact?: boolean; disabled?: boolean }) {
  const copy = useI18n().t.settings.permissions
  const { state } = useStore($permissions)
  const cwd = useStore($currentCwd)
  const remote = useStore($connection)?.mode === 'remote'
  const verdict = useStore($confinement).state?.verdict
  const composer = useComposerScope().target
  const selected = useStore($selectedStoredSessionId)
  const sessionId = composer.startsWith('tile:') ? composer.slice('tile:'.length) : selected
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<null | string>(null)
  const [optimistic, setOptimistic] = useState<OptimisticMode | null>(null)
  const requestSeq = useRef(0)
  const ids = useId()
  const titleId = `${ids}-title`
  const scopeLineId = `${ids}-scope`

  useEffect(() => (remote ? undefined : watchPermissions(cwd || null, { records: false })), [cwd, remote])

  // L5-08: another chat drops the guess, and an answer still on its way for the old one is ignored.
  // Reset during render when the chat changes (no effect mirroring): the answer handler also checks the seq.
  const [seenSession, setSeenSession] = useState(sessionId)

  if (seenSession !== sessionId) {
    setSeenSession(sessionId)
    setOptimistic(null)
    // Invalidates every answer still on its way for the old chat; a double render only invalidates twice.
    requestSeq.current += 1
  }

  if (remote || !state) {
    return null
  }

  const { inForce: stored, target } = barMode(state, sessionId)
  const live = optimistic !== null && optimistic.sessionId === sessionId ? optimistic : null
  const guessing = live !== null && (!live.answered || live.against === state)
  const showGuess = guessing && Boolean(live?.early || live?.answered)
  const pending = guessing && !showGuess
  const inForce = showGuess && live ? live.mode : stored
  const name = (mode: PermissionMode) => copy.modes[mode].name
  const ignoring = inForce === 'ignore'

  const setMenuOpen = (next: boolean) => {
    setOpen(next)
    setError(null)

    if (next) {
      void readConfinementOnce()
    } else {
      releaseTypingFocus()
    }
  }

  const refuse = (seq: number, reason: string) => {
    if (seq === requestSeq.current) {
      setOptimistic(null)
      setOpen(true)
      setError(reason)
    }
  }

  const settle = (seq: number, result: Promise<SetModeResultView>) =>
    void result.then(
      outcome => {
        if (seq !== requestSeq.current) {
          return
        }

        if (outcome.ok) {
          triggerHaptic('success')
          setOptimistic(current => (current ? { ...current, answered: true } : null))
        } else if (outcome.error === 'confirm') {
          // A cancel on the system alert: nothing changed, nothing to explain.
          setOptimistic(null)
        } else {
          refuse(seq, outcome.error === 'gesture' ? copy.refused.gesture : outcome.message || copy.refused.invalid)
        }
      },
      () => refuse(seq, copy.refused.unavailable)
    )

  // Synchronous from the row's select handler: the preload's proof of the click or key is single use and short.
  const choose = (mode: PermissionMode) => {
    // While Ignore's alert is open, asking for Ignore again would only stack a second request behind it.
    const alreadyAsked = pending && live?.mode === mode

    if (mode !== inForce && !alreadyAsked) {
      const request = requestPermissionMode({ mode, ...target })
      const seq = (requestSeq.current += 1)

      setOptimistic({ answered: false, against: state, early: mode !== 'ignore', mode, sessionId })
      settle(seq, request)
    }

    setMenuOpen(false)
  }

  return (
    <DropdownMenu onOpenChange={setMenuOpen} open={open}>
      <DropdownMenuTrigger asChild>
        <Button
          aria-busy={pending || undefined}
          aria-label={copy.menu.trigger(name(inForce))}
          className={cn(
            'h-(--composer-control-size) min-w-0 shrink gap-1 rounded-md px-1.5 text-xs font-normal',
            'text-(--ic-text-2) transition-opacity duration-150 ease-out hover:bg-(--ic-fill-hover) hover:text-[color:var(--ic-text-1)]',
            ignoring && 'text-(--ic-warning) hover:text-(--ic-warning)',
            // L5-02: the current mode stays, dimmed, while main's Ignore alert is open.
            pending && 'opacity-60'
          )}
          data-permission-mode={inForce}
          data-permission-pending={pending ? '' : undefined}
          data-testid="permission-mode-trigger"
          disabled={disabled}
          type="button"
          variant="ghost"
        >
          {compact ? <ShieldIcon aria-hidden="true" /> : <span className="truncate">{name(inForce)}</span>}
          <ChevronDown aria-hidden="true" className="size-2.5 shrink-0 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-64 p-1"
        data-perm-mode-shortcuts=""
        data-testid="permission-mode-menu"
        onKeyDown={event => {
          if (event.repeat || event.altKey || event.ctrlKey || event.metaKey) {
            return
          }

          // Keys 1 to 5 choose the row. The preload's proof of this key is single use, so this stays synchronous.
          const mode = PERMISSION_MODES[Number(event.key) - 1]

          if (mode) {
            event.preventDefault()
            choose(mode)
          }
        }}
        side="top"
        sideOffset={8}
      >
        {/* L5-06: a real menu label, which also names the mode list, set off from the choices by a divider. */}
        <div className="px-2 pt-1.5 pb-1.5">
          <DropdownMenuLabel className={cn('p-0 text-[color:var(--ic-text-1)]', TITLE_TEXT)} id={titleId}>
            {copy.menu.title}
          </DropdownMenuLabel>
          <p className={cn('pt-0.5 text-(--ic-text-2)', META_TEXT)} data-permission-scope-line="" id={scopeLineId}>
            {target.scope === 'session' ? copy.menu.appliesToSession : copy.menu.appliesToNewChat}
          </p>
          <ModeResetNotice className="pt-1.5" />
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup aria-describedby={scopeLineId} aria-labelledby={titleId} value={inForce}>
          {PERMISSION_MODES.map((mode, index) => {
            const shortId = `${ids}-short-${mode}`

            return (
              <DropdownMenuRadioItem
                aria-describedby={shortId}
                aria-keyshortcuts={String(index + 1)}
                aria-label={name(mode)}
                className={cn(
                  'items-start gap-2 px-2 py-1.5',
                  // L5-09: the highlight is the background; the ring is for the keyboard only.
                  'focus-visible:ring-1 focus-visible:ring-(--ic-text-3) focus-visible:ring-inset',
                  // L5-05: the primitive's own check takes an auto margin and pushes the key off its column; this row
                  // draws its check in a fixed slot instead.
                  '[&>span[data-state]]:hidden'
                )}
                data-perm-mode={mode}
                data-perm-mode-confirm=""
                key={mode}
                onSelect={event => {
                  // The menu closes through `choose`, after the request is on its way with this click's proof.
                  event.preventDefault()
                  choose(mode)
                }}
                value={mode}
              >
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex items-center gap-2">
                    <span className={cn('truncate', mode === 'ignore' && 'text-(--ic-warning)')}>{name(mode)}</span>
                  </span>
                  <span className={cn('truncate text-(--ic-text-2)', META_TEXT)} data-perm-mode-short="" id={shortId}>
                    {copy.modes[mode].short}
                  </span>
                </span>
                <span
                  aria-hidden="true"
                  className="ms-auto flex h-4 w-3 shrink-0 items-center justify-center text-[color:var(--ic-text-1)]"
                  data-perm-mode-check=""
                >
                  {mode === inForce ? <CheckIcon className="text-xs" /> : null}
                </span>
                <span
                  aria-hidden="true"
                  className={cn('w-2 shrink-0 pt-px text-end tabular-nums text-(--ic-text-3)', META_TEXT)}
                  data-perm-mode-key=""
                >
                  {index + 1}
                </span>
              </DropdownMenuRadioItem>
            )
          })}
        </DropdownMenuRadioGroup>
        {state.enforcement === 'not-enforced' ? (
          <p className={cn('px-2 py-1.5 text-(--ic-warning)', META_TEXT)} role="note">
            {copy.enforcement['not-enforced']}
          </p>
        ) : null}
        {ignoring ? (
          // L5-01 (DECISOES_LEAD 11-10): one line. The full account is the Ignore summary in Settings and main's alert.
          <p
            className={cn(
              'px-2 pt-1 pb-1.5',
              META_TEXT,
              verdict === 'green' ? 'text-(--ic-text-2)' : 'text-(--ic-warning)'
            )}
            data-permission-ignore-note={verdict === 'green' ? 'confined' : 'unconfined'}
            role="note"
          >
            {verdict === 'green' ? copy.menu.ignoreNote.confined : copy.menu.ignoreNote.unconfined}
          </p>
        ) : null}
        {error ? (
          <p className={cn('px-2 pb-1.5 text-(--ic-danger)', META_TEXT)} role="alert">
            {error}
          </p>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
