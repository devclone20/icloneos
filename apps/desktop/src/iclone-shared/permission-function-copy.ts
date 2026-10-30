/**
 * V3-F2 — the words of the per-function levels: the Functions matrix in Settings › Agent › Permissions (each locale's
 * permissions catalogue takes its block from here) and the NATIVE old → new confirm main shows before a level is
 * raised (a dialog no renderer can click). One file so main and the window say the same thing, in the six shipped
 * locales (pt-PT landed with the V3-T merge, M-T1).
 */
import { catalogueLocaleFor } from './offered-locale'
import type { FunctionLevel, PermissionFunction } from './permissions'

interface FunctionCopy {
  title: string
  lead: string
  /** Column headers of the matrix (short). */
  columns: Record<FunctionLevel, string>
  levels: Record<FunctionLevel, { name: string; summary: string }>
  functions: Record<PermissionFunction, { name: string; detail: string }>
  touchNote: string
  /**
   * The master key is not sealed in the system keychain, so nothing wider than Manual is in force yet. The cells stay
   * clickable and the choice is kept: this says so, and that the switch, a restart and the system dialog put it in force.
   */
  unsealed: string
  /**
   * A level chosen while unsealed is not in force until it is confirmed on the system dialog (review s4, M1). Takes
   * the row names, comma-separated.
   */
  unconfirmed: (names: string) => string
  /** A Privacy switch this row's actions can meet is OFF: those actions stay refused whatever the level. */
  capped: string
  /** A Privacy switch this row's actions can meet is undecided: what the level would allow asks first. */
  cappedUndecided: string
  levelAria: (fn: string, level: string) => string
  /** A pending cell: the user's choice, not in force yet (review s4 r2, lens 6). */
  levelPendingAria: (fn: string, level: string) => string
  /** Settings › Agent › Permissions › Activity: a level change, in the reader's words (main's log line is English). */
  change: (fn: string, from: string, to: string) => string
  refused: { gesture: string; invalid: string; unavailable: string }
  grantFor: (fn: string) => string
  dialog: {
    title: (fn: string, from: string, to: string) => string
    lead: string
    lifts: Record<FunctionLevel, string>
    still: string
    confirm: string
    cancel: string
  }
}

const PRODUCT = 'iclone os'

