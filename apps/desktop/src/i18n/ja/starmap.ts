import type { TranslationOverrides } from '../define-locale'

export const starmap: TranslationOverrides['starmap'] = {
  title: 'メモリグラフ',
  subtitle: (nodes, clusters) => `${clusters} カテゴリの ${nodes} スキル`,
  close: 'メモリグラフを閉じる',
  refresh: '更新',
  memory: 'メモリ',
  filterAll: 'すべて',
  filterUsed: '使用済み',
  filterLearned: '学習済み',
  viewGraph: 'グラフ',
  loadFailed: 'メモリグラフを読み込めませんでした',
  loading: '読み込み中…',
  emptyTitle: 'まだ学習はありません',
  emptyDesc: 'エージェントがスキルやメモリを蓄積すると、ここに表示されます。'
}
