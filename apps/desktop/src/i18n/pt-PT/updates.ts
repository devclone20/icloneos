import type { TranslationOverrides } from '../define-locale'

export const updates: TranslationOverrides['updates'] = {
  stages: {
    idle: 'A preparar…',
    prepare: 'A preparar…',
    fetch: 'A transferir…',
    pull: 'Quase lá…',
    pydeps: 'A concluir…',
    update: 'A atualizar o iclone os…',
    rebuild: 'A reconstruir a aplicação para computador…',
    restart: 'A reiniciar o iclone os…',
    done: 'Atualização concluída',
    manual: 'Atualizar a partir do terminal',
    guiSkew: 'Atualizar a aplicação para computador',
    error: 'Atualização em pausa'
  },
  checking: 'A procurar atualizações…',
  checkFailedTitle: 'Não foi possível procurar atualizações',
  tryAgain: 'Tentar novamente',
  notAvailableTitle: 'Atualização indisponível',
  unsupportedMessage: 'Esta versão do iclone os não se pode atualizar a partir da própria aplicação.',
  connectionRetry: 'Verifique a sua ligação e tente novamente.',
  latestBody: 'Está a usar a versão mais recente.',
  latestBodyBackend: 'O backend está a executar a versão mais recente.',
  allSetTitle: 'Está tudo pronto',
  availableTitle: 'Nova atualização disponível',
  availableBody: 'Uma nova versão do iclone os está pronta para instalar.',
  availableTitleBackend: 'Atualização do backend disponível',
  availableBodyBackend: 'Uma versão mais recente do backend do agente ligado está pronta para instalar.',
  availableBodyNoChangelog:
    'Está pronta uma versão mais recente. As notas de versão não estão disponíveis para este tipo de instalação.',
  updateNow: 'Atualizar agora',
  maybeLater: 'Talvez mais tarde',
  moreChanges: count =>
    `+ ${count} ${count === 1 ? 'alteração adicional incluída' : 'alterações adicionais incluídas'}.`,
  manualTitle: 'Atualizar a partir do terminal',
  manualBody:
    'Instalou o agente a partir da linha de comandos, por isso as atualizações também são feitas lá. Cole isto no seu terminal:',
  manualPickedUp: 'O agente vai usar a nova versão da próxima vez que o iniciar.',
  guiSkewTitle: 'Atualizar a aplicação para computador',
  guiSkewBody:
    'O backend foi atualizado, mas este pacote da aplicação para computador não foi alterado. Atualize ou reinstale a aplicação para computador do iclone os (o seu AppImage / .deb / .rpm) para corresponder.',
  copy: 'Copiar',
  copied: 'Copiado',
  done: 'Concluído',
  applyingBody:
    'O atualizador assume o controlo na sua própria janela e reabre o iclone os automaticamente quando terminar. Não reabra o iclone os enquanto estiver a ser atualizado.',
  applyingBodyBackend:
    'O backend remoto está a aplicar a atualização e vai reiniciar. O iclone os volta a ligar-se automaticamente quando estiver disponível.',
  applyingClose: 'Esta janela vai fechar durante a atualização e depois o iclone os reabre sozinho.',
  errorTitle: 'A atualização não terminou',
  errorBody: 'Não se preocupe — não se perdeu nada. Pode tentar novamente agora.',
  blockerTitle: 'Fechar as pré-visualizações locais para atualizar o iclone os?',
  blockerBody:
    'O iclone os tem de parar estas pré-visualizações locais antes de atualizar. Isto não vai alterar nem eliminar os seus ficheiros.',
  foreignBlockerTitle: 'Feche outros processos para atualizar o iclone os',
  foreignBlockerBody:
    'O iclone os não consegue fechar estes processos automaticamente em segurança. Feche a aplicação, o terminal ou o serviço a que cada um pertence e tente atualizar novamente.',
  mixedBlockerBody:
    'O iclone os pode fechar as pré-visualizações locais indicadas abaixo. Os outros processos têm de ser fechados manualmente antes de a atualização poder continuar.',
  closePreviewsAndUpdate: 'Fechar pré-visualizações e atualizar',
  closePreviewsAndCheckAgain: 'Fechar pré-visualizações e verificar novamente',
  localPreview: 'Pré-visualização local',
  portLabel: port => `Porta ${port}`,
  pidLabel: pid => `Processo ${pid}`,
  technicalDetails: 'Detalhes técnicos',
  notNow: 'Agora não',
  clientAlsoBehindTitle: 'A aplicação para computador está desatualizada',
  clientAlsoBehindMessage:
    'O backend está atualizado, mas esta aplicação para computador ainda está numa versão mais antiga. Atualize-a para obter as correções mais recentes.',
  clientAlsoBehindAction: 'Atualizar a aplicação para computador',
  everythingDispatched: 'Atualização enviada',
  everythingSkipped: 'Ignorado',
  everythingRowFailed: 'A atualização falhou',
  everythingFanoutFailedTitle: 'Não foi possível atualizar as outras instâncias',
  applyStatus: {
    preparing: 'A atualizar o backend…',
    pulling: 'O backend está a ser atualizado…',
    restarting: 'O backend está a reiniciar para carregar a atualização…',
    notAvailable: 'Atualização indisponível para este backend.',
    failed: 'A atualização do backend falhou.',
    noReturn:
      'O backend não voltou a ficar online. A atualização pode não ter sido concluída — verifique o anfitrião do backend.'
  }
}
