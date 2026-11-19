/**
 * v0.0.9 F5 — the words of the home iNFT Collection panel and the personal wallet popover.
 *
 * English only (the app ships English); imported directly by collections.tsx and wallet-panel.tsx.
 * Every user-facing string of those two surfaces lives here — no literal in their JSX.
 */

// Counts in this locale's own digit grouping (5,000 not 5000), the inftBook.ts idiom.
const n = (value: number): string => value.toLocaleString('en-US')
const plural = (count: number, one: string, many: string): string => `${n(count)} ${count === 1 ? one : many}`

export const f5Collection = {
  /** The right-edge pull tab's word (a brand mark: the same in every locale). */
  tabLabel: 'iNFT',
  title: 'iNFT Collection',
  dialogLabel: 'iNFT Collection',
  close: 'Close the iNFT Collection',
  count: (infts: number, collections: number): string =>
    `${plural(infts, 'iNFT', 'iNFTs')} · ${plural(collections, 'collection', 'collections')}`,
  openBook: 'Open iNFT Book',
  loading: 'Scanning your wallet',
  signedOut: 'Connect a wallet to see your iNFTs',
  connectWallet: 'Connect wallet',
  emptyWallet: 'No iNFTs in this wallet yet.',
  scanFailed: 'The wallet scan failed.',
  /** v0.0.9 r4d (design r4 F5-2): who failed and what it means; the raw scan text sits behind Details. */
  scanFailedCause: 'The iNFT indexer or the network did not answer, so nothing could be read. Your wallet is unchanged.',
  details: 'Details',
  hideDetails: 'Hide details',
  /** r4d (design r4 F5-3): one verb for the same action across the Collection and the iNFT Book. */
  retry: 'Rescan',
  partial: (missing: readonly string[]): string =>
    missing.length > 0
      ? `Some collections could not be read: ${missing.join(', ')}. The iNFTs below are the ones that loaded.`
      : 'Some collections could not be read. The iNFTs below are the ones that loaded.',
  partialCause: (cause: string): string =>
    `Some collections could not be read (${cause.trim().replace(/[.\s]+$/, '')}). The iNFTs below are the ones that loaded.`,
  cardLabel: (name: string, collection: string): string => `${name} — ${collection}`,
  economyOs: 'EconomyOS',
  setupNeeded: 'Setup needed',
  tokenId: 'Token',
  chain: 'Chain',
  contract: 'Contract',
  copy: 'Copy',
  copyContract: (contract: string): string => `Copy contract ${contract}`,
  copied: 'Copied',
  copyFailed: "Couldn't copy",
  open: 'Open',
  openLabel: (name: string): string => `Open ${name}`,
  setUp: 'Set up in EconomyOS'
} as const

export const f5Wallet = {
  dialogLabel: 'Wallet',
  title: 'Wallet',
  copy: 'Copy',
  copyAddress: 'Copy wallet address',
  copied: 'Copied',
  copyFailed: "Couldn't copy",
  accountEmbedded: 'Privy embedded wallet',
  accountExternal: 'External wallet',
  networks: 'Networks',
  unavailable: 'Unavailable',
  unavailableCause: (chain: string, cause: string | undefined): string =>
    cause ? `${chain}: ${cause}` : `${chain} did not answer. It is tried again on the next refresh.`,
  zeroNetworks: (count: number): string => `${plural(count, 'network', 'networks')} with no balance`,
  loading: 'Reading balances',
  failed: 'Balances could not be read.',
  /** v0.0.9 r4 (design r3 N6): the cause when none came back — what failed and who, and that nothing moved. */
  // G-4 (design G): the body no longer repeats the title ("Balances could not be read.").
  failedCause: 'The balance service or the network did not answer. Your funds are unchanged.',
  // r4d (design r4 F5-3): one verb per surface — the popover's own Refresh, not a second word for it.
  retry: 'Refresh',
  updated: (seconds: number): string =>
    seconds < 5
      ? 'Updated just now'
      : seconds < 60
        ? `Updated ${n(seconds)} s ago`
        : `Updated ${n(Math.floor(seconds / 60))} min ago`,
  refresh: 'Refresh',
  signOut: 'Sign out of wallet',
  confirmTitle: 'Sign out of your wallet?',
  confirmBody: 'Your iNFTs stay yours; the app forgets this session until you sign in again.',
  confirmCancel: 'Cancel',
  confirmAction: 'Sign out',
  confirmBusy: 'Signing out…',
  confirmDone: 'Signed out',
  confirmError: 'Sign out did not finish. Try again.',
  signedOut: 'Signed out',
  signOutFailedTitle: 'Sign out did not finish',
  signOutFailedMessage:
    'The app stopped using the wallet here, but could not erase the saved sign-in, so the next launch may sign you back in.',
  signOutFailedNext: 'Try again. If it keeps failing, quit and reopen the app, then sign out again.',
  signOutRetry: 'Try again'
} as const
