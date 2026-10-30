import type { TranslationOverrides } from '../define-locale'

export const fileMenu: TranslationOverrides['fileMenu'] = {
  revealFinder: '在 Finder 中顯示',
  revealExplorer: '在檔案總管中顯示',
  revealFileManager: '開啟所在資料夾',
  revealInSidebar: '在檔案樹中顯示',
  copyPath: '複製路徑',
  copyRelativePath: '複製相對路徑',
  download: '下載',
  downloadSaved: '已儲存',
  downloadFailed: '下載失敗',
  rename: '重新命名…',
  delete: '刪除',
  renameTitle: '重新命名',
  renameLabel: '新名稱',
  deleteTitle: name => `刪除 ${name}？`,
  deleteBody: '將移至垃圾桶，你可以從那裡還原。',
  pathCopied: '已複製路徑'
}
