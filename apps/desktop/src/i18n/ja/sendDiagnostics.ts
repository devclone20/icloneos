import type { TranslationOverrides } from '../define-locale'

export const sendDiagnostics: TranslationOverrides['sendDiagnostics'] = {
  title: '診断レポートを保存',
  lead: 'この Mac の外には何も送られません。icloneOS は、あなたが選んだファイルにレポートを書き込みます。シークレット、キー、トークン、メールアドレス、ホームフォルダーは先に取り除かれます。内容：',
  parts: {
    context: '失敗した内容',
    logs: 'アプリの最近のログ',
    report: '最新の診断レポート'
  },
  lines: count => `${count} 行`,
  preview: 'レポートを表示',
  loading: 'レポートを準備しています…',
  save: 'ファイルに保存…',
  saving: '保存しています…',
  cancel: 'キャンセル',
  close: '閉じる',
  savedTitle: 'レポートを保存しました',
  savedDescription: name =>
    `${name} として保存しました。この Mac に残ります。必要な場合だけ issue に添付してください。`,
  failedTitle: 'レポートは保存されませんでした',
  reportIssue: '問題を報告',
  reportIssueHint:
    'GitHub でタイトルだけの新しい issue を開きます。レポートの内容は送られません。必要ならファイルをご自身で添付してください。',
  issueTitle: 'icloneOS からの問題報告'
}
