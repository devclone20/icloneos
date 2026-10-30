import type { Translations } from '../types'

export const slash: Translations['slash'] = {
  alsoKnownAs: aliases => `也可用 ${aliases}`,
  fromLibrary: '来自你的技能库',
  needs: names => `需要 ${names}`,
  skillsTitle: '技能',
  groupPorted: 'icloneOS · 来自你的技能库',
  groupIclone: 'icloneOS',
  groupLearned: '已学习',
  groupUpstream: '上游',
  groupHub: 'Hub',
  groupOther: '技能',
  skillsEmpty: '未找到技能。',
  skillsFooter: count => `${count} 个技能 · 输入 /名称 打开`,
  skillsRestartNote: '新同步的技能在后端重启后才对代理生效。',
  skillsUnavailable: count => `${count} 个技能需要本机缺少的东西（见上）。`,
  needsSummary: rows => `你的技能库中有 ${rows.length} 个技能需要本机缺少的东西：${rows.join('；')}。`,
  manifestProblem: message => `manifest.json 无效 — ${message}`,
  manifestSummary: rows => `${rows.length} 个技能的 manifest.json 无效：${rows.join('；')}。`,
  by: (author, license) => `作者 ${author}（${license}）`,
  catalogUnavailable: command => `${command} 未发送：无法读取命令目录。请重试。`
}
