import { type ToolCallMessagePartProps } from '@assistant-ui/react'
import { type FC } from 'react'

import { AGENT_MESSAGE_RE, useAgentAvatar } from '@/components/assistant-ui/thread/user-message'

// Sender-side inter-agent delivery: `hermes -p <agent> chat … -q "Message
// from 🤖 <sender>…"` run through the terminal tool IS the messaging
// pipeline (the Bot Mode / multi-profile convention shipped with #85855).
// Rendering it as a terminal transcript makes the sending bot's chat read
// like ops tooling; the user-facing truth is "Messaged X" and, when the
// quiet run returns the recipient's reply, "Message from X" — the same
// compact event notices the receiving chat shows.
const DELIVERY_COMMAND_RE =
  /(?:^|[;&|]\s*|\bhermes\s+)-p\s+("?)([a-z0-9][a-z0-9_-]{0,63})\1\s+chat\b[\s\S]*?-q\s+["']Message from/iu

export function deliveryTargetFromCommand(command: string): null | string {
  const match = DELIVERY_COMMAND_RE.exec(command)

  return match ? match[2].toLowerCase() : null
}

/** Extract the recipient's reply text from the terminal result payload. */
export function replyTextFromResult(result: unknown): string {
  const container = (result ?? {}) as { content?: unknown; output?: unknown }
  let raw = ''

  if (typeof result === 'string') {
    raw = result
  } else if (typeof container.output === 'string') {
    raw = container.output
  } else if (Array.isArray(container.content)) {
    raw = container.content
      .map(entry => (typeof (entry as { text?: unknown })?.text === 'string' ? (entry as { text: string }).text : ''))
      .join('\n')
  }

  // Terminal results may be JSON-wrapped: {"output": "...", "exit_code": 0}
  if (raw.trimStart().startsWith('{')) {
    try {
      const parsed = JSON.parse(raw) as { output?: unknown }

      if (typeof parsed.output === 'string') {
        raw = parsed.output
      }
    } catch {
      /* not JSON — use as-is */
    }
  }

  // Drop session_id bookkeeping lines; what remains is the reply.
  return raw
    .split('\n')
    .filter(line => !/^session_id:\s/.test(line.trim()))
    .join('\n')
    .trim()
}

const NOTICE_CLASS =
  'flex max-w-[min(86%,44rem)] flex-col gap-0.5 self-center px-2 py-0.5 text-[0.6875rem] leading-5 text-[color:var(--ic-chat-2-60)]'

const AgentGlyph: FC<{ handle: string }> = ({ handle }) => {
  const avatar = useAgentAvatar(handle)

  return avatar ? (
    <img alt="" aria-hidden className="size-4 shrink-0 rounded-full object-cover" src={avatar} />
  ) : (
    <span aria-hidden className="text-[0.8125rem] leading-none">
      🤖
    </span>
  )
}

/** "Messaged X" (+ "Message from X" once the reply lands) for a delivery
 *  command run via the terminal tool. Returns null when the command is not
 *  a delivery — caller falls through to the normal terminal row. */
export const AgentDeliveryNotice: FC<ToolCallMessagePartProps> = props => {
  const command = typeof props.args?.command === 'string' ? props.args.command : ''
  const target = deliveryTargetFromCommand(command)

  if (!target || props.isError) {
    return null
  }

  const pending = props.result === undefined
  const reply = pending ? '' : replyTextFromResult(props.result)
  // Strip a leading agent-message prefix if the recipient echoed one back.
  const replyBody = AGENT_MESSAGE_RE.exec(reply)?.[4] ?? reply

  return (
    <div className="flex w-full min-w-0 flex-col items-stretch gap-0.5">
      <div className={NOTICE_CLASS} data-slot="aui_agent-delivery-notice">
        <span className="flex items-center justify-center gap-1.5">
          <AgentGlyph handle={target} />
          <span className="wrap-anywhere">
            {pending ? 'Messaging' : 'Messaged'} {target}
            {pending ? '…' : ''}
          </span>
        </span>
      </div>
      {!pending && replyBody && (
        <div className={NOTICE_CLASS} data-slot="aui_agent-reply-notice">
          <span className="flex items-center justify-center gap-1.5">
            <AgentGlyph handle={target} />
            <span className="wrap-anywhere">Message from {target}</span>
          </span>
          <details className="self-center">
            <summary className="cursor-pointer select-none text-center text-[color:var(--ic-chat-2-45)] hover:text-[color:var(--ic-chat-2-70)]">
              show message
            </summary>
            <div className="mt-1 max-w-[36rem] whitespace-pre-wrap rounded-lg border border-(--ic-border-strong) px-3 py-2 text-left text-[0.75rem] leading-5 text-[color:var(--ic-chat-1-85)]">
              {replyBody}
            </div>
          </details>
        </div>
      )}
    </div>
  )
}
