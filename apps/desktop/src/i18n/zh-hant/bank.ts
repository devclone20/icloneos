import type { TranslationOverrides } from '../define-locale'

export const bank: TranslationOverrides['bank'] = {
  card: {
    cardholder: '持卡人',
    tapToFlip: '點按翻轉',
    spendLimit: '消費額度',
    lastSpendLimit: '上次消費額度',
    spent: '已消費',
    status: '狀態',
    funding: '資金來源',
    active: '有效',
    locked: '已鎖定',
    notSignedUp: '未註冊',
    signedOut: '已登出',
    showFront: '顯示卡片正面',
    showBack: '顯示卡片背面'
  },
  gate: {
    notSetUpLabel: 'AgentCard — 尚未設定',
    signedOutLabel: 'AgentCard — 已登出',
    signInRequiredLabel: 'AgentCard — 需要登入',
    noCardTitle: '還沒有卡',
    noCardHint: agentName => `只要設定一次 AgentCard，${agentName} 就能為自己的購買付款——你核准額度，它負責結帳。`,
    stepSignUp: '註冊',
    stepSignUpHint: '為代理建立 AgentCard 帳戶。',
    stepVerify: '驗證',
    stepVerifyHint: '登入連結會寄到代理自己的收件匣。',
    stepPayment: '付款方式',
    stepPaymentHint: '連結一張卡或一個錢包為其儲值。',
    stepLimit: '額度',
    stepLimitHint: '設定它無需詢問你即可消費的金額。',
    openSetup: '開啟設定精靈',
    signInRequired: '需要登入',
    useCardAgain: '請重新登入 Virtuals 以使用此卡',
    readCardAgain: '請重新登入 Virtuals 以讀取 AgentCard',
    signInAgain: '重新登入',
    linkSentAgo: ago => `${ago}寄出`,
    resendLink: '重新寄送連結',
    resendIn: seconds => `${seconds} 秒後可重新寄送`,
    agentInbox: agentName => `${agentName} 的收件匣`,
    linkSentCardKnown: '請重新登入 AgentCard——登入連結已寄至 {target}',
    linkSent: '登入連結已寄至 {target}——開啟「郵件」App，點擊連結，然後繼續設定。',
    askFetchLink: agentName => `請 ${agentName} 取得連結`,
    otherPath:
      '設定 AgentCard 有兩種方式：在這裡的設定精靈中，透過 Virtuals 為此代理設定卡片（acp card）；或在終端機中使用你自己的 AgentCard 帳戶——先執行 agentcard signup，再執行 agentcard setup 與用於 KYC 的 agentcard identity。這是兩個獨立的帳戶。',
    agentcardAccount: {
      signedOut: '你自己的 AgentCard 帳戶已登出。',
      kycRequired: '你自己的 AgentCard 帳戶需要身分驗證（KYC）。',
      ready: '你自己的 AgentCard 帳戶已就緒。'
    },
    linkNotRecorded: '未傳送任何內容——傳送前無法先儲存紀錄'
  },
  notice: {
    tryAgain: '重試'
  },
  account: {
    label: '帳戶',
    unavailable: reason => `無法取得個人資料——${reason}`,
    onFileHidden: '個人資料已存檔——不顯示詳細資訊。',
    noName: '尚無姓名',
    noPhone: '尚無電話',
    needsNamePhone: 'AgentCard 需要姓名和電話才能結帳。',
    changeInSetup: '在設定精靈中變更'
  },
  stats: {
    reading: '讀取中…',
    notSet: '尚未設定',
    limitLeft: (left, total) => `剩餘 ${left}，共 ${total}`,
    openRequests: '待處理請求',
    reviewFirst: '查看第一筆',
    nothingWaiting: '沒有待處理項目',
    codesWaiting: '待用 3DS 驗證碼',
    codesLive: '有效——剩幾分鐘'
  },
  toolbar: {
    changeLimit: '變更額度',
    issueCard: '為一筆購買發卡',
    readOnly: agentName => `AgentCard · 唯讀——發卡需透過 ${agentName}`
  },
  requests: {
    title: '消費請求',
    tabOpen: '待處理',
    tabAll: '全部',
    showAll: '顯示全部',
    nothingOpenTitle: '沒有待處理請求',
    nothingOpenHint: agentName => `${agentName} 的所有請求都已處理——沒有需要你處理的事項。`,
    emptyTitle: '還沒有消費請求',
    emptyHint: (agentName, action) => `當 ${agentName} 為某樣東西付款時，請求會顯示在這裡。用「${action}」發起一筆。`,
    colRequest: '請求',
    colCaptured: '已扣款',
    colStatus: '狀態',
    colIssued: '發卡時間',
    colExpires: '到期',
    expires: ago => `到期 ${ago}`,
    updated: ago => `更新於 ${ago}`
  },
  detail: {
    title: '消費請求',
    close: '關閉請求',
    request: '請求',
    amount: '金額',
    status: '狀態',
    created: '建立時間',
    issued: '發卡時間',
    captured: '已扣款',
    capturedAt: '扣款時間',
    expires: '到期',
    card: '卡片'
  },
  codes: {
    title: '3DS 驗證碼',
    active: count => `${count} 個有效`,
    none: '目前沒有 3DS 驗證碼——你的代理觸發結帳後，驗證碼會在這裡顯示約五分鐘。',
    left: time => `剩餘 ${time}`,
    expired: '已過期',
    amountNotGiven: '未提供金額'
  },
  checking: '正在檢查卡片…',
  agentFallback: '你的代理'
}
