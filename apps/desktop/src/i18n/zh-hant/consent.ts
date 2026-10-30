// iCLONE OS — first-launch consent sheet + Settings › Privacy, Traditional Chinese (U2-p2b-01).
// The policy text itself stays English and binding; these are the sheet's own words.
import { type ConsentBank, PRODUCT_NAME } from '@/i18n/en/enConsent'

export const zhHantConsent: ConsentBank = {
  sheet: {
    eyebrow: (title, version, effective) => `${title} · 版本 ${version} · 生效日期 ${effective}`,
    termsTitle: '開始之前',
    termsLead: `${PRODUCT_NAME} 在這台 Mac 上執行你的代理。這是它處理你資料方式的簡要說明。`,
    updateTitle: '我們的政策已更新',
    updateLead: `請閱讀並接受新版本，以繼續使用 ${PRODUCT_NAME}。你已儲存的權限選擇保持不變。`,
    readFull: '閱讀完整政策',
    readOffline: '離線閱讀',
    hideOffline: '收起全文',
    offlineUnavailable: '無法讀取隨附的副本。完整政策見 cloneframe.io/privacy。',
    policyLanguage: '本政策以英文撰寫，以英文文本為準。',
    aiDisclosure:
      '當你連接 AI 供應商時，你的訊息、檔案、人格與記憶，以及包括螢幕在內的工具結果，會從這台 Mac 直接傳送給該供應商（政策 §5）。',
    accept: (title, version) => `我已閱讀並接受 ${title} v${version}，包括向我連接的 AI 供應商傳送資料`,
    quit: '結束',
    continue: '繼續',
    permissionsEyebrow: '權限',
    permissionsTitle: `你的代理和 ${PRODUCT_NAME} 在這台 Mac 上可以做什麼`,
    permissionsFooter:
      '現在不會向 macOS 要求任何權限。只有當某項功能需要時系統才會詢問；你可以隨時在設定 › 隱私權或系統設定 › 隱私權與安全性中更改。',
    acceptHint: '接受政策以繼續',
    keychainLine: on =>
      on
        ? '你的閘道登入資訊由 Mac 鑰匙圈加密；macOS 可能會請你允許一次。'
        : '你的閘道登入資訊儲存在這台 Mac 上，未經鑰匙圈加密。',
    keychainChange: '你可以在設定 › 閘道中更改；macOS 可能會在那裡再次詢問。',
    skip: '暫時略過',
    allowAll: '全部允許',
    allAllowed: '已全部允許',
    allowAllKeychainTitle: '鑰匙圈保持不變',
    allowAllKeychain: '「全部允許」不會更改鑰匙圈：你已儲存的密鑰保持設定 › 閘道中的狀態（未加密）。請在那裡開啟加密。',
    saving: '正在儲存…',
    saveFailed: '無法儲存你的選擇。請再試一次。',
    step: (n, total) => `第 ${n} 步，共 ${total} 步`
  },
  groups: {
    capabilities: '代理能力',
    capabilitiesHint: '代理啟動時會被告知每項選擇。當任務需要你關閉的某項能力時，它會先在這裡詢問你。',
    device: '裝置',
    deviceHint: '只有當某項功能需要時 macOS 才會詢問。',
    neverUsed: '從不使用',
    neverUsedHint: `僅供參考：${PRODUCT_NAME} 不使用這些。`
  },
  rows: {
    terminal: {
      name: '終端機指令',
      purpose: '允許代理以你的使用者帳戶權限在終端機中執行指令。你可以看到它執行了什麼。'
    },
    fileWriting: { name: '寫入檔案', purpose: '允許代理為完成任務在這台 Mac 上建立和修改檔案' },
    webBrowsing: { name: '網頁瀏覽與網路呼叫', purpose: '允許代理替你瀏覽網頁或使用線上工具，並傳送任務所需的內容' },
    installSoftware: { name: '安裝軟體與套件', purpose: '允許代理在任務需要時安裝工具和套件（Homebrew、npm、pip）' },
    scheduledTasks: { name: '排程任務', purpose: '允許代理建立稍後在這台 Mac 上執行的工作' },
    sendMessages: { name: '傳送郵件與訊息', purpose: '允許代理代你傳送代理郵件' },
    spendTrade: {
      name: '消費與交易',
      purpose: '僅在你親自給予的授權範圍內，允許代理在卡片額度內消費、承接市集任務或進行交易'
    },
    microphone: { name: '麥克風', purpose: '允許你透過語音按鈕與代理對話' },
    screen: { name: '螢幕', purpose: '允許代理為完成任務截圖或錄影' },
    automation: { name: '控制其他應用程式', purpose: '允許代理為完成任務控制其他應用程式' },
    notifications: { name: '通知', purpose: `允許 ${PRODUCT_NAME} 顯示聊天和代理通知` },
    clipboard: { name: '剪貼簿', purpose: '允許代理為完成任務讀寫剪貼簿' },
    keychain: { name: '鑰匙圈', purpose: '使用 Mac 鑰匙圈加密你的閘道登入資訊' }
  },
  neverUsed: {
    camera: { name: '相機', line: '本應用程式不使用你的相機。' },
    location: { name: '位置', line: '本應用程式不使用你的位置。' },
    contacts: { name: '聯絡人', line: '本應用程式不使用你的聯絡人。' }
  },
  effect: {
    terminal: '關閉：代理被告知不要執行終端機指令。',
    fileWriting: '關閉：代理被告知不要建立、修改或刪除檔案。讀取你選擇的資料夾不受影響。',
    webBrowsing: '關閉：代理被告知不要瀏覽網頁或呼叫線上工具。',
    installSoftware: '關閉：代理被告知不要安裝軟體或套件。',
    scheduledTasks: '關閉：代理被告知不要建立排程任務。',
    sendMessages: '關閉：代理被告知不要代你傳送郵件或訊息。',
    spendTrade: '關閉：代理被告知未經你同意不得轉移價值。',
    microphone: '關閉：語音按鈕保持關閉，且不會向 macOS 要求權限。',
    screen: '關閉：應用程式隱去其他應用程式的視窗標題，代理被告知不要截圖或錄影。',
    automation: '關閉：代理被告知不要控制其他應用程式。',
    notifications: `關閉：${PRODUCT_NAME} 不顯示聊天或代理通知。`,
    clipboard: '關閉：代理被告知不要使用剪貼簿。你自己的複製和貼上始終可用。',
    keychain: '閘道登入資訊儲存在這台 Mac 上；是否由鑰匙圈加密顯示在本列旁邊，可在設定 › 閘道中更改。'
  },
  settings: {
    nav: '隱私權',
    policyHeading: '政策',
    policyRow: version => `${PRODUCT_NAME} 政策與隱私權 v${version}`,
    effective: date => `生效日期 ${date}`,
    accepted: date => `接受於 ${date}`,
    acceptedOlder: version => `已接受 v${version}`,
    notAccepted: '未接受',
    openLive: '開啟線上頁面',
    readOffline: '離線閱讀',
    hideOffline: '收起全文',
    permissionsHeading: '權限',
    notConfigured: '未設定',
    notConfiguredHint: '你略過了這一步。在你選擇之前，只有當某項功能需要權限時 macOS 才會詢問。',
    permissionsFooter: `開關記錄 ${PRODUCT_NAME} 可以使用什麼；某項功能首次需要權限時，macOS 仍會詢問。`,
    requestsHeading: '來自代理的請求',
    requestsEmpty: '尚無請求。當任務需要你關閉的權限時，代理會在這裡詢問。',
    requestAnswer: { always: '一律允許', once: '允許一次', denied: '已拒絕', timeout: '無回應' },
    requestBy: (inft, date) => `${inft} · ${date}`,
    keychainState: on => (on ? '已加密' : '未加密'),
    keychainOpen: '開啟閘道設定',
    aiHeading: 'AI 供應商',
    aiRow: '你連接的 AI 供應商會收到什麼',
    aiRowDesc: '訊息、檔案、人格與記憶，以及包括螢幕在內的工具結果，會從這台 Mac 直接傳送給你連接的供應商（政策 §5）。',
    aiWithdrawn: date => `撤回於 ${date}`,
    aiNotRecorded: '未記錄',
    aiWithdrawnHint: `${PRODUCT_NAME} 會保留你撤回的日期。它不會自行中斷已連接的供應商：要停止傳送，請在設定中中斷該供應商。`,
    aiAcceptAgain: '再次接受',
    openProviders: '開啟供應商',
    withdraw: '撤回對 AI 供應商的同意',
    withdrawTitle: '撤回對 AI 供應商的同意？',
    withdrawDesc: `${PRODUCT_NAME} 會記錄你撤回的日期。它不會自行中斷已連接的供應商：要停止傳送，請在設定中中斷該供應商。`,
    withdrawConfirm: '撤回',
    saveFailed: '無法儲存。請再試一次。',
    unavailable: '隱私權設定可在桌面應用程式中使用。'
  },
  door: {
    eyebrow: inft => `權限請求 · ${inft}`,
    title: name => `你的代理需要「${name}」`,
    reasonLabel: '原因（代理的原話）',
    hint: `「允許一次」在 ${PRODUCT_NAME} 結束前有效。「一律允許」會開啟設定 › 隱私權中的開關。`,
    expires: '兩分鐘內無回應視為拒絕。',
    deny: '拒絕',
    once: '允許一次',
    always: '一律允許'
  }
}
