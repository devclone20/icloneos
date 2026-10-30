import type { Translations } from '../types'

export const backgroundTasks: Translations['backgroundTasks'] = {
  doorLabel: (active, died) =>
    `バックグラウンドタスク: 実行中 ${active} 件${died > 0 ? `、気づかれずに停止 ${died} 件` : ''}`,
  title: 'バックグラウンドタスク',
  tabs: { tasks: 'タスク', log: '権限ログ' },
  kinds: {
    agent: 'エージェント',
    shell: 'シェルジョブ',
    cron: 'Cron 実行',
    pane: 'iT ペイン',
    action: 'デスクトップ操作'
  },
  states: {
    running: '実行中',
    waiting: 'あなたの応答待ち',
    done: '完了',
    failed: '失敗',
    died: '停止（異常）',
    stopped: '停止済み'
  },
  endedBy: { owner: 'あなたが停止', rewind: '巻き戻しで削除', session: 'セッション終了' },
  startUnknown: '開始時刻は不明です：取得元が開始時刻を報告していません。',
  stop: '停止',
  stopping: '停止中…',
  didNotStop: detail => (detail ? `停止しませんでした — ${detail}` : '停止しませんでした'),
  cannotConfirm: '確認できません',
  retryStop: '再試行',
  cannotStop: {
    agent: 'サブエージェントはまだここから停止できません。',
    shell: 'このジョブはここから停止できません。',
    cron: '実行は停止できません。Cron でジョブを一時停止してください。',
    pane: 'iT ペインで停止してください。',
    action: 'この操作はここから停止できません。',
    waiting: 'チャットで応答してください。'
  },
  dismiss: '閉じる',
  showMore: count => `さらに ${count} 件表示`,
  diedBanner: count => `誰も見ていない間に ${count} 件のタスクが停止しました`,
  exitCode: code => `終了コード ${code}`,
  signal: name => `${name} で終了`,
  noOutput: 'まだ出力はありません',
  emptyTitle: 'バックグラウンドの処理はありません',
  emptyText: '見えないところで動くエージェント、シェルジョブ、Cron 実行がここに表示されます。',
  loading: 'バックグラウンドの処理を読み込み中…',
  sourceError: (source, detail) => `${source} を読み込めませんでした: ${detail}`,
  sources: {
    agent: 'サブエージェント',
    shell: 'シェルジョブ',
    cron: 'Cron',
    perm: '権限ログ',
    pane: 'iT ペイン',
    action: 'デスクトップ操作'
  },
  logEmpty: '権限の判断はまだありません。',
  logUnavailable: 'このビルドでは権限ログを利用できません。'
}
