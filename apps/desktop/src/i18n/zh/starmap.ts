import type { Translations } from '../types'

export const starmap: Translations['starmap'] = {
  title: '记忆图谱',
  subtitle: (nodes, clusters) => `${clusters} 个类别中的 ${nodes} 个技能`,
  close: '关闭记忆图谱',
  refresh: '刷新',
  memory: '记忆',
  filterAll: '全部',
  filterUsed: '已使用',
  filterLearned: '已学习',
  viewGraph: '图谱',
  loadFailed: '无法加载记忆图谱',
  loading: '加载中…',
  emptyTitle: '尚无学习内容',
  emptyDesc: '当智能体为你的工作构建技能和记忆时，会显示在这里。',
  share: '分享图谱',
  shareHint: '复制代码以分享此图谱，或粘贴代码以载入。仅包含布局，不含你的记忆或技能内容。',
  shareTitle: '导入 / 导出图谱',
  sharePlaceholder: '粘贴图谱代码…',
  copy: '复制图谱代码',
  copied: '已复制！',
  importMap: '导入图谱',
  importBtn: '加载',
  importEmpty: '粘贴图谱代码以加载。',
  importSuccess: nodes => `已加载包含 ${nodes} 个节点的图谱。`,
  importedBadge: '导入的图谱',
  resetToMine: '返回我的图谱'
}
