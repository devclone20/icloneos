import type { ConsentSwitchKey } from '@/components/consent/types'
import { useI18n } from '@/i18n'
import { PRODUCT_NAME as P } from '@/i18n/en/enConsent'
import type { Locale } from '@/i18n/types'

// Settings › Privacy in all five locales (lead grant r2). Each switch reads as one sentence a person
// understands; the longer purpose sits under it and the "Off:" line says what the switch really does.
// The first-launch sheet keeps its own catalogue (src/i18n/en/enConsent.ts); the policy text is verbatim.

interface PrivacyRow {
  title: string
  hint: string
  effect: string
}

type RequestAnswer = 'always' | 'once' | 'denied' | 'timeout'

const en = {
  groups: {
    capabilities: 'What your agent may do',
    device: 'What the app may use on this computer',
    neverUsed: 'What the app never uses'
  },
  rows: {
    terminal: {
      title: 'Let your agent run commands in a terminal',
      hint: 'It runs them with your user account’s permissions, and you can see what it runs.',
      effect: 'Off: your agent is told not to run terminal commands.'
    },
    fileWriting: {
      title: 'Let your agent create and change files',
      hint: 'Only on this computer, and only for the task you gave it.',
      effect:
        'Off: your agent is told not to create, change or delete files. Reading the folders you choose still works.'
    },
    webBrowsing: {
      title: 'Let your agent browse the web and use online tools',
      hint: 'It sends only what the task needs.',
      effect: 'Off: your agent is told not to browse the web or call online tools.'
    },
    automation: {
      title: 'Let your agent control other apps',
      hint: 'Only when you ask it to.',
      effect: 'Off: your agent is told not to control other apps.'
    },
    screen: {
      title: 'Let your agent see your screen',
      hint: 'Screenshots and recordings when a task needs them, and the titles of other apps’ windows.',
      effect:
        'Off: the app withholds other apps’ window titles, and your agent is told not to take screenshots or recordings.'
    },
    clipboard: {
      title: 'Let your agent use the clipboard',
      hint: 'Copying and pasting between you, the app and your agent.',
      effect: 'Off: your agent is told not to use the clipboard. Your own copy and paste always work.'
    },
    installSoftware: {
      title: 'Let your agent install software',
      hint: 'Tools and packages a task needs, such as Homebrew, npm or pip.',
      effect: 'Off: your agent is told not to install software or packages.'
    },
    scheduledTasks: {
      title: 'Let your agent schedule tasks for later',
      hint: 'Jobs that run later on this computer.',
      effect: 'Off: your agent is told not to create scheduled tasks.'
    },
    sendMessages: {
      title: 'Let your agent send email and messages for you',
      hint: 'Agent email sent in your name.',
      effect: 'Off: your agent is told not to send email or messages for you.'
    },
    spendTrade: {
      title: 'Let your agent spend and trade within your limits',
      hint: 'Within a card limit, marketplace jobs or trades, and only with authorisations you gave yourself.',
      effect: 'Off: your agent is told not to move value without you.'
    },
    microphone: {
      title: 'Let the app use your microphone',
      hint: 'For voice features, such as speaking to your agent.',
      effect: 'Off: the voice button stays off and your system is never asked.'
    },
    notifications: {
      title: 'Let the app show notifications',
      hint: 'Alerts from the app and from your agent.',
      effect: `Off: ${P} shows no chat or agent notifications.`
    },
    keychain: {
      title: 'Keep sign-in details in secure storage',
      hint: 'The signing key and sign-in token and, if you turn it on, encrypted connection secrets. Your system may ask you to allow access.',
      effect: 'Whether they are encrypted is shown beside this row; you change it in the connection settings.'
    }
  } satisfies Record<ConsentSwitchKey, PrivacyRow>,
  neverUsed: {
    camera: 'The app never uses your camera',
    location: 'The app never uses your location',
    contacts: 'The app never uses your contacts'
  },
  settings: {
    policyHeading: 'The policy you accepted',
    policyRow: (version: string) => `Policies and privacy, version ${version}`,
    effective: (date: string) => `In effect since ${date}`,
    accepted: (date: string) => `Accepted ${date}`,
    acceptedOlder: (version: string) => `Accepted version ${version}`,
    notAccepted: 'Not accepted',
    openLive: 'Open the live page',
    readOffline: 'Read it here',
    hideOffline: 'Hide the full text',
    permissionsHeading: 'What the app and your agent may use',
    notConfigured: 'Not chosen yet',
    notConfiguredHint:
      'You skipped this step. Until you choose, your system asks only when a feature needs a permission.',
    permissionsFooter: `A switch records what ${P} may use; your system still asks the first time a feature needs a permission. Microphone, window titles and notifications change at once; your agent learns the rest the next time it starts.`,
    requestsHeading: 'What your agent has asked to use',
    requestsEmpty: 'No requests yet. When a task needs a permission you left off, your agent asks here.',
    requestAnswer: {
      always: 'Allowed always',
      once: 'Allowed once',
      denied: 'Denied',
      timeout: 'No answer'
    } satisfies Record<RequestAnswer, string>,
    requestBy: (inft: string, date: string) => `${inft} · ${date}`,
    keychainState: (on: boolean): string => (on ? 'Encrypted' : 'Not encrypted'),
    keychainOpen: 'Open connection settings',
    aiHeading: 'Your AI provider',
    aiRow: 'What your AI provider receives',
    aiRowDesc:
      'Messages, files, persona and memory, and tool results including the screen go straight from this computer to the provider you connect (policy §5). You accepted this with the policy.',
    aiWithdrawn: (date: string) => `Withdrawn ${date}`,
    aiNotRecorded: 'Not recorded',
    aiWithdrawnHint: `${P} keeps the date you withdrew. It does not cut off a connected provider by itself: disconnect the provider in Settings › Providers to stop sending.`,
    aiAcceptAgain: 'Accept again',
    openProviders: 'Open Providers',
    withdraw: 'Withdraw consent',
    withdrawTitle: 'Withdraw your consent for the AI provider?',
    withdrawDesc: `${P} records the date you withdrew it. It does not cut off a connected provider by itself: to stop sending, disconnect the provider in Settings › Providers.`,
    withdrawConfirm: 'Withdraw',
    saveFailed: 'Could not save. Try again.',
    unavailable: 'Privacy settings are available in the desktop app.'
  }
}