const en: FunctionCopy = {
  title: 'Functions',
  lead: 'How freely your agent acts in each area. A level here overrides the mode above for that area only; Follow mode is the default.',
  columns: {
    mode: 'Mode',
    ignore: 'Ignore',
    automatic: 'Auto',
    askOnce: 'Ask once',
    askAlways: 'Ask always',
    manual: 'Manual'
  },
  levels: {
    mode: { name: 'Follow mode', summary: 'Does what the mode above says. The default.' },
    ignore: { name: 'Ignore', summary: 'Fully autonomous: acts without asking you.' },
    automatic: { name: 'Automatic', summary: 'Acts on its own; asks when an action looks dangerous.' },
    askOnce: { name: 'Ask once', summary: 'Asks first; your answer can cover this chat, this project or everywhere.' },
    askAlways: { name: 'Ask always', summary: 'Asks every time; nothing you allowed before counts.' },
    manual: { name: 'Manual', summary: 'Off: your agent never does it; you do it yourself.' }
  },
  functions: {
    email: { name: 'Email', detail: 'Send, reply to and forward e-mail' },
    payments: {
      name: 'Payments',
      detail: 'x402, mandates, wallet sends and on-chain transactions; caps in Economy › Payments'
    },
    trading: { name: 'Trading', detail: 'Hyperliquid orders, deposits, withdrawals, swaps and bridges' },
    shopping: { name: 'Shopping', detail: 'AgentCard cards, checkouts and purchases' },
    acp: { name: 'ACP jobs', detail: 'Accept, deliver, fund and pay jobs on the ACP market' },
    messaging: { name: 'Messaging', detail: 'Telegram, X and other posts, messages and reactions' },
    shell: { name: 'Shell', detail: 'Run commands and code' },
    files: { name: 'Files', detail: 'Write, copy, move and delete files' },
    publish: { name: 'Network publish', detail: 'Push, publish, deploy, upload and submit forms' }
  },
  // R3-N: word for word the sentence of contract V3F2 §4.5 ("Consequence the pane states")
  touchNote:
    'On a command line, anything that spends is decided by all four money rows together (Payments, Trading, Shopping, ACP jobs), and anything that sends a message by both Email and Messaging. A command that does more is decided by the strictest row any part of it touches, Shell included. Code is decided by Shell and by every row touched by the commands it is seen to run.',
  unsealed:
    'Choose freely: what you pick is kept. Until the Keychain switch is on and icloneOS has restarted, the policy cannot be protected: a row marked Manual, or changed while the Keychain is off, never acts, and every other row asks before each action, whatever is marked. After the restart, a wider level is not in force until you click it and confirm it on the system dialog.',
  unconfirmed: names =>
    `Not in force yet: ${names}. Each was chosen while the Keychain was off, so for now it acts as Manual: your agent does not do it. To put the marked level in force, click it and confirm on the system dialog.`,
  capped: 'A switch in Settings › Privacy is off for some of this: those actions stay refused until you turn it on.',
  cappedUndecided:
    'A switch in Settings › Privacy is not decided yet for some of this: those actions ask you first until you decide it.',
  levelAria: (fn, level) => `${fn}: ${level}`,
  levelPendingAria: (fn, level) => `${fn}: ${level} — chosen, not in force yet`,
  change: (fn, from, to) => `${fn}: ${from} → ${to}`,
  refused: {
    gesture: 'A level is raised only from your own click.',
    invalid: 'This level cannot be set here.',
    unavailable: `Function levels need the ${PRODUCT} desktop app.`
  },
  grantFor: fn => `${fn} · Ask once`,
  dialog: {
    title: (fn, from, to) => `${fn}: ${from} → ${to}?`,
    lead: 'You are letting your agent act more freely here. From now on it will:',
    lifts: {
      mode: 'do what the permission mode says, which may let it act without asking',
      ignore: 'act without asking you, every time',
      automatic: 'act without asking unless the action looks dangerous',
      askOnce: 'ask once, then act on what you allow for longer',
      askAlways: 'ask you every time instead of never acting',
      manual: 'never do it'
    },
    still: `It still never does what ${PRODUCT} refuses at every level, and a switch you turned off in Privacy still refuses.`,
    confirm: 'Raise the level',
    cancel: 'Keep the current level'
  }
}

