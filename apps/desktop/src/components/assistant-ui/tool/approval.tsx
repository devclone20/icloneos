'use client'

import { useStore } from '@nanostores/react'
import { type FC, useEffect, useMemo, useState } from 'react'

import { useSessionView } from '@/app/chat/session-view'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { AlertCircle, ChevronDown } from '@/lib/icons'
import { cn } from '@/lib/utils'
import {
  type ApprovalRequest,
  registerApprovalInlineAnchor,
  sessionApprovalInlineVisible,
  sessionApprovalRequest
} from '@/store/prompts'

import type { ToolPart } from './fallback-model'

// Inline approval control. Rendered as a compact button strip
// under the pending tool row that raised the approval (the row already shows
// the command, so the strip deliberately doesn't repeat it) instead of as a
// modal overlay.
//
// Binding is POSITIONAL, not command-matched: the desktop `tool.start` payload
// carries no structured args (only tool_id/name/context — see
// tui_gateway/server.py::_on_tool_start), so we cannot join the approval to the
// row by command string. `approval.request` can fire from the command guards
// and protected-instruction file writes. The agent thread blocks on exactly one
// approval at a time, so the single pending row of those tools IS the row that
// raised it. The command/description text comes from `$approvalRequest` (the
// event payload), which is the only place that data reliably exists.
export const APPROVAL_TOOLS = new Set(['terminal', 'execute_code', 'patch', 'write_file'])

export const PendingToolApproval: FC<{ part: ToolPart }> = ({ part }) => {
  // The tool row lives in whichever session's transcript rendered it — read
  // THAT session's approval (works for the primary and every tile).
  const sessionId = useStore(useSessionView().$runtimeId)
  const $request = useMemo(() => sessionApprovalRequest(sessionId), [sessionId])
  const request = useStore($request)

  if (!request || !APPROVAL_TOOLS.has(part.toolName)) {
    return null
  }

  return <InlineApprovalBar request={request} />
}

const InlineApprovalBar: FC<{ request: ApprovalRequest }> = ({ request }) => {
  useEffect(() => registerApprovalInlineAnchor(request.sessionId), [request.sessionId])

  return <ApprovalBar request={request} surface="inline" />
}

export const PendingApprovalFallback: FC = () => {
  const { t } = useI18n()
  const sessionId = useStore(useSessionView().$runtimeId)
  const $request = useMemo(() => sessionApprovalRequest(sessionId), [sessionId])
  const $inlineVisible = useMemo(() => sessionApprovalInlineVisible(sessionId), [sessionId])
  const request = useStore($request)
  const inlineVisible = useStore($inlineVisible)

  if (!request || inlineVisible) {
    return null
  }

  return (
    <div
      className="pointer-events-none absolute left-1/2 z-30 w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2"
      data-slot="tool-approval-fallback"
      style={{ bottom: 'calc(var(--composer-measured-height) + 0.875rem)' }}
    >
      <div className="pointer-events-auto rounded-xl border border-[color:var(--ic-chat-accent-30)] bg-(--ic-surface-glass) px-3 py-2 shadow-lg backdrop-blur-xl [-webkit-backdrop-filter:blur(1rem)]">
        <div className="flex min-w-0 items-center gap-2 text-sm text-[color:var(--ic-accent)]">
          <AlertCircle className="size-4 shrink-0" />
          <span className="shrink-0 font-medium">{t.assistant.approval.jumpToApproval}</span>
          {request.description && <span className="min-w-0 truncate text-(--ic-text-2)">{request.description}</span>}
        </div>
        <ApprovalBar request={request} surface="floating" />
      </div>
    </div>
  )
}

/**
 * V3-F §3: the strip under the tool row is a pointer, never an answer. The permission is answered on the sheet main
 * owns (the window relays the Hermes request there — store/prompts.ts); this only says so and shows the command.
 */
const ApprovalBar: FC<{ request: ApprovalRequest; surface: 'floating' | 'inline' }> = ({ request, surface }) => {
  const { t } = useI18n()
  const copy = t.assistant.approval
  const [showCommand, setShowCommand] = useState(false)
  const hasCommand = request.command.trim().length > 0

  return (
    <div
      className={cn(surface === 'inline' ? 'mt-1 ps-5' : 'mt-2')}
      data-slot={surface === 'inline' ? 'tool-approval-inline' : 'tool-approval-actions'}
    >
      <div className="flex items-center gap-2.5">
        <span className="text-xs text-[color:var(--ic-accent)]" data-slot="tool-approval-pointer">
          {t.settings.permissions.approvalPointer}
        </span>

        {hasCommand && (
          <Button
            aria-expanded={showCommand}
            className="h-6 gap-1 rounded-md px-1.5 text-xs font-normal text-(--ic-text-2) hover:text-[color:var(--ic-text-1)]"
            onClick={() => setShowCommand(value => !value)}
            size="xs"
            variant="ghost"
          >
            {copy.command}
            <ChevronDown className={cn('size-3 transition-transform', showCommand && 'rotate-180')} />
          </Button>
        )}
      </div>

      {showCommand && hasCommand && (
        <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-(--ic-border-strong) bg-(--ic-surface-glass) px-2.5 py-1.5 font-mono text-xs leading-snug text-[color:var(--ic-text-1)]">
          {request.command.trim()}
        </pre>
      )}
    </div>
  )
}
