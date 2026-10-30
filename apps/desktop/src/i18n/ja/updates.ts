import type { TranslationOverrides } from '../define-locale'

export const updates: TranslationOverrides['updates'] = {
  stages: {
    idle: '準備中…',
    prepare: '準備中…',
    fetch: 'ダウンロード中…',
    pull: 'もうすぐ完了…',
    pydeps: '仕上げ中…',
    update: 'iclone os を更新中…',
    rebuild: 'デスクトップアプリを再ビルド中…',
    restart: 'iclone os を再起動中…',
    done: '更新が完了しました',
    manual: 'ターミナルから更新',
    guiSkew: 'デスクトップアプリを更新してください',
    error: '更新が一時停止中'
  },
  checking: '更新を確認中…',
  checkFailedTitle: '更新を確認できませんでした',
  tryAgain: '再試行',
  notAvailableTitle: '更新は利用できません',
  unsupportedMessage: 'このバージョンの iclone os はアプリ内から自分を更新できません。',
  connectionRetry: '接続を確認してもう一度試してください。',
  latestBody: '最新バージョンを実行しています。',
  latestBodyBackend: 'バックエンドは最新バージョンを実行しています。',
  allSetTitle: '準備完了',
  availableTitle: '新しい更新が利用可能',
  availableBody: '新しいバージョンの iclone os をインストールする準備ができています。',
  availableTitleBackend: 'バックエンドの更新があります',
  availableBodyBackend: '接続中のエージェントのバックエンドの新しいバージョンをインストールできます。',
  availableBodyNoChangelog: '新しいバージョンを利用できます。このインストール形式ではリリースノートは表示できません。',
  updateNow: '今すぐ更新',
  maybeLater: '後で',
  moreChanges: count => `さらに ${count} 件の変更が含まれています。`,
  manualTitle: 'ターミナルから更新',
  manualBody:
    'エージェントをコマンドラインからインストールしたため、更新もそこで実行されます。これをターミナルに貼り付けてください:',
  manualPickedUp: 'エージェントは次回起動時に新しいバージョンを読み込みます。',
  guiSkewTitle: 'デスクトップアプリを更新してください',
  guiSkewBody:
    'バックエンドは更新されましたが、このデスクトップアプリのパッケージは変更されていません。一致させるために iclone os デスクトップアプリ（AppImage / .deb / .rpm）を更新または再インストールしてください。',
  copy: 'コピー',
  copied: 'コピーしました',
  done: '完了',
  applyingBody:
    'アップデーターが独自のウィンドウで引き継ぎ、完了後に自動的に iclone os を再度開きます。更新中はご自分で iclone os を開き直さないでください。',
  applyingBodyBackend:
    'リモートバックエンドが更新を適用して再起動します。復帰すると iclone os が自動的に再接続します。',
  applyingClose: 'このウィンドウは更新中に閉じ、その後 iclone os が自動的に再度開きます。',
  errorTitle: '更新が完了しませんでした',
  errorBody: 'ご安心ください。何も失われていません。今すぐ再試行できます。',
  blockerTitle: 'iclone os を更新するためにローカルプレビューを閉じますか？',
  blockerBody:
    '更新する前に、これらのローカルプレビューを停止する必要があります。ファイルが変更または削除されることはありません。',
  foreignBlockerTitle: '他のプロセスを閉じて iclone os を更新',
  foreignBlockerBody:
    'iclone os はこれらのプロセスを安全に自動終了できません。各プロセスを所有するアプリ、ターミナル、またはサービスを閉じてから、もう一度更新してください。',
  mixedBlockerBody:
    'iclone os は以下のローカルプレビューを閉じることができます。更新を続けるには、他のプロセスを手動で閉じる必要があります。',
  closePreviewsAndUpdate: 'プレビューを閉じて更新',
  closePreviewsAndCheckAgain: 'プレビューを閉じて再確認',
  localPreview: 'ローカルプレビュー',
  portLabel: port => `ポート ${port}`,
  pidLabel: pid => `PID ${pid}`,
  technicalDetails: '技術的な詳細',
  notNow: '今は後で',
  clientAlsoBehindTitle: 'デスクトップアプリが古くなっています',
  clientAlsoBehindMessage:
    'バックエンドは最新ですが、このデスクトップアプリはまだ古いバージョンです。最新の修正を反映するには更新してください。',
  clientAlsoBehindAction: 'デスクトップアプリを更新',
  everythingDispatched: '更新を開始しました',
  everythingSkipped: 'スキップ',
  everythingRowFailed: '更新に失敗しました',
  everythingFanoutFailedTitle: '他のインスタンスを更新できませんでした',
  applyStatus: {
    preparing: 'バックエンドを更新しています…',
    pulling: 'バックエンドを更新中…',
    restarting: 'バックエンドが更新を読み込むため再起動しています…',
    notAvailable: 'このバックエンドでは更新を利用できません。',
    failed: 'バックエンドの更新に失敗しました。',
    noReturn:
      'バックエンドがオンラインに戻りませんでした。更新が完了していない可能性があります。バックエンドホストを確認してください。'
  }
}
