// iclone os — V3-D サイドバーの iT セクションのペインごとの行（日本語）。
import type { ItPanesCopy } from '@/i18n/en/itPanes'

export const jaItPanes: ItPanesCopy = {
  linesLabel: workspace => `${workspace} のペイン`,
  states: {
    running: '実行中',
    idle: '待機中',
    'needs-input': '入力待ち',
    exited: '終了',
    dead: '停止'
  },
  signals: { attention: '呼び出し', bell: 'ベル', notification: '通知' },
  ago: age => `${age} 前`,
  noBranch: 'git なし',
  ports: list => `ポート ${list}`,
  tmuxRemoteOff: 'このリリースでは ssh 越しの tmux は無効で、検証用ホストで実証されるまでこの Mac でのみ動きます。'
}
