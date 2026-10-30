import type { Translations } from '../types'

export const backgroundTasks: Translations['backgroundTasks'] = {
  doorLabel: (active, died) => `背景任務：${active} 個執行中${died > 0 ? `，${died} 個已在無人察覺時終止` : ''}`,
  title: '背景任務',
  tabs: { tasks: '任務', log: '權限記錄' },
  kinds: { agent: '智慧體', shell: 'Shell 工作', cron: 'Cron 執行', pane: 'iT 窗格', action: '桌面操作' },
  states: {
    running: '執行中',
    waiting: '等待你的回覆',
    done: '已完成',
    failed: '失敗',
    died: '意外終止',
    stopped: '已停止'
  },
  endedBy: { owner: '已由你停止', rewind: '已因回溯移除', session: '工作階段已結束' },
  startUnknown: '開始時間不明：其來源未提供開始時間。',
  stop: '停止',
  stopping: '正在停止…',
  didNotStop: detail => (detail ? `未能停止 — ${detail}` : '未能停止'),
  cannotConfirm: '無法確認',
  retryStop: '重試',
  cannotStop: {
    agent: '暫時無法在此停止子智慧體。',
    shell: '無法在此停止此工作。',
    cron: '無法停止單次執行；請在 Cron 中暫停此工作。',
    pane: '請在對應的 iT 窗格中停止。',
    action: '無法在此停止此操作。',
    waiting: '請在聊天中回覆。'
  },
  dismiss: '關閉',
  showMore: count => `再顯示 ${count} 個`,
  diedBanner: count => `有 ${count} 個任務在無人察覺時終止`,
  exitCode: code => `結束代碼 ${code}`,
  signal: name => `被 ${name} 終止`,
  noOutput: '尚無輸出',
  emptyTitle: '背景沒有任務',
  emptyText: '在背景執行的智慧體、Shell 工作與 Cron 執行會顯示在這裡。',
  loading: '正在讀取背景任務…',
  sourceError: (source, detail) => `無法讀取${source}：${detail}`,
  sources: {
    agent: '子智慧體',
    shell: 'Shell 工作',
    cron: 'Cron',
    perm: '權限記錄',
    pane: 'iT 窗格',
    action: '桌面操作'
  },
  logEmpty: '尚無權限決定。',
  logUnavailable: '此版本無法使用權限記錄。'
}