const ar: FunctionCopy = {
  title: 'الوظائف',
  lead: 'مدى حرية وكيلك في كل مجال. المستوى هنا يتجاوز الوضع أعلاه لهذا المجال وحده؛ «اتباع الوضع» هو الافتراضي.',
  columns: {
    mode: 'الوضع',
    ignore: 'تجاهل',
    automatic: 'تلقائي',
    askOnce: 'اسأل مرة',
    askAlways: 'اسأل دائمًا',
    manual: 'يدوي'
  },
  levels: {
    mode: { name: 'اتباع الوضع', summary: 'يفعل ما يقوله الوضع أعلاه. هذا هو الافتراضي.' },
    ignore: { name: 'تجاهل', summary: 'مستقل تمامًا: يتصرف دون أن يسألك.' },
    automatic: { name: 'تلقائي', summary: 'يتصرف وحده، ويسأل حين يبدو الإجراء خطرًا.' },
    askOnce: { name: 'اسأل مرة', summary: 'يسأل أولًا؛ قد يشمل جوابك هذه المحادثة أو هذا المشروع أو كل مكان.' },
    askAlways: { name: 'اسأل دائمًا', summary: 'يسأل في كل مرة؛ لا يُحتسب أي إذن سابق.' },
    manual: { name: 'يدوي', summary: 'متوقف: لا يفعله وكيلك أبدًا؛ تفعله أنت بنفسك.' }
  },
  functions: {
    email: { name: 'البريد الإلكتروني', detail: 'إرسال الرسائل والرد عليها وإعادة توجيهها' },
    payments: {
      name: 'المدفوعات',
      detail: 'x402 والتفويضات وإرسال المحفظة والمعاملات على السلسلة؛ الحدود في الاقتصاد › المدفوعات'
    },
    trading: { name: 'التداول', detail: 'أوامر Hyperliquid والإيداعات والسحوبات والمبادلات والجسور' },
    shopping: { name: 'التسوق', detail: 'بطاقات AgentCard وعمليات الدفع والمشتريات' },
    acp: { name: 'مهام ACP', detail: 'قبول المهام وتسليمها وتمويلها والدفع لها في سوق ACP' },
    messaging: { name: 'المراسلة', detail: 'منشورات Telegram وX وغيرهما والرسائل والتفاعلات' },
    shell: { name: 'الطرفية', detail: 'تشغيل الأوامر والشيفرة' },
    files: { name: 'الملفات', detail: 'كتابة الملفات ونسخها ونقلها وحذفها' },
    publish: { name: 'النشر على الشبكة', detail: 'الدفع والنشر والإطلاق والرفع وإرسال النماذج' }
  },
  touchNote:
    'في سطر الأوامر، كل ما ينفق المال تحسمه صفوف المال الأربعة معاً (المدفوعات، التداول، التسوق، مهام ACP)، وكل ما يرسل رسالة يحسمه صفّا البريد الإلكتروني والمراسلة معاً. والأمر الذي يفعل أكثر من ذلك يحسمه أشد صف يلمسه أي جزء منه، بما في ذلك الطرفية. أما الشيفرة فتحسمها الطرفية وكل صف تلمسه الأوامر التي يُرى أنها تشغّلها.',
  // G-25: English until this locale is translated.
  unsealed:
    'Choose freely: what you pick is kept. Until the Keychain switch is on and icloneOS has restarted, the policy cannot be protected: a row marked Manual, or changed while the Keychain is off, never acts, and every other row asks before each action, whatever is marked. After the restart, a wider level is not in force until you click it and confirm it on the system dialog.',
  unconfirmed: names =>
    `Not in force yet: ${names}. Each was chosen while the Keychain was off, so for now it acts as Manual: your agent does not do it. To put the marked level in force, click it and confirm on the system dialog.`,
  capped: 'مفتاح في الإعدادات › الخصوصية مُطفأ لبعض هذا: تبقى تلك الأفعال مرفوضة حتى تشغّل ذلك المفتاح.',
  cappedUndecided: 'مفتاح في الإعدادات › الخصوصية لم يُحسم بعد لبعض هذا: تلك الأفعال تسألك أولًا حتى تحسمه.',
  levelAria: (fn, level) => `${fn}: ${level}`,
  levelPendingAria: (fn, level) => `${fn}: ${level} — chosen, not in force yet`,
  change: (fn, from, to) => `${fn}: ${from} ← ${to}`,
  refused: {
    gesture: 'لا يُرفع المستوى إلا بنقرك أنت.',
    invalid: 'لا يمكن ضبط هذا المستوى هنا.',
    unavailable: `مستويات الوظائف تحتاج تطبيق ${PRODUCT} لسطح المكتب.`
  },
  grantFor: fn => `${fn} · اسأل مرة`,
  dialog: {
    title: (fn, from, to) => `${fn}: ${from} ← ${to}؟`,
    lead: 'أنت تمنح وكيلك حرية أكبر هنا. من الآن فصاعدًا سوف:',
    lifts: {
      mode: 'يفعل ما يقوله وضع الأذونات، وقد يسمح له ذلك بالتصرف دون سؤال',
      ignore: 'يتصرف دون أن يسألك، في كل مرة',
      automatic: 'يتصرف دون سؤال ما لم يبدُ الإجراء خطرًا',
      askOnce: 'يسأل مرة، ثم يتصرف بما تسمح به لمدة أطول',
      askAlways: 'يسألك في كل مرة بدلًا من ألا يتصرف أبدًا',
      manual: 'لا يفعله أبدًا'
    },
    still: `ولن يفعل أبدًا ما يرفضه ${PRODUCT} في كل المستويات، ويظل المفتاح الذي أطفأته في الخصوصية يرفض.`,
    confirm: 'رفع المستوى',
    cancel: 'الإبقاء على المستوى الحالي'
  }
}

