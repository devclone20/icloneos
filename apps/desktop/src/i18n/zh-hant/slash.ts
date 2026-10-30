import type { TranslationOverrides } from '../define-locale'

export const slash: TranslationOverrides['slash'] = {
  alsoKnownAs: aliases => `也可用 ${aliases}`,
  fromLibrary: '來自你的技能庫',
  needs: names => `需要 ${names}`,
  skillsTitle: '技能',
  groupPorted: 'icloneOS · 來自你的技能庫',
  groupIclone: 'icloneOS',
  groupLearned: '已學習',
  groupUpstream: '上游',
  groupHub: 'Hub',
  groupOther: '技能',
  skillsEmpty: '找不到技能。',
  skillsFooter: count => `${count} 個技能 · 輸入 /名稱 開啟`,
  skillsRestartNote: '新同步的技能在後端重新啟動後才對代理生效。',
  skillsUnavailable: count => `${count} 個技能需要本機缺少的東西（見上）。`,
  needsSummary: rows => `你的技能庫中有 ${rows.length} 個技能需要本機缺少的東西：${rows.join('；')}。`,
  manifestProblem: message => `manifest.json 無效 — ${message}`,
  manifestSummary: rows => `${rows.length} 個技能的 manifest.json 無效：${rows.join('；')}。`,
  by: (author, license) => `作者 ${author}（${license}）`,
  catalogUnavailable: command => `${command} 未送出：無法讀取命令目錄。請重試。`
}
