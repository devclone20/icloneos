import { atom } from 'nanostores'

import { registry } from '@/contrib/registry'

/**
 * iclone os — the wallet as a NATIVE titlebar tool.
 *
 * Owner rule: the wallet lives in the top-right titlebar button group as one
 * of them — icon only, no name, no address, signed in or not. Clicking it
 * opens the balances panel when a session exists, or starts the Privy login
 * when none does. Registered on `titleBar.tools.right` like the theme tool;
 * `order: 1` keeps it beside the theme glyph and before page-registered
 * groups (which start at order 100).
 */
import { IcWallet } from './iclone-icons'
import { $privySession, openPrivyLogin } from './privy-session'
import { $toolsCopy } from './tools-copy'

/** Shared open state — the tool toggles it, home-view renders the panel. */
export const $walletPanelOpen = atom(false)

export function hideWalletPanel() {
  $walletPanelOpen.set(false)
}

function onWalletToolSelect() {
  if ($privySession.get().status === 'in') {
    $walletPanelOpen.set(!$walletPanelOpen.get())
  } else {
    openPrivyLogin()
  }
}

/** The label carries the moment-of-choice: the same glyph signs you in or
 *  opens balances depending on the session, and the tooltip should say which
 *  BEFORE the click, the way the browser eye does. */
function walletLabel(): string {
  const copy = $toolsCopy.get()

  return $privySession.get().status === 'in' ? copy.walletBalances : copy.walletSignIn
}

let dispose: (() => void) | null = null

function publish() {
  dispose?.()
  dispose = registry.register({
    id: 'iclone-wallet',
    area: 'titleBar.tools.right',
    order: 1,
    data: {
      // Active while its panel is open — the browser eye and the recording
      // disc light up on the same contract; the wallet was the odd one out.
      active: $walletPanelOpen.get(),
      id: 'iclone-wallet',
      label: walletLabel(),
      icon: <IcWallet size={16} strokeWidth={1.7} />,
      onSelect: onWalletToolSelect,
      title: walletLabel()
    }
  })
}

let registered = false

/** Idempotent — wiring imports this module once per window. */
export function registerIcloneWalletTool() {
  if (registered) {
    return
  }

  registered = true
  publish()
  $walletPanelOpen.subscribe(publish)
  $privySession.subscribe(publish)
  $toolsCopy.listen(publish)
}
