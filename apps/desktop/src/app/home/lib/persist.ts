/**
 * iCLONE OS — writes into upstream-owned persisted state, kept in one place.
 *
 * The theme keys are the ones src/themes/context.tsx reads (global slot +
 * per-profile records); the synthetic StorageEvent wakes its ThemeProvider —
 * the proven pattern from the iclone-theme runtime plugin.
 */
import { readKey, writeKey } from '@/lib/storage'

const SKIN_KEY = 'hermes-desktop-theme-v2'
const PROFILE_SKINS_KEY = 'hermes-desktop-profile-themes-v1'
const MODE_KEY = 'hermes-desktop-mode-v1'
const PROFILE_MODES_KEY = 'hermes-desktop-profile-modes-v1'

/** The persisted global skin, or null. */
export function storedSkin(): null | string {
  return readKey(SKIN_KEY)
}

/** Persist `skin` + `mode` globally and for every profile, then wake the
 *  ThemeProvider. Throws on a malformed per-profile record (caller reports). */
export function applySkin(skin: string, mode: 'dark' | 'light'): void {
  writeKey(SKIN_KEY, skin)
  writeKey(MODE_KEY, mode)

  for (const key of [PROFILE_SKINS_KEY, PROFILE_MODES_KEY]) {
    const raw = readKey(key)

    if (!raw) {
      continue
    }

    const record = JSON.parse(raw) as Record<string, string>
    const value = key === PROFILE_SKINS_KEY ? skin : mode

    for (const profile of Object.keys(record)) {
      record[profile] = value
    }

    writeKey(key, JSON.stringify(record))
  }

  window.dispatchEvent(new StorageEvent('storage', { key: SKIN_KEY, newValue: skin, storageArea: window.localStorage }))
}
