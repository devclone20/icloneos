import { fileURLToPath } from 'node:url'

import { BrowserWindow } from 'electron'

// IPC that reaches a shell (terminal) must only come from the app's own
// renderer: the top frame of a real BrowserWindow, on the renderer's own URL.
// That excludes <webview> guests, subframes (embeds, previews), and windows
// that load remote pages with their own preload (the Privy sign-in window).

const LOG_TAG = '[iclone-ipc-sender]'

interface SenderFrameLike {
  url: string
}

interface SenderContentsLike {
  getType?: () => string
  isDestroyed?: () => boolean
  mainFrame?: unknown
}

export interface IpcSenderEventLike {
  sender: SenderContentsLike
  senderFrame?: (SenderFrameLike & object) | null
}

interface AppSenderGuardOptions {
  devServer?: string
  rendererIndexPath: () => string
  log: (line: string) => void
  hasOwnerWindow?: (sender: SenderContentsLike) => boolean
}

export function isAppRendererUrl(rawUrl: string, devServer: string | undefined, rendererIndexPath: string): boolean {
  let url: URL

  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }

  if (devServer) {
    try {
      return url.origin === new URL(devServer).origin
    } catch {
      return false
    }
  }

  if (url.protocol !== 'file:') {
    return false
  }

  try {
    return fileURLToPath(url) === rendererIndexPath
  } catch {
    return false
  }
}

function defaultHasOwnerWindow(sender: SenderContentsLike): boolean {
  return BrowserWindow.fromWebContents(sender as Electron.WebContents) !== null
}

export function createAppSenderGuard({
  devServer,
  rendererIndexPath,
  log,
  hasOwnerWindow = defaultHasOwnerWindow
}: AppSenderGuardOptions): (event: IpcSenderEventLike, channel: string) => boolean {
  log(`${LOG_TAG} guard active (${devServer ? 'dev server origin' : 'renderer index file'})`)

  return (event, channel) => {
    const { sender, senderFrame } = event

    const trusted =
      senderFrame != null &&
      sender.isDestroyed?.() !== true &&
      sender.getType?.() === 'window' &&
      senderFrame === sender.mainFrame &&
      hasOwnerWindow(sender) &&
      isAppRendererUrl(senderFrame.url, devServer, rendererIndexPath())

    if (!trusted) {
      log(`${LOG_TAG} refused ${channel} from ${sender.getType?.() ?? 'unknown'} sender`)
    }

    return trusted
  }
}
