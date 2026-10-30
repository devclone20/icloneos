import { type RefObject, useState } from 'react'

import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
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
  permission.cls !== '$' && permission.target.length > TARGET_CLIP

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
  onAnswer: (choice: 'deny' | PermissionDoorScope) => void
  permission: ConsentDoorPermission
  request: ConsentDoorRequest
}) {
  const copy = useI18n().t.settings.permissions
  const [scope, setScope] = useState<PermissionDoorScope>('once')
  const [expanded, setExpanded] = useState(false)
  const long = clips(permission)
  const target = long && !expanded ? `${permission.target.slice(0, TARGET_CLIP)}…` : permission.target
  const who = [request.inft, permission.subagent, permission.session?.slice(0, 12)].filter(Boolean).join(' · ')

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
        >
          {target}
        </pre>
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
        <p className="mt-3 text-[0.6875rem] text-(--ui-text-tertiary)">{copy.ask.reasonLabel}</p>
        <p
          className="mt-1 text-[length:var(--conversation-text-font-size)] break-words text-(--ic-text-1)"
          data-consent-door-reason=""
          id="consent-door-reason"
        >
          {request.reason}
        </p>
        <p className="mt-3 text-[0.75rem] leading-4 text-(--ic-text-3)">{copy.ask.effects[permission.cls]}</p>
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
        <Button data-consent-door-answer={scope} disabled={busy} onClick={() => onAnswer(scope)}>
          {copy.ask.allow}
        </Button>
      </div>
    </>
  )
}
