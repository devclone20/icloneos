import type { TranslationOverrides } from '../define-locale'

export const remoteDisplayBanner: TranslationOverrides['remoteDisplayBanner'] = {
  message: reason => `軟體繪圖已啟用 — 偵測到遠端顯示（${reason}）。為防止畫面閃爍，已停用 GPU 加速。`
}
