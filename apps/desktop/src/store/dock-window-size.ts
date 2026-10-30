import { type Codec, persistentAtom } from '@/lib/persisted'

/** How a window opens from the Dock: filling the app (the default) or on the one fixed window rect. */
export type DockWindowSize = 'maximized' | 'normal'

const STORAGE_KEY = 'hermes.desktop.dockWindowSize.v1'

// Only a stored 'normal' opts out: a missing or damaged record opens the windows maximized, the product default.
const sizeCodec: Codec<DockWindowSize> = {
  decode: raw => (raw === 'normal' ? 'normal' : 'maximized'),
  encode: value => value
}

export const $dockWindowSize = persistentAtom<DockWindowSize>(STORAGE_KEY, 'maximized', sizeCodec)

export function setDockWindowSize(size: DockWindowSize) {
  $dockWindowSize.set(size)
}