type PrivacyCopy = typeof en

const ja: PrivacyCopy = {
  groups: {
    capabilities: 'エージェントに許可すること',
    device: 'このコンピューターでアプリが使うもの',
    neverUsed: 'アプリが決して使わないもの'
  },
  rows: {
    terminal: {
      title: 'エージェントがターミナルでコマンドを実行できるようにする',
      hint: 'あなたのユーザーアカウントの権限で実行し、何を実行したかはいつでも確認できます。',
      effect: 'オフ: エージェントにはターミナルコマンドを実行しないよう伝えます。'
    },
    fileWriting: {
      title: 'エージェントがファイルを作成・変更できるようにする',
      hint: 'このコンピューター上で、頼んだ作業のためだけに行います。',
      effect:
        'オフ: エージェントにはファイルを作成・変更・削除しないよう伝えます。選んだフォルダーの読み取りはそのまま使えます。'
    },
    webBrowsing: {
      title: 'エージェントが Web を閲覧しオンラインツールを使えるようにする',
      hint: '送るのは作業に必要なものだけです。',
      effect: 'オフ: エージェントには Web の閲覧やオンラインツールの使用をしないよう伝えます。'
    },
    automation: {
      title: 'エージェントがほかのアプリを操作できるようにする',
      hint: 'あなたが頼んだときだけです。',
      effect: 'オフ: エージェントにはほかのアプリを操作しないよう伝えます。'
    },
    screen: {
      title: 'エージェントが画面を見られるようにする',
      hint: '作業に必要なときのスクリーンショットや録画、ほかのアプリのウィンドウ名です。',
      effect:
        'オフ: アプリはほかのアプリのウィンドウ名を渡さず、エージェントにはスクリーンショットや録画をしないよう伝えます。'
    },
    clipboard: {
      title: 'エージェントがクリップボードを使えるようにする',
      hint: 'あなた、アプリ、エージェントの間でのコピーと貼り付けです。',
      effect: 'オフ: エージェントにはクリップボードを使わないよう伝えます。あなた自身のコピーと貼り付けは常に使えます。'
    },
    installSoftware: {
      title: 'エージェントがソフトウェアをインストールできるようにする',
      hint: 'Homebrew、npm、pip など、作業に必要なツールやパッケージです。',
      effect: 'オフ: エージェントにはソフトウェアやパッケージをインストールしないよう伝えます。'
    },
    scheduledTasks: {
      title: 'エージェントが後で実行する作業を予約できるようにする',
      hint: 'このコンピューターで後から実行されるジョブです。',
      effect: 'オフ: エージェントには予約タスクを作らないよう伝えます。'
    },
    sendMessages: {
      title: 'エージェントがあなたの代わりにメールやメッセージを送れるようにする',
      hint: 'あなたの名前で送るエージェントのメールです。',
      effect: 'オフ: エージェントにはあなたの代わりにメールやメッセージを送らないよう伝えます。'
    },
    spendTrade: {
      title: 'エージェントが上限の範囲内で支払いや取引をできるようにする',
      hint: 'カードの上限内、マーケットプレイスの仕事や取引で、あなた自身が与えた許可の範囲だけです。',
      effect: 'オフ: エージェントにはあなた抜きで価値を動かさないよう伝えます。'
    },
    microphone: {
      title: 'アプリがマイクを使えるようにする',
      hint: 'エージェントに話しかけるなどの音声機能のためです。',
      effect: 'オフ: 音声ボタンはオフのままで、システムに許可を求めることもありません。'
    },
    notifications: {
      title: 'アプリが通知を表示できるようにする',
      hint: 'アプリとエージェントからのお知らせです。',
      effect: `オフ: ${P} はチャットやエージェントの通知を表示しません。`
    },
    keychain: {
      title: 'サインイン情報を安全な保管庫に保存する',
      hint: '署名キーとサインイントークン、オンにした場合は暗号化された接続の秘密情報です。システムがアクセスの許可を求めることがあります。',
      effect: '暗号化されているかはこの行の横に表示され、接続の設定で変更できます。'
    }
  },
  neverUsed: {
    camera: 'アプリがカメラを使うことはありません',
    location: 'アプリが位置情報を使うことはありません',
    contacts: 'アプリが連絡先を使うことはありません'
  },
  settings: {
    policyHeading: '同意したポリシー',
    policyRow: (version: string) => `ポリシーとプライバシー（バージョン ${version}）`,
    effective: (date: string) => `${date} から有効`,
    accepted: (date: string) => `${date} に同意`,
    acceptedOlder: (version: string) => `バージョン ${version} に同意`,
    notAccepted: '未同意',
    openLive: '公開ページを開く',
    readOffline: 'ここで読む',
    hideOffline: '全文を閉じる',
    permissionsHeading: 'アプリとエージェントが使えるもの',
    notConfigured: 'まだ選んでいません',
    notConfiguredHint: 'この手順はスキップされました。選ぶまでは、機能が必要とするときだけシステムが許可を求めます。',
    permissionsFooter: `スイッチは ${P} が使ってよいものを記録します。機能が初めて許可を必要とするときは、システムが引き続き確認します。マイク、ウィンドウ名、通知はすぐに変わり、そのほかはエージェントの次回起動時に伝わります。`,
    requestsHeading: 'エージェントが使用を求めたもの',
    requestsEmpty: 'まだリクエストはありません。オフにした許可が作業に必要になると、エージェントがここで求めます。',
    requestAnswer: { always: '常に許可', once: '一度だけ許可', denied: '拒否', timeout: '応答なし' },
    requestBy: (inft: string, date: string) => `${inft} · ${date}`,
    keychainState: (on: boolean) => (on ? '暗号化済み' : '暗号化されていません'),
    keychainOpen: '接続の設定を開く',
    aiHeading: 'AI プロバイダー',
    aiRow: 'AI プロバイダーが受け取るもの',
    aiRowDesc:
      'メッセージ、ファイル、ペルソナと記憶、画面を含むツールの結果は、このコンピューターから接続したプロバイダーへ直接送られます（ポリシー §5）。ポリシーへの同意でこれに同意しています。',
    aiWithdrawn: (date: string) => `${date} に撤回`,
    aiNotRecorded: '記録なし',
    aiWithdrawnHint: `${P} は撤回した日付を記録します。接続中のプロバイダーを自動では切断しません。送信を止めるには、設定 › プロバイダーで切断してください。`,
    aiAcceptAgain: 'もう一度同意する',
    openProviders: 'プロバイダーを開く',
    withdraw: '同意を撤回',
    withdrawTitle: 'AI プロバイダーへの同意を撤回しますか？',
    withdrawDesc: `${P} は撤回した日付を記録します。接続中のプロバイダーを自動では切断しません。送信を止めるには、設定 › プロバイダーで切断してください。`,
    withdrawConfirm: '撤回',
    saveFailed: '保存できませんでした。もう一度お試しください。',
    unavailable: 'プライバシーの設定はデスクトップアプリで利用できます。'
  }
}

