/**
 * v0.0.9 F4 — the words of the one notification system: the toast stack, the notification centre (the bell in the
 * titlebar), the status banner and the inline alert. English only (the app ships English); imported directly.
 */
export const f4Notes = {
  /** The single toast region's landmark name. */
  region: 'Recent notifications',
  close: 'Close notification',
  /** Shown under a toast whose words do not fit three lines, or that carries more detail: opens the centre entry. */
  // r5 (design R5-2): the toast's way to the full entry is the same disclosure as everywhere else.
  more: 'Details',
  /** "+N in Notifications": toasts the stack cap moved into the centre. */
  overflow: (count: number) => `+${count} in Notifications`,
  kind: {
    error: 'Error',
    info: 'Notice',
    success: 'Done',
    warning: 'Warning'
  }
}

export const f4Centre = {
  /** r4d (design r4 F4-1): identical plain notices merged into one entry. */
  repeated: (n: number) => `×${n}`,
  title: 'Notifications',
  /** The bell's name in the titlebar; the unread count rides along for assistive tech. */
  tool: (unread: number) => (unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'),
  close: 'Close notifications',
  clearAll: 'Clear all',
  empty: 'Nothing yet. Notices, errors and finished work collect here.',
  today: 'Today',
  yesterday: 'Yesterday',
  earlier: 'Earlier',
  what: 'What happened',
  why: 'Why',
  next: 'What to do',
  detail: 'Details',
  copyDetail: 'Copy detail',
  copyDetailFailed: 'Could not copy the detail',
  remove: 'Remove from notifications',
  /** The count line under the title. */
  // v0.0.9 r4 (design r3 F4 b): an empty centre says "No notifications", never "0 notifications".
  count: (n: number) => `${n === 0 ? 'No' : n} ${n === 1 ? 'notification' : 'notifications'} · last 200 kept`,
  fromNative: 'Sent while the app was in the background'
}

export const f4Banner = {
  showDetails: 'Details',
  collapse: 'Collapse',
  expand: 'Expand'
}
