// iclone os — V3-D a linha de cada painel na secção iT da barra lateral Mensagem (pt-PT).
import type { ItPanesCopy } from '@/i18n/en/itPanes'

export const ptPtItPanes: ItPanesCopy = {
  linesLabel: workspace => `Painéis de ${workspace}`,
  states: {
    running: 'em execução',
    idle: 'inativo',
    'needs-input': 'precisa de si',
    exited: 'terminado',
    dead: 'morto'
  },
  signals: { attention: 'chamou por si', bell: 'campainha', notification: 'notificação' },
  ago: age => `há ${age}`,
  noBranch: 'sem git',
  ports: list => `portas ${list}`,
  tmuxRemoteOff:
    'O tmux por ssh está desativado nesta versão: só é executado neste Mac até ser comprovado num anfitrião de laboratório.'
}