const zh: PrivacyCopy = {
  groups: {
    capabilities: '你的智能体可以做什么',
    device: '应用可以在这台电脑上使用什么',
    neverUsed: '应用从不使用的内容'
  },
  rows: {
    terminal: {
      title: '允许你的智能体在终端中运行命令',
      hint: '它以你的用户账户权限运行命令，你可以看到它运行了什么。',
      effect: '关闭：会告诉你的智能体不要运行终端命令。'
    },
    fileWriting: {
      title: '允许你的智能体创建和修改文件',
      hint: '只在这台电脑上，且只为你交给它的任务。',
      effect: '关闭：会告诉你的智能体不要创建、修改或删除文件。读取你选择的文件夹不受影响。'
    },
    webBrowsing: {
      title: '允许你的智能体浏览网页并使用在线工具',
      hint: '它只发送任务需要的内容。',
      effect: '关闭：会告诉你的智能体不要浏览网页或调用在线工具。'
    },
    automation: {
      title: '允许你的智能体控制其他应用',
      hint: '只在你要求时。',
      effect: '关闭：会告诉你的智能体不要控制其他应用。'
    },
    screen: {
      title: '允许你的智能体查看你的屏幕',
      hint: '任务需要时的截图和录屏，以及其他应用的窗口标题。',
      effect: '关闭：应用不提供其他应用的窗口标题，并告诉你的智能体不要截图或录屏。'
    },
    clipboard: {
      title: '允许你的智能体使用剪贴板',
      hint: '在你、应用和智能体之间复制和粘贴。',
      effect: '关闭：会告诉你的智能体不要使用剪贴板。你自己的复制和粘贴始终可用。'
    },
    installSoftware: {
      title: '允许你的智能体安装软件',
      hint: '任务需要的工具和软件包，例如 Homebrew、npm 或 pip。',
      effect: '关闭：会告诉你的智能体不要安装软件或软件包。'
    },
    scheduledTasks: {
      title: '允许你的智能体安排稍后运行的任务',
      hint: '稍后在这台电脑上运行的作业。',
      effect: '关闭：会告诉你的智能体不要创建计划任务。'
    },
    sendMessages: {
      title: '允许你的智能体代你发送邮件和消息',
      hint: '以你的名义发送的智能体邮件。',
      effect: '关闭：会告诉你的智能体不要代你发送邮件或消息。'
    },
    spendTrade: {
      title: '允许你的智能体在你的限额内支付和交易',
      hint: '在卡片限额内、市场任务或交易中，且只在你亲自给出的授权范围内。',
      effect: '关闭：会告诉你的智能体不要在没有你的情况下转移价值。'
    },
    microphone: {
      title: '允许应用使用你的麦克风',
      hint: '用于语音功能，例如和你的智能体说话。',
      effect: '关闭：语音按钮保持关闭，也不会向系统请求权限。'
    },
    notifications: {
      title: '允许应用显示通知',
      hint: '来自应用和你的智能体的提醒。',
      effect: `关闭：${P} 不显示聊天或智能体通知。`
    },
    keychain: {
      title: '把登录信息保存在安全存储中',
      hint: '签名密钥和登录令牌，以及在你开启后加密的连接机密。系统可能会请求你允许访问。',
      effect: '是否已加密显示在这一行旁边，可以在连接设置中更改。'
    }
  },
  neverUsed: { camera: '应用从不使用你的摄像头', location: '应用从不使用你的位置', contacts: '应用从不使用你的通讯录' },
  settings: {
    policyHeading: '你已接受的政策',
    policyRow: (version: string) => `政策与隐私（版本 ${version}）`,
    effective: (date: string) => `自 ${date} 起生效`,
    accepted: (date: string) => `已于 ${date} 接受`,
    acceptedOlder: (version: string) => `已接受版本 ${version}`,
    notAccepted: '未接受',
    openLive: '打开在线页面',
    readOffline: '在这里阅读',
    hideOffline: '隐藏全文',
    permissionsHeading: '应用和你的智能体可以使用什么',
    notConfigured: '尚未选择',
    notConfiguredHint: '你跳过了这一步。在你选择之前，只有功能需要权限时系统才会询问。',
    permissionsFooter: `开关记录 ${P} 可以使用什么；功能第一次需要权限时，系统仍会询问。麦克风、窗口标题和通知会立即更改；其余内容会在智能体下次启动时生效。`,
    requestsHeading: '你的智能体请求使用的内容',
    requestsEmpty: '还没有请求。当任务需要你关闭的权限时，你的智能体会在这里询问。',
    requestAnswer: { always: '始终允许', once: '允许一次', denied: '已拒绝', timeout: '未回应' },
    requestBy: (inft: string, date: string) => `${inft} · ${date}`,
    keychainState: (on: boolean) => (on ? '已加密' : '未加密'),
    keychainOpen: '打开连接设置',
    aiHeading: '你的 AI 提供方',
    aiRow: '你的 AI 提供方会收到什么',
    aiRowDesc:
      '消息、文件、人设和记忆，以及包括屏幕在内的工具结果，会从这台电脑直接发送到你连接的提供方（政策 §5）。你在接受政策时已同意这一点。',
    aiWithdrawn: (date: string) => `已于 ${date} 撤回`,
    aiNotRecorded: '未记录',
    aiWithdrawnHint: `${P} 会记录你撤回的日期，但不会自行断开已连接的提供方：要停止发送，请在 设置 › 提供方 中断开该提供方。`,
    aiAcceptAgain: '重新接受',
    openProviders: '打开提供方',
    withdraw: '撤回同意',
    withdrawTitle: '撤回你对 AI 提供方的同意？',
    withdrawDesc: `${P} 会记录你撤回的日期，但不会自行断开已连接的提供方：要停止发送，请在 设置 › 提供方 中断开该提供方。`,
    withdrawConfirm: '撤回',
    saveFailed: '无法保存，请重试。',
    unavailable: '隐私设置可在桌面应用中使用。'
  }
}

