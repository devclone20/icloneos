import type { TranslationOverrides } from '../define-locale'

export const prompts: TranslationOverrides['prompts'] = {
  gatewayDisconnected: 'O gateway do agente não está ligado',
  sudoSendFailed: 'Não foi possível enviar a palavra-passe sudo',
  secretSendFailed: 'Não foi possível enviar o segredo',
  sudoTitle: 'Palavra-passe de administrador',
  sudoDesc:
    'O agente precisa da sua palavra-passe sudo para executar um comando privilegiado. É enviada apenas para o seu agente local.',
  sudoPlaceholder: 'palavra-passe sudo',
  secretTitle: 'Segredo necessário',
  secretDesc: 'O agente precisa de uma credencial para continuar.',
  secretPlaceholder: 'valor do segredo'
}
