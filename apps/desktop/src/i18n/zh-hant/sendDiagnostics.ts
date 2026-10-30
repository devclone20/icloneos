import type { TranslationOverrides } from '../define-locale'

export const sendDiagnostics: TranslationOverrides['sendDiagnostics'] = {
  title: '儲存診斷報告',
  lead: '不會有任何內容離開這台 Mac：icloneOS 會把報告寫入你選擇的檔案。密鑰、權杖、電子郵件地址和你的主資料夾路徑會先被移除。報告包含：',
  parts: {
    context: '失敗的內容',
    logs: '應用程式的近期日誌',
    report: '最近一次診斷報告'
  },
  lines: count => `${count} 行`,
  preview: '顯示報告',
  loading: '正在準備報告…',
  save: '儲存到檔案…',
  saving: '正在儲存…',
  cancel: '取消',
  close: '關閉',
  savedTitle: '報告已儲存',
  savedDescription: name => `已儲存為 ${name}。它留在這台 Mac 上；只有在你願意時才把它附加到問題中。`,
  failedTitle: '報告未儲存',
  reportIssue: '回報問題',
  reportIssueHint: '在 GitHub 上開啟一個只有標題的新問題。報告中的任何內容都不會被傳送；如需附加檔案，請自行加入。',
  issueTitle: '來自 icloneOS 的問題回報'
}
