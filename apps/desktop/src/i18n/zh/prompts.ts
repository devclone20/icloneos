import type { Translations } from '../types'

export const prompts: Translations['prompts'] = {
  gatewayDisconnected: '智能体的网关未连接',
  sudoSendFailed: '无法发送 sudo 密码',
  secretSendFailed: '无法发送密钥',
  sudoTitle: '管理员密码',
  sudoDesc: '智能体需要你的 sudo 密码来运行特权命令。它只会发送给你的本地智能体。',
  sudoPlaceholder: 'sudo 密码',
  secretTitle: '需要密钥',
  secretDesc: '智能体需要一个凭据才能继续。',
  secretPlaceholder: '密钥值'
}
