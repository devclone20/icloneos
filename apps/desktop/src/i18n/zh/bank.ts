import type { Translations } from '../types'

export const bank: Translations['bank'] = {
  card: {
    cardholder: '持卡人',
    tapToFlip: '点按翻转',
    spendLimit: '消费限额',
    lastSpendLimit: '上次消费限额',
    spent: '已消费',
    status: '状态',
    funding: '资金来源',
    active: '有效',
    locked: '已锁定',
    notSignedUp: '未注册',
    signedOut: '已退出登录',
    showFront: '显示卡片正面',
    showBack: '显示卡片背面'
  },
  gate: {
    notSetUpLabel: 'AgentCard — 未设置',
    signedOutLabel: 'AgentCard — 已退出登录',
    signInRequiredLabel: 'AgentCard — 需要登录',
    noCardTitle: '还没有卡',
    noCardHint: agentName => `只需设置一次 AgentCard，${agentName} 就能为自己的购买付款——你批准限额，它负责结账。`,
    stepSignUp: '注册',
    stepSignUpHint: '为智能体创建 AgentCard 账户。',
    stepVerify: '验证',
    stepVerifyHint: '登录链接会发送到智能体自己的收件箱。',
    stepPayment: '付款方式',
    stepPaymentHint: '关联一张卡或一个钱包为其充值。',
    stepLimit: '限额',
    stepLimitHint: '设置它无需询问你即可消费的金额。',
    openSetup: '打开设置向导',
    signInRequired: '需要登录',
    useCardAgain: '请重新登录 Virtuals 以使用此卡',
    readCardAgain: '请重新登录 Virtuals 以读取 AgentCard',
    signInAgain: '重新登录',
    linkSentAgo: ago => `${ago}发送`,
    resendLink: '重新发送链接',
    resendIn: seconds => `${seconds} 秒后可重新发送`,
    agentInbox: agentName => `${agentName} 的收件箱`,
    linkSentCardKnown: '请重新登录 AgentCard——登录链接已发送至 {target}',
    linkSent: '登录链接已发送至 {target}——打开“邮件”应用，点击链接，然后继续设置。',
    askFetchLink: agentName => `让 ${agentName} 获取链接`,
    otherPath:
      '设置 AgentCard 有两种方式：在这里的设置向导中，通过 Virtuals 为此智能体设置卡（acp card）；或在终端中使用你自己的 AgentCard 账户——先运行 agentcard signup，再运行 agentcard setup 和用于 KYC 的 agentcard identity。这是两个独立的账户。',
    agentcardAccount: {
      signedOut: '你自己的 AgentCard 账户已退出登录。',
      kycRequired: '你自己的 AgentCard 账户需要身份验证（KYC）。',
      ready: '你自己的 AgentCard 账户已就绪。'
    },
    linkNotRecorded: '未发送任何内容——发送前无法先保存记录'
  },
  notice: {
    tryAgain: '重试'
  },
  account: {
    label: '账户',
    unavailable: reason => `无法获取资料——${reason}`,
    onFileHidden: '资料已存档——详情不显示。',
    noName: '尚无姓名',
    noPhone: '尚无电话',
    needsNamePhone: 'AgentCard 需要姓名和电话才能结账。',
    changeInSetup: '在设置向导中更改'
  },
  stats: {
    reading: '读取中…',
    notSet: '尚未设置',
    limitLeft: (left, total) => `剩余 ${left}，共 ${total}`,
    openRequests: '待处理请求',
    reviewFirst: '查看第一个',
    nothingWaiting: '没有待处理项',
    codesWaiting: '待用 3DS 验证码',
    codesLive: '有效——剩余几分钟'
  },
  toolbar: {
    changeLimit: '更改限额',
    issueCard: '为一笔购买发卡',
    readOnly: agentName => `AgentCard · 只读——发卡需通过 ${agentName}`
  },
  requests: {
    title: '消费请求',
    tabOpen: '待处理',
    tabAll: '全部',
    showAll: '显示全部',
    nothingOpenTitle: '没有待处理请求',
    nothingOpenHint: agentName => `${agentName} 的所有请求都已处理——没有需要你处理的事项。`,
    emptyTitle: '还没有消费请求',
    emptyHint: (agentName, action) => `当 ${agentName} 为某样东西付款时，其请求会显示在这里。用“${action}”发起一个。`,
    colRequest: '请求',
    colCaptured: '已扣款',
    colStatus: '状态',
    colIssued: '发卡时间',
    colExpires: '到期',
    expires: ago => `到期 ${ago}`,
    updated: ago => `更新于 ${ago}`
  },
  detail: {
    title: '消费请求',
    close: '关闭请求',
    request: '请求',
    amount: '金额',
    status: '状态',
    created: '创建时间',
    issued: '发卡时间',
    captured: '已扣款',
    capturedAt: '扣款时间',
    expires: '到期',
    card: '卡片'
  },
  codes: {
    title: '3DS 验证码',
    active: count => `${count} 个有效`,
    none: '目前没有 3DS 验证码——你的智能体触发结账后，验证码会在这里显示约五分钟。',
    left: time => `剩余 ${time}`,
    expired: '已过期',
    amountNotGiven: '未提供金额'
  },
  checking: '正在检查卡片…',
  agentFallback: '你的智能体'
}
