import type { Translations } from '../types'

export const boot: Translations['boot'] = {
  ready: 'iclone os 已就绪',
  desktopBootFailedWithMessage: message => `桌面启动失败：${message}`,
  steps: {
    connectingGateway: '正在连接桌面网关',
    preparingAgentDependencies: '正在准备智能代理的依赖项…',
    loadingSettings: '正在加载设置',
    loadingSessions: '正在加载最近会话',
    retryingRemoteBackend: '正在重新连接远程智能体后端…',
    startingDesktopConnection: '正在启动桌面连接',
    startingHermesDesktop: '正在启动 iclone os…'
  },
  errors: {
    backgroundExited: '智能体后台进程已退出。',
    backgroundExitedDuringStartup: '智能体后台进程在启动期间退出。',
    backendStopped: '后端已停止',
    desktopBootFailed: '桌面启动失败',
    gatewayConnectionLost: '与网关的连接已断开',
    gatewayConnectionLostDetail: '仍在后台重试。你可以继续阅读和起草；如果问题持续，请打开网关设置。',
    gatewaySignInRequired: '需要登录网关',
    ipcBridgeUnavailable: '桌面 IPC 桥不可用。'
  },
  failure: {
    title: '智能体无法启动',
    description: '后台网关没有启动。请尝试下面的恢复步骤；这里不会删除你的对话或设置。',
    remoteTitle: '需要重新登录远程网关',
    remoteDescription: '你的远程网关会话已过期。请重新登录以恢复连接。这些操作不会删除你的对话或设置。',
    retry: '重试',
    repairInstall: '修复安装',
    useLocalGateway: '使用本地网关',
    gatewaySettings: '网关设置',
    back: '返回',
    openLogs: '打开日志',
    repairHint: '修复会重新运行安装器，在新机器上可能需要几分钟。',
    remoteSignInHint: signInLabel =>
      `先退出已保存的远程浏览器会话，然后打开${signInLabel}。也可以使用本地网关切换到随应用提供的后端。`,
    signOutAndSignIn: '退出并重新登录',
    remoteFailureHint: '在“网关设置”中检查网关 URL 和登录，或切换到本地网关。',
    cloudDownTitle: '你的云端智能体已宕机',
    cloudDownDescription:
      '此网关连接的托管云端智能体正在返回服务器错误。无法在此处重启——请检查其状态、切换到本地网关或获取支持。',
    cloudDownHint: '使用下方按钮打开 Nous Portal（查看实例状态与操作）或加入 Discord 获取支持。',
    gateTitle: '权限关卡未生效',
    gateDescription:
      'icloneOS 没有启动智能体：无法在此智能体运行时中安装或加载权限关卡，因此任何命令都不会被检查。此处的操作不会删除你的聊天或设置。',
    gateHint:
      '“重试”会再次检查权限关卡。“修复安装”会重新安装智能体运行时，然后安装权限关卡。如果上方的方框显示权限关卡已在配置中被禁用，请先从 Hermes 的 config.yaml 中的 plugins.disabled 里移除 iclone-permissions 和 iclone-confinement，然后重试。',
    gateHintUnmanaged:
      '此智能体运行时不是由 icloneOS 安装的（例如你自己的 Hermes git 检出），因此 icloneOS 只会检查它，绝不会更改它。“修复安装”会在应用的文件夹中设置 icloneOS 自己经过验证的副本；你的文件夹保持不变。',
    cloudDownCheckPortal: '查看 Portal 状态',
    cloudDownDiscord: '在 Discord 获取帮助',
    hideRecentLogs: '隐藏最近日志',
    showRecentLogs: '显示最近日志',
    signedInTitle: '已登录',
    signedInMessage: '正在重新连接远程网关…',
    signInIncompleteTitle: '登录未完成',
    signInIncompleteMessage: '登录窗口在认证完成前关闭。',
    signInFailed: '登录失败',
    signInToRemoteGateway: '登录远程网关',
    signInWithProvider: provider => `使用 ${provider} 登录`,
    identityProvider: '你的身份提供方'
  }
}
