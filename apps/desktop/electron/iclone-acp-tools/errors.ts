/**
 * REL-6 — a refusal or failure of the ACP tools, as a reason code (src/iclone-shared/acp-tools.ts) and its data. The
 * message is English for the log; the window never shows it (it composes its own words from the code).
 */
import type { AcpToolsProblemInfo, AcpToolsReason } from '../../src/iclone-shared/acp-tools'

import { TarError } from './tar'

export class AcpToolsError extends Error {
  readonly reason: AcpToolsReason
  readonly subject: string | undefined

  constructor(reason: AcpToolsReason, subject?: string, detail?: string) {
    super(`${reason}${subject ? ` (${subject})` : ''}${detail ? `: ${detail}` : ''}`)
    this.name = 'AcpToolsError'
    this.reason = reason
    this.subject = subject
  }
}

/** Any thrown value as a reason code: ours carry one; the tar reader's are `tar-unsafe`; the rest is `internal`. */
export function problemOf(error: unknown, subject?: string): AcpToolsProblemInfo {
  if (error instanceof AcpToolsError) {
    return error.subject === undefined ? { reason: error.reason } : { reason: error.reason, subject: error.subject }
  }

  if (error instanceof TarError) {
    return subject === undefined ? { reason: 'tar-unsafe' } : { reason: 'tar-unsafe', subject }
  }

  const code = (error as { code?: unknown } | null)?.code

  if (typeof code === 'string' && /^E(NOSPC|ACCES|PERM|ROFS|DQUOT|IO|EXIST|NOTDIR|ISDIR)$/.test(code)) {
    return { reason: 'disk' }
  }

  return { reason: 'internal' }
}

export const logText = (error: unknown): string => (error instanceof Error ? error.message : String(error))
