// iclone os — V3-I ACP 市場 › 工作（繁體中文）。
import type { AcpWorkTranslations } from '../types/acpWork'

export const acpWork: AcpWorkTranslations = {
  tab: '工作',
  states: {
    offline: '離線',
    starting: '正在啟動',
    online: '在線',
    draining: '正在安全下線',
    'offline-safe': '已離線，所有任務已結清',
    failed: '需要你處理'
  },
  onlineMeaning: '在線表示它的任務監聽器已從這台 Mac 連線。市場是否顯示它在線尚未驗證。',
  desktopOnly: '工作功能在桌面應用程式中執行，由它讓代理從你的 Mac 保持在線。',
  awakeOnly: '關閉此視窗後它仍保持在線，前提是這台 Mac 處於喚醒狀態。',
  actions: { online: '上線', offline: '下線', reboot: '重新啟動監聽器', refresh: '立即讀取任務' },
  autonomy: {
    title: '自主程度',
    levels: {
      L0: { name: '僅觀察', summary: '尋找並排序工作，一切由你來做。' },
      L1: { name: '逐一核准', summary: '符合你政策的報價在這裡等待你核准。' },
      L2: { name: '依政策行動', summary: '自行為符合政策的報價出價。只有你本人的點擊才能開啟。' }
    },
    downgrade: {
      'chain-broken': '工作帳本驗證失敗，在處理之前只觀察。',
      'spend-trade-off': '「設定 › 隱私」中的支出與交易已關閉，因此只觀察。'
    },
    earnOnly: '只賺不花：它從不支出、僱用或儲值。'
  },
  writesOff: '在此版本中，核准會被記錄，報價會被保留，不會送出。',
  offers: {
    title: '報價',
    empty: '尚無報價',
    emptyHint: '向此 iNFT 提出的任務請求會連同政策結論顯示在這裡。',
    approve: '核准',
    decline: '拒絕',
    standing: {
      pending: '等待你處理',
      approved: '已核准',
      declined: '已拒絕',
      refused: '被政策拒絕',
      seen: '已檢視'
    },
    rules: {
      spend: '它要求此 iNFT 出資',
      token: '使用政策不接受的代幣支付',
      chain: '位於政策不接受的鏈上',
      'requester-denied': '請求方在拒絕名單上',
      'requester-unknown': '請求方不在允許名單上',
      class: '政策不接受的工作類型',
      'price-floor': '費用低於下限或未註明',
      'open-cap': '進行中的任務已過多',
      oversize: '請求超過大小上限'
    },
    price: amount => `費用 ${amount}`,
    requester: address => `來自 ${address}`
  },
  groups: { 'in-flight': '進行中', completed: '已完成', payments: '收款', history: '歷史' },
  groupsEmpty: '這裡還沒有內容。',
  trace: { offer: '報價', job: '任務', budget: '預算', deliverable: '已交付', payment: '已付款', gap: '缺少' },
  totals: { earned: '已賺取', spent: '已支出', escrow: '託管中' },
  fixes: {
    title: '修復',
    empty: '沒有任何失敗。',
    causes: {
      'listener-exited': '監聽器已結束',
      'needs-sign-in': '代理需要重新登入',
      'owner-reboot': '你要求了重新啟動',
      'read-failed': '無法讀取任務清單',
      'tools-missing': 'ACP 工具未安裝或無法驗證'
    },
    actions: {
      'restart-backoff': '正在重新啟動，每次等待更久（最多一分鐘）',
      restarted: '已重新啟動監聽器',
      'stopped-for-sign-in': '已停止重試——請在設定中登入，然後讓它上線',
      'retry-next-poll': '將在下次檢查時重新讀取',
      'stopped-for-tools': '已停止 — 請在 ACP Market 中安裝 ACP 工具，然後讓它上線'
    },
    now: state => `目前：${state}`
  },
  draining: jobs => `監聽器停止前正在等待任務 ${jobs}。`,
  drainUnknown: '監聽器停止前，正在等待一份可信的任務清單。',
  stopReport: (open, escrow) => (open === 0 ? '沒有進行中的任務。' : `仍有 ${open} 個任務進行中，託管 ${escrow}。`),
  readError: detail => `上次讀取失敗：${detail}`,
  holds: {
    'signed-out': '離線：你已登出，所有監聽器都已停止。請先登入，再讓它上線。',
    'wallet-switch': '離線：錢包已更換，所有監聽器都已停止。只有持有此 iNFT 的錢包才能讓它上線。',
    'ownership-lost': '離線：此 iNFT 已不在你的錢包中，它的監聽器已停止。',
    'ownership-unverified': '正在確認此 iNFT 仍在你的錢包中，確認後才會重新上線。'
  },
  repair: {
    action: '修復帳本',
    hint: '修復會保留所有能通過驗證的記錄，把損壞的檔案另存，並記下缺口。「依政策行動」需要重新選擇。'
  },
  chainGaps: count => `有 ${count} 次寫入被中斷或修復，帳本已逐一記下缺口。`,
  chainBroken: '工作帳本驗證失敗。',
  errors: {
    gesture: '這需要你本人的點擊。',
    invalid: '該任務已不再是待處理的報價。',
    policy: '政策拒絕了這個報價。',
    state: '現在不行——代理僅在觀察或正在下線。',
    ownership: '目前無法證明此 iNFT 在你的錢包中。',
    'sign-in': '請先用持有此 iNFT 的錢包登入。',
    busy: '仍在處理上一個請求。',
    tools: '請先安裝 ACP 工具（ACP Market › 安裝）。'
  },
  refusedBy: rule => `已拒絕：${rule}`
}
