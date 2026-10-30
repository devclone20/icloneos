import type { Translations } from '../types'

export const fileMenu: Translations['fileMenu'] = {
  revealFinder: '在访达中显示',
  revealExplorer: '在文件资源管理器中显示',
  revealFileManager: '打开所在文件夹',
  revealInSidebar: '在文件树中显示',
  copyPath: '复制路径',
  copyRelativePath: '复制相对路径',
  download: '下载',
  downloadSaved: '已保存',
  downloadFailed: '下载失败',
  rename: '重命名…',
  delete: '删除',
  renameTitle: '重命名',
  renameLabel: '新名称',
  deleteTitle: name => `删除 ${name}？`,
  deleteBody: '将移至废纸篓，你可以从那里恢复。',
  pathCopied: '已复制路径'
}
