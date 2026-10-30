import type { Translations } from '../types'

export const backgroundTasks: Translations['backgroundTasks'] = {
  doorLabel: (active, died) => `后台任务：${active} 个运行中${died > 0 ? `，${died} 个已在无人察觉时终止` : ''}`,
  title: '后台任务',
  tabs: { tasks: '任务', log: '权限日志' },
  kinds: { agent: '智能体', shell: 'Shell 任务', cron: 'Cron 运行', pane: 'iT 窗格', action: '桌面操作' },
  states: {
    running: '运行中',
    waiting: '等待你的回复',
    done: '已完成',
    failed: '失败',
    died: '意外终止',
    stopped: '已停止'
  },
  endedBy: { owner: '已由你停止', rewind: '已因回退移除', session: '会话已结束' },
  startUnknown: '开始时间未知：其来源未提供开始时间。',
  stop: '停止',
  stopping: '正在停止…',
  didNotStop: detail => (detail ? `未能停止 — ${detail}` : '未能停止'),
  cannotConfirm: '无法确认',
  retryStop: '重试',
  cannotStop: {
    agent: '暂时无法在此停止子智能体。',
    shell: '无法在此停止该任务。',
    cron: '无法停止单次运行；请在 Cron 中暂停该任务。',
    pane: '请在对应的 iT 窗格中停止。',
    action: '无法在此停止该操作。',
    waiting: '请在聊天中回复。'
  },
  dismiss: '关闭',
  showMore: count => `再显示 ${count} 个`,
  diedBanner: count => `有 ${count} 个任务在无人察觉时终止`,
  exitCode: code => `退出码 ${code}`,
  signal: name => `被 ${name} 终止`,
  noOutput: '暂无输出',
  emptyTitle: '后台没有任务',
  emptyText: '在后台运行的智能体、Shell 任务和 Cron 运行会显示在这里。',
  loading: '正在读取后台任务…',
  sourceError: (source, detail) => `无法读取${source}：${detail}`,
  sources: {
    agent: '子智能体',
    shell: 'Shell 任务',
    cron: 'Cron',
    perm: '权限日志',
    pane: 'iT 窗格',
    action: '桌面操作'
  },
  logEmpty: '还没有权限决定。',
  logUnavailable: '此版本无法使用权限日志。'
}
