import type { TranslationOverrides } from '../define-locale'

export const prompts: TranslationOverrides['prompts'] = {
  gatewayDisconnected: '智慧代理的閘道未連線',
  sudoSendFailed: '無法傳送 sudo 密碼',
  secretSendFailed: '無法傳送密鑰',
  sudoTitle: '管理員密碼',
  sudoDesc: '智慧代理需要您的 sudo 密碼來執行特權指令。它只會傳送給您的本機智慧代理。',
  sudoPlaceholder: 'sudo 密碼',
  secretTitle: '需要密鑰',
  secretDesc: '智慧代理需要一個憑證才能繼續。',
  secretPlaceholder: '密鑰值'
}