const ja: FunctionCopy = {
  title: '機能',
  lead: '分野ごとにエージェントがどこまで自由に動くか。ここでのレベルは、その分野に限って上のモードより優先されます。既定は「モードに従う」です。',
  columns: {
    mode: 'モード',
    ignore: '無視',
    automatic: '自動',
    askOnce: '一度確認',
    askAlways: '毎回確認',
    manual: '手動'
  },
  levels: {
    mode: { name: 'モードに従う', summary: '上のモードのとおりに動きます。既定です。' },
    ignore: { name: '無視', summary: '完全に自律: 確認せずに実行します。' },
    automatic: { name: '自動', summary: '自分で実行し、危険に見える操作のときだけ確認します。' },
    askOnce: {
      name: '一度確認',
      summary: '最初に確認します。回答はこのチャット、このプロジェクト、またはすべてに適用できます。'
    },
    askAlways: { name: '毎回確認', summary: '毎回確認します。以前の許可は数えません。' },
    manual: { name: '手動', summary: 'オフ: エージェントは決して実行せず、あなたが自分で行います。' }
  },
  functions: {
    email: { name: 'メール', detail: 'メールの送信、返信、転送' },
    payments: { name: '支払い', detail: 'x402、委任、ウォレット送金、オンチェーン取引。上限は経済 › 支払いで設定' },
    trading: { name: 'トレード', detail: 'Hyperliquid の注文、入金、出金、スワップ、ブリッジ' },
    shopping: { name: 'ショッピング', detail: 'AgentCard のカード、チェックアウト、購入' },
    acp: { name: 'ACP ジョブ', detail: 'ACP マーケットでのジョブの受注、納品、資金提供、支払い' },
    messaging: { name: 'メッセージ', detail: 'Telegram や X などへの投稿、メッセージ、リアクション' },
    shell: { name: 'シェル', detail: 'コマンドとコードの実行' },
    files: { name: 'ファイル', detail: 'ファイルの書き込み、コピー、移動、削除' },
    publish: { name: 'ネットワークへの公開', detail: 'プッシュ、公開、デプロイ、アップロード、フォーム送信' }
  },
  touchNote:
    'コマンドラインでは、お金を使う操作はお金の 4 行（支払い、トレード、ショッピング、ACP ジョブ）すべてで、メッセージを送る操作はメールとメッセージの両方の行で決まります。それ以上のことをするコマンドは、その一部が関わる行のうち最も厳しいもの（シェルを含む）で決まります。コードは、シェルと、実行することが読み取れたコマンドが関わるすべての行で決まります。',
  // G-25: English until this locale is translated.
  unsealed:
    'Choose freely: what you pick is kept. Until the Keychain switch is on and icloneOS has restarted, the policy cannot be protected: a row marked Manual, or changed while the Keychain is off, never acts, and every other row asks before each action, whatever is marked. After the restart, a wider level is not in force until you click it and confirm it on the system dialog.',
  unconfirmed: names =>
    `Not in force yet: ${names}. Each was chosen while the Keychain was off, so for now it acts as Manual: your agent does not do it. To put the marked level in force, click it and confirm on the system dialog.`,
  capped: '設定 › プライバシーのスイッチがその一部でオフです: オンにするまで、その操作は拒否されます。',
  cappedUndecided: '設定 › プライバシーのスイッチがその一部で未設定です: 設定するまで、その操作は先に確認します。',
  levelAria: (fn, level) => `${fn}: ${level}`,
  levelPendingAria: (fn, level) => `${fn}: ${level} — chosen, not in force yet`,
  change: (fn, from, to) => `${fn}: ${from} → ${to}`,
  refused: {
    gesture: 'レベルはあなた自身のクリックでのみ上げられます。',
    invalid: 'このレベルはここでは設定できません。',
    unavailable: `機能レベルには ${PRODUCT} デスクトップアプリが必要です。`
  },
  grantFor: fn => `${fn} · 一度確認`,
  dialog: {
    title: (fn, from, to) => `${fn}: ${from} → ${to}？`,
    lead: 'ここでエージェントにより多くの自由を与えようとしています。今後エージェントは:',
    lifts: {
      mode: '権限モードのとおりに動き、確認せずに実行することもあります',
      ignore: '毎回、あなたに確認せずに実行します',
      automatic: '危険に見えない限り、確認せずに実行します',
      askOnce: '一度確認し、その後はあなたが長く許可した範囲で実行します',
      askAlways: '一切実行しない代わりに、毎回あなたに確認します',
      manual: '決して実行しません'
    },
    still: `${PRODUCT} がどのレベルでも拒否することは決して行わず、プライバシーでオフにしたスイッチも引き続き拒否します。`,
    confirm: 'レベルを上げる',
    cancel: '現在のレベルのままにする'
  }
}

