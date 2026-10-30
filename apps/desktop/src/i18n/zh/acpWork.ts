// iclone os — V3-I ACP 市场 › 工作（简体中文）。
import type { AcpWorkTranslations } from '../types/acpWork'

export const acpWork: AcpWorkTranslations = {
  tab: '工作',
  states: {
    offline: '离线',
    starting: '正在启动',
    online: '在线',
    draining: '正在安全下线',
    'offline-safe': '已离线，所有任务已结清',
    failed: '需要你处理'
  },
  onlineMeaning: '在线表示它的任务监听器已从这台 Mac 连接。市场是否显示它在线尚未验证。',
  desktopOnly: '工作功能在桌面应用中运行，由它让代理从你的 Mac 保持在线。',
  awakeOnly: '关闭此窗口后它仍保持在线，前提是这台 Mac 处于唤醒状态。',
  actions: { online: '上线', offline: '下线', reboot: '重启监听器', refresh: '立即读取任务' },
  autonomy: {
    title: '自主程度',
    levels: {
      L0: { name: '仅观察', summary: '寻找并排序工作，一切由你来做。' },
      L1: { name: '逐个批准', summary: '符合你策略的报价在这里等待你批准。' },
      L2: { name: '按策略行动', summary: '自行为符合策略的报价出价。只有你本人的点击才能开启。' }
    },
    downgrade: {
      'chain-broken': '工作账本校验失败，在处理之前只观察。',
      'spend-trade-off': '“设置 › 隐私”中的支出与交易已关闭，因此只观察。'
    },
    earnOnly: '只赚不花：它从不支出、雇佣或充值。'
  },
  writesOff: '在此版本中，批准会被记录，报价会被保留，不会发送。',
  offers: {
    title: '报价',
    empty: '暂无报价',
    emptyHint: '向此 iNFT 发出的任务请求会连同策略结论显示在这里。',
    approve: '批准',
    decline: '拒绝',
    standing: {
      pending: '等待你处理',
      approved: '已批准',
      declined: '已拒绝',
      refused: '被策略拒绝',
      seen: '已查看'
    },
    rules: {
      spend: '它要求此 iNFT 出资',
      token: '使用策略不接受的代币支付',
      chain: '位于策略不接受的链上',
      'requester-denied': '请求方在拒绝名单上',
      'requester-unknown': '请求方不在允许名单上',
      class: '策略不接受的工作类型',
      'price-floor': '费用低于下限或未注明',
      'open-cap': '进行中的任务已过多',
      oversize: '请求超过大小上限'
    },
    price: amount => `费用 ${amount}`,
    requester: address => `来自 ${address}`
  },
  groups: { 'in-flight': '进行中', completed: '已完成', payments: '收款', history: '历史' },
  groupsEmpty: '这里还没有内容。',
  trace: { offer: '报价', job: '任务', budget: '预算', deliverable: '已交付', payment: '已付款', gap: '缺失' },
  totals: { earned: '已赚取', spent: '已支出', escrow: '托管中' },
  fixes: {
    title: '修复',
    empty: '没有任何失败。',
    causes: {
      'listener-exited': '监听器已退出',
      'needs-sign-in': '代理需要重新登录',
      'owner-reboot': '你要求了重启',
      'read-failed': '无法读取任务列表',
      'tools-missing': 'ACP 工具未安装或无法验证'
    },
    actions: {
      'restart-backoff': '正在重启，每次等待更久（最多一分钟）',
      restarted: '已重启监听器',
      'stopped-for-sign-in': '已停止重试——请在设置中登录，然后让它上线',
      'retry-next-poll': '将在下次检查时重新读取',
      'stopped-for-tools': '已停止 — 请在 ACP Market 中安装 ACP 工具，然后让它上线'
    },
    now: state => `当前：${state}`
  },
  draining: jobs => `监听器停止前正在等待任务 ${jobs}。`,
  drainUnknown: '监听器停止前，正在等待一份可信的任务列表。',
  stopReport: (open, escrow) => (open === 0 ? '没有进行中的任务。' : `仍有 ${open} 个任务进行中，托管 ${escrow}。`),
  readError: detail => `上次读取失败：${detail}`,
  holds: {
    'signed-out': '离线：你已退出登录，所有监听器都已停止。请先登录，再让它上线。',
    'wallet-switch': '离线：钱包已更换，所有监听器都已停止。只有持有此 iNFT 的钱包才能让它上线。',
    'ownership-lost': '离线：此 iNFT 已不在你的钱包中，它的监听器已停止。',
    'ownership-unverified': '正在确认此 iNFT 仍在你的钱包中，确认后才会重新上线。'
  },
  repair: {
    action: '修复账本',
    hint: '修复会保留所有能通过校验的记录，把损坏的文件另存，并记下缺口。“按策略行动”需要重新选择。'
  },
  chainGaps: count => `有 ${count} 次写入被中断或修复，账本已逐一记下缺口。`,
  chainBroken: '工作账本校验失败。',
  errors: {
    gesture: '这需要你本人的点击。',
    invalid: '该任务已不再是待处理的报价。',
    policy: '策略拒绝了这个报价。',
    state: '现在不行——代理仅在观察或正在下线。',
    ownership: '目前无法证明此 iNFT 在你的钱包中。',
    'sign-in': '请先用持有此 iNFT 的钱包登录。',
    busy: '仍在处理上一个请求。',
    tools: '请先安装 ACP 工具（ACP Market › 安装）。'
  },
  refusedBy: rule => `已拒绝：${rule}`
}
