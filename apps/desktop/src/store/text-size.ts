/**
 * The chosen text size, per device. Imported for its side effect before
 * React's first commit (themes/context.tsx), so `<html data-text-size>` is
 * set before anything paints; every open window follows a change through the
 * `storage` event.
 */

import { atom } from 'nanostores'

import { persistString, storedString } from '@/lib/storage'
import { parseTextSize, type TextSize } from '@/lib/text-size'

/** User data on disk: never rename. Local until D2 registers it in ICLONE_STORAGE (home/lib/storage-keys.ts). */
const TEXT_SIZE_STORAGE_KEY = 'iclone.appearance.textSize'

export const $textSize = atom<TextSize>(parseTextSize(storedString(TEXT_SIZE_STORAGE_KEY)))

export function setTextSize(size: TextSize): void {
  persistString(TEXT_SIZE_STORAGE_KEY, size === 'default' ? null : size)
  $textSize.set(size)
}

if (typeof document !== 'undefined') {
  $textSize.subscribe(size => {
    if (size === 'default') {
      delete document.documentElement.dataset.textSize
    } else {
      document.documentElement.dataset.textSize = size
    }
  })

  window.addEventListener('storage', event => {
    if (event.key === TEXT_SIZE_STORAGE_KEY || event.key === null) {
      $textSize.set(parseTextSize(storedString(TEXT_SIZE_STORAGE_KEY)))
    }
  })
}