const zh: FunctionCopy = {
  title: '功能',
  lead: '智能体在每个领域可以多自由地行动。这里的级别只在该领域覆盖上方的模式；默认是“跟随模式”。',
  columns: {
    mode: '模式',
    ignore: '忽略',
    automatic: '自动',
    askOnce: '询问一次',
    askAlways: '每次询问',
    manual: '手动'
  },
  levels: {
    mode: { name: '跟随模式', summary: '按上方的模式行事。这是默认值。' },
    ignore: { name: '忽略', summary: '完全自主：不询问你就行动。' },
    automatic: { name: '自动', summary: '自行行动；操作看起来危险时才询问。' },
    askOnce: { name: '询问一次', summary: '先询问；你的回答可以覆盖本次聊天、本项目或所有地方。' },
    askAlways: { name: '每次询问', summary: '每次都询问；之前的任何允许都不算数。' },
    manual: { name: '手动', summary: '关闭：智能体从不执行，由你亲自完成。' }
  },
  functions: {
    email: { name: '电子邮件', detail: '发送、回复和转发邮件' },
    payments: { name: '支付', detail: 'x402、授权、钱包转账和链上交易；上限在 经济 › 支付 中设置' },
    trading: { name: '交易', detail: 'Hyperliquid 订单、充值、提现、兑换和跨链桥' },
    shopping: { name: '购物', detail: 'AgentCard 卡片、结账和购买' },
    acp: { name: 'ACP 任务', detail: '在 ACP 市场接受、交付、出资和支付任务' },
    messaging: { name: '消息', detail: 'Telegram、X 等平台的帖子、消息和回应' },
    shell: { name: '终端', detail: '运行命令和代码' },
    files: { name: '文件', detail: '写入、复制、移动和删除文件' },
    publish: { name: '网络发布', detail: '推送、发布、部署、上传和提交表单' }
  },
  touchNote:
    '在命令行中，任何花钱的操作都由全部四个资金行（支付、交易、购物、ACP 任务）共同决定，任何发送消息的操作都由电子邮件和消息两行共同决定。做更多事情的命令，由其任一部分涉及的最严格的一行（包括终端）决定。代码由终端以及其可见运行的命令所涉及的每一行决定。',
  // G-25: English until this locale is translated.
  unsealed:
    'Choose freely: what you pick is kept. Until the Keychain switch is on and icloneOS has restarted, the policy cannot be protected: a row marked Manual, or changed while the Keychain is off, never acts, and every other row asks before each action, whatever is marked. After the restart, a wider level is not in force until you click it and confirm it on the system dialog.',
  unconfirmed: names =>
    `Not in force yet: ${names}. Each was chosen while the Keychain was off, so for now it acts as Manual: your agent does not do it. To put the marked level in force, click it and confirm on the system dialog.`,
  capped: '设置 › 隐私 中对其中部分操作的开关已关闭：在你打开该开关之前，这些操作会一直被拒绝。',
  cappedUndecided: '设置 › 隐私 中对其中部分操作的开关尚未决定：在你决定之前，这些操作会先询问你。',
  levelAria: (fn, level) => `${fn}：${level}`,
  levelPendingAria: (fn, level) => `${fn}: ${level} — chosen, not in force yet`,
  change: (fn, from, to) => `${fn}：${from} → ${to}`,
  refused: {
    gesture: '只有你亲手点击才能提高级别。',
    invalid: '此处无法设置该级别。',
    unavailable: `功能级别需要 ${PRODUCT} 桌面应用。`
  },
  grantFor: fn => `${fn} · 询问一次`,
  dialog: {
    title: (fn, from, to) => `${fn}：${from} → ${to}？`,
    lead: '你正在让智能体在这里更自由地行动。从现在起它将：',
    lifts: {
      mode: '按权限模式行事，可能不询问就行动',
      ignore: '每次都不询问你就行动',
      automatic: '除非操作看起来危险，否则不询问就行动',
      askOnce: '询问一次，之后按你较长期的允许行动',
      askAlways: '每次都询问你，而不是从不执行',
      manual: '从不执行'
    },
    still: `它仍然绝不会做 ${PRODUCT} 在任何级别下都拒绝的事，你在隐私中关闭的开关也仍会拒绝。`,
    confirm: '提高级别',
    cancel: '保持当前级别'
  }
}

