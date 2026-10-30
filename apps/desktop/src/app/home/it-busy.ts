import { screenLooksIdle } from './it-cli-args'
import { readTerminalById } from './it/engine/buffer'

/** Shells among `terminalIds` that do not look idle (no prompt on screen). A
 *  pane whose PTY never started has no screen and is idle by definition. The
 *  pane ×, ⌘W and the rail's workspace close all ask this before closing. */
export function busyShellCount(terminalIds: Iterable<string>): number {
  let busy = 0

  for (const id of terminalIds) {
    const read = readTerminalById(id)

    if (read && !screenLooksIdle(read.text)) {
      busy += 1
    }
  }

  return busy
}
