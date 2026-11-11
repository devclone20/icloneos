// iclone os — V3-F 權限模式（繁體中文）。設定 › 代理 › 權限，以及同意面板上的權限請求。
import { PRODUCT_NAME } from '@/i18n/en/enConsent'
import type { PermissionsCopy } from '@/i18n/en/enPermissions'
import { FUNCTION_COPY } from '@/iclone-shared/permission-function-copy'

export const zhHantPermissions: PermissionsCopy = {
  title: '權限',
  lead: `你的代理在這台 Mac 上無須詢問你即可做的事。模式透過在此應用程式中的點擊變更，代理的要求與更新都不能變更它；在「忽略權限」下且電腦操控開啟時，代理也能點擊。`,
  enforcement: {
    enforced: '已生效：代理的每次工具呼叫都會先經過這些規則。',
    starting: '啟動中：正在確認代理已載入權限關卡。',
    'not-enforced': '未生效：權限關卡沒有回應，在代理重新啟動前其工具呼叫都會被拒絕。',
    'no-agent': '代理未在執行。',
    degraded: '系統鑰匙圈無法保護紀錄的金鑰：僅限手動模式，重新啟動後無法驗證紀錄。',
    // FX-2 r1b: the degraded state's cause when the owner's Keychain setting is off, and the fix.
    'keychain-off':
      '你選擇的模式會持續到結束 icloneOS，之後恢復為手動：鑰匙圈設定已關閉，因此無法受保護地儲存。要保留它，請在 設定 › 裝置 › 閘道 ›「把已儲存的密碼存入系統鑰匙圈」 中開啟鑰匙圈。',
    // V3-FX M1: turned on while the app runs — payments and the ACP tools follow at once, the modes after a restart.
    'keychain-restart':
      '鑰匙圈已開啟。權限金鑰在 icloneOS 啟動時封存：請重新啟動 icloneOS 以使用自動、計畫等模式。付款和 ACP 工具已經可以使用。'
  },
  // r3/r4: the button beside the modes' restart line (the Keychain turned on since launch), and what it says
  // when main refuses the relaunch.
  restartNow: '立即重新啟動',
  restartRefused: 'icloneOS 現在無法重新啟動。請結束後重新開啟，即可使用這些模式。',
  modes: {
    ignore: {
      name: '忽略權限',
      short: '從不詢問',
      summary:
        '什麼都不詢問，包括花錢、轉移 iNFT、傳送金鑰、管理員密碼與自身權限。除隔離開啟時的隔離外，保留五項檢查：摧毀整個磁碟、主資料夾或系統，整個目標是無法讀懂的變數或指令輸出的遞迴刪除，或它能讀出是針對整個磁碟、主資料夾或系統的遞迴刪除（包括變數留空時會變成這樣的情況，或由無法讀懂名稱的指令執行），或它無法完整讀懂目標或選項的遞迴刪除，無法讀懂、因而無法檢查的呼叫（無法確定所涉檔案的修補、未指明檔案的寫入或無法讀懂的參數），你自己寫的拒絕規則，以及檔案工具對執行階段自身儲存區（寫入 state.db、工作階段、權杖、配對、保險庫、瀏覽器設定檔和執行階段自身的 .env；讀取權杖、保險庫、瀏覽器設定檔、auth.json、auth.lock、該 .env 和 webhook 訂閱）的存取。電腦操控、螢幕錄製和瀏覽器在 Seatbelt 之外執行，檔案工具會在 Seatbelt 之外逐一寫入主資料夾中的檔案。'
    },
    manual: {
      name: '手動',
      short: '行動前先詢問',
      summary:
        '除寫入自身 iNFT 檔案（SOUL、記憶、自身資料夾）外，每次寫入、指令、連網、傳訊息、安裝與刪除前都會詢問。讀取專案內容無需詢問，讀取主資料夾其他位置的檔案可能會詢問，受隔離的指令只能讀取它執行所在的資料夾。'
    },
    automatic: {
      name: '自動',
      short: '編輯並執行安全指令',
      summary: '自行在專案內寫入、執行安全的指令並使用網路，其餘都會詢問。'
    },
    plan: {
      name: '計畫',
      short: '閱讀並規劃',
      summary: '閱讀並在聊天中擬定計畫。除自身 iNFT 檔案（SOUL、記憶、自身資料夾）外，不做任何變更。'
    },
    acceptEdits: { name: '接受編輯', short: '編輯無需詢問', summary: '自行編輯專案內的檔案，其餘一律詢問。' }
  },
  menu: {
    title: '此聊天',
    trigger: (mode: string) => `此聊天的權限模式：${mode}`,
    triggerNotInForce: (inForce: string, chosen: string) => `此聊天的權限模式：${inForce}。已選擇 ${chosen}，但未生效`,
    appliesToSession: '僅此聊天，從下一則訊息起。預設值在「設定 › 代理 › 權限」。',
    appliesToNewChat: '僅此新聊天。預設值在「設定 › 代理 › 權限」。',
    ignoreNote: {
      confined: '五項檢查仍會拒絕。詳情見設定。',
      unconfined: 'Seatbelt 已關閉：僅剩五項 App 內檢查。'
    }
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
  chosenNotInForce: '已選擇，未生效',
  choose: '使用',
  scope: {
    label: '適用於',
    standing: '新工作階段的預設',
    standingNote:
      '已開啟且有自己模式的聊天會保持該模式，可在其訊息列中變更。聊天及其專案都沒有自己的模式時，會遵循此預設。',
    project: path => `此專案 · ${path}`,
    noProject: '開啟一個專案即可為它單獨選擇模式。'
  },
  refused: {
    gesture: '模式只能透過在此應用程式中的點擊變更。',
    invalid: '此處無法選擇該模式。',
    unavailable: `權限模式需要 ${PRODUCT_NAME} 桌面 App。`
  },
  floor: {
    title: '仍會檢查的內容',
    items: [
      '在所有模式下（包括「忽略權限」），都會拒絕抹除磁碟、你的主資料夾或系統資料夾，或格式化磁碟機。',
      '在「忽略權限」以外，未經你回答，它不能轉移 iNFT、傳送你的金鑰、輸入管理員密碼或變更自己的權限，任何授權都不能解除這一點。',
      '在「忽略權限」下什麼都不會詢問，因此它可以做以上所有事情。',
      '這些是應用程式內的檢查，不是核心層的屏障：程式可以繞過它們。'
    ]
  },
  // V3-F2: the Functions matrix (shared with main's native raise confirm).
  functions: FUNCTION_COPY['zh-hant'],
  // FX-6: what confinement really does (on by default, V3-G); the pane picks the line for the live state.
  shellNote: {
    on: '隔離已開啟，你可以將其關閉。代理指令在所有模式下都在隔離中執行（Seatbelt），包括「忽略權限」：只能寫入專案和一個暫存資料夾，只有在模式或授權允許時才能連上網路。你核准的 shell 指令會在隔離之外執行一次。',
    off: '隔離已關閉：在所有模式下，指令都以你的身分執行，可以讀取和變更你能存取的一切。',
    // V3-FX M2: main's live verdict is red (on but not working), or not read yet.
    red: '隔離目前未生效（原因見「容器」）：在恢復之前，任何模式下的指令都可以讀取和變更你能存取的一切。',
    pending: '正在讀取隔離狀態…'
  },
  grants: {
    title: '你給出的權限',
    empty: '尚無。當你允許超過一次時，它會顯示在這裡。',
    scope: { session: '此聊天', project: '此專案', standing: '所有地方' },
    revoke: '撤銷',
    folderTitle: '你允許的資料夾',
    folderHint: '在模式允許時，命令可以寫入此處',
    removeFolder: '移除'
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
    chainOk: count => `${count.toLocaleString()} 筆紀錄 · 完整`,
    chainBroken: `紀錄有缺口，或在 ${PRODUCT_NAME} 之外被變更。`,
    chainVerifying: '正在檢查紀錄…',
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
      standingIgnore: '被較早版本拒絕：當時「忽略權限」不能設為預設',
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
    folderLabel: '所在資料夾',
    expand: '顯示全部',
    collapse: '收合',
    reasonLabel: '原因（代理的原話）',
    heldFile:
      '這是 shell、git 或 launchd 執行時使用的檔案，或其中保存著金鑰。代理寫入這裡的內容之後可能以你的權限執行。允許前請先閱讀路徑。',
    outsideFilePatch: '允許後，將在 Seatbelt 之外讀取並隨後寫入這一個檔案。代理程式會看到它變更的行：',
    effects: {
      R: '它只會讀取，不做任何變更。',
      Wp: '它會在專案內建立或修改此檔案。',
      Wo: '它會在專案外建立或修改此檔案。Seatbelt 開啟時，此應用程式本身的檔案保持關閉，屆時會告知代理改用 shell 指令，你會先讀完整內容。',
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
    laterConfined:
      '只有這條指令會到外面執行。之後不受任何檢查攔截的指令不再詢問並留在 Seatbelt 內，需要更多權限的會被拒絕。在「設定 › 代理 › 權限」中撤銷此項即可重新詢問。',
    heldRead:
      '此檔案或資料夾保存金鑰或權杖，或由你的 shell 執行。Seatbelt 已關閉，再沒有其他阻擋：允許後代理將取得其全部內容，它讀到的內容會傳送給模型。',
    covers: {
      session: (what: string) => `允許此聊天中所有「${what}」的請求，而不只是這一次。`,
      project: (what: string) => `允許此專案中所有「${what}」的請求，而不只是這一次。`,
      standing: (what: string) => `在所有地方允許所有「${what}」的請求，直到你撤銷。`
    },
    deny: '拒絕',
    allow: '允許',
    expires: '兩分鐘內未回答視為拒絕。'
  },
  modeReset: {
    standing: (mode: string) => `由於找不到紀錄，預設模式已恢復為${mode}。請重新選擇。`,
    project: (mode: string | null) =>
      mode === null
        ? '由於找不到紀錄，某個專案的專屬模式已被移除。請重新選擇。'
        : `由於找不到紀錄，某個專案的模式已恢復為${mode}。請重新選擇。`,
    session: (mode: string | null) =>
      mode === null
        ? '由於找不到紀錄，某個對話的專屬模式已被移除。請重新選擇。'
        : `由於找不到紀錄，某個對話的模式已恢復為${mode}。請重新選擇。`,
    dismiss: '關閉'
  },
  approvalPointer: '正在等待你的許可——請在頂部的面板中回答。'
}
