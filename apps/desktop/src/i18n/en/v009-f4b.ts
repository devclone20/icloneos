/**
 * v0.0.9 F4b — words for the second half of the notification system: the explicit refusal on blocking prompts, the
 * centre's memory note, and the in-app decision dialogs that replace the main process's native message boxes while a
 * window exists. English only (the app ships English); imported directly.
 */
export const f4bPrompts = {
  /** The explicit refusal on a blocking credential prompt (sudo password, skill secret). Esc does the same. */
  notNow: 'Not now'
}

export const f4bCentre = {
  /** Under the centre title: where the history lives and when it goes. */
  memoryNote: 'Kept in memory on this device only. Cleared when the app restarts or reloads.',
  memoryTipLabel: 'Where notifications are kept'
}

export const f4bBanner = {
  /** The status banner's ✕, offered only where the owner may put the reminder away (billing, provider, display). */
  dismiss: 'Dismiss'
}