const zhHant: PrivacyCopy = {
  groups: {
    capabilities: '您的代理可以做什麼',
    device: '應用程式可以在這台電腦上使用什麼',
    neverUsed: '應用程式從不使用的內容'
  },
  rows: {
    terminal: {
      title: '允許您的代理在終端機中執行命令',
      hint: '它以您的使用者帳號權限執行命令，您可以看到它執行了什麼。',
      effect: '關閉：會告訴您的代理不要執行終端機命令。'
    },
    fileWriting: {
      title: '允許您的代理建立和修改檔案',
      hint: '只在這台電腦上，且只為您交給它的任務。',
      effect: '關閉：會告訴您的代理不要建立、修改或刪除檔案。讀取您選擇的資料夾不受影響。'
    },
    webBrowsing: {
      title: '允許您的代理瀏覽網頁並使用線上工具',
      hint: '它只傳送任務需要的內容。',
      effect: '關閉：會告訴您的代理不要瀏覽網頁或呼叫線上工具。'
    },
    automation: {
      title: '允許您的代理控制其他應用程式',
      hint: '只在您要求時。',
      effect: '關閉：會告訴您的代理不要控制其他應用程式。'
    },
    screen: {
      title: '允許您的代理查看您的螢幕',
      hint: '任務需要時的截圖和錄影，以及其他應用程式的視窗標題。',
      effect: '關閉：應用程式不提供其他應用程式的視窗標題，並告訴您的代理不要截圖或錄影。'
    },
    clipboard: {
      title: '允許您的代理使用剪貼簿',
      hint: '在您、應用程式和代理之間複製和貼上。',
      effect: '關閉：會告訴您的代理不要使用剪貼簿。您自己的複製和貼上始終可用。'
    },
    installSoftware: {
      title: '允許您的代理安裝軟體',
      hint: '任務需要的工具和套件，例如 Homebrew、npm 或 pip。',
      effect: '關閉：會告訴您的代理不要安裝軟體或套件。'
    },
    scheduledTasks: {
      title: '允許您的代理排定稍後執行的工作',
      hint: '稍後在這台電腦上執行的工作。',
      effect: '關閉：會告訴您的代理不要建立排程工作。'
    },
    sendMessages: {
      title: '允許您的代理代您傳送郵件和訊息',
      hint: '以您的名義傳送的代理郵件。',
      effect: '關閉：會告訴您的代理不要代您傳送郵件或訊息。'
    },
    spendTrade: {
      title: '允許您的代理在您的限額內付款和交易',
      hint: '在卡片限額內、市集工作或交易中，且只在您親自給出的授權範圍內。',
      effect: '關閉：會告訴您的代理不要在沒有您的情況下轉移價值。'
    },
    microphone: {
      title: '允許應用程式使用您的麥克風',
      hint: '用於語音功能，例如和您的代理說話。',
      effect: '關閉：語音按鈕保持關閉，也不會向系統要求權限。'
    },
    notifications: {
      title: '允許應用程式顯示通知',
      hint: '來自應用程式和您的代理的提醒。',
      effect: `關閉：${P} 不顯示聊天或代理通知。`
    },
    keychain: {
      title: '把登入資訊保存在安全儲存區',
      hint: '簽署金鑰和登入權杖，以及在您開啟後加密的連線機密。系統可能會要求您允許存取。',
      effect: '是否已加密顯示在這一列旁邊，可以在連線設定中變更。'
    }
  },
  neverUsed: {
    camera: '應用程式從不使用您的相機',
    location: '應用程式從不使用您的位置',
    contacts: '應用程式從不使用您的聯絡人'
  },
  settings: {
    policyHeading: '您已接受的政策',
    policyRow: (version: string) => `政策與隱私（版本 ${version}）`,
    effective: (date: string) => `自 ${date} 起生效`,
    accepted: (date: string) => `已於 ${date} 接受`,
    acceptedOlder: (version: string) => `已接受版本 ${version}`,
    notAccepted: '未接受',
    openLive: '開啟線上頁面',
    readOffline: '在這裡閱讀',
    hideOffline: '隱藏全文',
    permissionsHeading: '應用程式和您的代理可以使用什麼',
    notConfigured: '尚未選擇',
    notConfiguredHint: '您跳過了這一步。在您選擇之前，只有功能需要權限時系統才會詢問。',
    permissionsFooter: `開關記錄 ${P} 可以使用什麼；功能第一次需要權限時，系統仍會詢問。麥克風、視窗標題和通知會立即變更；其餘內容會在代理下次啟動時生效。`,
    requestsHeading: '您的代理要求使用的內容',
    requestsEmpty: '還沒有要求。當任務需要您關閉的權限時，您的代理會在這裡詢問。',
    requestAnswer: { always: '一律允許', once: '允許一次', denied: '已拒絕', timeout: '未回應' },
    requestBy: (inft: string, date: string) => `${inft} · ${date}`,
    keychainState: (on: boolean) => (on ? '已加密' : '未加密'),
    keychainOpen: '開啟連線設定',
    aiHeading: '您的 AI 提供方',
    aiRow: '您的 AI 提供方會收到什麼',
    aiRowDesc:
      '訊息、檔案、人設和記憶，以及包含螢幕在內的工具結果，會從這台電腦直接傳送到您連線的提供方（政策 §5）。您在接受政策時已同意這一點。',
    aiWithdrawn: (date: string) => `已於 ${date} 撤回`,
    aiNotRecorded: '未記錄',
    aiWithdrawnHint: `${P} 會記錄您撤回的日期，但不會自行中斷已連線的提供方：要停止傳送，請在 設定 › 提供方 中斷開該提供方。`,
    aiAcceptAgain: '重新接受',
    openProviders: '開啟提供方',
    withdraw: '撤回同意',
    withdrawTitle: '撤回您對 AI 提供方的同意？',
    withdrawDesc: `${P} 會記錄您撤回的日期，但不會自行中斷已連線的提供方：要停止傳送，請在 設定 › 提供方 中斷開該提供方。`,
    withdrawConfirm: '撤回',
    saveFailed: '無法儲存，請再試一次。',
    unavailable: '隱私設定可在桌面應用程式中使用。'
  }
}

