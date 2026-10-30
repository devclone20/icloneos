/**
 * REL-6 — the window's door to the ACP tools installer. Every channel passes the app sender guard (P7, required: no
 * guard refuses everything). Installing is an `I` (install) action under V3-F: it needs main's own gesture verdict for
 * THAT sender (the preload's `data-acp-tools-confirm` lock + real input), it is written to the permission audit before
 * anything is fetched, and no agent path reaches it — the agent's socket has no install verb, and every ACP path the
 * agent can reach only refuses while the tools are absent.
 */
import type { AcpToolsInstallResult, AcpToolsView } from '../../src/iclone-shared/acp-tools'
import { guardedHandler } from '../iclone-consent'
import type { ConsentSenderGuard } from '../iclone-consent'

import type { AcpTools } from './installer'

interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: any[]) => unknown): void
}

/** What the install decision records in V3-F's audit (src `install`, class `I`). Null: the audit is not up. */
export type InstallAuditSink = (entry: { kind: 'refuse' | 'use'; reason: string; gesture: boolean }) => unknown

export interface AcpToolsIpcDeps {
  ipcMain: IpcMainLike
  isTrustedSender: ConsentSenderGuard | undefined
  tools: AcpTools
  gestureOk(event: unknown, input: unknown): boolean
  /** V3-F's audit; an install is refused when it cannot be recorded. */
  audit: InstallAuditSink
  /** Opens a fixed file the renderer can only name by kind (never by path). */
  openFile(file: string): Promise<unknown>
  /** THIRD_PARTY_NOTICES.md shipped with this build. */
  appNotices: string
}

export async function requestInstall(
  deps: Pick<AcpToolsIpcDeps, 'tools' | 'audit'>,
  gesture: boolean
): Promise<AcpToolsInstallResult> {
  const pinned = deps.tools.cliVersion() ?? 'unknown'

  if (!gesture) {
    deps.audit({ kind: 'refuse', reason: `acp tools: install ${pinned} without the owner's own click`, gesture: false })

    return { ok: false, error: 'gesture' }
  }

  if (deps.tools.view().state === 'installing') {
    return { ok: false, error: 'busy' }
  }

  if (
    deps.audit({ kind: 'use', reason: `acp tools: the owner asked to install ${pinned} from npm`, gesture: true }) ===
    null
  ) {
    return { ok: false, error: 'audit' }
  }

  const answer = await deps.tools.install()

  if (answer.ok) {
    return answer
  }

  if (answer.cancelled === true) {
    return { ok: false, error: 'cancelled' }
  }

  // A code and its data, never a sentence (critic m4): the window composes the words in its locale.
  return answer.subject === undefined
    ? { ok: false, error: 'failed', reason: answer.reason }
    : { ok: false, error: 'failed', reason: answer.reason, subject: answer.subject }
}

export function registerAcpToolsIpc(deps: AcpToolsIpcDeps): void {
  const ipcMain = guardedHandler(deps.ipcMain, deps.isTrustedSender)

  ipcMain.handle('iclone:acp-tools:state', async (): Promise<AcpToolsView> => {
    const view = deps.tools.view()

    return view.state === 'checking' ? deps.tools.refresh() : view
  })
  ipcMain.handle('iclone:acp-tools:check', (): Promise<AcpToolsView> => deps.tools.refresh())
  ipcMain.handle('iclone:acp-tools:install', (event, input) => requestInstall(deps, deps.gestureOk(event, input)))
  // Doing less never needs a gesture.
  ipcMain.handle('iclone:acp-tools:cancel', () => deps.tools.cancel())
  ipcMain.handle('iclone:acp-tools:open-notices', async (_event, input) => {
    const which = (input as Record<string, unknown> | null)?.which
    const file = which === 'installed' ? deps.tools.noticesFile() : which === 'app' ? deps.appNotices : null

    if (!file) {
      return false
    }

    await deps.openFile(file)

    return true
  })
}
