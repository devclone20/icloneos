// iclone os — V3-D 側欄 iT 區域中每個窗格的一行（繁體中文）。
import type { ItPanesCopy } from '@/i18n/en/itPanes'

export const zhHantItPanes: ItPanesCopy = {
  linesLabel: workspace => `${workspace} 的窗格`,
  states: {
    running: '執行中',
    idle: '閒置',
    'needs-input': '等待你',
    exited: '已結束',
    dead: '已終止'
  },
  signals: { attention: '請求關注', bell: '響鈴', notification: '通知' },
  ago: age => `${age}前`,
  noBranch: '無 git',
  ports: list => `連接埠 ${list}`,
  tmuxRemoteOff: '此版本中透過 ssh 的 tmux 已關閉：在實驗主機上驗證之前，它只在這台 Mac 上執行。'
}