const zhHant: FunctionCopy = {
  title: '功能',
  lead: '代理在每個領域可以多自由地行動。這裡的層級只在該領域覆蓋上方的模式；預設是「跟隨模式」。',
  columns: {
    mode: '模式',
    ignore: '忽略',
    automatic: '自動',
    askOnce: '詢問一次',
    askAlways: '每次詢問',
    manual: '手動'
  },
  levels: {
    mode: { name: '跟隨模式', summary: '依上方的模式行事。這是預設值。' },
    ignore: { name: '忽略', summary: '完全自主：不詢問你就行動。' },
    automatic: { name: '自動', summary: '自行行動；操作看起來危險時才詢問。' },
    askOnce: { name: '詢問一次', summary: '先詢問；你的回答可以涵蓋這次聊天、這個專案或所有地方。' },
    askAlways: { name: '每次詢問', summary: '每次都詢問；之前的任何允許都不算數。' },
    manual: { name: '手動', summary: '關閉：代理從不執行，由你親自完成。' }
  },
  functions: {
    email: { name: '電子郵件', detail: '傳送、回覆和轉寄郵件' },
    payments: { name: '付款', detail: 'x402、授權、錢包轉帳和鏈上交易；上限在 經濟 › 付款 中設定' },
    trading: { name: '交易', detail: 'Hyperliquid 訂單、入金、出金、兌換和跨鏈橋' },
    shopping: { name: '購物', detail: 'AgentCard 卡片、結帳和購買' },
    acp: { name: 'ACP 任務', detail: '在 ACP 市場接受、交付、出資和支付任務' },
    messaging: { name: '訊息', detail: 'Telegram、X 等平台的貼文、訊息和回應' },
    shell: { name: '終端機', detail: '執行指令和程式碼' },
    files: { name: '檔案', detail: '寫入、複製、移動和刪除檔案' },
    publish: { name: '網路發布', detail: '推送、發布、部署、上傳和送出表單' }
  },
  touchNote:
    '在指令列中，任何花錢的操作都由全部四個資金行（付款、交易、購物、ACP 任務）共同決定，任何傳送訊息的操作都由電子郵件和訊息兩行共同決定。做更多事情的指令，由其任一部分涉及的最嚴格的一行（包括終端機）決定。程式碼由終端機以及其可見執行的指令所涉及的每一行決定。',
  // G-25: English until this locale is translated.
  unsealed:
    'Choose freely: what you pick is kept. Until the Keychain switch is on and icloneOS has restarted, the policy cannot be protected: a row marked Manual, or changed while the Keychain is off, never acts, and every other row asks before each action, whatever is marked. After the restart, a wider level is not in force until you click it and confirm it on the system dialog.',
  unconfirmed: names =>
    `Not in force yet: ${names}. Each was chosen while the Keychain was off, so for now it acts as Manual: your agent does not do it. To put the marked level in force, click it and confirm on the system dialog.`,
  capped: '設定 › 隱私 中對其中部分操作的開關已關閉：在你開啟該開關之前，這些操作會一直被拒絕。',
  cappedUndecided: '設定 › 隱私 中對其中部分操作的開關尚未決定：在你決定之前，這些操作會先詢問你。',
  levelAria: (fn, level) => `${fn}：${level}`,
  levelPendingAria: (fn, level) => `${fn}: ${level} — chosen, not in force yet`,
  change: (fn, from, to) => `${fn}：${from} → ${to}`,
  refused: {
    gesture: '只有你親手點擊才能提高層級。',
    invalid: '此處無法設定該層級。',
    unavailable: `功能層級需要 ${PRODUCT} 桌面應用程式。`
  },
  grantFor: fn => `${fn} · 詢問一次`,
  dialog: {
    title: (fn, from, to) => `${fn}：${from} → ${to}？`,
    lead: '你正在讓代理在這裡更自由地行動。從現在起它將：',
    lifts: {
      mode: '依權限模式行事，可能不詢問就行動',
      ignore: '每次都不詢問你就行動',
      automatic: '除非操作看起來危險，否則不詢問就行動',
      askOnce: '詢問一次，之後依你較長期的允許行動',
      askAlways: '每次都詢問你，而不是從不執行',
      manual: '從不執行'
    },
    still: `它仍然絕不會做 ${PRODUCT} 在任何層級下都拒絕的事，你在隱私中關閉的開關也仍會拒絕。`,
    confirm: '提高層級',
    cancel: '保持目前層級'
  }
}

