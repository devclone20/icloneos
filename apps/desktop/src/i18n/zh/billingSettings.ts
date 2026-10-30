/** The words of the Billing Settings pane (front I-C, 2026-10-20). */
import type { BillingSettingsCopy } from '../en/billingSettings'

export const zhBillingSettings: BillingSettingsCopy = {
  sections: {
    plan: '你的套餐',
    payment: '付款方式与额度',
    usage: '余额与用量',
    invoices: '发票'
  },
  providerBilling: {
    title: '账单由你连接的模型提供商处理',
    hint: '这个应用使用你添加的密钥运行，用量和费用都在该提供商那里。登录 Nous Portal 订阅后，其套餐和用量会显示在这里。',
    openProviders: '打开提供商'
  },
  empty: {
    title: '这个连接没有需要计费的内容',
    hint: '计费属于 Nous Portal 托管的账户。这个应用使用你自己的密钥运行，因此这里没有需要计量或收费的内容；用量和费用由你的模型提供商管理。'
  },
  summary: {
    balance: '余额',
    plan: '套餐',
    refill: '自动充值',
    enabled: '已开启',
    off: '已关闭'
  },
  notice: {
    openPortal: '打开门户 ↗',
    noCardTitle: '没有登记付款方式',
    noCardMessage: '登记银行卡之前，购买充值额度和自动充值都无法使用。请在门户中添加。',
    addCard: '添加银行卡 ↗'
  },
  payment: {
    title: '你用来付款的银行卡',
    hint: '用于充值和订阅续费。',
    noneHint: '尚未登记银行卡。',
    add: '添加付款方式',
    update: '更新'
  },
  buy: {
    title: '立即购买额度',
    hint: '对你的银行卡扣款一次，今天就计入余额。',
    action: '购买',
    customAmount: '自定义额度'
  },
  refill: {
    title: '余额不足时自动充值',
    generic: '余额低于阈值时自动补足。',
    manage: '管理',
    manageOnPortal: '请在门户中管理自动充值。',
    turnOnPortal: '请在门户中开启自动充值',
    reconcile: '核对 ↗',
    differentCard: '另一张银行卡',
    threshold: '自动充值阈值',
    reloadTo: '自动充值补足金额',
    distinctCaption: (card: string) => `自动充值从 ${card} 扣款——请在门户中核对`,
    charges: (reloadTo: string, threshold: string) => `余额低于 ${threshold} 时自动扣款 ${reloadTo}。`
  },
  plan: {
    currentTitle: (tier: string) => `你正在使用 ${tier} 方案`,
    free: '免费',
    unavailable: '无法获取订阅详情，但仍可打开门户。',
    noSubscription: '没有有效的订阅——付费模型会消耗充值额度。',
    change: '更改套餐',
    view: '查看套餐',
    adjust: '调整套餐 ↗',
    choose: '选择 ↗',
    back: '返回计费',
    changesTo: (tier: string, when: string) => `将于 ${when} 更改为 ${tier}。`,
    cancels: (when: string) => `将于 ${when} 取消。`,
    renews: (date: string) => `${date} 续订`
  },
  usage: {
    left: (left: string, total: string) => `剩余 ${left}，共 ${total}`,
    over: (amount: string) => `超出 ${amount}`,
    used: (spent: string, limit: string) => `已用 ${spent}，共 ${limit}`,
    subscriptionRemaining: '订阅剩余额度',
    subscription: '你的订阅还剩下的额度',
    noExpiry: '永不过期。',
    topup: '你自己购买的额度',
    capUsed: '本月支出上限已用',
    defaultCeiling: '这是你账户的默认上限。',
    monthlyRemote: '统计你每月在此应用中的支出。',
    cap: '你本月已用掉的支出上限',
    resets: (date: string) => `${date} 重置`
  },
  header: '账单',
  actions: {
    save: '保存',
    saving: '正在保存…',
    cancel: '取消',
    undo: '撤销',
    undoing: '正在撤销…',
    tryAgain: '重试',
    dismiss: '关闭',
    openPortal: '打开门户',
    verify: '验证后继续',
    openVerification: '打开验证页面',
    turnOff: '关闭'
  },
  status: {
    processing: '正在处理你的付款…',
    added: (amount: string) => `已添加 ${amount}，余额正在刷新。`,
    waitingLink: '正在等待验证链接…'
  },
  autoRefill: {
    thresholdShort: '低于',
    reloadToShort: '充值到',
    confirmOff: '要关闭自动充值吗？',
    updated: '自动充值已更新。',
    turnedOff: '自动充值已关闭。',
    thresholdName: '阈值',
    reloadToName: '充值金额',
    badFormat: (name: string) => `${name}需要填写最多两位小数的美元金额。`,
    notPositive: (name: string) => `${name}必须大于 $0。`,
    belowMin: (name: string, min: string) => `${name}不能低于 ${min}。`,
    aboveMax: (name: string, max: string) => `${name}不能高于 ${max}。`,
    order: '充值金额必须高于阈值。'
  },
  provenance: {
    autoRefill: '用于自动充值',
    customerDefault: '你的默认卡',
    subPin: '用于你的订阅'
  },
  plans: {
    titleUpgrade: (tier: string) => `升级到 ${tier} 方案`,
    titleDowngrade: (tier: string) => `降级到 ${tier} 方案`,
    titleScheduled: (tier: string) => `本期结束时你将改用 ${tier} 方案`,
    title: '套餐',
    empty: '目前没有其他可更换的套餐。',
    current: '当前套餐',
    scheduled: '已安排',
    downgrade: '降级',
    checking: '正在检查此更改…',
    blocked: '无法在这里进行此更改。',
    noOp: (tier: string) => `你已在使用 ${tier}，无需更改。`,
    scheduledChange: (tier: string, when: string) =>
      `你将在 ${when} 改为 ${tier}。现在不会扣费，在此之前你仍使用当前套餐。`,
    creditsChange: (delta: string) => `你的每月额度将变化 ${delta}。`,
    cannotSchedule: '无法在这里安排此更改。',
    confirm: '确认降级',
    scheduling: '正在安排…',
    perMonth: (amount: string) => `${amount}/月`,
    creditsPerMonth: (amount: string) => `每月 ${amount} 额度`
  },
  refusal: {
    consentTitle: '请在门户中确认这张卡',
    consentMessage: '在本应用向这张卡扣费之前，需要你在门户中批准。',
    scopeTitle: '请先允许此设备消费',
    scopeMessage: '开始一次充值以允许此设备消费，然后重试。',
    stoppedTitle: '此设备的消费已被停止',
    stoppedByAdmin: '管理员已停止此设备的消费。重新登录即可允许。',
    stoppedByYou: '你已停止此设备的消费。重新登录即可允许。',
    sessionTitle: '你已退出登录',
    sessionMessage: '请重新登录以继续使用账单功能。',
    disabledTitle: '此应用的消费已关闭',
    disabledMessage: '账单管理员可以在门户中开启。',
    roleTitle: '只有管理员可以充值',
    roleMessage: '请联系组织的管理员或所有者，或在门户中管理账单。',
    conflictTitle: '请开始新的充值',
    conflictMessage: '这笔充值已用于其他金额，请重新开始。',
    noCardTitle: '请先在门户中保存一张卡',
    noCardMessage: '单次购买额度不会保存可重复使用的卡。请在门户中添加。',
    orgTitle: '你无法管理此组织',
    orgMessage: '此登录未关联到你管理的组织。',
    capTitle: '你已达到每月消费上限',
    capMessage: '请在门户中提高上限，或等待其重置。',
    capRemaining: (amount: string) => `距离每月上限还剩 ${amount}。`,
    busyTitle: '同时扣费过多',
    busyMessage: '这不是付款失败。请稍等片刻后重试。',
    retryIn: (minutes: number) => `请在约 ${minutes} 分钟后重试。`,
    paymentServiceTitle: '支付服务出现问题',
    paymentServiceMessage: '请稍等片刻后重试。',
    planLimitTitle: '你今天更换套餐的次数过多',
    planLimitMessage: '请明天再试。',
    unavailableTitle: '这里无法使用账单',
    unavailableMessage: '此连接不提供账单功能，请稍后重试。',
    timeoutTitle: '账单响应时间过长',
    timeoutMessage: '请检查网络连接后重试。',
    offlineTitle: '无法连接到账单服务',
    offlineMessage: '请检查网络连接后重试。',
    failedTitle: '账单无法完成此请求',
    failedMessage: '请稍后重试。'
  },
  charge: {
    added: (amount: string) => `已向你的余额添加 ${amount}。`,
    addedGeneric: '额度已添加到你的余额。',
    failedTitle: '付款未成功',
    bankCheck: '你的银行需要验证这笔付款，请在门户中完成。',
    expired: '你的卡已过期，请在门户中更新。',
    declined: '你的卡被拒绝，请在门户中换一张卡。',
    failedGeneric: '请重试，或在门户中使用其他卡。',
    unconfirmedTitle: '你上一笔付款尚未确认',
    unconfirmed: '重试前请先在门户中查看余额。',
    checkFailedTitle: '无法检查这笔付款',
    untrackedTitle: '无法跟踪这笔付款',
    untrackedMessage: '付款已被接受，但无法跟踪。请在门户中查看余额。',
    slowTitle: '付款仍在处理中',
    slowMessage: '它可能仍会成功。重试前请先查看门户。'
  },
  stepUp: {
    deniedTitle: '验证未获批准',
    deniedMessage: '此设备仍不允许消费。',
    doneTitle: '验证已完成',
    doneMessage: '此设备现在可以使用你的账户消费。'
  },
  devFixture: '计费预览数据（仅开发）'
}
