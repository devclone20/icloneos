import type { Translations } from '../types'

export const remoteDisplayBanner: Translations['remoteDisplayBanner'] = {
  message: reason => `软件渲染已启用 — 检测到远程显示（${reason}）。为防止画面闪烁，已禁用 GPU 加速。`
}
