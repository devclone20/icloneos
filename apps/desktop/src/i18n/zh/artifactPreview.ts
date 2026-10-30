import type { Translations } from '../types'

export const artifactPreview: Translations['artifactPreview'] = {
  versionOf: (current, total) => `第 ${current}/${total} 版`,
  olderVersion: '较旧版本',
  newerVersion: '较新版本',
  latest: '最新',
  copyContent: '复制内容',
  download: '下载',
  openInBrowser: '在浏览器中打开',
  openInBrowserFailed: '无法在浏览器中打开',
  missingTitle: '产物不可用',
  missingBody: '此产物已不在本地注册表中。'
}
