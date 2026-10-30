import type { Translations } from '../../types'
import type { SettingsProfileTranslations } from '../../types/settings/profile'

export const settingsProfile: Pick<Translations['settings'], keyof SettingsProfileTranslations> = {
  credentials: {
    pasteKey: '粘贴密钥',
    pasteLabelKey: label => `粘贴 ${label} 密钥`,
    optional: '可选',
    enterValueFirst: '请先输入一个值。',
    couldNotSave: '无法保存凭据。',
    remove: '移除',
    getKey: '获取密钥',
    saving: '保存中'
  },
  envActions: {
    actions: '操作',
    manageInKeys: '在 API 密钥中管理',
    docs: '文档',
    hideValue: '隐藏值',
    revealValue: '显示值',
    replace: '替换',
    set: '设置'
  },
  keys: {
    failedLoad: 'API 密钥加载失败',
    empty: '此类别暂时没有配置项。'
  },
  providers: {
    connectAccount: '连接账号',
    haveApiKey: '改用 API 密钥？',
    intro: '用你已有的账户登录，无需复制密钥。登录会在浏览器中打开，并在这里完成。',
    connected: '已连接',
    collapse: '收起',
    connectAnother: '连接其他提供方',
    otherProviders: '其他提供方',
    claudeSubscription: 'Claude 订阅（需要额外使用额度）',
    disconnect: '断开连接',
    disconnectInTerminal: '断开连接（在终端中运行移除命令）',
    removeExternalGeneric: provider => `${provider} 由其自身的 CLI 管理 — 请在那里移除。`,
    removeKeyManaged: provider => `${provider} 由 API 密钥配置。请从 API Keys 中移除。`,
    removeTerminalRunning: provider => `正在终端中断开 ${provider}…`,
    removedTitle: '账号已移除',
    removedMessage: provider => `${provider} 已移除。`,
    noProviderKeys: '没有可用的提供方 API 密钥。',
    searchKeys: '搜索提供方…',
    noKeysMatch: '没有匹配的提供方。',
    manage: provider => `管理 ${provider}`,
    endpoints: {
      heading: '你自己的模型服务器',
      addHeading: '添加服务器',
      editHeading: '编辑此服务器',
      name: '这个服务器的名称',
      nameHint: '选择模型时你会看到这个名称。',
      providerId: '这个服务器的简短 ID',
      providerIdHint: '小写字母、数字和连字符；应用用它区分不同服务器。',
      url: '服务器的应答地址',
      urlHint: '它的网址；兼容 OpenAI 的服务器通常以 /v1 结尾。',
      model: '默认用哪个模型回答',
      context: '模型能记住多少对话内容',
      contextHint: '保持“自动”，应用会向服务器询问。',
      apiKey: '服务器需要的密钥',
      apiKeyHint: '仅在服务器要求时填写。',
      useForNewChats: '新对话使用这个服务器',
      discoverModels: '测试时查找它提供的模型',
      discoverModelsHint: '找到的列表会填入上方的模型字段。'
    },
    featuredPitch: '一个订阅即可使用 300 多个前沿模型。',
    moreFields: count => `更多设置（${count}）`,
    localEndpoint: {
      title: '使用你自己的模型服务器',
      description: '任何兼容 OpenAI 的服务器都可以，例如 vLLM、llama.cpp 或 Ollama。',
      action: '设置'
    }
  }
}
