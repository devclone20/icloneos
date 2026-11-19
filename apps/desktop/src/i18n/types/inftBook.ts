export type InftBookTranslations = {
  navLabel: string
  keywords: readonly string[]
  rule: string
  openBook: string
  wallet: (address: string) => string
  count: (total: number, onHome: number) => string
  rescan: string
  search: string
  filterCollection: string
  allCollections: string
  filterChain: string
  allChains: string
  filterState: string
  stateAll: string
  stateChecked: string
  stateUnchecked: string
  checkShown: string
  uncheckShown: string
  confirmTitle: (count: number) => string
  confirmBody: string
  confirmAction: string
  confirmBusy: string
  confirmDone: string
  confirmError: string
  cancel: string
  scanning: (found: number) => string
  partial: (loaded: number) => string
  /** v0.0.9 r4b: the partial line while a filter is on — what is shown of what loaded. */
  partialFiltered: (shown: number, loaded: number) => string
  capped: (limit: number) => string
  retry: string
  kept: (count: number) => string
  dismiss: string
  noWallet: string
  signIn: string
  none: string
  /** v0.0.9 r4 (design r3 N5): the empty Book's next step. */
  noneHint: string
  noMatch: string
  scanFailed: string
  /** v0.0.9 r4 (design r3 N5): what failed and who — the indexer or the network — and that the wallet is unchanged. */
  scanFailedCause: string
  /** The wallet scan's sender was refused by main (K21): shown on Home and in iNFT setup. */
  scanRefused: string
  showOnHome: (name: string) => string
  /** The Book card's status mark, read aloud and in the tooltip: the iNFT is set up (Virtuals CLI configured). */
  setUp: string
  /** The Book card's status mark: the iNFT still needs setup. */
  setupNeeded: string
  homeEmpty: string
}
