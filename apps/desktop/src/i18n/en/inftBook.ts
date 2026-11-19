import type { Translations } from '../types'

// K21/N5: counts in this locale's own digit grouping (5,000 not 5000).
const n = (value: number): string => value.toLocaleString('en-US')

export const inftBook: Translations['inftBook'] = {
  navLabel: 'iNFT Book',
  keywords: ['inft', 'book', 'wallet', 'collection', 'home', 'check'],
  rule: 'Home shows only the iNFTs you check in the iNFT Book.',
  openBook: 'Open the iNFT Book',
  wallet: address => `Wallet ${address}`,
  count: (total, onHome) => `${n(total)} ${total === 1 ? 'iNFT' : 'iNFTs'} · ${n(onHome)} on Home`,
  rescan: 'Rescan',
  search: 'Search iNFTs',
  filterCollection: 'Collection',
  allCollections: 'All collections',
  filterChain: 'Chain',
  allChains: 'All chains',
  filterState: 'Show',
  stateAll: 'All',
  stateChecked: 'On Home',
  stateUnchecked: 'Not on Home',
  checkShown: 'Check all shown',
  uncheckShown: 'Uncheck all shown',
  confirmTitle: count => `Put ${n(count)} iNFTs on Home?`,
  confirmBody: 'A long Home collection takes longer to browse. You can uncheck any of them later.',
  confirmAction: 'Check them',
  confirmBusy: 'Checking…',
  confirmDone: 'Checked',
  confirmError: 'They could not be checked. Try again.',
  cancel: 'Cancel',
  scanning: found => `Scanning your wallet… ${n(found)} found so far`,
  partial: loaded => `Showing ${n(loaded)} — the rest of the wallet didn't load.`,
  partialFiltered: (shown, loaded) => `Showing ${n(shown)} of the ${n(loaded)} that loaded — the rest of the wallet didn't load.`,
  capped: limit =>
    `Showing the first ${n(limit)} iNFTs. This wallet holds more; the iNFT Book reads at most ${n(limit)}.`,
  // r4d (design r4 F5-3): one verb for the same action — the page's own Rescan.
  retry: 'Rescan',
  kept: count => `We kept ${n(count)} on Home from before the iNFT Book.`,
  dismiss: 'Dismiss',
  noWallet: 'Sign in with your wallet to see its iNFTs.',
  signIn: 'Sign in',
  none: 'No iNFTs in this wallet yet.',
  noneHint: 'iNFTs you mint or buy appear here. After a purchase, use Rescan.',
  noMatch: 'No iNFT matches these filters.',
  scanFailed: 'The wallet scan failed.',
  scanFailedCause: 'The iNFT indexer or the network did not answer, so nothing could be read. Your wallet is unchanged; Retry asks again.',
  scanRefused: 'The wallet scan was refused.',
  showOnHome: name => `Show ${name} on Home`,
  setUp: 'Set up',
  setupNeeded: 'Setup needed',
  homeEmpty: 'No iNFT is checked for Home yet.'
}
