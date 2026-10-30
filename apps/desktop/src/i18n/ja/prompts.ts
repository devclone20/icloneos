import type { TranslationOverrides } from '../define-locale'

export const prompts: TranslationOverrides['prompts'] = {
  gatewayDisconnected: 'エージェントのゲートウェイが接続されていません',
  sudoSendFailed: 'sudo パスワードを送信できませんでした',
  secretSendFailed: 'シークレットを送信できませんでした',
  sudoTitle: '管理者パスワード',
  sudoDesc:
    'エージェントは特権コマンドを実行するために sudo パスワードが必要です。ローカルエージェントにのみ送信されます。',
  sudoPlaceholder: 'sudo パスワード',
  secretTitle: 'シークレットが必要です',
  secretDesc: 'エージェントは続行するための認証情報が必要です。',
  secretPlaceholder: 'シークレット値'
}
