// iclone os — V3-G 隔離：Dock 的「容器」面板（繁體中文）。
import { type ConfinementCopy, confinement as english } from '../en/confinement'

export const confinement: ConfinementCopy = {
  title: '容器',
  tile: '容器',
  unavailable: '容器在桌面 App 中執行，你的代理也在那裡執行指令。',
  verdict: {
    green: {
      label: '已隔離',
      hint: '每個代理指令都在其設定檔內執行，例外是你核准的 shell 指令，它會在設定檔之外執行一次。受隔離的指令在外部嘗試的操作會被阻擋，並列在 Refusals 下。隔離期間，MCP 伺服器、排程工作的指令碼、外掛/技能/套件的安裝、編輯前的檔案副本、編輯後的程式碼檢查、委派工作的副本和你的掛鉤會關閉。電腦操控在你授權後，透過已簽署的驅動程式在設定檔之外執行，並在「忽略權限」以外的所有模式下詢問。你可以在 Backends 或 設定 › 代理 › 權限 中關閉隔離；應用程式會先詢問。'
    },
    red: { label: '未隔離', hint: '隔離未經驗證。原因見下方。' },
    off: {
      label: '已關閉',
      hint: '隔離已關閉：代理指令不受隔離，MCP 伺服器、排程工作的指令碼、安裝、編輯前的檔案副本、編輯後的程式碼檢查、委派工作的副本和你的掛鉤會重新執行。'
    }
  },
  kinds: {
    hermes: '代理執行環境',
    'agent-command': '代理指令，未隔離',
    tool: '工具（MCP 伺服器、輔助程式）',
    runtime: english.kinds.runtime
  },
  killed: count => `已停止 ${count} 個程序`,
  killFailed: {
    survivors: count => `有 ${count} 個程序無法停止`,
    unverified: () => '已停止能看到的部分，但無法向 macOS 確認是否還有殘留',
    'not-confined': () => '不是受隔離的程序：未停止任何內容',
    invalid: () => '不是程序：未停止任何內容'
  },
  scope:
    '已隔離：終端機、程式碼執行、檔案工具與媒體處理，各自在自己的設定檔內。隔離期間關閉：MCP 伺服器、排程工作的指令碼、外掛/技能/套件的安裝、從鑰匙圈匯入，以及本機語音辨識指令。電腦操控在你授權後，透過已簽署的驅動程式在設定檔之外執行，並在「忽略權限」以外的所有模式下詢問。瀏覽器和螢幕錄影在模式允許時也在設定檔之外執行。「網頁瀏覽與網路呼叫」開啟時，瀏覽器在「手動」和「接受編輯」下詢問，在「自動」下不詢問直接執行，在「計畫」下只開啟和閱讀網頁，不詢問。螢幕錄影在其開關開啟時，除「計畫」（會拒絕）外的所有模式都詢問。在「忽略權限」下兩者都不詢問。',
  backendName: { seatbelt: 'Seatbelt（macOS）', container: 'Apple container' },
  backendStatus: {
    ready: '就緒',
    'not-installed': '未安裝',
    installed: '已安裝',
    unsupported: '此 Mac 不支援',
    broken: '無法運作',
    unknown: '無法檢查'
  },
  active: '使用中',
  network: { grant: '僅在授權後連網', never: '永不連網' },
  reads: '可讀',
  writes: '可寫',
  never: count => `永遠禁止：${count} 個機密與 App 路徑、鑰匙圈`,
  classes: {
    research: { name: '研究', summary: '讀取專案，只寫入其暫存目錄。' },
    project: { name: '專案', summary: '寫入專案及其暫存目錄。' },
    build: { name: '建置', summary: '專案加上套件快取。' },
    offline: { name: '離線', summary: '專案，永不連網。' },
    media: { name: '媒體', summary: '讀取輸入，只寫入一個輸出資料夾。' }
  },
  defaultClass: name => `預設：${name}`,
  unattributed: '未歸屬',
  noSession: '無工作階段',
  insideCount: count => `隔離內 ${count}`,
  outsideCount: count => `隔離外 ${count}`,
  elapsed: seconds =>
    seconds < 60
      ? `${seconds} 秒`
      : seconds < 3600
        ? `${Math.floor(seconds / 60)} 分`
        : `${Math.floor(seconds / 3600)} 小時`,
  reasons: '變紅的原因',
  reason: {
    'backend-not-confining': ({ backend, detail }) =>
      backend === 'container'
        ? 'Apple container 尚未提供隔離'
        : detail === 'probe-timeout'
          ? '未能及時檢查 Seatbelt：目前無法確認隔離是否生效'
          : detail === 'probe-failed'
            ? '無法檢查 Seatbelt：檢查本身失敗了，因此目前無法確認隔離是否生效'
            : 'Seatbelt 在這台 Mac 上沒有發揮隔離作用',
    'plugin-not-loaded': () => 'Shell 已封鎖：隔離未載入。在它載入之前，你的智慧代理命令都會被拒絕。',
    'profile-changed': ({ cls }) => `${cls} 設定檔在磁碟上被修改了`,
    'widened-profile': ({ pid }) => `程序 ${pid} 在被放寬的設定檔下執行`,
    'unknown-profile': ({ pid }) => `程序 ${pid} 在並非本應用程式產生的設定檔下執行`,
    'agent-command-outside': ({ pid }) => `智慧代理命令 ${pid} 在隔離之外執行`,
    'forged-marker': ({ pid }) => `程序 ${pid} 聲稱已被隔離，但 macOS 表示並沒有`,
    'agent-config-unreadable': () =>
      '無法讀取 config.yaml，因此其中的 terminal.backend 未被套用。指令仍在沙箱中執行。請修正該檔案並重新啟動。',
    'membership-unverified': () => '無法向 macOS 查詢哪些程序受隔離：脫離程序樹的程序可能未被計入',
    'hardlink-appeared': ({ path, pid, root }) =>
      `執行 ${pid} 期間，${root} 中出現了指向專案外檔案的硬連結（${path}）：只能在執行結束後發現，該次執行可能已存取到它；在你允許之前，那裡的下一次執行將被拒絕`,
    'runtime-not-confined': english.reason['runtime-not-confined'],
    'runtime-not-running': english.reason['runtime-not-running'],
    'launcher-down': english.reason['launcher-down'],
    'agent-commands-unavailable': english.reason['agent-commands-unavailable'],
    'settings-ignored': () => '磁碟上的隔離設定檔未經本應用程式簽署，已被忽略：隔離按預設設定保持開啟'
  },
  notes: '注意',
  backendEnforcingOff: '對照設定檔拒絕了測試檔案。',
  backendDetail: {
    enforcing: '正在生效：對照設定檔拒絕了測試檔案。',
    'not-enforcing': '可以執行但沒有生效：對照設定檔沒有拒絕測試檔案。',
    'cannot-run': '無法執行設定檔。',
    'binary-missing': '缺少 sandbox-exec：無法隔離任何內容。',
    'macos-only': 'Seatbelt 僅存在於 macOS。',
    'needs-apple-silicon': 'Apple container 需要 Apple 晶片與 macOS 26 或更新版本。',
    'no-version': '已安裝，但沒有回應版本檢查：安裝似乎已損壞。',
    'not-installed': '未安裝。安裝由你完成，需要輸入一次管理員密碼：',
    'not-wired': '此版本不使用：icloneOS 只用 Seatbelt 隔離命令。',
    'probe-failed': '檢查本身失敗了。',
    'probe-timeout': '檢查未能及時完成：這台 Mac 當時可能很忙。稍後會再次檢查。'
  },
  firstScan: dirs => `正在檢查專案資料夾… ${dirs.toLocaleString('zh-Hant')} 個資料夾`,
  hardlinks: {
    blocked: (root, paths, count) =>
      `隔離不會在 ${root} 中啟動：${paths.join('、')}${count > paths.length ? ` 等 ${count} 個檔案` : ''}是指向專案外檔案的硬連結，請刪除它們或在下方按資料夾允許。`,
    cannotScan: (root, paths, count) =>
      `隔離不會在 ${root} 中啟動：無法列出 ${paths.join('、')}${count > paths.length ? ` 等 ${count} 個資料夾` : ''}，硬連結可能藏在其中，請給這些資料夾讀取權限（chmod u+rx）。`,
    group: (dir, count) => `${dir} 下的 ${count} 個檔案 — 指向專案外的硬連結`,
    allow: count => (count === 1 ? '允許此檔案' : `允許 ${count} 個檔案`),
    allowTip: '指令可以讀寫這些檔案的目前版本，並由此讀寫它們所連結的專案外檔案；新的連結會再次詢問',
    allowed: count => `已允許：這 ${count} 個檔案的目前版本`,
    ackFailed: {
      'no-gesture': '未允許：請親自點擊按鈕',
      'not-in-project': '未允許：該資料夾不在這個專案中',
      'nothing-to-allow': '無需允許：該資料夾下已沒有硬連結',
      changed: '未允許：該資料夾下的檔案在顯示後發生了變化，請重新讀取',
      invalid: '未允許：該資料夾已不存在'
    },
    showAll: (count: number) => `全部顯示（${count.toLocaleString('zh-Hant')}）`,
    showMore: (left: number) => `再顯示 ${left.toLocaleString('zh-Hant')} 個`,
    showFewer: '收合',
    cachesUnscanned: '套件快取（npm、pip、cargo、pnpm…）不掃描硬連結：Build 指令本來就可以讀寫它們。'
  },
  // The run ledger's words are English in every locale until the translation pass: the app ships in English.
  ledger: english.ledger
}
