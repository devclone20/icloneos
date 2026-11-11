// iclone os — V3-F 权限模式（简体中文）。设置 › 智能体 › 权限，以及同意面板上的权限请求。
import { PRODUCT_NAME } from '@/i18n/en/enConsent'
import type { PermissionsCopy } from '@/i18n/en/enPermissions'
import { FUNCTION_COPY } from '@/iclone-shared/permission-function-copy'

export const zhPermissions: PermissionsCopy = {
  title: '权限',
  lead: `你的智能体在这台 Mac 上无需询问你即可做的事。模式通过在此应用中的点击更改，智能体的请求和更新都不能更改它；在“忽略权限”下且电脑操控开启时，智能体也能点击。`,
  enforcement: {
    enforced: '已生效：智能体的每次工具调用都会先经过这些规则。',
    starting: '启动中：正在确认智能体已加载权限关卡。',
    'not-enforced': '未生效：权限关卡没有响应，在智能体重启前其工具调用都会被拒绝。',
    'no-agent': '智能体未运行。',
    degraded: '系统钥匙串无法保护记录的密钥：仅限手动模式，重启后无法验证记录。',
    // FX-2 r1b: the degraded state's cause when the owner's Keychain setting is off, and the fix.
    'keychain-off':
      '你选择的模式会持续到退出 icloneOS，之后恢复为手动：钥匙串设置已关闭，因此无法受保护地保存。要保留它，请在 设置 › 设备 › 网关 ›“把已保存的密码存入系统钥匙串” 中打开钥匙串。',
    // V3-FX M1: turned on while the app runs — payments and the ACP tools follow at once, the modes after a restart.
    'keychain-restart':
      '钥匙串已打开。权限密钥在 icloneOS 启动时封存：请重启 icloneOS 以使用自动、计划等模式。支付和 ACP 工具已经可以使用。'
  },
  // r3/r4: the button beside the modes' restart line (the Keychain turned on since launch), and what it says
  // when main refuses the relaunch.
  restartNow: '立即重启',
  restartRefused: 'icloneOS 现在无法重启。请退出后重新打开，即可使用这些模式。',
  modes: {
    ignore: {
      name: '忽略权限',
      short: '从不询问',
      summary:
        '什么都不询问，包括花钱、转移 iNFT、发送密钥、管理员密码和自身权限。除隔离开启时的隔离外，保留五项检查：摧毁整个磁盘、主文件夹或系统，整个目标是无法读懂的变量或命令输出的递归删除，或它能读出是针对整个磁盘、主文件夹或系统的递归删除（包括变量留空时会变成这样的情况，或由无法读懂名称的命令执行），或它无法完整读懂目标或选项的递归删除，无法读懂、因而无法检查的调用（无法确定所涉文件的补丁、未指明文件的写入或无法读懂的参数），你自己写的拒绝规则，以及文件工具对运行时自身存储（写入 state.db、会话、令牌、配对、保险库、浏览器配置文件和运行时自身的 .env；读取令牌、保险库、浏览器配置文件、auth.json、auth.lock、该 .env 和 webhook 订阅）的访问。电脑操控、屏幕录制和浏览器在 Seatbelt 之外运行，文件工具会在 Seatbelt 之外逐个写入主文件夹中的文件。'
    },
    manual: {
      name: '手动',
      short: '行动前先询问',
      summary:
        '除写入自身 iNFT 档案（SOUL、记忆、自身文件夹）外，每次写入、命令、联网、发消息、安装和删除前都会询问。读取项目内容无需询问，读取主文件夹其他位置的文件可能会询问，受隔离的命令只能读取它运行所在的文件夹。'
    },
    automatic: {
      name: '自动',
      short: '编辑并运行安全命令',
      summary: '自行在项目内写入、运行安全的命令并使用网络，其余都会询问。'
    },
    plan: {
      name: '计划',
      short: '阅读并规划',
      summary: '阅读并在聊天中制定计划。除自身 iNFT 档案（SOUL、记忆、自身文件夹）外，不做任何更改。'
    },
    acceptEdits: { name: '接受编辑', short: '编辑无需询问', summary: '自行编辑项目内的文件，其余一律询问。' }
  },
  menu: {
    title: '此聊天',
    trigger: (mode: string) => `此聊天的权限模式：${mode}`,
    triggerNotInForce: (inForce: string, chosen: string) => `此聊天的权限模式：${inForce}。已选择 ${chosen}，但未生效`,
    appliesToSession: '仅此聊天，从下一条消息起。默认值在“设置 › 智能体 › 权限”。',
    appliesToNewChat: '仅此新聊天。默认值在“设置 › 智能体 › 权限”。',
    ignoreNote: {
      confined: '五项检查仍会拒绝。详情见设置。',
      unconfined: 'Seatbelt 已关闭：仅剩五项应用内检查。'
    }
  },
  classes: {
    R: '读取文件',
    Wp: '写入项目内的文件',
    Wo: '写入项目外的文件',
    X: '运行命令',
    N: '使用网络',
    $: '花钱',
    M: '发送消息',
    S: '申请系统权限',
    I: '安装软件',
    D: '删除文件'
  },
  current: '使用中',
  chosenNotInForce: '已选择，未生效',
  choose: '使用',
  scope: {
    label: '适用于',
    standing: '新会话的默认设置',
    standingNote:
      '已打开且有自己模式的聊天会保持该模式，可在其消息栏中更改。聊天及其项目都没有自己的模式时，遵循此默认设置。',
    project: path => `此项目 · ${path}`,
    noProject: '打开一个项目即可为它单独选择模式。'
  },
  refused: {
    gesture: '模式只能通过在此应用中的点击更改。',
    invalid: '此处无法选择该模式。',
    unavailable: `权限模式需要 ${PRODUCT_NAME} 桌面应用。`
  },
  floor: {
    title: '仍会检查的内容',
    items: [
      '在所有模式下（包括“忽略权限”），都会拒绝抹掉磁盘、你的主文件夹或系统文件夹，或格式化驱动器。',
      '在“忽略权限”以外，未经你回答，它不能转移 iNFT、发送你的密钥、输入管理员密码或更改自己的权限，任何授权都不能解除这一点。',
      '在“忽略权限”下什么都不会询问，因此它可以做以上所有事情。',
      '这些是应用内的检查，不是内核层的屏障：程序可以绕过它们。'
    ]
  },
  // V3-F2: the Functions matrix (shared with main's native raise confirm).
  functions: FUNCTION_COPY.zh,
  // FX-6: what confinement really does (on by default, V3-G); the pane picks the line for the live state.
  shellNote: {
    on: '隔离已开启，你可以将其关闭。智能体命令在所有模式下都在隔离中运行（Seatbelt），包括“忽略权限”：只能写入项目和一个临时文件夹，只有在模式或授权允许时才能访问网络。你批准的 shell 命令会在隔离之外运行一次。',
    off: '隔离已关闭：在所有模式下，命令都以你的身份运行，可以读取和更改你能访问的一切。',
    // V3-FX M2: main's live verdict is red (on but not working), or not read yet.
    red: '隔离目前未生效（原因见“容器”）：在恢复之前，任何模式下的命令都可以读取和更改你能访问的一切。',
    pending: '正在读取隔离状态…'
  },
  grants: {
    title: '你给出的权限',
    empty: '暂无。当你允许超过一次时，它会显示在这里。',
    scope: { session: '此聊天', project: '此项目', standing: '所有地方' },
    revoke: '撤销',
    folderTitle: '你允许的文件夹',
    folderHint: '在模式允许时，命令可以写入此处',
    removeFolder: '移除'
  },
  // A-1：主进程在启动时拒绝或无法验证的权限状态文件。
  integrity: {
    mode: {
      tampered: `磁盘上的权限模式在 ${PRODUCT_NAME} 之外被更改或损坏，不再生效：在您重新选择模式之前，所有位置均为手动。`,
      unverified: '权限模式由旧版本保存，或在钥匙串关闭时保存，因此无法验证：在您重新选择模式之前，所有位置均为手动。',
      missing: '权限模式文件缺失：在您重新选择模式之前，所有位置均为手动。'
    },
    functions: {
      tampered: `磁盘上的功能级别在 ${PRODUCT_NAME} 之外被更改或损坏，不再生效：在您重新选择之前，每项功能均为手动。`,
      unverified:
        '功能级别由旧版本保存，或在钥匙串关闭时保存，因此无法验证：比手动更宽的每个级别保持为手动，直到您在下方确认。',
      missing: '功能级别文件缺失：在您重新选择之前，每项功能均为手动。'
    },
    grants: {
      tampered: `您授予的权限在 ${PRODUCT_NAME} 之外被更改或损坏，不再生效：再次询问时请重新允许。`,
      unverified: '您授予的权限由旧版本保存，或在钥匙串关闭时保存，因此无法验证且不再生效：再次询问时请重新允许。',
      missing: '您授予的权限文件缺失；均不生效：再次询问时请重新允许。'
    }
  },
  audit: {
    title: '活动',
    empty: '尚无记录。',
    chainOk: count => `${count.toLocaleString()} 条记录 · 完整`,
    chainBroken: `记录有缺口，或在 ${PRODUCT_NAME} 之外被更改。`,
    chainVerifying: '正在检查记录…',
    otherKind: '权限记录',
    kinds: {
      use: '已允许',
      refuse: '已拒绝',
      ask: '已询问你',
      answer: '你的回答',
      timeout: '无回答',
      mode_set: '模式已更改',
      mode_refused: '更改被拒绝',
      grant: '已授予权限',
      revoke: '已撤销权限',
      gap: '缺口',
      restart: `${PRODUCT_NAME} 已启动`,
      fn_level_set: '级别已更改',
      fn_level_refused: '级别更改被拒绝'
    },
    details: {
      denied: '你已拒绝',
      busy: '等待中的权限请求过多',
      withdrawn: '在你回答前已撤回',
      noGesture: '并非你亲手点击',
      notConfirmed: '未在系统对话框中确认',
      standingIgnore: '被早期版本拒绝：当时“忽略权限”不能设为默认设置',
      invalid: '无效的更改',
      raced: '对话框打开期间级别已更改',
      gateNotStarted: pid =>
        pid
          ? `Hermes 中的权限关卡（pid ${pid}）从未启动；其工具调用会被拒绝`
          : 'Hermes 中的权限关卡从未启动；其工具调用会被拒绝',
      gateStopped: pid => (pid ? `Hermes 中的权限关卡（pid ${pid}）已停止响应` : 'Hermes 中的权限关卡已停止响应'),
      unverified: count => `来自 Hermes 的 ${count} 行无法验证，未被记录`,
      missedEvents: count => `来自权限关卡的 ${count} 个事件从未到达`,
      confinementBurst: count => `该分钟内另有 ${count} 次隔离拒绝只保存在 容器 › 拒绝记录 中`,
      confined: '被隔离拦截',
      gap: '有内容未能记录',
      payment: {
        settled: '付款已结算',
        pending: '结算仍在等待中',
        failed: '付款未完成',
        ledger: '付款记录未通过验证',
        limit: '超出 经济 › 支付 中的限额',
        stopped: '紧急停止：所有付款都会被拒绝',
        payee: '收款方或网站不被允许',
        mandate: '没有有效的授权书',
        denied: '你在权限请求中拒绝了',
        setting: '对 经济 › 支付 的更改',
        service: '被支付服务拒绝',
        other: '一笔付款',
        unrecorded: '一笔未记入付款记录的付款',
        uncertain: '结果未知：请查看付款记录',
        stopOff: '紧急停止已解除',
        mandateIssued: '授权书已签发',
        mandateRevoked: '授权书已撤销',
        mandateChange: '对授权书的更改'
      }
    }
  },
  ask: {
    eyebrow: who => `权限请求 · ${who}`,
    title: what => `你的智能体想要${what}`,
    targetLabel: '具体内容',
    folderLabel: '所在文件夹',
    expand: '显示全部',
    collapse: '收起',
    reasonLabel: '原因（智能体的原话）',
    heldFile:
      '这是 shell、git 或 launchd 运行时使用的文件，或其中保存着密钥。智能体写入这里的内容之后可能以你的权限运行。允许前请先阅读路径。',
    outsideFilePatch: '允许后，将在 Seatbelt 之外读取并随后写入这一个文件。智能体会看到它更改的行：',
    effects: {
      R: '它只会读取，不做任何更改。',
      Wp: '它会在项目内创建或修改此文件。',
      Wo: '它会在项目外创建或修改此文件。Seatbelt 开启时，此应用自身的文件保持关闭，届时会告知智能体改用 shell 命令，你会先读完整内容。',
      X: '它会在这台 Mac 上运行此命令。',
      N: '它会通过互联网发送此请求。',
      $: '它会从你的钱包或卡中转出这笔金额。',
      M: '它会以你的名义发送此消息。',
      S: '它会向 macOS 申请此权限；由你在系统设置中授予。',
      I: '它会为你的用户安装此软件。',
      D: '它会删除此内容。'
    },
    mode: name => `模式：${name}`,
    scopeLabel: '允许范围',
    scopes: { once: '仅此一次', session: '此聊天', project: '此项目', standing: '所有地方' },
    laterConfined:
      '只有这条命令会到外面运行。之后不受任何检查拦截的命令不再询问并留在 Seatbelt 内，需要更多权限的会被拒绝。在“设置 › 智能体 › 权限”中撤销此项即可重新询问。',
    heldRead:
      '此文件或文件夹保存密钥或令牌，或由你的 shell 运行。Seatbelt 已关闭，再没有其他阻拦：允许后智能体将获得其全部内容，它读到的内容会发送给模型。',
    covers: {
      session: (what: string) => `允许此聊天中所有“${what}”的请求，而不只是这一次。`,
      project: (what: string) => `允许此项目中所有“${what}”的请求，而不只是这一次。`,
      standing: (what: string) => `在所有地方允许所有“${what}”的请求，直到你撤销。`
    },
    deny: '拒绝',
    allow: '允许',
    expires: '两分钟内未回答视为拒绝。'
  },
  modeReset: {
    standing: (mode: string) => `由于找不到记录，默认模式已恢复为${mode}。请重新选择。`,
    project: (mode: string | null) =>
      mode === null
        ? '由于找不到记录，某个项目的专属模式已被移除。请重新选择。'
        : `由于找不到记录，某个项目的模式已恢复为${mode}。请重新选择。`,
    session: (mode: string | null) =>
      mode === null
        ? '由于找不到记录，某个对话的专属模式已被移除。请重新选择。'
        : `由于找不到记录，某个对话的模式已恢复为${mode}。请重新选择。`,
    dismiss: '关闭'
  },
  approvalPointer: '正在等待你的许可——请在顶部的面板中回答。'
}
