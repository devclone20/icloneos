// iCLONE OS — first-launch consent sheet + Settings › Privacy, Simplified Chinese (U2-p2b-01).
// The policy text itself stays English and binding; these are the sheet's own words.
import { type ConsentBank, PRODUCT_NAME } from '@/i18n/en/enConsent'

export const zhConsent: ConsentBank = {
  sheet: {
    eyebrow: (title, version, effective) => `${title} · 版本 ${version} · 生效日期 ${effective}`,
    termsTitle: '开始之前',
    termsLead: `${PRODUCT_NAME} 在这台 Mac 上运行你的智能体。这是它处理你数据方式的简要说明。`,
    updateTitle: '我们的政策已更新',
    updateLead: `请阅读并接受新版本，以继续使用 ${PRODUCT_NAME}。你已保存的权限选择保持不变。`,
    readFull: '阅读完整政策',
    readOffline: '离线阅读',
    hideOffline: '收起全文',
    offlineUnavailable: '无法读取随附的副本。完整政策见 cloneframe.io/privacy。',
    policyLanguage: '本政策以英文撰写，以英文文本为准。',
    aiDisclosure:
      '当你连接 AI 提供商时，你的消息、文件、人格与记忆，以及包括屏幕在内的工具结果，会从这台 Mac 直接发送给该提供商（政策 §5）。',
    accept: (title, version) => `我已阅读并接受 ${title} v${version}，包括向我连接的 AI 提供商发送数据`,
    quit: '退出',
    continue: '继续',
    permissionsEyebrow: '权限',
    permissionsTitle: `你的智能体和 ${PRODUCT_NAME} 在这台 Mac 上可以做什么`,
    permissionsFooter:
      '现在不会向 macOS 请求任何权限。只有当某项功能需要时系统才会询问；你可以随时在设置 › 隐私或系统设置 › 隐私与安全性中更改。',
    acceptHint: '接受政策以继续',
    keychainLine: on =>
      on
        ? '你的网关登录信息由 Mac 钥匙串加密；macOS 可能会请你允许一次。'
        : '你的网关登录信息保存在这台 Mac 上，未经钥匙串加密。',
    keychainChange: '你可以在设置 › 网关中更改；macOS 可能会在那里再次询问。',
    skip: '暂时跳过',
    allowAll: '全部允许',
    allAllowed: '已全部允许',
    allowAllKeychainTitle: '钥匙串保持不变',
    allowAllKeychain: '“全部允许”不会更改钥匙串：你已保存的密钥保持设置 › 网关中的状态（未加密）。请在那里开启加密。',
    saving: '正在保存…',
    saveFailed: '无法保存你的选择。请重试。',
    step: (n, total) => `第 ${n} 步，共 ${total} 步`
  },
  groups: {
    capabilities: '智能体能力',
    capabilitiesHint: '智能体启动时会被告知每项选择。当任务需要你关闭的某项能力时，它会先在这里询问你。',
    device: '设备',
    deviceHint: '只有当某项功能需要时 macOS 才会询问。',
    neverUsed: '从不使用',
    neverUsedHint: `仅供参考：${PRODUCT_NAME} 不使用这些。`
  },
  rows: {
    terminal: { name: '终端命令', purpose: '允许智能体以你的用户账户权限在终端中运行命令。你可以看到它运行了什么。' },
    fileWriting: { name: '写入文件', purpose: '允许智能体为完成任务在这台 Mac 上创建和修改文件' },
    webBrowsing: { name: '网页浏览与网络调用', purpose: '允许智能体替你浏览网页或使用在线工具，并发送任务所需的内容' },
    installSoftware: {
      name: '安装软件与软件包',
      purpose: '允许智能体在任务需要时安装工具和软件包（Homebrew、npm、pip）'
    },
    scheduledTasks: { name: '计划任务', purpose: '允许智能体创建稍后在这台 Mac 上运行的作业' },
    sendMessages: { name: '发送邮件与消息', purpose: '允许智能体代你发送智能体邮件' },
    spendTrade: {
      name: '消费与交易',
      purpose: '仅在你亲自给予的授权范围内，允许智能体在卡额度内消费、承接市场任务或进行交易'
    },
    microphone: { name: '麦克风', purpose: '允许你通过语音按钮与智能体对话' },
    screen: { name: '屏幕', purpose: '允许智能体为完成任务截屏或录屏' },
    automation: { name: '控制其他应用', purpose: '允许智能体为完成任务控制其他应用' },
    notifications: { name: '通知', purpose: `允许 ${PRODUCT_NAME} 显示聊天和智能体通知` },
    clipboard: { name: '剪贴板', purpose: '允许智能体为完成任务读写剪贴板' },
    keychain: { name: '钥匙串', purpose: '使用 Mac 钥匙串加密你的网关登录信息' }
  },
  neverUsed: {
    camera: { name: '相机', line: '本应用不使用你的相机。' },
    location: { name: '位置', line: '本应用不使用你的位置。' },
    contacts: { name: '通讯录', line: '本应用不使用你的通讯录。' }
  },
  effect: {
    terminal: '关闭：智能体被告知不要运行终端命令。',
    fileWriting: '关闭：智能体被告知不要创建、修改或删除文件。读取你选择的文件夹不受影响。',
    webBrowsing: '关闭：智能体被告知不要浏览网页或调用在线工具。',
    installSoftware: '关闭：智能体被告知不要安装软件或软件包。',
    scheduledTasks: '关闭：智能体被告知不要创建计划任务。',
    sendMessages: '关闭：智能体被告知不要代你发送邮件或消息。',
    spendTrade: '关闭：智能体被告知未经你同意不得转移价值。',
    microphone: '关闭：语音按钮保持关闭，且不会向 macOS 请求权限。',
    screen: '关闭：应用隐去其他应用的窗口标题，智能体被告知不要截屏或录屏。',
    automation: '关闭：智能体被告知不要控制其他应用。',
    notifications: `关闭：${PRODUCT_NAME} 不显示聊天或智能体通知。`,
    clipboard: '关闭：智能体被告知不要使用剪贴板。你自己的复制和粘贴始终可用。',
    keychain: '网关登录信息保存在这台 Mac 上；是否由钥匙串加密显示在本行旁边，可在设置 › 网关中更改。'
  },
  settings: {
    nav: '隐私',
    policyHeading: '政策',
    policyRow: version => `${PRODUCT_NAME} 政策与隐私 v${version}`,
    effective: date => `生效日期 ${date}`,
    accepted: date => `接受于 ${date}`,
    acceptedOlder: version => `已接受 v${version}`,
    notAccepted: '未接受',
    openLive: '打开在线页面',
    readOffline: '离线阅读',
    hideOffline: '收起全文',
    permissionsHeading: '权限',
    notConfigured: '未配置',
    notConfiguredHint: '你跳过了这一步。在你选择之前，只有当某项功能需要权限时 macOS 才会询问。',
    permissionsFooter: `开关记录 ${PRODUCT_NAME} 可以使用什么；某项功能首次需要权限时，macOS 仍会询问。`,
    requestsHeading: '来自智能体的请求',
    requestsEmpty: '暂无请求。当任务需要你关闭的权限时，智能体会在这里询问。',
    requestAnswer: { always: '始终允许', once: '允许一次', denied: '已拒绝', timeout: '无应答' },
    requestBy: (inft, date) => `${inft} · ${date}`,
    keychainState: on => (on ? '已加密' : '未加密'),
    keychainOpen: '打开网关设置',
    aiHeading: 'AI 提供商',
    aiRow: '你连接的 AI 提供商会收到什么',
    aiRowDesc: '消息、文件、人格与记忆，以及包括屏幕在内的工具结果，会从这台 Mac 直接发送给你连接的提供商（政策 §5）。',
    aiWithdrawn: date => `撤回于 ${date}`,
    aiNotRecorded: '未记录',
    aiWithdrawnHint: `${PRODUCT_NAME} 会保留你撤回的日期。它不会自行断开已连接的提供商：要停止发送，请在设置中断开该提供商。`,
    aiAcceptAgain: '再次接受',
    openProviders: '打开提供商',
    withdraw: '撤回对 AI 提供商的同意',
    withdrawTitle: '撤回对 AI 提供商的同意？',
    withdrawDesc: `${PRODUCT_NAME} 会记录你撤回的日期。它不会自行断开已连接的提供商：要停止发送，请在设置中断开该提供商。`,
    withdrawConfirm: '撤回',
    saveFailed: '无法保存。请重试。',
    unavailable: '隐私设置在桌面应用中可用。'
  },
  door: {
    eyebrow: inft => `权限请求 · ${inft}`,
    title: name => `你的智能体需要“${name}”`,
    reasonLabel: '原因（智能体的原话）',
    hint: `“允许一次”在 ${PRODUCT_NAME} 退出前有效。“始终允许”会开启设置 › 隐私中的开关。`,
    expires: '两分钟内无应答视为拒绝。',
    deny: '拒绝',
    once: '允许一次',
    always: '始终允许'
  }
}
