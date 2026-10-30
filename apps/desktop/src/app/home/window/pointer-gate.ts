/** Below this a window's surface is invisible AND hit-transparent (a
 * deliberate live gesture). The restore floor for the Message window sits
 * here so the app never boots into an invisible, click-through chat. */
export const MIN_INTERACTIVE = 0.06
