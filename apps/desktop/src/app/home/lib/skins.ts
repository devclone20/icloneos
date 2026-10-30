/** iCLONE OS — the iclone skin cycle and the colour mode each skin pairs with. */
export const ICLONE_SKIN_CYCLE = ['iclone-natural', 'iclone-dark', 'iclone-light'] as const

export const ICLONE_SKIN_MODE: Record<string, 'dark' | 'light'> = {
  'iclone-natural': 'dark',
  'iclone-dark': 'dark',
  'iclone-light': 'light'
}
