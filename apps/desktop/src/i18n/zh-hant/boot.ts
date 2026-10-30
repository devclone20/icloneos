import type { TranslationOverrides } from '../define-locale'

export const boot: TranslationOverrides['boot'] = {
  ready: 'iclone os 已就緒',
  desktopBootFailedWithMessage: message => `桌面啟動失敗：${message}`,
  steps: {
    connectingGateway: '正在連線桌面閘道',
    preparingAgentDependencies: '正在準備智慧代理的相依套件…',
    loadingSettings: '正在載入設定',
    loadingSessions: '正在載入最近工作階段',
    retryingRemoteBackend: '正在重新連線遠端智慧代理後端…',
    startingDesktopConnection: '正在啟動桌面連線',
    startingHermesDesktop: '正在啟動 iclone os…'
  },
  errors: {
    backgroundExited: '智慧代理背景程序已結束。',
    backgroundExitedDuringStartup: '智慧代理背景程序在啟動期間結束。',
    backendStopped: '後端已停止',
    desktopBootFailed: '桌面啟動失敗',
    gatewayConnectionLost: '與閘道的連線已中斷',
    gatewayConnectionLostDetail:
      'Still retrying in the background. You can keep reading and drafting — open Gateway settings if this persists.',
    gatewaySignInRequired: '需要閘道登入',
    ipcBridgeUnavailable: '桌面 IPC 橋接器不可用。'
  },
  failure: {
    title: '智慧代理無法啟動',
    description: '背景閘道未啟動。請嘗試下面的復原步驟。這裡的操作不會刪除您的聊天或設定。',
    remoteTitle: '需要重新登入遠端閘道',
    remoteDescription: '您的遠端閘道工作階段已過期。請重新登入以重新連線。這裡的操作不會刪除您的聊天或設定。',
    retry: '重試',
    repairInstall: '修復安裝',
    useLocalGateway: '使用本機閘道',
    gatewaySettings: '閘道設定',
    back: '返回',
    openLogs: '開啟記錄',
    repairHint: '修復會重新執行安裝程式，在新機器上可能需要幾分鐘。',
    remoteSignInHint: signInLabel =>
      `先登出已儲存的遠端瀏覽器工作階段，然後開啟${signInLabel}。使用本機閘道可切換至內建後端。`,
    signOutAndSignIn: '登出並重新登入',
    remoteFailureHint: '在「閘道設定」中檢查閘道 URL 與登入，或切換至本機閘道。',
    cloudDownTitle: '你的雲端智慧代理已停機',
    cloudDownDescription:
      '此閘道連線的託管雲端智慧代理正在回傳伺服器錯誤。無法在此處重新啟動——請檢查其狀態、切換至本機閘道，或取得支援。',
    cloudDownHint: '使用下方按鈕開啟 Nous Portal（檢視執行個體狀態與操作）或加入 Discord 取得支援。',
    gateTitle: '權限關卡未生效',
    gateDescription:
      'icloneOS 沒有啟動代理：無法在此代理執行環境中安裝或載入權限關卡，因此任何指令都不會被檢查。這裡的操作不會刪除你的聊天或設定。',
    gateHint:
      '「重試」會再次檢查權限關卡。「修復安裝」會重新安裝代理執行環境，再安裝權限關卡。如果上方的方框顯示權限關卡已在設定中停用，請先從 Hermes 的 config.yaml 的 plugins.disabled 中移除 iclone-permissions 與 iclone-confinement，然後再重試。',
    gateHintUnmanaged:
      '此代理執行環境不是由 icloneOS 安裝的（例如你自己的 Hermes git 檢出），因此 icloneOS 只會檢查它，絕不會更改它。「修復安裝」會在應用程式的資料夾中設定 icloneOS 自己經過驗證的副本；你的資料夾保持不變。',
    cloudDownCheckPortal: '查看 Portal 狀態',
    cloudDownDiscord: '在 Discord 取得協助',
    hideRecentLogs: '隱藏最近記錄',
    showRecentLogs: '顯示最近記錄',
    signedInTitle: '已登入',
    signedInMessage: '正在重新連線至遠端閘道…',
    signInIncompleteTitle: '登入未完成',
    signInIncompleteMessage: '登入視窗在驗證完成前關閉。',
    signInFailed: '登入失敗',
    signInToRemoteGateway: '登入遠端閘道',
    signInWithProvider: provider => `使用 ${provider} 登入`,
    identityProvider: '您的身分提供方'
  }
}