const ar: PrivacyCopy = {
  groups: {
    capabilities: 'ما يُسمح لوكيلك بفعله',
    device: 'ما يستخدمه التطبيق على هذا الحاسوب',
    neverUsed: 'ما لا يستخدمه التطبيق أبدًا'
  },
  rows: {
    terminal: {
      title: 'السماح لوكيلك بتشغيل الأوامر في الطرفية',
      hint: 'يشغّلها بصلاحيات حساب المستخدم الخاص بك، ويمكنك رؤية ما يشغّله.',
      effect: 'إيقاف: يُطلب من وكيلك ألا يشغّل أوامر الطرفية.'
    },
    fileWriting: {
      title: 'السماح لوكيلك بإنشاء الملفات وتغييرها',
      hint: 'على هذا الحاسوب فقط، وللمهمة التي أعطيتها له فقط.',
      effect: 'إيقاف: يُطلب من وكيلك ألا ينشئ الملفات أو يغيّرها أو يحذفها. تبقى قراءة المجلدات التي تختارها متاحة.'
    },
    webBrowsing: {
      title: 'السماح لوكيلك بتصفح الويب واستخدام الأدوات عبر الإنترنت',
      hint: 'يرسل فقط ما تحتاجه المهمة.',
      effect: 'إيقاف: يُطلب من وكيلك ألا يتصفح الويب أو يستدعي أدوات عبر الإنترنت.'
    },
    automation: {
      title: 'السماح لوكيلك بالتحكم في التطبيقات الأخرى',
      hint: 'فقط عندما تطلب منه ذلك.',
      effect: 'إيقاف: يُطلب من وكيلك ألا يتحكم في التطبيقات الأخرى.'
    },
    screen: {
      title: 'السماح لوكيلك برؤية شاشتك',
      hint: 'لقطات الشاشة والتسجيلات عندما تحتاجها المهمة، وعناوين نوافذ التطبيقات الأخرى.',
      effect: 'إيقاف: يحجب التطبيق عناوين نوافذ التطبيقات الأخرى، ويُطلب من وكيلك ألا يلتقط الشاشة أو يسجلها.'
    },
    clipboard: {
      title: 'السماح لوكيلك باستخدام الحافظة',
      hint: 'النسخ واللصق بينك وبين التطبيق ووكيلك.',
      effect: 'إيقاف: يُطلب من وكيلك ألا يستخدم الحافظة. يبقى النسخ واللصق الخاص بك متاحًا دائمًا.'
    },
    installSoftware: {
      title: 'السماح لوكيلك بتثبيت البرامج',
      hint: 'الأدوات والحزم التي تحتاجها المهمة، مثل Homebrew أو npm أو pip.',
      effect: 'إيقاف: يُطلب من وكيلك ألا يثبّت البرامج أو الحزم.'
    },
    scheduledTasks: {
      title: 'السماح لوكيلك بجدولة مهام لوقت لاحق',
      hint: 'مهام تعمل لاحقًا على هذا الحاسوب.',
      effect: 'إيقاف: يُطلب من وكيلك ألا ينشئ مهام مجدولة.'
    },
    sendMessages: {
      title: 'السماح لوكيلك بإرسال البريد والرسائل نيابةً عنك',
      hint: 'بريد الوكيل المرسل باسمك.',
      effect: 'إيقاف: يُطلب من وكيلك ألا يرسل البريد أو الرسائل نيابةً عنك.'
    },
    spendTrade: {
      title: 'السماح لوكيلك بالإنفاق والتداول ضمن حدودك',
      hint: 'ضمن حد البطاقة أو مهام السوق أو التداول، وفقط بتفويضات منحتها أنت بنفسك.',
      effect: 'إيقاف: يُطلب من وكيلك ألا ينقل أي قيمة من دونك.'
    },
    microphone: {
      title: 'السماح للتطبيق باستخدام الميكروفون',
      hint: 'لميزات الصوت، مثل التحدث إلى وكيلك.',
      effect: 'إيقاف: يبقى زر الصوت متوقفًا ولا يُطلب الإذن من نظامك أبدًا.'
    },
    notifications: {
      title: 'السماح للتطبيق بعرض الإشعارات',
      hint: 'تنبيهات من التطبيق ومن وكيلك.',
      effect: `إيقاف: لا يعرض ${P} إشعارات المحادثة أو الوكيل.`
    },
    keychain: {
      title: 'حفظ بيانات تسجيل الدخول في تخزين آمن',
      hint: 'مفتاح التوقيع ورمز تسجيل الدخول، وأسرار الاتصال المشفّرة إذا فعّلت ذلك. قد يطلب نظامك منك السماح بالوصول.',
      effect: 'تظهر حالة التشفير بجانب هذا الصف، ويمكنك تغييرها في إعدادات الاتصال.'
    }
  },
  neverUsed: {
    camera: 'لا يستخدم التطبيق الكاميرا أبدًا',
    location: 'لا يستخدم التطبيق موقعك أبدًا',
    contacts: 'لا يستخدم التطبيق جهات اتصالك أبدًا'
  },
  settings: {
    policyHeading: 'السياسة التي قبلتها',
    policyRow: (version: string) => `السياسات والخصوصية، الإصدار ${version}`,
    effective: (date: string) => `سارية منذ ${date}`,
    accepted: (date: string) => `تم القبول في ${date}`,
    acceptedOlder: (version: string) => `تم قبول الإصدار ${version}`,
    notAccepted: 'لم يتم القبول',
    openLive: 'فتح الصفحة المباشرة',
    readOffline: 'القراءة هنا',
    hideOffline: 'إخفاء النص الكامل',
    permissionsHeading: 'ما يمكن للتطبيق ولوكيلك استخدامه',
    notConfigured: 'لم يتم الاختيار بعد',
    notConfiguredHint: 'لقد تخطيت هذه الخطوة. إلى أن تختار، يسأل نظامك فقط عندما تحتاج ميزة إلى إذن.',
    permissionsFooter: `يسجّل كل مفتاح ما يُسمح لـ ${P} باستخدامه؛ ويظل نظامك يسأل في أول مرة تحتاج فيها ميزة إلى إذن. يتغير الميكروفون وعناوين النوافذ والإشعارات فورًا؛ ويصل الباقي إلى وكيلك في المرة التالية التي يبدأ فيها.`,
    requestsHeading: 'ما طلب وكيلك استخدامه',
    requestsEmpty: 'لا توجد طلبات بعد. عندما تحتاج مهمة إلى إذن أوقفته، يسألك وكيلك هنا.',
    requestAnswer: { always: 'مسموح دائمًا', once: 'مسموح مرة واحدة', denied: 'مرفوض', timeout: 'لا إجابة' },
    requestBy: (inft: string, date: string) => `${inft} · ${date}`,
    keychainState: (on: boolean) => (on ? 'مشفّر' : 'غير مشفّر'),
    keychainOpen: 'فتح إعدادات الاتصال',
    aiHeading: 'مزوّد الذكاء الاصطناعي',
    aiRow: 'ما يتلقاه مزوّد الذكاء الاصطناعي',
    aiRowDesc:
      'تنتقل الرسائل والملفات والشخصية والذاكرة ونتائج الأدوات بما فيها الشاشة مباشرةً من هذا الحاسوب إلى المزوّد الذي تتصل به (السياسة §5). وقد وافقت على ذلك مع السياسة.',
    aiWithdrawn: (date: string) => `تم السحب في ${date}`,
    aiNotRecorded: 'غير مسجّل',
    aiWithdrawnHint: `يحتفظ ${P} بتاريخ سحبك للموافقة، لكنه لا يقطع اتصال المزوّد من تلقاء نفسه: لإيقاف الإرسال، افصل المزوّد في الإعدادات › المزوّدون.`,
    aiAcceptAgain: 'القبول مرة أخرى',
    openProviders: 'فتح المزوّدين',
    withdraw: 'سحب الموافقة',
    withdrawTitle: 'هل تريد سحب موافقتك على مزوّد الذكاء الاصطناعي؟',
    withdrawDesc: `يسجّل ${P} تاريخ سحبك للموافقة، لكنه لا يقطع اتصال المزوّد من تلقاء نفسه: لإيقاف الإرسال، افصل المزوّد في الإعدادات › المزوّدون.`,
    withdrawConfirm: 'سحب',
    saveFailed: 'تعذّر الحفظ. حاول مرة أخرى.',
    unavailable: 'إعدادات الخصوصية متاحة في تطبيق سطح المكتب.'
  }
}

