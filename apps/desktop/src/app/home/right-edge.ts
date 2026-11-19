/**
 * The right edge holds ONE island at a time.
 *
 * The iNFT collection and FILES are laid out on the same rect (top 56, right
 * 12, bottom 28), so two open at once are two islands on the same pixels.
 * They are made mutually exclusive where they are opened; this module is the
 * other half — an open island publishes itself on <html> so the chrome it
 * lands on can step aside:
 *
 *   - the Message window's controls (close · expand · opacity) shift left of
 *     the island instead of vanishing under it, which left the window with no
 *     way to close while FILES was open;
 *   - the iNFT pull tab gets out of the way instead of ghosting through the
 *     frost.
 */
export function claimRightEdge(owner: string, widthCss: string): () => void {
  const root = document.documentElement

  root.dataset.icloneIsland = owner
  root.style.setProperty('--iclone-island-w', widthCss)

  return () => {
    // Ownership-checked: if the other island claimed the edge while this one
    // was still closing, that newer claim has to survive this cleanup.
    if (root.dataset.icloneIsland !== owner) {
      return
    }

    delete root.dataset.icloneIsland
    root.style.removeProperty('--iclone-island-w')
  }
}

/**
 * v0.0.9 F4: the other half of "one island at a time" for islands that open from different places (FILES from the
 * dock, the iNFT collection from its tab, the notification centre from the titlebar bell). While `owner` is open,
 * another island claiming the edge closes it: `onTaken` runs once that claim lands. Returns the disposer.
 */
export function watchRightEdge(owner: string, onTaken: () => void): () => void {
  const root = document.documentElement

  if (typeof MutationObserver === 'undefined') {
    return () => undefined
  }

  const observer = new MutationObserver(() => {
    const holder = root.dataset.icloneIsland

    if (holder && holder !== owner) {
      onTaken()
    }
  })

  observer.observe(root, { attributeFilter: ['data-iclone-island'], attributes: true })

  return () => observer.disconnect()
}
