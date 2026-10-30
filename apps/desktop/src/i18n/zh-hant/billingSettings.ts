/** The words of the Billing Settings pane (front I-C, 2026-10-20). */
import type { BillingSettingsCopy } from '../en/billingSettings'

export const zhHantBillingSettings: BillingSettingsCopy = {
  sections: {
    plan: '你的方案',
    payment: '付款方式與額度',
    usage: '餘額與用量',
    invoices: '發票'
  },
  providerBilling: {
    title: '帳單由你連接的模型提供商處理',
    hint: '這個應用程式使用你新增的金鑰運行，用量和費用都在該提供商那裡。登入 Nous Portal 訂閱後，其方案和用量會顯示在這裡。',
    openProviders: '開啟提供商'
  },
  empty: {
    title: '這個連線沒有需要計費的內容',
    hint: '計費屬於 Nous Portal 代管的帳戶。這個應用程式使用你自己的金鑰執行，因此這裡沒有需要計量或收費的內容；用量和費用由你的模型供應商管理。'
  },
  summary: {
    balance: '餘額',
    plan: '方案',
    refill: '自動儲值',
    enabled: '已開啟',
    off: '已關閉'
  },
  notice: {
    openPortal: '開啟入口網站 ↗',
    noCardTitle: '沒有登記付款方式',
    noCardMessage: '登記銀行卡之前，購買儲值額度和自動儲值都無法使用。請在入口網站中新增。',
    addCard: '新增銀行卡 ↗'
  },
  payment: {
    title: '你用來付款的銀行卡',
    hint: '用於儲值和訂閱續約。',
    noneHint: '尚未登記銀行卡。',
    add: '新增付款方式',
    update: '更新'
  },
  buy: {
    title: '立即購買額度',
    hint: '對你的銀行卡扣款一次，今天就計入餘額。',
    action: '購買',
    customAmount: '自訂額度'
  },
  refill: {
    title: '餘額不足時自動儲值',
    generic: '餘額低於門檻時自動補足。',
    manage: '管理',
    manageOnPortal: '請在入口網站中管理自動儲值。',
    turnOnPortal: '請在入口網站中開啟自動儲值',
    reconcile: '核對 ↗',
    differentCard: '另一張銀行卡',
    threshold: '自動儲值門檻',
    reloadTo: '自動儲值補足金額',
    distinctCaption: (card: string) => `自動儲值從 ${card} 扣款——請在入口網站中核對`,
    charges: (reloadTo: string, threshold: string) => `餘額低於 ${threshold} 時自動扣款 ${reloadTo}。`
  },
  plan: {
    currentTitle: (tier: string) => `你正在使用 ${tier} 方案`,
    free: '免費',
    unavailable: '無法取得訂閱詳情，但仍可開啟入口網站。',
    noSubscription: '沒有有效的訂閱——付費模型會消耗儲值額度。',
    change: '變更方案',
    view: '查看方案',
    adjust: '調整方案 ↗',
    choose: '選擇 ↗',
    back: '返回計費',
    changesTo: (tier: string, when: string) => `將於 ${when} 變更為 ${tier}。`,
    cancels: (when: string) => `將於 ${when} 取消。`,
    renews: (date: string) => `${date} 續約`
  },
  usage: {
    left: (left: string, total: string) => `剩餘 ${left}，共 ${total}`,
    over: (amount: string) => `超出 ${amount}`,
    used: (spent: string, limit: string) => `已用 ${spent}，共 ${limit}`,
    subscriptionRemaining: '訂閱剩餘額度',
    subscription: '你的訂閱還剩下的額度',
    noExpiry: '永不過期。',
    topup: '你自己購買的額度',
    capUsed: '本月支出上限已用',
    defaultCeiling: '這是你帳戶的預設上限。',
    monthlyRemote: '統計你每月在此應用程式中的支出。',
    cap: '你本月已用掉的支出上限',
    resets: (date: string) => `${date} 重設`
  },
  header: '帳單',
  actions: {
    save: '儲存',
    saving: '正在儲存…',
    cancel: '取消',
    undo: '復原',
    undoing: '正在復原…',
    tryAgain: '重試',
    dismiss: '關閉',
    openPortal: '開啟入口網站',
    verify: '驗證後繼續',
    openVerification: '開啟驗證頁面',
    turnOff: '關閉'
  },
  status: {
    processing: '正在處理你的付款…',
    added: (amount: string) => `已加入 ${amount}，餘額正在重新整理。`,
    waitingLink: '正在等待驗證連結…'
  },
  autoRefill: {
    thresholdShort: '低於',
    reloadToShort: '儲值到',
    confirmOff: '要關閉自動儲值吗？',
    updated: '自動儲值已更新。',
    turnedOff: '自動儲值已關閉。',
    thresholdName: '門檻',
    reloadToName: '儲值金額',
    badFormat: (name: string) => `${name}需要填寫最多兩位小數的美元金額。`,
    notPositive: (name: string) => `${name}必須大於 $0。`,
    belowMin: (name: string, min: string) => `${name}不能低於 ${min}。`,
    aboveMax: (name: string, max: string) => `${name}不能高於 ${max}。`,
    order: '儲值金額必須高於門檻。'
  },
  provenance: {
    autoRefill: '用於自動儲值',
    customerDefault: '你的預設卡',
    subPin: '用於你的訂閱'
  },
  plans: {
    titleUpgrade: (tier: string) => `升級到 ${tier} 方案`,
    titleDowngrade: (tier: string) => `降級到 ${tier} 方案`,
    titleScheduled: (tier: string) => `本期結束時你將改用 ${tier} 方案`,
    title: '方案',
    empty: '目前沒有其他可更換的方案。',
    current: '目前方案',
    scheduled: '已排定',
    downgrade: '降級',
    checking: '正在檢查此變更…',
    blocked: '無法在這裡進行此變更。',
    noOp: (tier: string) => `你已在使用 ${tier}，無需變更。`,
    scheduledChange: (tier: string, when: string) =>
      `你將在 ${when} 改為 ${tier}。現在不會扣款，在此之前你仍使用目前方案。`,
    creditsChange: (delta: string) => `你的每月額度將變化 ${delta}。`,
    cannotSchedule: '無法在這裡排定此變更。',
    confirm: '確認降級',
    scheduling: '正在排定…',
    perMonth: (amount: string) => `${amount}/月`,
    creditsPerMonth: (amount: string) => `每月 ${amount} 額度`
  },
  refusal: {
    consentTitle: '請在入口網站中確認這張卡',
    consentMessage: '在本應用程式向這張卡扣款之前，需要你在入口網站中核准。',
    scopeTitle: '請先允許此裝置消費',
    scopeMessage: '開始一次儲值以允許此裝置消費，然後重試。',
    stoppedTitle: '此裝置的消費已被停止',
    stoppedByAdmin: '管理員已停止此裝置的消費。重新登入即可允許。',
    stoppedByYou: '你已停止此裝置的消費。重新登入即可允許。',
    sessionTitle: '你已登出',
    sessionMessage: '請重新登入以繼續使用帳單功能。',
    disabledTitle: '此應用程式的消費已關閉',
    disabledMessage: '帳單管理員可以在入口網站中開啟。',
    roleTitle: '只有管理員可以儲值',
    roleMessage: '請聯絡組織的管理員或擁有者，或在入口網站中管理帳單。',
    conflictTitle: '請開始新的儲值',
    conflictMessage: '這筆儲值已用於其他金額，請重新開始。',
    noCardTitle: '請先在入口網站中儲存一張卡',
    noCardMessage: '單次購買額度不會儲存可重複使用的卡。請在入口網站中加入。',
    orgTitle: '你無法管理此組織',
    orgMessage: '此登入未連結到你管理的組織。',
    capTitle: '你已達到每月消費上限',
    capMessage: '請在入口網站中提高上限，或等待其重設。',
    capRemaining: (amount: string) => `距離每月上限還剩 ${amount}。`,
    busyTitle: '同時扣款過多',
    busyMessage: '這不是付款失敗。請稍候片刻後重試。',
    retryIn: (minutes: number) => `請在約 ${minutes} 分鐘後重試。`,
    paymentServiceTitle: '付款服務發生問題',
    paymentServiceMessage: '請稍候片刻後重試。',
    planLimitTitle: '你今天更換方案的次數過多',
    planLimitMessage: '請明天再試。',
    unavailableTitle: '這裡無法使用帳單',
    unavailableMessage: '此連線不提供帳單功能，請稍後重試。',
    timeoutTitle: '帳單回應時間過長',
    timeoutMessage: '請檢查網路連線後重試。',
    offlineTitle: '無法連線到帳單服務',
    offlineMessage: '請檢查網路連線後重試。',
    failedTitle: '帳單無法完成此要求',
    failedMessage: '請稍後重試。'
  },
  charge: {
    added: (amount: string) => `已向你的餘額加入 ${amount}。`,
    addedGeneric: '額度已加入到你的餘額。',
    failedTitle: '付款未成功',
    bankCheck: '你的銀行需要驗證這筆付款，請在入口網站中完成。',
    expired: '你的卡已過期，請在入口網站中更新。',
    declined: '你的卡被拒絕，請在入口網站中換一張卡。',
    failedGeneric: '請重試，或在入口網站中使用其他卡。',
    unconfirmedTitle: '你上一筆付款尚未確認',
    unconfirmed: '重試前請先在入口網站中查看餘額。',
    checkFailedTitle: '無法檢查這筆付款',
    untrackedTitle: '無法追蹤這筆付款',
    untrackedMessage: '付款已被接受，但無法追蹤。請在入口網站中查看餘額。',
    slowTitle: '付款仍在處理中',
    slowMessage: '它可能仍會成功。重試前請先查看入口網站。'
  },
  stepUp: {
    deniedTitle: '驗證未獲核准',
    deniedMessage: '此裝置仍不允許消費。',
    doneTitle: '驗證已完成',
    doneMessage: '此裝置現在可以使用你的帳戶消費。'
  },
  devFixture: '計費預覽資料（僅限開發）'
}