const ptPt: PrivacyCopy = {
  groups: {
    capabilities: 'O que o seu agente pode fazer',
    device: 'O que a aplicação pode usar neste computador',
    neverUsed: 'O que a aplicação nunca usa'
  },
  rows: {
    terminal: {
      title: 'Permitir que o seu agente execute comandos num terminal',
      hint: 'Executa-os com as permissões da sua conta de utilizador, e pode ver o que executa.',
      effect: 'Desativado: o seu agente é instruído a não executar comandos no terminal.'
    },
    fileWriting: {
      title: 'Permitir que o seu agente crie e altere ficheiros',
      hint: 'Apenas neste computador e apenas para a tarefa que lhe deu.',
      effect:
        'Desativado: o seu agente é instruído a não criar, alterar nem eliminar ficheiros. Ler as pastas que escolher continua a funcionar.'
    },
    webBrowsing: {
      title: 'Permitir que o seu agente navegue na web e use ferramentas online',
      hint: 'Envia apenas o que a tarefa precisa.',
      effect: 'Desativado: o seu agente é instruído a não navegar na web nem chamar ferramentas online.'
    },
    automation: {
      title: 'Permitir que o seu agente controle outras aplicações',
      hint: 'Apenas quando lho pedir.',
      effect: 'Desativado: o seu agente é instruído a não controlar outras aplicações.'
    },
    screen: {
      title: 'Permitir que o seu agente veja o seu ecrã',
      hint: 'Capturas de ecrã e gravações quando uma tarefa precisa delas, e os títulos das janelas de outras aplicações.',
      effect:
        'Desativado: a aplicação oculta os títulos das janelas de outras aplicações, e o seu agente é instruído a não fazer capturas de ecrã nem gravações.'
    },
    clipboard: {
      title: 'Permitir que o seu agente use a área de transferência',
      hint: 'Copiar e colar entre si, a aplicação e o seu agente.',
      effect:
        'Desativado: o seu agente é instruído a não usar a área de transferência. O seu próprio copiar e colar funciona sempre.'
    },
    installSoftware: {
      title: 'Permitir que o seu agente instale software',
      hint: 'Ferramentas e pacotes de que uma tarefa precisa, como Homebrew, npm ou pip.',
      effect: 'Desativado: o seu agente é instruído a não instalar software nem pacotes.'
    },
    scheduledTasks: {
      title: 'Permitir que o seu agente agende tarefas para mais tarde',
      hint: 'Trabalhos que são executados mais tarde neste computador.',
      effect: 'Desativado: o seu agente é instruído a não criar tarefas agendadas.'
    },
    sendMessages: {
      title: 'Permitir que o seu agente envie e-mails e mensagens por si',
      hint: 'E-mails do agente enviados em seu nome.',
      effect: 'Desativado: o seu agente é instruído a não enviar e-mails nem mensagens por si.'
    },
    spendTrade: {
      title: 'Permitir que o seu agente gaste e negoceie dentro dos seus limites',
      hint: 'Dentro de um limite do cartão, trabalhos do mercado ou negociações, e apenas com autorizações que deu pessoalmente.',
      effect: 'Desativado: o seu agente é instruído a não movimentar valor sem si.'
    },
    microphone: {
      title: 'Permitir que a aplicação use o seu microfone',
      hint: 'Para funcionalidades de voz, como falar com o seu agente.',
      effect: 'Desativado: o botão de voz fica desativado e o sistema nunca é questionado.'
    },
    notifications: {
      title: 'Permitir que a aplicação mostre notificações',
      hint: 'Alertas da aplicação e do seu agente.',
      effect: `Desativado: ${P} não mostra notificações de conversas nem do agente.`
    },
    keychain: {
      title: 'Guardar os dados de início de sessão num armazenamento seguro',
      hint: 'A chave de assinatura e o token de sessão e, se o ativar, os segredos de ligação encriptados. O sistema pode pedir-lhe que permita o acesso.',
      effect: 'Se estão encriptados é indicado ao lado desta linha; pode alterá-lo nas definições de ligação.'
    }
  } satisfies Record<ConsentSwitchKey, PrivacyRow>,
  neverUsed: {
    camera: 'A aplicação nunca usa a sua câmara',
    location: 'A aplicação nunca usa a sua localização',
    contacts: 'A aplicação nunca usa os seus contactos'
  },
  settings: {
    policyHeading: 'A política que aceitou',
    policyRow: (version: string) => `Políticas e privacidade, versão ${version}`,
    effective: (date: string) => `Em vigor desde ${date}`,
    accepted: (date: string) => `Aceite em ${date}`,
    acceptedOlder: (version: string) => `Versão ${version} aceite`,
    notAccepted: 'Não aceite',
    openLive: 'Abrir a página em linha',
    readOffline: 'Ler aqui',
    hideOffline: 'Ocultar o texto completo',
    permissionsHeading: 'O que a aplicação e o seu agente podem usar',
    notConfigured: 'Ainda não escolhido',
    notConfiguredHint:
      'Ignorou este passo. Até escolher, o sistema só pergunta quando uma funcionalidade precisa de uma permissão.',
    permissionsFooter: `Um interruptor regista o que ${P} pode usar; o sistema continua a perguntar na primeira vez que uma funcionalidade precisa de uma permissão. O microfone, os títulos das janelas e as notificações mudam de imediato; o seu agente fica a saber o resto da próxima vez que iniciar.`,
    requestsHeading: 'O que o seu agente pediu para usar',
    requestsEmpty:
      'Ainda não há pedidos. Quando uma tarefa precisar de uma permissão que deixou desativada, o seu agente pede aqui.',
    requestAnswer: {
      always: 'Permitido sempre',
      once: 'Permitido uma vez',
      denied: 'Recusado',
      timeout: 'Sem resposta'
    } satisfies Record<RequestAnswer, string>,
    requestBy: (inft: string, date: string) => `${inft} · ${date}`,
    keychainState: (on: boolean): string => (on ? 'Encriptado' : 'Não encriptado'),
    keychainOpen: 'Abrir definições de ligação',
    aiHeading: 'O seu fornecedor de IA',
    aiRow: 'O que o seu fornecedor de IA recebe',
    aiRowDesc:
      'Mensagens, ficheiros, persona e memória, e resultados de ferramentas, incluindo o ecrã, vão diretamente deste computador para o fornecedor que ligar (política §5). Aceitou isto com a política.',
    aiWithdrawn: (date: string) => `Retirado em ${date}`,
    aiNotRecorded: 'Não registado',
    aiWithdrawnHint: `${P} guarda a data em que retirou o consentimento. Não desliga sozinho um fornecedor ligado: desligue o fornecedor em Definições › Fornecedores para deixar de enviar.`,
    aiAcceptAgain: 'Aceitar novamente',
    openProviders: 'Abrir Fornecedores',
    withdraw: 'Retirar consentimento',
    withdrawTitle: 'Retirar o seu consentimento para o fornecedor de IA?',
    withdrawDesc: `${P} regista a data em que o retirou. Não desliga sozinho um fornecedor ligado: para deixar de enviar, desligue o fornecedor em Definições › Fornecedores.`,
    withdrawConfirm: 'Retirar',
    saveFailed: 'Não foi possível guardar. Tente novamente.',
    unavailable: 'As definições de privacidade estão disponíveis na aplicação para computador.'
  }
}

const COPY: Record<Locale, PrivacyCopy> = { ar, en, ja, zh, 'zh-hant': zhHant, 'pt-PT': ptPt }

export const privacyCopy = (locale: Locale): PrivacyCopy => COPY[locale] ?? en

export function usePrivacyCopy(): PrivacyCopy {
  const { locale } = useI18n()

  return privacyCopy(locale)
}
