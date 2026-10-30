import type { AgentUpdateCopy } from '../en'

/** Settings › Updates › Agent (shape: `AgentUpdateCopy` in ../en). */
export const jaAgentUpdate: AgentUpdateCopy = {
  appSection: 'iclone os',
  eyebrow: 'オープンソースのエージェント',
  title: 'エージェント',
  intro:
    'iclone os が動かすエージェントです。変更されるのはあなたが求めたときだけ — iclone os が自分で確認・更新することはありません。',
  installed: 'インストール済み',
  latest: '公式の最新版',
  verified: 'このリリースで検証済み',
  newer: '検証済みバージョンより新しい',
  compatibility: (verdict: string) => `互換性 ${verdict}`,
  /** The verdict words a person reads; the engine's RED/AMBER/GREEN/UNKNOWN keys never reach the screen. */
  compatibilityWords: { AMBER: '要確認', GREEN: '互換', RED: '要注意', UNKNOWN: '未確認' },
  localChanges: 'エージェントのフォルダーにローカルの変更があります。',
  unmanagedRuntime: '管理対象外のランタイム',
  unknown: '不明',
  notChecked: 'まだ確認していません。iclone os が自分で確認することはありません。',
  upToDate: '最新のエージェントです。',
  commitsNewer: (count: number) => `${count} 件新しいコミット`,
  countUnavailable: 'コミット数を取得できません',
  releaseTag: (tag: string) => `最新のリリースタグ ${tag}`,
  checkedAgo: (age: string) => `${age}に確認`,
  justNow: 'たった今',
  minAgo: (count: number) => `${count} 分前`,
  hoursAgo: (count: number) => `${count} 時間前`,
  daysAgo: (count: number) => `${count} 日前`,
  offline: '更新元に接続できませんでした。接続を確認して、もう一度お試しください。',
  unavailable: '更新元からバージョンが返りませんでした。後でもう一度お試しください。',
  noRuntime: 'このプロフィールにはまだエージェントがインストールされていません。',
  failed: '確認が完了しませんでした。もう一度お試しください。',
  doorClosed: 'このバージョンでは、エージェントの更新はアプリの更新に含まれます。',
  noBridge: 'このビルドの iclone os ではエージェントを更新できません。',
  check: 'アップデートを確認',
  checking: '確認中…',
  update: (version: string) => `${version} に更新…`,
  updateLatest: '最新のエージェントに更新…',
  openUpdates: 'アップデートを開く',
  restore: (version: string) => `検証済みバージョンに戻す (${version})`,
  confirmTitle: (version: string) => `エージェントを ${version} に更新しますか？`,
  confirmTitleLatest: 'エージェントを最新バージョンに更新しますか？',
  confirmBackup: '最初にエージェントとそのデータの完全なバックアップを作成します。',
  confirmClose: 'iclone os を終了します。',
  confirmFetch: '公式リポジトリからエージェントを更新します。通常は数分かかります。',
  confirmReopen: '更新が終わると iclone os が再び開きます。',
  confirmWindows:
    'Windows では、iclone os からはまだエージェントを更新できません。iclone os を終了し、ターミナルで hermes update --backup を実行してから、iclone os を開き直してください。',
  confirmUpdate: '更新',
  cancel: 'キャンセル',
  restoreTitle: (version: string) => `エージェントを ${version} に戻しますか？`,
  restoreBody:
    'これはロールバックです。エージェントはこのリリースの iclone os で検証されたバージョンに戻り、それより新しい変更は取り除かれます。進行状況はアップデーターのウィンドウに表示されます。',
  restoreConfirm: 'ロールバック',
  applying: '更新を準備しています — まもなく iclone os が終了します。',
  applyErrors: {
    'app-update-pending':
      'iclone os のアップデートが待機中です。先に再起動して適用してから、エージェントを更新してください。',
    bridge: 'このビルドの iclone os ではエージェントを更新できません。',
    'door-closed': 'このバージョンでは、エージェントの更新はアプリの更新に含まれます。',
    'compat-hold': 'このエージェントのバージョンはインストール前に互換性の確認が必要です。',
    failed: '更新を開始できませんでした。もう一度お試しください。',
    gesture: '確認のため、ご自身で「更新」を押してください。',
    'handoff-failed': 'アップデーターを起動できませんでした。何も変更されていません。',
    'no-check': '先にアップデートを確認してください。',
    'no-runtime': 'このプロフィールにはまだエージェントがインストールされていません。',
    'origin-mismatch':
      'このエージェントは公式リポジトリから取得されていないため、確認したバージョンをインストールできません。何も変更されていません。',
    'preflight-failed': '更新前のチェックに失敗しました。何も変更されていません。',
    'stale-check': 'より新しいエージェントが見つかりました。再確認しています…',
    'unsupported-platform': 'このシステムではまだ iclone os からエージェントを更新できません。',
    'updater-running': 'アップデーターはすでに実行中です。'
  },
  reviewCompat: '互換性を確認',
  reviewTitle: (version: string) => `${version} の互換性を確認`,
  reviewTitleLatest: '最新のエージェントの互換性を確認',
  reviewBody: {
    AMBER: 'このバージョンは iclone os が使う部分を変更します。下の項目を承認すると更新に進みます。',
    GREEN: 'このバージョンは互換性チェックに合格しました。更新に進んでください。',
    RED: 'このバージョンは iclone os が使う部分を壊します。それでもインストールするには、ボタンを 3 秒間押し続けて下のすべての項目を承認してください。',
    UNKNOWN:
      'このバージョンは iclone os で確認されていません。それでもインストールするには、ボタンを 1.5 秒間押し続けてください。'
  },
  reviewAccept: { AMBER: '承認して続ける', GREEN: '続ける', RED: '押し続けて承認', UNKNOWN: '押し続けて続ける' },
  reviewHolding: 'そのまま押し続けてください…',
  reviewRecheck: 'この確認は期限切れです。もう一度アップデートを確認してから、このバージョンを確認してください。',
  reviewRefused: '確認は受け付けられませんでした。もう一度お試しください。',
  reviewMore: (count: number) => `ほか ${count} 件`,
  lastRefusal: (when: string) =>
    `前回の更新（${when}）は互換性チェックで保留されました。更新の前に互換性を確認してください。`,
  lastUpdate: '前回の更新',
  outcomes: {
    failed: '失敗',
    partial: '一部のみ適用',
    running: '完了しませんでした',
    success: '更新済み',
    unknown: '結果不明'
  },
  backup: (name: string) => `バックアップ ${name}`,
  noBackup: 'バックアップの記録はありません',
  reveal: '表示',
  tookSeconds: (seconds: number) => (seconds < 90 ? `${seconds} 秒` : `${Math.round(seconds / 60)} 分`),
  compatRed:
    'インストール済みのエージェントは、このバージョンの iclone os では検証されていません。検証済みバージョンに戻すか、新しいエージェントがないか確認してください。',
  compatFlagged:
    'このリリースで検証済みのエージェントは、その後に問題が報告されました。新しいエージェントがないか確認してください。',
  aboutVerified: (version: string) => `エージェント ${version} · 検証済み`,
  aboutNewer: (version: string) => `エージェント ${version} · 検証済みバージョンより新しい`,
  aboutFlagged: (version: string) => `エージェント ${version} · 検証済み、その後要注意に`,
  aboutOpen: 'エージェントの更新',
  searchLabel: 'エージェントを更新',
  searchDescription: '公式リポジトリで最新のエージェントを確認し、クリックしたときだけ更新します。'
}
