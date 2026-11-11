import { type RefObject, useCallback, useLayoutEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { rawOf, visibleSegments } from '@/iclone-shared/one-shot-text'
import type { PermissionDoorScope } from '@/iclone-shared/permissions'
import { cn } from '@/lib/utils'

import type { ConsentDoorPermission, ConsentDoorRequest } from './types'

const TARGET_CLIP = 160

/**
 * A `$` ask is never clipped (V3-J completion): the payment and the mandate it spends under — amount, payee list,
 * budget left, range, expiry — are the decision itself, so every line is on screen before the click, in the same
 * scrolling block. Other classes keep the 160-character preview behind "Show all".
 */
const clips = (permission: ConsentDoorPermission): boolean =>
  !permission.outsideOnce && !permission.outsideFile && permission.cls !== '$' && permission.target.length > TARGET_CLIP

/**
 * S1: the last character of the box has been on screen and nothing runs off its side. A box with no size has shown
 * nothing, so an unmeasured sheet fails to Allow disabled, never to Allow enabled.
 */
const wholeTextShown = (box: HTMLElement): boolean =>
  box.clientHeight > 0 &&
  box.scrollTop + box.clientHeight >= box.scrollHeight - 1 &&
  box.scrollWidth <= box.clientWidth + 1

const KEYCHAIN_OFF_ONCE =
  'Allow covers this one request. The Keychain setting is off, so nothing can be remembered and no longer choice is offered.'

/**
 * V3-F §3 — a permission ask on the consent door's own chassis: who, what (the class and the literal target), why (the
 * agent's words), what happens, and the scope. Deny is focused by the sheet; an answer counts only from a real click
 * on these buttons (the preload's tracker on `data-consent-door-answer`).
 */
export function PermissionAskBody({
  busy,
  denyRef,
  onAnswer,
  permission,
  request
}: {
  busy: boolean
  denyRef: RefObject<HTMLButtonElement | null>
  onAnswer: (choice: 'deny' | PermissionDoorScope, shown?: string) => void
  permission: ConsentDoorPermission
  request: ConsentDoorRequest
}) {
  const copy = useI18n().t.settings.permissions
  const [scope, setScope] = useState<PermissionDoorScope>('once')
  const [expanded, setExpanded] = useState(false)
  const long = clips(permission)
  const target = long && !expanded ? `${permission.target.slice(0, TARGET_CLIP)}…` : permission.target
  const outside = Boolean(permission.outsideOnce || permission.outsideFile)
  const segments = visibleSegments(target, { layout: outside })
  const keychainOnce = permission.keychainOff === true && permission.scopes.length === 1
  // S1: this sheet is the authority for a run outside the Seatbelt, so it has to have shown all of it. Once shown stays
  // shown; a new ask is a new component (door-sheet keys it by id) and starts unread.
  const box = useRef<HTMLPreElement>(null)
  const [read, setRead] = useState(false)
  const waiting = outside && !read

  const measure = useCallback(() => {
    if (box.current && wholeTextShown(box.current)) {
      setRead(true)
    }
  }, [])

  useLayoutEffect(measure, [measure, target])
  const who = [request.inft, permission.subagent].filter(Boolean).join(' · ')

  return (
    <>
      <div className="px-5 pt-5 pb-3" data-permission-ask={permission.cls}>
        <p className="text-[0.6875rem] text-(--ui-text-tertiary)">{copy.ask.eyebrow(who)}</p>
        <h2
          className="mt-1.5 text-[length:var(--conversation-text-font-size)] font-semibold text-(--ic-text-1)"
          id="consent-door-title"
        >
          {copy.ask.title(copy.classes[permission.cls])}
        </h2>
        <p className="mt-1 text-[0.6875rem] text-(--ui-text-tertiary)">
          {copy.ask.mode(copy.modes[permission.mode].name)}
        </p>
        <p className="mt-3 text-[0.6875rem] text-(--ui-text-tertiary)">{copy.ask.targetLabel}</p>
        <pre
          className="mt-1 max-h-40 overflow-auto rounded-(--ic-radius-sm) border border-(--ic-border-subtle) px-2.5 py-1.5 font-mono text-xs leading-snug break-words whitespace-pre-wrap text-(--ic-text-1)"
          data-permission-target=""
          onScroll={outside ? measure : undefined}
          ref={box}
          tabIndex={outside ? 0 : undefined}
        >
          {segments.map((segment, index) =>
            segment.mark ? (
              <span className="text-(--ui-warning,currentColor)" data-permission-mark="" key={index}>
                {segment.shown}
              </span>
            ) : (
              segment.shown
            )
          )}
        </pre>
        {waiting ? (
          <p className="mt-1 text-xs font-medium text-(--ic-text-2)" data-permission-read-first="">
            Scroll to the end of the command. Allow turns on once all of it has been on screen.
          </p>
        ) : null}
        {long ? (
          <Button
            className="mt-1 h-6 px-1.5 text-xs"
            onClick={() => setExpanded(value => !value)}
            size="xs"
            variant="ghost"
          >
            {expanded ? copy.ask.collapse : copy.ask.expand}
          </Button>
        ) : null}
        {permission.outsideOnce ? (
          <p
            className="mt-3 border-l-2 border-(--ui-warning,currentColor) pl-3 text-xs leading-relaxed font-medium text-(--ic-text-2)"
            data-permission-outside-once=""
          >
            Allowing runs this one command outside the Seatbelt, with your full access, together with the programs it
            starts, in <span className="font-mono break-all">{permission.outsideOnce}</span>. It is logged in Activity.
            {scope !== 'once' ? (
              <span className="mt-1 block" data-permission-later-confined="">
                {copy.ask.laterConfined}
              </span>
            ) : null}
          </p>
        ) : null}
        {permission.outsideFile ? (
          <p
            className="mt-3 border-l-2 border-(--ui-warning,currentColor) pl-3 text-xs leading-relaxed font-medium text-(--ic-text-2)"
            data-permission-outside-file=""
          >
            {permission.outsideFileRead
              ? 'Allowing reads this one file once outside the Seatbelt and gives the agent all of it, keys included:'
              : permission.tool === 'patch'
                ? copy.ask.outsideFilePatch
                : 'Allowing writes this one file outside the Seatbelt:'}{' '}
            <span className="font-mono break-all">{permission.outsideFile}</span>. Nothing else in that folder opens. It
            is logged in Activity.
            {permission.outsideFileLink ? (
              <span className="mt-1 block" data-permission-file-link="">
                This is the real file behind the link{' '}
                <span className="font-mono break-all">{permission.outsideFileLink}</span>. The link stays as it is.
              </span>
            ) : null}
            {permission.outsideFileRuns ? (
              <span className="mt-1 block" data-permission-file-runs="">
                {copy.ask.heldFile}
              </span>
            ) : null}
          </p>
        ) : null}
        {permission.credentialFile && !permission.outsideFile ? (
          <p
            className="mt-3 border-l-2 border-(--ui-warning,currentColor) pl-3 text-xs leading-relaxed font-medium text-(--ic-text-2)"
            data-permission-credential-file=""
          >
            {copy.ask.heldFile}
          </p>
        ) : null}
        {permission.credentialRead ? (
          <p
            className="mt-3 border-l-2 border-(--ui-warning,currentColor) pl-3 text-xs leading-relaxed font-medium text-(--ic-text-2)"
            data-permission-credential-read=""
          >
            {copy.ask.heldRead}
          </p>
        ) : null}
        {permission.tool === 'execute_code' ? (
          <p
            className="mt-3 border-l-2 border-(--ui-warning,currentColor) pl-3 text-xs leading-relaxed font-medium text-(--ic-text-2)"
            data-permission-stays-confined=""
          >
            Allowing runs this code inside the Seatbelt. It stays confined: writes outside its folder and the network may
            still be refused. To go outside, the agent has to use a shell command, which you read in full first.
          </p>
        ) : null}
        {permission.project && permission.outsideOnce !== permission.project && permission.tool !== 'computer_use' ? (
          // fx13 (D13, lens3-policy H3): the folder the ask names, on a line of its own — allowing a command here is
          // how the user names a folder in Manual, so the user must see it.
          <p className="mt-2 font-mono text-xs break-all text-(--ic-text-2)" data-permission-project="">
            <span className="text-(--ui-text-tertiary)">{copy.ask.folderLabel} </span>
            {permission.project}
          </p>
        ) : null}
        {request.reason ? (
          <>
            <p className="mt-3 text-[0.6875rem] text-(--ui-text-tertiary)">{copy.ask.reasonLabel}</p>
            <p
              className="mt-1 text-[length:var(--conversation-text-font-size)] break-words text-(--ic-text-1)"
              data-consent-door-reason=""
              id="consent-door-reason"
            >
              {request.reason}
            </p>
          </>
        ) : null}
        <p className="mt-3 text-[0.75rem] leading-4 text-(--ic-text-3)">{copy.ask.effects[permission.cls]}</p>
        {keychainOnce ? (
          <p className="mt-3 text-[0.75rem] leading-4 text-(--ic-text-3)" data-permission-once-only="">
            {KEYCHAIN_OFF_ONCE}
          </p>
        ) : null}
        {permission.scopes.length > 1 ? (
          <div aria-label={copy.ask.scopeLabel} className="mt-3 flex flex-wrap items-center gap-1.5" role="radiogroup">
            <span className="me-1 text-[0.6875rem] text-(--ui-text-tertiary)">{copy.ask.scopeLabel}</span>
            {permission.scopes.map(option => (
              <Button
                aria-checked={scope === option}
                className={cn('h-6 px-2 text-xs', scope === option && 'text-(--ic-text-1)')}
                disabled={busy}
                key={option}
                onClick={() => setScope(option)}
                role="radio"
                size="xs"
                variant={scope === option ? 'outline' : 'ghost'}
              >
                {copy.ask.scopes[option]}
              </Button>
            ))}
          </div>
        ) : null}
        {scope !== 'once' ? (
          <p className="mt-2 text-[0.75rem] leading-4 text-(--ic-text-3)" data-permission-scope-covers={scope}>
            {copy.ask.covers[scope](copy.classes[permission.cls])}
          </p>
        ) : null}
        <p className="mt-3 text-[0.75rem] leading-4 text-(--ui-text-tertiary)">{copy.ask.expires}</p>
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-(--ic-border-subtle) px-5 py-3.5">
        <Button
          data-consent-door-answer="deny"
          disabled={busy}
          onClick={() => onAnswer('deny')}
          ref={denyRef}
          variant="ghost"
        >
          {copy.ask.deny}
        </Button>
        <Button
          data-consent-door-answer={scope}
          disabled={busy || waiting}
          onClick={() => onAnswer(scope, outside ? rawOf(segments) : undefined)}
        >
          {keychainOnce ? 'Allow once' : copy.ask.allow}
        </Button>
      </div>
    </>
  )
}
