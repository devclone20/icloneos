import type { TranslationOverrides } from '../define-locale'

export const starmap: TranslationOverrides['starmap'] = {
  title: '記憶圖譜',
  subtitle: (nodes, clusters) => `${clusters} 個類別中的 ${nodes} 個技能`,
  close: '關閉記憶圖譜',
  refresh: '重新整理',
  memory: '記憶',
  filterAll: '全部',
  filterUsed: '已使用',
  filterLearned: '已學習',
  viewGraph: '圖譜',
  loadFailed: '無法載入記憶圖譜',
  loading: '載入中…',
  emptyTitle: '尚無學習內容',
  emptyDesc: '當智慧代理為你的工作建立技能與記憶時，會顯示在這裡。'
}