/** Every shipped catalogue. The keys are the i18n catalogue ids. */
const ptPt: FunctionCopy = {
  title: 'Funções',
  lead: 'A liberdade com que o seu agente atua em cada área. Um nível definido aqui sobrepõe-se ao modo acima, apenas nessa área; a predefinição é Seguir o modo.',
  columns: {
    mode: 'Modo',
    ignore: 'Ignorar',
    automatic: 'Automático',
    askOnce: 'Perguntar uma vez',
    askAlways: 'Perguntar sempre',
    manual: 'Manual'
  },
  levels: {
    mode: { name: 'Seguir o modo', summary: 'Faz o que o modo acima indica. É a predefinição.' },
    ignore: { name: 'Ignorar', summary: 'Totalmente autónomo: atua sem lhe perguntar.' },
    automatic: { name: 'Automático', summary: 'Atua sozinho; pergunta quando uma ação parecer perigosa.' },
    askOnce: {
      name: 'Perguntar uma vez',
      summary: 'Pergunta primeiro; a sua resposta pode valer nesta conversa, neste projeto ou em todo o lado.'
    },
    askAlways: {
      name: 'Perguntar sempre',
      summary: 'Pergunta todas as vezes; as permissões que concedeu antes não contam.'
    },
    manual: { name: 'Manual', summary: 'Desativado: o seu agente nunca o faz; fica a seu cargo.' }
  },
  functions: {
    email: { name: 'E-mail', detail: 'Enviar, responder e reencaminhar e-mails' },
    payments: {
      name: 'Pagamentos',
      detail: 'x402, mandatos, envios da carteira e transações on-chain; limites em Economia › Pagamentos'
    },
    trading: { name: 'Negociação', detail: 'Ordens, depósitos, levantamentos, swaps e bridges na Hyperliquid' },
    shopping: { name: 'Compras', detail: 'Cartões AgentCard, finalização de encomendas e compras' },
    acp: { name: 'Trabalhos ACP', detail: 'Aceitar, entregar, financiar e pagar trabalhos no Mercado ACP' },
    messaging: {
      name: 'Mensagens',
      detail: 'Publicações, mensagens e reações no Telegram, no X e noutras plataformas'
    },
    shell: { name: 'Terminal', detail: 'Executar comandos e código' },
    files: { name: 'Ficheiros', detail: 'Escrever, copiar, mover e eliminar ficheiros' },
    publish: {
      name: 'Publicação na rede',
      detail: 'Enviar (push), publicar, implementar, carregar e submeter formulários'
    }
  },
  touchNote:
    'Num comando de terminal, tudo o que gasta dinheiro é decidido pelas quatro linhas de dinheiro em conjunto (Pagamentos, Negociação, Compras, Trabalhos ACP), e tudo o que envia uma mensagem é decidido pelas duas linhas E-mail e Mensagens. Um comando que faz mais do que isso é decidido pela linha mais restrita em que toca qualquer parte dele, incluindo o Terminal. O código é decidido pelo Terminal e por todas as linhas tocadas pelos comandos que nele se detetam.',
  unsealed:
    'Escolha à vontade: o que marcar fica guardado. Enquanto o interruptor Keychain acima estiver desativado, a política não pode ser protegida, por isso cada linha funciona como Manual (pergunta-lhe antes de cada ação), seja o que for que esteja marcado aqui.',
  unconfirmed: names =>
    `Not in force yet: ${names}. Each was chosen while the Keychain was off, so for now it acts as Manual: your agent does not do it. To put the marked level in force, click it and confirm on the system dialog.`,
  capped:
    'Um interruptor em Definições › Privacidade está desativado para parte disto: essas ações continuam recusadas até o ativar.',
  cappedUndecided:
    'Um interruptor em Definições › Privacidade ainda está por definir para parte disto: até ser definido, o agente pergunta-lhe primeiro nessas ações.',
  levelAria: (fn, level) => `${fn}: ${level}`,
  levelPendingAria: (fn, level) => `${fn}: ${level} — chosen, not in force yet`,
  change: (fn, from, to) => `${fn}: ${from} → ${to}`,
  refused: {
    gesture: 'Um nível só sobe com um clique seu.',
    invalid: 'Este nível não pode ser definido aqui.',
    unavailable: `Os níveis por função precisam da aplicação para computador do ${PRODUCT}.`
  },
  grantFor: fn => `${fn} · Perguntar uma vez`,
  dialog: {
    title: (fn, from, to) => `${fn}: ${from} → ${to}?`,
    lead: 'Está a dar mais liberdade ao seu agente nesta área. A partir de agora, o agente vai:',
    lifts: {
      mode: 'fazer o que o modo de permissão indica, o que pode deixá-lo atuar sem perguntar',
      ignore: 'atuar sempre sem lhe perguntar',
      automatic: 'atuar sem perguntar, exceto quando a ação parecer perigosa',
      askOnce: 'perguntar uma vez e depois atuar de acordo com o que permitir, por mais tempo',
      askAlways: 'perguntar-lhe todas as vezes, em vez de nunca atuar',
      manual: 'nunca o fazer'
    },
    still: `Mesmo assim, nunca fará o que o ${PRODUCT} recusa em qualquer nível, e um interruptor desativado por si em Privacidade continua a recusar.`,
    confirm: 'Subir o nível',
    cancel: 'Manter o nível atual'
  }
}

