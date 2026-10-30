import type { TranslationOverrides } from '../define-locale'

export const artifactPreview: TranslationOverrides['artifactPreview'] = {
  versionOf: (current, total) => `${total} 中 v${current}`,
  olderVersion: '前のバージョン',
  newerVersion: '次のバージョン',
  latest: '最新',
  copyContent: 'コンテンツをコピー',
  download: 'ダウンロード',
  openInBrowser: 'ブラウザで開く',
  openInBrowserFailed: 'ブラウザで開けませんでした',
  missingTitle: 'アーティファクトを利用できません',
  missingBody: 'このアーティファクトはローカルレジストリに存在しません。'
}
