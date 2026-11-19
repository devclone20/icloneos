/**
 * Where a runtime check reports its steps (v0.0.9 pass 4, fleet-profile-rail :320). Only the PRIMARY backend's boot
 * owns the global boot progress the window shows. A pool (secondary) backend reports nowhere: a write would turn a
 * ready app back into "booting", and restoring "ready" afterwards would flicker. The owner's clean form: no channel.
 */
import { advanceBootProgress, updateBootProgress } from './boot-progress'

export interface RuntimeProgress {
  advance: typeof advanceBootProgress
  update: typeof updateBootProgress
}

const SILENT: RuntimeProgress = {
  advance: async () => undefined,
  update: () => undefined
}

const PRIMARY: RuntimeProgress = { advance: advanceBootProgress, update: updateBootProgress }

/** The primary's boot progress, or no channel at all for a pool backend. */
export function runtimeProgress(reportBootProgress: boolean): RuntimeProgress {
  return reportBootProgress ? PRIMARY : SILENT
}
