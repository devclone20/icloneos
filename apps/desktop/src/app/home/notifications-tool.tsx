import { registry } from '@/contrib/registry'
import { f4Centre } from '@/i18n/en/v009-f4'
import { Bell } from '@/lib/icons'
import { $notificationCentre, $unreadNotifications, toggleNotificationCentre } from '@/store/notifications'

/**
 * v0.0.9 F4 — the bell: the notification centre's door, a NATIVE titlebar tool like the wallet (wallet-tool.tsx).
 * Icon only; a gold dot while something is unread, the count in its accessible name. Pressed while the centre is open.
 * The centre itself is mounted app-wide with the toast stack (components/notifications.tsx).
 */

export const NOTIFICATIONS_TOOL_ID = 'iclone-notifications'

function BellGlyph({ unread }: { unread: number }) {
  return (
    <span className="icn-bell">
      <Bell aria-hidden="true" size={16} />
      {unread > 0 ? <span aria-hidden="true" className="icn-bell__dot" data-testid="bell-unread" /> : null}
    </span>
  )
}

let dispose: (() => void) | null = null

function publish() {
  const unread = $unreadNotifications.get()
  const label = f4Centre.tool(unread)

  dispose?.()
  dispose = registry.register({
    id: NOTIFICATIONS_TOOL_ID,
    area: 'titleBar.tools.right',
    order: 5,
    data: {
      active: $notificationCentre.get().open,
      icon: <BellGlyph unread={unread} />,
      id: NOTIFICATIONS_TOOL_ID,
      label,
      onSelect: toggleNotificationCentre,
      title: label
    }
  })
}

let registered = false

/** Idempotent — FrameTools registers it once per window. */
export function registerIcloneNotificationsTool() {
  if (registered) {
    return
  }

  registered = true
  publish()
  $notificationCentre.listen(publish)
  $unreadNotifications.listen(publish)
}
