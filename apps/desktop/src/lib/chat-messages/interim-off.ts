/**
 * `display.interim_assistant_messages: false` in the desktop transcript (v0.0.9 pass 4, the lead's ruling).
 *
 * The runtime honours the key: with it off no `message.interim` is ever emitted (tui_gateway/server.py:384). But the
 * text a model streams beside its tool calls still arrives as `message.delta`, and the renderer keeps it as text parts
 * between the tool parts of the turn's bubble, so the commentary the user turned off stayed on screen. When the turn
 * completes with the key off, this drops exactly that: the text parts of the turn that come BEFORE its last tool call.
 * The final answer (the text after the last tool call) is never touched, nor is a turn without tool calls, nor any
 * earlier turn.
 */
import type { ChatMessage } from './types'

export function dropPreToolStreamedText(messages: ChatMessage[]): ChatMessage[] {
  const lastUser = messages.findLastIndex(message => message.role === 'user')
  const turn = messages.slice(lastUser + 1)

  // The position of the turn's last tool call, across the turn's assistant messages in order.
  let lastTool: [number, number] | null = null

  turn.forEach((message, m) => {
    if (message.role !== 'assistant') {
      return
    }

    message.parts.forEach((part, p) => {
      if (part.type === 'tool-call') {
        lastTool = [m, p]
      }
    })
  })

  if (lastTool === null) {
    return messages
  }

  const [toolMessage, toolPart] = lastTool as [number, number]
  let changed = false

  const settled = turn.map((message, m) => {
    if (message.role !== 'assistant' || m > toolMessage) {
      return message
    }

    const parts = message.parts.filter((part, p) => {
      const beforeLastTool = m < toolMessage || p < toolPart

      return !(part.type === 'text' && beforeLastTool)
    })

    if (parts.length === message.parts.length) {
      return message
    }

    changed = true

    return { ...message, parts }
  })

  return changed ? [...messages.slice(0, lastUser + 1), ...settled] : messages
}

/** The same drop for every turn of a transcript (a resume, a re-read after the turn: one row per turn, merged). */
export function dropPreToolStreamedTextInEveryTurn(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []
  let turn: ChatMessage[] = []

  const flush = () => {
    out.push(...dropPreToolStreamedText(turn))
    turn = []
  }

  for (const message of messages) {
    if (message.role === 'user') {
      flush()
    }

    turn.push(message)
  }

  flush()

  return out
}
