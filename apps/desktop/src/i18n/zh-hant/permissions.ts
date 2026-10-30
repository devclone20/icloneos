// iclone os — V3-F 權限模式（繁體中文）。設定 › 代理 › 權限，以及同意面板上的權限請求。
import { PRODUCT_NAME } from '@/i18n/en/enConsent'
import type { PermissionsCopy } from '@/i18n/en/enPermissions'
import { FUNCTION_COPY } from '@/iclone-shared/permission-function-copy'

export const zhHantPermissions: PermissionsCopy = {
  title: '權限',
  lead: `你的代理在這台 Mac 上無須詢問你即可做的事。只有你在這裡親手點擊才能變更——代理與更新都不能。`,
  enforcement: {
    enforced: '已生效：代理的每次工具呼叫都會先經過這些規則。',
    starting: '啟動中：正在確認代理已載入權限關卡。',
    'not-enforced': '未生效：權限關卡沒有回應，在代理重新啟動前其工具呼叫都會被拒絕。',
    'no-agent': '代理未在執行。',
    degraded: '系統鑰匙圈無法保護紀錄的金鑰：僅限手動模式，重新啟動後無法驗證紀錄。',
    // FX-2 r1b: the degraded state's cause when the owner's Keychain setting is off, and the fix.
    'keychain-off':
      '僅限手動：鑰匙圈設定已關閉，其他模式無法受到保護。請在 設定 › 裝置 › 閘道 ›「把已儲存的密碼存入系統鑰匙圈」 中開啟鑰匙圈，即可使用自動、計畫等模式。',
    // V3-FX M1: turned on while the app runs — payments and the ACP tools follow at once, the modes after a restart.
    'keychain-restart':
      '鑰匙圈已開啟。權限金鑰在 icloneOS 啟動時封存：請重新啟動 icloneOS 以使用自動、計畫等模式。付款和 ACP 工具已經可以使用。'
  },
  // r3/r4: the button beside the modes' restart line (the Keychain turned on since launch), and what it says
  // when main refuses the relaunch.
  restartNow: '立即重新啟動',
  restartRefused: 'icloneOS 現在無法重新啟動。請結束後重新開啟，即可使用這些模式。',
  modes: {
    ignore: { name: '忽略權限', summary: '除了花錢與申請系統權限外，一律不詢問直接執行。永遠不會成為預設。' },
    manual: { name: '手動', summary: '每次寫入、指令、連網、傳訊息、安裝與刪除前都會詢問。讀取不受限制。' },
    automatic: { name: '自動', summary: '自行在專案內寫入、執行安全的指令並瀏覽網頁，其餘都會詢問。' },
    plan: { name: '計畫', summary: '唯讀。代理只閱讀並在聊天中寫出計畫，不做任何變更。' },
    acceptEdits: { name: '接受編輯', summary: '自行編輯專案內的檔案，其餘一律詢問。' }
  },
  classes: {
    R: '讀取檔案',
    Wp: '寫入專案內的檔案',
    Wo: '寫入專案外的檔案',
    X: '執行指令',
    N: '使用網路',
    $: '花錢',
    M: '傳送訊息',
    S: '申請系統權限',
    I: '安裝軟體',
    D: '刪除檔案'
  },
  current: '使用中',
  choose: '使用',
  scope: {
    label: '適用於',
    standing: '所有地方',
    project: path => `此專案 · ${path}`,
    noProject: '開啟一個專案即可為它單獨選擇模式。'
  },
  ignoreConfirm: {
    standingOnly: '「忽略權限」不能作為所有地方的預設，請為單一專案選擇。'
  },
  refused: {
    gesture: '模式只能透過你親手點擊變更。',
    invalid: '此處無法選擇該模式。',
    unavailable: `權限模式需要 ${PRODUCT_NAME} 桌面 App。`
  },
  floor: {
    title: '在任何模式或層級下都絕不',
    items: [
      '清除磁碟、個人專屬資料夾或系統資料夾，格式化磁碟，或關閉 Mac',
      '變更自己的權限、此模式或其行為紀錄',
      '讀取你的金鑰、密碼、錢包助記詞或權杖並傳送到任何地方',
      `停止 ${PRODUCT_NAME}、其代理執行環境或此權限關卡`,
      '輸入你的管理者密碼或替自己開啟系統權限',
      '轉讓 iNFT 或為其簽署授權'
    ]
  },
  // V3-F2: the Functions matrix (shared with main's native raise confirm).
  functions: FUNCTION_COPY['zh-hant'],
  // FX-6: what confinement really does (on by default, V3-G); the pane picks the line for the live state.
  shellNote: {
    on: '代理指令預設在隔離中執行（Seatbelt），所有模式皆然，包括「忽略權限」：只能寫入專案和一個暫存資料夾，只有在模式或授權允許時才能連上網路。你可以在「容器」中選擇「這台 Mac」來關閉隔離。',
    off: '隔離已關閉（你在「容器」中選擇了「這台 Mac」）：在「忽略權限」與「自動」模式下，指令可能寫入專案之外。',
    // V3-FX M2: main's live verdict is red (on but not working), or not read yet.
    red: '隔離目前未生效（原因見「容器」）：在恢復之前，在「忽略權限」與「自動」模式下，指令可能寫入專案之外。',
    pending: '正在讀取隔離狀態…'
  },
  grants: {
    title: '你給出的權限',
    empty: '尚無。當你允許超過一次時，它會顯示在這裡。',
    scope: { session: '此聊天', project: '此專案', standing: '所有地方' },
    revoke: '撤銷'
  },
  // A-1：主處理程序在啟動時拒絕或無法驗證的權限狀態檔案。
  integrity: {
    mode: {
      tampered: `磁碟上的權限模式在 ${PRODUCT_NAME} 之外被變更或損毀，不再生效：在您重新選擇模式之前，所有位置均為手動。`,
      unverified: '權限模式由舊版本儲存，或在鑰匙圈關閉時儲存，因此無法驗證：在您重新選擇模式之前，所有位置均為手動。',
      missing: '權限模式檔案遺失：在您重新選擇模式之前，所有位置均為手動。'
    },
    functions: {
      tampered: `磁碟上的功能層級在 ${PRODUCT_NAME} 之外被變更或損毀，不再生效：在您重新選擇之前，每項功能均為手動。`,
      unverified:
        '功能層級由舊版本儲存，或在鑰匙圈關閉時儲存，因此無法驗證：比手動更寬的每個層級保持為手動，直到您在下方確認。',
      missing: '功能層級檔案遺失：在您重新選擇之前，每項功能均為手動。'
    },
    grants: {
      tampered: `您授予的權限在 ${PRODUCT_NAME} 之外被變更或損毀，不再生效：再次詢問時請重新允許。`,
      unverified: '您授予的權限由舊版本儲存，或在鑰匙圈關閉時儲存，因此無法驗證且不再生效：再次詢問時請重新允許。',
      missing: '您授予的權限檔案遺失；均不生效：再次詢問時請重新允許。'
    }
  },
  audit: {
    title: '活動',
    empty: '尚無紀錄。',
    chainOk: count => `${count} 筆紀錄 · 完整`,
    chainBroken: `紀錄有缺口，或在 ${PRODUCT_NAME} 之外被變更。`,
    otherKind: '權限紀錄',
    kinds: {
      use: '已允許',
      refuse: '已拒絕',
      ask: '已詢問你',
      answer: '你的回答',
      timeout: '無回答',
      mode_set: '模式已變更',
      mode_refused: '變更被拒絕',
      grant: '已授予權限',
      revoke: '已撤銷權限',
      gap: '缺口',
      restart: `${PRODUCT_NAME} 已啟動`,
      fn_level_set: '層級已變更',
      fn_level_refused: '層級變更被拒絕'
    },
    details: {
      denied: '你已拒絕',
      busy: '等待中的權限請求過多',
      withdrawn: '在你回答前已撤回',
      noGesture: '並非你親手點擊',
      notConfirmed: '未在系統對話框中確認',
      standingIgnore: '「忽略權限」不能成為所有地方的預設',
      invalid: '無效的變更',
      raced: '對話框開啟期間層級已變更',
      gateNotStarted: pid =>
        pid
          ? `Hermes 中的權限關卡（pid ${pid}）從未啟動；其工具呼叫會被拒絕`
          : 'Hermes 中的權限關卡從未啟動；其工具呼叫會被拒絕',
      gateStopped: pid => (pid ? `Hermes 中的權限關卡（pid ${pid}）已停止回應` : 'Hermes 中的權限關卡已停止回應'),
      unverified: count => `來自 Hermes 的 ${count} 行無法驗證，未被記錄`,
      missedEvents: count => `來自權限關卡的 ${count} 個事件從未到達`,
      confinementBurst: count => `該分鐘內另有 ${count} 次隔離拒絕只保存在 容器 › 拒絕紀錄 中`,
      confined: '被隔離攔截',
      gap: '有內容未能記錄',
      payment: {
        settled: '付款已結算',
        pending: '結算仍在等待中',
        failed: '付款未完成',
        ledger: '付款紀錄未通過驗證',
        limit: '超出 經濟 › 付款 中的限額',
        stopped: '緊急停止：所有付款都會被拒絕',
        payee: '收款方或網站不被允許',
        mandate: '沒有有效的授權書',
        denied: '你在權限請求中拒絕了',
        setting: '對 經濟 › 付款 的變更',
        service: '被付款服務拒絕',
        other: '一筆付款',
        unrecorded: '一筆未記入付款紀錄的付款',
        uncertain: '結果未知：請查看付款紀錄',
        stopOff: '緊急停止已解除',
        mandateIssued: '授權書已簽發',
        mandateRevoked: '授權書已撤銷',
        mandateChange: '對授權書的變更'
      }
    }
  },
  ask: {
    eyebrow: who => `權限請求 · ${who}`,
    title: what => `你的代理想要${what}`,
    targetLabel: '具體內容',
    expand: '顯示全部',
    collapse: '收合',
    reasonLabel: '原因（代理的原話）',
    effects: {
      R: '它只會讀取，不做任何變更。',
      Wp: '它會在專案內建立或修改此檔案。',
      Wo: '它會在專案外建立或修改此檔案。',
      X: '它會在這台 Mac 上執行此指令。',
      N: '它會透過網際網路傳送此請求。',
      $: '它會從你的錢包或卡片轉出這筆金額。',
      M: '它會以你的名義傳送此訊息。',
      S: '它會向 macOS 申請此權限；由你在系統設定中授予。',
      I: '它會為你的使用者安裝此軟體。',
      D: '它會刪除此內容。'
    },
    mode: name => `模式：${name}`,
    scopeLabel: '允許範圍',
    scopes: { once: '僅此一次', session: '此聊天', project: '此專案', standing: '所有地方' },
    covers: {
      session: (what: string) => `允許此聊天中所有「${what}」的請求，而不只是這一次。`,
      project: (what: string) => `允許此專案中所有「${what}」的請求，而不只是這一次。`,
      standing: (what: string) => `在所有地方允許所有「${what}」的請求，直到你撤銷。`
    },
    deny: '拒絕',
    allow: '允許',
    expires: '兩分鐘內未回答視為拒絕。'
  },
  approvalPointer: '正在等待你的許可——請在頂部的面板中回答。'
}
