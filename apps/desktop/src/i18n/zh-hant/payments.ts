// iclone os — V3-J 設定 › 經濟 › 付款 (zh-hant)。
import type { PaymentsTranslations } from '../types/payments'

export const payments: PaymentsTranslations = {
  navLabel: '付款',
  keywords: ['x402', 'USDC', '支出', '上限', '停止', '授權書'],
  intro: '你的智慧代理可以付款給什麼、付給誰、每天多少。提高上限或新增收款方會先詢問你；降低會立即生效。',
  desktopOnly: '付款在桌面應用程式中執行，金鑰保存在這台 Mac 上。',
  status: {
    title: '狀態',
    ready: '就緒',
    off: '關閉',
    readyHint: '智慧代理可以在你簽署的授權書下、在下方上限內付款。',
    pocket: '錢包地址',
    pocketHint: '這台 Mac 上智慧代理的錢包。儲值請勿超過你的每日上限。',
    noPocket: '尚無錢包',
    today: '今日已簽署 (UTC)',
    todayValue: (amount, cap) => `${amount} / ${cap} USDC`,
    ledgerBroken: '付款紀錄無法驗證：在修復之前，所有付款都會被拒絕。',
    unprotected: '未受保護的設定檔',
    unprotectedHint:
      '應用程式無法確認這些設定檔中的付款技能已關閉（資料夾或 config.yaml 位於 Hermes 主目錄之外，或無法讀取或寫入）：其中的智慧代理無法付款。',
    notReady: {
      sealing_off:
        '付款已關閉：鑰匙圈設定已關閉，無法封存付款金鑰。請在 設定 › 裝置 › 閘道 ›「把已儲存的密碼存入系統鑰匙圈」 中開啟鑰匙圈，即可使用付款。',
      keys_unavailable: '已封存的付款金鑰無法使用，因此付款已關閉。',
      disabled: '付款已關閉。',
      socket_down: '智慧代理用於付款的連線未在執行。'
    }
  },
  caps: {
    title: '支出上限',
    perTx: '每筆付款',
    perTxHint: '超過此金額的單筆付款會被拒絕。',
    perDay: '每天',
    perDayHint: '所有智慧代理合計，以 UTC 日計算。',
    perAgentDay: '每個智慧代理每天',
    perAgentDayHint: '每個智慧代理自己的上限：遭入侵的智慧代理一天最多能花的金額。',
    save: '儲存上限',
    invalid: '請輸入 USDC 金額，最多 6 位小數。',
    note: '提高上限會在權限請求中詢問你。降低會立即生效。'
  },
  stop: {
    title: '緊急停止',
    label: '停止所有付款',
    hint: '拒絕所有付款，包括進行中的付款。關閉它會在權限請求中詢問你。'
  },
  allowlist: {
    title: '智慧代理可以付款給誰',
    payees: '收款方',
    payeesHint: '智慧代理可以付款的地址。清單為空時，不能付款給任何人。',
    origins: '網站',
    originsHint: '智慧代理可以回應其付款請求的網站。清單為空時，不回應任何請求。',
    add: '新增',
    remove: '移除',
    invalidPayee: '不是地址：應為 0x 加 40 個十六進位字元。',
    invalidOrigin: '不是網站地址：請以 https:// 或 http:// 開頭。',
    full: max => `清單已滿（${max} 個項目）。請先移除一個。`,
    listed: '已在清單中。',
    empty: '尚無',
    problems: {
      notList: list => `${list}：不是清單。`,
      tooMany: (list, count, max) => `${list}：${count} 項，最多 ${max} 項。`,
      entries: (list, entries, more) => `${list}：${entries}${more > 0 ? `（另有 ${more} 項）` : ''}`
    }
  },
  issue: {
    title: '新授權書',
    intro:
      '授權書是你簽署的、允許一個智慧代理付款的許可：總額、每次金額、付給誰、到什麼時候。沒有授權書，智慧代理無法付款。',
    agent: '智慧代理',
    agentHint: '智慧代理的設定檔名稱，例如 inft-alpha。',
    budget: '預算',
    budgetHint: '此授權書下所有付款合計的上限。初始值為你設定的每個智慧代理每日上限。',
    min: '最小付款',
    max: '最大付款',
    rangeHint: '每筆付款必須在此範圍內。最大值初始為每筆付款上限。',
    payees: '可付給',
    payeesHint: '只能從上方清單中選擇收款方。',
    noPayees: '請先在上方清單中新增收款方。',
    starts: '付款開始',
    ends: '付款截止',
    expires: '授權書到期',
    datesHint: '使用你的當地時間。授權書最長 90 天。',
    review: '你將要簽署的內容',
    payee: '收款方',
    summary: {
      agent: agent => `用於 ${agent}`,
      budget: budget => `總計不超過 ${budget} USDC`,
      range: (min, max) => `每筆付款在 ${min} 到 ${max} USDC 之間`,
      payees: count => `付給 ${count} 個收款方：`,
      window: (from, to) => `允許付款時間：${from} 至 ${to}`,
      expires: at => `授權書於 ${at} 到期`,
      caps: (perTx, perDay, perAgentDay) =>
        `你的上限仍然適用：每筆 ${perTx} USDC，每天 ${perDay} USDC，每個智慧代理每天 ${perAgentDay} USDC。`
    },
    problems: {
      agent: '請輸入智慧代理的設定檔名稱：小寫字母、數字、- 和 _。',
      amount: '請檢查金額：大於零，最多 6 位小數，且最小 ≤ 最大 ≤ 預算。',
      dates: '請檢查日期：付款開始早於截止，截止不晚於到期時間，到期時間在未來且不超過 90 天。',
      payees: '請從清單中至少選擇一個收款方。'
    },
    sign: '簽署授權書…',
    signHint: '你會在顯示全部條款的權限確認中再確認一次。之後撤銷會立即生效。',
    signed: '授權書已簽署。'
  },
  mandates: {
    title: '授權書',
    empty: '沒有授權書。智慧代理只能在你簽署的授權書下付款。',
    forAgent: agent => `用於 ${agent}`,
    terms: (budget, expires) => `預算 ${budget} USDC · ${expires} 到期`,
    revoked: '已撤銷',
    revoke: '撤銷'
  },
  saved: '已儲存',
  refusals: {
    allowlist: '未變更：每個清單最多 50 個有效項目，且不能重複。',
    door_denied: '未變更：權限請求被拒絕或已逾時。',
    gesture: '未變更：此變更需要你親自點擊。',
    invalid: '未變更：請求無效。',
    ledger: '未變更：無法寫入付款紀錄。',
    no_door: '未變更：權限請求無法使用。',
    not_ready: '付款無法使用。',
    settings_moved: '設定在此期間已變更。請檢查後再試一次。',
    unavailable: '此版本無法使用。',
    unknown: '發生問題。沒有做任何變更。'
  }
}
