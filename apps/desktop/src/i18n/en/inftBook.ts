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
  partial: loaded => `Loaded ${n(loaded)} of ? — the scan stopped before the end.`,
  capped: limit =>
    `Showing the first ${n(limit)} iNFTs. This wallet holds more; the iNFT Book reads at most ${n(limit)}.`,
  retry: 'Retry',
  kept: count => `We kept ${n(count)} on Home from before the iNFT Book.`,
  dismiss: 'Dismiss',
  noWallet: 'Sign in with your wallet to see its iNFTs.',
  signIn: 'Sign in',
  none: 'No iNFTs in this wallet yet.',
  noMatch: 'No iNFT matches these filters.',
  scanFailed: 'The wallet scan failed.',
  scanRefused: 'The wallet scan was refused.',
  showOnHome: name => `Show ${name} on Home`,
  setUp: 'Set up',
  setupNeeded: 'Setup needed',
  homeEmpty: 'No iNFT is checked for Home yet.'
}
