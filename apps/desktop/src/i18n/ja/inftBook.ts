import type { TranslationOverrides } from '../define-locale'

// K21/N5: counts in this locale's own digit grouping (5,000 not 5000).
const n = (value: number): string => value.toLocaleString('ja-JP')

export const inftBook: TranslationOverrides['inftBook'] = {
  navLabel: 'iNFT Book',
  keywords: ['inft', 'book', 'ブック', 'ウォレット', 'コレクション', 'ホーム'],
  rule: 'ホームには iNFT Book でチェックした iNFT だけが表示されます。',
  openBook: 'iNFT Book を開く',
  wallet: address => `ウォレット ${address}`,
  count: (total, onHome) => `${n(total)} 件の iNFT · ホームに ${n(onHome)} 件`,
  rescan: '再スキャン',
  search: 'iNFT を検索',
  filterCollection: 'コレクション',
  allCollections: 'すべてのコレクション',
  filterChain: 'チェーン',
  allChains: 'すべてのチェーン',
  filterState: '表示',
  stateAll: 'すべて',
  stateChecked: 'ホームにある',
  stateUnchecked: 'ホームにない',
  checkShown: '表示中をすべてチェック',
  uncheckShown: '表示中のチェックをすべて外す',
  confirmTitle: count => `${n(count)} 件の iNFT をホームに置きますか？`,
  confirmBody: 'ホームのコレクションが長いほど見渡すのに時間がかかります。あとでいつでもチェックを外せます。',
  confirmAction: 'チェックする',
  confirmBusy: 'チェック中…',
  confirmDone: 'チェックしました',
  confirmError: 'チェックできませんでした。もう一度お試しください。',
  cancel: 'キャンセル',
  scanning: found => `ウォレットをスキャン中… これまでに ${n(found)} 件`,
  partial: loaded => `${n(loaded)} / ? 件を読み込みました — スキャンは途中で止まりました。`,
  capped: limit =>
    `最初の ${n(limit)} 件を表示しています。このウォレットにはさらにありますが、iNFT Book が読み込むのは最大 ${n(limit)} 件です。`,
  retry: '再試行',
  kept: count => `iNFT Book 以前からの ${n(count)} 件をホームに残しました。`,
  dismiss: '閉じる',
  noWallet: 'ウォレットでサインインすると iNFT が表示されます。',
  signIn: 'サインイン',
  none: 'このウォレットにはまだ iNFT がありません。',
  noMatch: '条件に合う iNFT はありません。',
  scanFailed: 'ウォレットのスキャンに失敗しました。',
  scanRefused: 'ウォレットのスキャンが拒否されました。',
  showOnHome: name => `${name} をホームに表示`,
  setUp: 'セットアップ済み',
  setupNeeded: 'セットアップが必要',
  homeEmpty: 'ホーム用にチェックされた iNFT はまだありません。'
}
