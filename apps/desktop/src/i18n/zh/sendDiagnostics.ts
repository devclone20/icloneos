import type { Translations } from '../types'

export const sendDiagnostics: Translations['sendDiagnostics'] = {
  title: '保存诊断报告',
  lead: '不会有任何内容离开这台 Mac：icloneOS 会把报告写入你选择的文件。密钥、令牌、电子邮件地址和你的主文件夹路径会先被移除。报告包含：',
  parts: {
    context: '失败的内容',
    logs: '应用的近期日志',
    report: '最近一次诊断报告'
  },
  lines: count => `${count} 行`,
  preview: '显示报告',
  loading: '正在准备报告…',
  save: '保存到文件…',
  saving: '正在保存…',
  cancel: '取消',
  close: '关闭',
  savedTitle: '报告已保存',
  savedDescription: name => `已保存为 ${name}。它留在这台 Mac 上；只有在你愿意时才把它附加到问题中。`,
  failedTitle: '报告未保存',
  reportIssue: '报告问题',
  reportIssueHint: '在 GitHub 上打开一个只带标题的新问题。报告中的任何内容都不会被发送；如需附加文件，请自行添加。',
  issueTitle: '来自 icloneOS 的问题报告'
}