export const FUNCTION_COPY: Readonly<Record<'ar' | 'en' | 'ja' | 'pt-PT' | 'zh' | 'zh-hant', FunctionCopy>> = {
  en,
  ar,
  ja,
  zh,
  'zh-hant': zhHant,
  'pt-PT': ptPt
}

/** The copy for a locale tag's catalogue language (`catalogueLocaleFor`); main passes `MAIN_DIALOG_LOCALE` (ruling 69). */
export function functionCopyFor(locale: string): FunctionCopy {
  return FUNCTION_COPY[catalogueLocaleFor(locale)]
}

/** The native raise dialog's text: the function, old → new, what the new level lets it do, what still holds. */
export function raiseConfirmText(
  locale: string,
  request: { fn: PermissionFunction; from: FunctionLevel; to: FunctionLevel }
): { title: string; detail: string; confirm: string; cancel: string } {
  const copy = functionCopyFor(locale)
  const fn = copy.functions[request.fn].name

  return {
    title: copy.dialog.title(fn, copy.levels[request.from].name, copy.levels[request.to].name),
    detail: [copy.dialog.lead, `• ${copy.dialog.lifts[request.to]}`, '', copy.dialog.still].join('\n'),
    confirm: copy.dialog.confirm,
    cancel: copy.dialog.cancel
  }
}
