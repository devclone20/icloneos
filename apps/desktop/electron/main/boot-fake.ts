// Fake boot mode: scripted boot progress and failure for UI tests (HERMES_DESKTOP_BOOT_FAKE*).

import { codePathEnv } from '../packaged-env'

export const BOOT_FAKE_MODE = codePathEnv('HERMES_DESKTOP_BOOT_FAKE') === '1' // iclone-seam: p7-env

export const BOOT_FAKE_ERROR = codePathEnv('HERMES_DESKTOP_BOOT_FAKE_ERROR') || '' // iclone-seam: p7-env

export const BOOT_FAKE_STEP_MS = (() => {
  const raw = Number.parseInt(String(process.env.HERMES_DESKTOP_BOOT_FAKE_STEP_MS || ''), 10)

  if (!Number.isFinite(raw) || raw <= 0) {
    return 650
  }

  return Math.max(120, raw)
})()
