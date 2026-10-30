import type { TranslationOverrides } from '../define-locale'

export const remoteDisplayBanner: TranslationOverrides['remoteDisplayBanner'] = {
  message: reason =>
    `ソフトウェアレンダリングが有効です — リモートディスプレイを検出しました（${reason}）。ちらつきを防ぐため GPU アクセラレーションは無効化されています。`
}
