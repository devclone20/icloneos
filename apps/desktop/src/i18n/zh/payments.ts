// iclone os — V3-J 设置 › 经济 › 支付 (zh)。
import type { PaymentsTranslations } from '../types/payments'

export const payments: PaymentsTranslations = {
  navLabel: '支付',
  keywords: ['x402', 'USDC', '支出', '上限', '停止', '授权书'],
  intro: '你的智能体可以支付什么、付给谁、每天多少。提高上限或添加收款方会先询问你；降低会立即生效。',
  desktopOnly: '支付在桌面应用中运行，密钥保存在这台 Mac 上。',
  status: {
    title: '状态',
    ready: '就绪',
    off: '关闭',
    readyHint: '智能体可以在你签署的授权书下、在下方上限内支付。',
    pocket: '钱包地址',
    pocketHint: '这台 Mac 上智能体的钱包。充值不要超过你的每日上限。',
    noPocket: '尚无钱包',
    today: '今日已签署 (UTC)',
    todayValue: (amount, cap) => `${amount} / ${cap} USDC`,
    ledgerBroken: '支付记录无法验证：在修复之前，所有支付都会被拒绝。',
    unprotected: '未受保护的配置档案',
    unprotectedHint:
      '应用无法确认这些配置档案中的支付技能已关闭（文件夹或 config.yaml 位于 Hermes 主目录之外，或无法读取或写入）：其中的智能体无法支付。',
    notReady: {
      sealing_off:
        '支付已关闭：钥匙串设置已关闭，无法封存支付密钥。请在 设置 › 设备 › 网关 ›“把已保存的密码存入系统钥匙串” 中打开钥匙串，即可使用支付。',
      keys_unavailable: '已封存的支付密钥无法使用，因此支付已关闭。',
      disabled: '支付已关闭。',
      socket_down: '智能体用于支付的连接未在运行。'
    }
  },
  caps: {
    title: '支出上限',
    perTx: '每笔支付',
    perTxHint: '超过此金额的单笔支付会被拒绝。',
    perDay: '每天',
    perDayHint: '所有智能体合计，按 UTC 日计算。',
    perAgentDay: '每个智能体每天',
    perAgentDayHint: '每个智能体自己的上限：一个被入侵的智能体一天最多能花的金额。',
    save: '保存上限',
    invalid: '请输入 USDC 金额，最多 6 位小数。',
    note: '提高上限会在权限请求中询问你。降低会立即生效。'
  },
  stop: {
    title: '紧急停止',
    label: '停止所有支付',
    hint: '拒绝所有支付，包括正在进行的支付。关闭它会在权限请求中询问你。'
  },
  allowlist: {
    title: '智能体可以付给谁',
    payees: '收款方',
    payeesHint: '智能体可以支付的地址。列表为空时，不能向任何人付款。',
    origins: '网站',
    originsHint: '智能体可以响应其付款请求的网站。列表为空时，不响应任何请求。',
    add: '添加',
    remove: '移除',
    invalidPayee: '不是地址：应为 0x 加 40 个十六进制字符。',
    invalidOrigin: '不是网站地址：请以 https:// 或 http:// 开头。',
    full: max => `列表已满（${max} 个条目）。请先删除一个。`,
    listed: '已在列表中。',
    empty: '暂无',
    problems: {
      notList: list => `${list}：不是列表。`,
      tooMany: (list, count, max) => `${list}：${count} 项，最多 ${max} 项。`,
      entries: (list, entries, more) => `${list}：${entries}${more > 0 ? `（另有 ${more} 项）` : ''}`
    }
  },
  issue: {
    title: '新授权书',
    intro:
      '授权书是你签署的、允许一个智能体付款的许可：总额、每次金额、付给谁、到什么时候。没有授权书，智能体无法付款。',
    agent: '智能体',
    agentHint: '智能体的配置文件名，例如 inft-alpha。',
    budget: '预算',
    budgetHint: '此授权书下所有付款合计的上限。初始值为你设定的每个智能体每日上限。',
    min: '最小付款',
    max: '最大付款',
    rangeHint: '每笔付款必须在此范围内。最大值初始为每笔付款上限。',
    payees: '可付给',
    payeesHint: '只能从上方列表中选择收款方。',
    noPayees: '请先在上方列表中添加收款方。',
    starts: '付款开始',
    ends: '付款截止',
    expires: '授权书到期',
    datesHint: '使用你的本地时间。授权书最长 90 天。',
    review: '你将要签署的内容',
    payee: '收款方',
    summary: {
      agent: agent => `用于 ${agent}`,
      budget: budget => `总计不超过 ${budget} USDC`,
      range: (min, max) => `每笔付款在 ${min} 到 ${max} USDC 之间`,
      payees: count => `付给 ${count} 个收款方：`,
      window: (from, to) => `允许付款时间：${from} 至 ${to}`,
      expires: at => `授权书于 ${at} 到期`,
      caps: (perTx, perDay, perAgentDay) =>
        `你的上限仍然适用：每笔 ${perTx} USDC，每天 ${perDay} USDC，每个智能体每天 ${perAgentDay} USDC。`
    },
    problems: {
      agent: '请输入智能体的配置文件名：小写字母、数字、- 和 _。',
      amount: '请检查金额：大于零，最多 6 位小数，且最小 ≤ 最大 ≤ 预算。',
      dates: '请检查日期：付款开始早于截止，截止不晚于到期时间，到期时间在未来且不超过 90 天。',
      payees: '请从列表中至少选择一个收款方。'
    },
    sign: '签署授权书…',
    signHint: '你会在显示全部条款的权限确认中再确认一次。之后撤销会立即生效。',
    signed: '授权书已签署。'
  },
  mandates: {
    title: '授权书',
    empty: '没有授权书。智能体只能在你签署的授权书下支付。',
    forAgent: agent => `用于 ${agent}`,
    terms: (budget, expires) => `预算 ${budget} USDC · ${expires} 到期`,
    revoked: '已撤销',
    revoke: '撤销'
  },
  saved: '已保存',
  refusals: {
    allowlist: '未更改：每个列表最多 50 个有效条目，且不能重复。',
    door_denied: '未更改：权限请求被拒绝或已超时。',
    gesture: '未更改：此更改需要你亲自点击。',
    invalid: '未更改：请求无效。',
    ledger: '未更改：无法写入支付记录。',
    no_door: '未更改：权限请求不可用。',
    not_ready: '支付不可用。',
    settings_moved: '设置在此期间已更改。请检查后重试。',
    unavailable: '此版本不可用。',
    unknown: '出了点问题。没有做任何更改。'
  }
}
