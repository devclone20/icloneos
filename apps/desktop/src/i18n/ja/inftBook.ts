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
  partial: loaded => `${n(loaded)} 件を表示中 — ウォレットの残りは読み込めませんでした。`,
  partialFiltered: (shown, loaded) => `読み込めた ${n(loaded)} 件のうち ${n(shown)} 件を表示中 — ウォレットの残りは読み込めませんでした。`,
  capped: limit =>
    `最初の ${n(limit)} 件を表示しています。このウォレットにはさらにありますが、iNFT Book が読み込むのは最大 ${n(limit)} 件です。`,
  // r4d (design r4 F5-3): one verb for the same action — the page's own Rescan.
  retry: '再スキャン',
  kept: count => `iNFT Book 以前からの ${n(count)} 件をホームに残しました。`,
  dismiss: '閉じる',
  noWallet: 'ウォレットでサインインすると iNFT が表示されます。',
  signIn: 'サインイン',
  none: 'このウォレットにはまだ iNFT がありません。',
  noneHint: 'ミントまたは購入した iNFT はここに表示されます。購入後は再スキャンしてください。',
  noMatch: '条件に合う iNFT はありません。',
  scanFailed: 'ウォレットのスキャンに失敗しました。',
  scanFailedCause: 'iNFT インデクサーまたはネットワークが応答しなかったため、何も読み込めませんでした。ウォレットは変わっていません。再試行でもう一度問い合わせます。',
  scanRefused: 'ウォレットのスキャンが拒否されました。',
  showOnHome: name => `${name} をホームに表示`,
  setUp: 'セットアップ済み',
  setupNeeded: 'セットアップが必要',
  homeEmpty: 'ホーム用にチェックされた iNFT はまだありません。'
}
