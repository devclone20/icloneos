/**
 * MCP — the output channel under the editor (E3 decision #8). Lifted out of
 * `mcp-tab.tsx`; the stdio section filter now lives in `servers.ts`.
 */
import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { LogTail } from '@/components/chat/log-tail'
import { getLogs } from '@/hermes'
import { $activeGatewayProfile } from '@/store/profile'

import { filterStdioSections } from './servers'

const LOG_POLL_MS = 2000

// The MCP output channel — Cursor's "MCP Logs" equivalent, pinned under the
// editor. Scope follows the cursor-selected server (all servers otherwise);
// source controls live in the pane header. Body is the app's tool-output
// surface: CodeCardBody typography + the floating hover-reveal copy button.
export function McpLogs({
  emptyLabel,
  server,
  source
}: {
  emptyLabel: string
  server: null | string
  source: 'stdio' | 'agent'
}) {
  const [lines, setLines] = useState<null | string[]>(null)
  // A profile switch reroutes getLogs to the new backend; keying the effect on
  // the active profile tears down the old poll (its `cancelled` flag blocks a
  // late setLines) so profile A's logs never flash in B.
  const activeProfile = useStore($activeGatewayProfile)

  useEffect(() => {
    let cancelled = false

    const poll = async () => {
      try {
        const response =
          source === 'stdio'
            ? await getLogs({ file: 'mcp', lines: 500 })
            : await getLogs({ file: 'agent', lines: 300, search: server ?? 'mcp' })

        if (!cancelled) {
          setLines(source === 'stdio' && server ? filterStdioSections(response.lines, server) : response.lines)
        }
      } catch {
        // Backend momentarily unavailable — keep the last tail.
      }
    }

    setLines(null)
    void poll()
    const timer = window.setInterval(() => void poll(), LOG_POLL_MS)

    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [server, source, activeProfile])

  return <LogTail emptyLabel={emptyLabel} lines={lines} />
}
