// iclone os — V3-G 隔離：Dock 的「容器」面板（繁體中文）。
import type { ConfinementCopy } from '../en/confinement'

export const confinement: ConfinementCopy = {
  title: '容器',
  tile: '容器',
  unavailable: '容器在桌面 App 中執行，你的代理也在那裡執行指令。',
  loading: '正在讀取這台 Mac 上執行的內容…',
  verdict: {
    green: {
      label: '已隔離',
      hint: '每個代理指令都在其設定檔內執行。隔離期間，MCP 伺服器、排程工作的指令碼、外掛/技能/套件的安裝、電腦操控、編輯前的檔案副本、編輯後的程式碼檢查、委派工作的副本和你的掛鉤皆關閉；選擇「這台 Mac」可恢復。'
    },
    red: { label: '未隔離', hint: '隔離未經驗證。原因見下方。' },
    off: {
      label: '已關閉',
      hint: '你選擇了「這台 Mac」：代理指令不受隔離，MCP 伺服器、排程工作的指令碼、安裝、電腦操控、編輯前的檔案副本、編輯後的程式碼檢查、委派工作的副本和你的掛鉤會重新執行。'
    }
  },
  tabs: { live: '即時', agents: '代理', profiles: '設定檔', refusals: '拒絕紀錄', backends: '後端' },
  inside: '隔離內',
  outside: '隔離外',
  col: { pid: 'PID', profile: '設定檔', session: '工作階段', time: '時間', command: '指令', kind: '類型' },
  kinds: { hermes: 'Hermes', 'agent-command': '代理指令，未隔離', tool: '工具（MCP 伺服器、輔助程式）' },
  kill: '終止',
  killTip: pid => `停止 ${pid} 及其啟動的一切`,
  killed: count => `已停止 ${count} 個程序`,
  killFailed: {
    survivors: count => `有 ${count} 個程序無法停止`,
    unverified: () => '已停止能看到的部分，但無法向 macOS 確認是否還有殘留',
    'not-confined': () => '不是受隔離的程序：未停止任何內容',
    invalid: () => '不是程序：未停止任何內容'
  },
  why: '原因',
  follow: '追蹤',
  following: pid => `正在追蹤 ${pid}`,
  stopFollowing: '停止追蹤',
  empty: {
    inside: '沒有正在執行的代理指令。',
    outside: '沒有代理內容在隔離外執行。',
    agents: '尚無代理活動。',
    refusals: '尚無拒絕紀錄。'
  },
  scope:
    '已隔離：終端機、程式碼執行、檔案工具，以及 Hermes 執行的瀏覽器與媒體處理，皆在同一沙盒內。隔離期間關閉：MCP 伺服器、排程工作的指令碼、外掛/技能/套件的安裝、電腦操控、從鑰匙圈匯入，以及本機語音辨識指令。',
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
  refusal: { operation: '已拒絕', target: '目標', process: '程序' },
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
    'membership-unverified': () => '無法向 macOS 查詢哪些程序受隔離：脫離程序樹的程序可能未被計入',
    'hardlink-appeared': ({ path, pid, root }) =>
      `執行 ${pid} 期間，${root} 中出現了指向專案外檔案的硬連結（${path}）：只能在執行結束後發現，該次執行可能已存取到它；在你允許之前，那裡的下一次執行將被拒絕`,
    'settings-ignored': () => '磁碟上的隔離設定檔未經本應用程式簽署，已被忽略：隔離按預設設定保持開啟'
  },
  notes: '注意',
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
    cachesUnscanned: '套件快取（npm、pip、cargo、pnpm…）不掃描硬連結：Build 指令本來就可以讀寫它們。'
  }
}
