import type { TranslationOverrides } from '../define-locale'

export const artifactPreview: TranslationOverrides['artifactPreview'] = {
  versionOf: (current, total) => `第 ${current}/${total} 版`,
  olderVersion: '較舊版本',
  newerVersion: '較新版本',
  latest: '最新',
  copyContent: '複製內容',
  download: '下載',
  openInBrowser: '在瀏覽器中開啟',
  openInBrowserFailed: '無法在瀏覽器中開啟',
  missingTitle: '產物無法使用',
  missingBody: '此產物已不在本機註冊表中。'
}
