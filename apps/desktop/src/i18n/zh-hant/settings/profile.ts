import type { TranslationOverrides } from '../../define-locale'
import type { SettingsProfileTranslations } from '../../types/settings/profile'

export const settingsProfile: Pick<NonNullable<TranslationOverrides['settings']>, keyof SettingsProfileTranslations> = {
  credentials: {
    pasteKey: '貼上金鑰',
    pasteLabelKey: label => `貼上 ${label} 金鑰`,
    optional: '選填',
    enterValueFirst: '請先輸入一個值。',
    couldNotSave: '無法儲存憑證。',
    remove: '移除',
    getKey: '取得金鑰',
    saving: '儲存中'
  },
  envActions: {
    actions: '動作',
    manageInKeys: '在 API 金鑰中管理',
    docs: '文件',
    hideValue: '隱藏值',
    revealValue: '顯示值',
    replace: '取代',
    set: '設定'
  },
  keys: {
    failedLoad: 'API 金鑰載入失敗',
    empty: '此類別尚未有任何設定。'
  },
  providers: {
    connectAccount: '連結帳號',
    haveApiKey: '改用 API 金鑰？',
    intro: '用你已有的帳戶登入，無需複製金鑰。登入會在瀏覽器中開啟，並在這裡完成。',
    connected: '已連線',
    collapse: '收合',
    connectAnother: '連結其他提供方',
    otherProviders: '其他提供方',
    claudeSubscription: 'Claude 訂閱（需要額外使用額度）',
    disconnect: '中斷連線',
    disconnectInTerminal: '中斷連線（在終端機中執行移除命令）',
    removeExternalGeneric: provider => `${provider} 由它自己的 CLI 管理，請在那裡移除。`,
    removeKeyManaged: provider => `${provider} 由 API 金鑰設定。請從 API Keys 中移除。`,
    removeTerminalRunning: provider => `正在終端機中中斷 ${provider} 的連線…`,
    removedTitle: '帳號已移除',
    removedMessage: provider => `${provider} 已移除。`,
    noProviderKeys: '沒有可用的提供方 API 金鑰。',
    searchKeys: '搜尋提供方…',
    noKeysMatch: '沒有符合的提供方。',
    manage: provider => `管理 ${provider}`,
    endpoints: {
      heading: '你自己的模型伺服器',
      addHeading: '新增伺服器',
      editHeading: '編輯此伺服器',
      name: '這個伺服器的名稱',
      nameHint: '選擇模型時你會看到這個名稱。',
      providerId: '這個伺服器的簡短 ID',
      providerIdHint: '小寫字母、數字和連字號；應用程式用它區分不同伺服器。',
      url: '伺服器的回應位址',
      urlHint: '它的網址；相容 OpenAI 的伺服器通常以 /v1 結尾。',
      model: '預設用哪個模型回答',
      context: '模型能記住多少對話內容',
      contextHint: '保持「自動」，應用程式會向伺服器詢問。',
      apiKey: '伺服器需要的金鑰',
      apiKeyHint: '僅在伺服器要求時填寫。',
      useForNewChats: '新對話使用這個伺服器',
      discoverModels: '測試時尋找它提供的模型',
      discoverModelsHint: '找到的清單會填入上方的模型欄位。'
    },
    featuredPitch: '一個訂閱即可使用 300 多個前沿模型。',
    moreFields: count => `更多設定（${count}）`,
    localEndpoint: {
      title: '使用你自己的模型伺服器',
      description: '任何相容 OpenAI 的伺服器都可以，例如 vLLM、llama.cpp 或 Ollama。',
      action: '設定'
    }
  }
}
