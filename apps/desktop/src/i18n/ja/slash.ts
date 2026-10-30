import type { TranslationOverrides } from '../define-locale'

export const slash: TranslationOverrides['slash'] = {
  alsoKnownAs: aliases => `${aliases} でも可`,
  fromLibrary: 'あなたのライブラリから',
  needs: names => `${names} が必要`,
  skillsTitle: 'スキル',
  groupPorted: 'icloneOS · あなたのライブラリから',
  groupIclone: 'icloneOS',
  groupLearned: '学習済み',
  groupUpstream: 'アップストリーム',
  groupHub: 'Hub',
  groupOther: 'スキル',
  skillsEmpty: 'スキルが見つかりません。',
  skillsFooter: count => `${count} 件のスキル · /名前 で開く`,
  skillsRestartNote: '新しく同期したスキルは、バックエンドの再起動後にエージェントへ届きます。',
  skillsUnavailable: count => `${count} 件のスキルは、このマシンにないものを必要とします（上記）。`,
  needsSummary: rows =>
    `あなたのライブラリの ${rows.length} 件のスキルが、このマシンにないものを必要とします：${rows.join('；')}。`,
  manifestProblem: message => `manifest.json が無効 — ${message}`,
  manifestSummary: rows => `${rows.length} 件のスキルの manifest.json が無効です：${rows.join('；')}。`,
  by: (author, license) => `作者 ${author}（${license}）`,
  catalogUnavailable: command => `${command} は送信されませんでした：コマンド一覧を読めません。もう一度お試しください。`
}
