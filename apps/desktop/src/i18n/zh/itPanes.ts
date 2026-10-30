// iclone os — V3-D 侧栏 iT 区域中每个窗格的一行（简体中文）。
import type { ItPanesCopy } from '@/i18n/en/itPanes'

export const zhItPanes: ItPanesCopy = {
  linesLabel: workspace => `${workspace} 的窗格`,
  states: {
    running: '运行中',
    idle: '空闲',
    'needs-input': '等待你',
    exited: '已退出',
    dead: '已终止'
  },
  signals: { attention: '请求关注', bell: '响铃', notification: '通知' },
  ago: age => `${age}前`,
  noBranch: '无 git',
  ports: list => `端口 ${list}`,
  tmuxRemoteOff: '此版本中通过 ssh 的 tmux 已关闭：在实验主机上验证之前，它只在这台 Mac 上运行。'
}
