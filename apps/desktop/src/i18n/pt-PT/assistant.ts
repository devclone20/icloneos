import type { TranslationOverrides } from '../define-locale'

export const assistant: TranslationOverrides['assistant'] = {
  thread: {
    loadingSession: 'A carregar a sessão',
    showEarlier: 'Mostrar mensagens anteriores',
    loadingResponse: 'O agente está a carregar uma resposta',
    resumeWhenBackgroundDone: count =>
      count === 1
        ? 'Retoma quando a tarefa em segundo plano terminar'
        : `Retoma quando as ${count} tarefas em segundo plano terminarem`,
    thinking: 'A pensar',
    thought: 'Pensou',
    thoughtBriefly: 'Pensou brevemente',
    thoughtFor: duration => `Pensou durante ${duration}`,
    turnDuration: duration => `Este turno demorou ${duration}`,
    today: time => `Hoje, ${time}`,
    yesterday: time => `Ontem, ${time}`,
    copy: 'Copiar',
    refresh: 'Atualizar',
    moreActions: 'Mais ações',
    branchNewChat: 'Ramificar numa nova conversa',
    react: 'Reagir',
    dismissError: 'Dispensar erro',
    errorLayers: {
      auth: 'Erro de autenticação',
      billing: 'Sem créditos',
      disk: 'Disco cheio',
      endpoint: 'Erro do endpoint personalizado',
      gateway: 'Erro do gateway',
      generic: 'O turno falhou',
      provider: 'Erro do fornecedor',
      runtime: 'Erro do runtime local',
      streaming: 'Erro na ligação de streaming'
    },
    errorRetry: 'Tentar novamente',
    errorSwitchProvider: 'Mudar de fornecedor',
    errorOpenLogs: 'Abrir registos',
    errorOpenLogsFailed: 'Não foi possível abrir a pasta de registos',
    errorOpenDesktopLogs: 'Abrir registos do Desktop',
    errorCopyDiagnostics: 'Copiar detalhes do erro',
    errorSendDiagnostics: 'Guardar diagnóstico',
    filesChanged: count => (count === 1 ? '1 ficheiro alterado' : `${count} ficheiros alterados`),
    readAloudFailed: 'A leitura em voz alta falhou',
    preparingAudio: 'A preparar o áudio...',
    stopReading: 'Parar leitura',
    readAloud: 'Ler em voz alta',
    editMessage: 'Editar mensagem',
    expandMessage: 'Expandir mensagem',
    scrollToBottom: 'Deslocar até ao fim',
    stop: 'Parar',
    restorePrevious: 'Restaurar ponto de controlo anterior',
    restoreCheckpoint: 'Restaurar ponto de controlo',
    restoreFromHere: 'Restaurar ponto de controlo — executar de novo a partir deste prompt',
    restoreTitle: 'Restaurar para este ponto de controlo?',
    restoreBody:
      'Tudo o que vem depois deste prompt é removido da conversa, e o prompt volta a ser executado a partir daqui.',
    restoreConfirm: 'Restaurar e executar',
    restoreNext: 'Restaurar ponto de controlo seguinte',
    goForward: 'Avançar',
    sendEdited: 'Enviar mensagem editada',
    attachingFile: 'A anexar…'
  },
  approval: {
    command: 'Comando',
    jumpToApproval: 'Aprovação necessária'
  },
  clarify: {
    notReady: 'O pedido de esclarecimento ainda não está pronto',
    gatewayDisconnected: 'O gateway do agente não está ligado',
    sendFailed: 'Não foi possível enviar a resposta de esclarecimento',
    loadingQuestion: 'A carregar a pergunta…',
    other: 'Outra (escreva a sua resposta)',
    placeholder: 'Escreva a sua resposta…',
    skip: 'Ignorar',
    skipped: 'Ignorada',
    continueLabel: 'Continuar',
    confirmAndContinueLabel: 'Confirmar e continuar',
    answeredBadge: 'Respondida',
    questionProgress: (answered, total) => `${answered} de ${total} respondidas`,
    lateAnswer: (question, choice) => `Re: "${question}" — a minha resposta: ${choice}`,
    lateAnswerTip: 'Redigir esta resposta como mensagem de seguimento',
    lateAnswerHint: 'Este pedido já não está à espera. Escolha uma opção para a redigir como mensagem de seguimento.'
  },
  mcpSetup: {
    installTitle: server => `Adicionar o servidor MCP ${server}?`,
    enableTitle: server => `Ativar o servidor MCP ${server}?`,
    authorizeTitle: server => `Autorizar o servidor MCP ${server}?`,
    installAction: 'Instalar',
    enableAction: 'Ativar',
    authorizeAction: 'Autorizar',
    decline: 'Agora não',
    declined: 'Recusado',
    installed: server => `${server} instalado`,
    enabled: server => `${server} ativado`,
    authorized: server => `${server} autorizado`,
    failed: server => `A configuração de ${server} falhou`,
    unanswered: 'Sem resposta',
    toolCount: count => (count === 1 ? '1 ferramenta' : `${count} ferramentas`),
    notInCatalog: server => `“${server}” não está no catálogo MCP`,
    catalogSource: 'Do catálogo aprovado',
    envRequired: 'Preencha primeiro as credenciais obrigatórias',
    sendFailed: 'Não foi possível enviar a resposta de configuração MCP',
    reloadFailed: 'Servidor guardado, mas o recarregamento das ferramentas MCP falhou — carregam na próxima sessão',
    gatewayDisconnected: 'O gateway do agente não está ligado'
  },
  tool: {
    copyCode: 'Copiar código',
    renderingImage: 'A renderizar a imagem',
    copyOutput: 'Copiar saída',
    copyCommand: 'Copiar comando',
    copyContent: 'Copiar conteúdo',
    copyUrl: 'Copiar URL',
    copyResults: 'Copiar resultados',
    copyQuery: 'Copiar consulta',
    copyFile: 'Copiar ficheiro',
    copyPath: 'Copiar caminho',
    outputAlt: 'Saída da ferramenta',
    rawResponse: 'Resposta em bruto',
    copyActivity: 'Copiar atividade',
    recoveredOne: 'Recuperado após 1 passo falhado',
    recoveredMany: count => `Recuperado após ${count} passos falhados`,
    failedOne: '1 passo falhou',
    failedMany: count => `${count} passos falharam`,
    statusRunning: 'Em execução',
    statusError: 'Erro',
    statusRecovered: 'Recuperado',
    statusDone: 'Concluído',
    memoryWriteNoted: 'Escrita na memória registada',
    actions: {
      read: 'Leu',
      reading: 'A ler',
      opened: 'Abriu',
      opening: 'A abrir',
      failedToOpen: 'Falha ao abrir',
      searched: 'Pesquisou',
      searching: 'A pesquisar',
      ran: 'Executou',
      running: 'A executar',
      ranCode: 'Executou código',
      runningCode: 'A programar'
    },
    prefixes: {
      browser: 'Navegador',
      web: 'Web'
    },
    titleTemplates: {
      actionCommand: (action, command) => `${action} ${command}`,
      actionQuoted: (action, value) => `${action} “${value}”`,
      actionTarget: (action, target) => `${action} ${target}`,
      prefixedDone: (prefix, action) => `${prefix}: ${action}`,
      runningPrefixedTool: (prefix, action) => `A executar ${prefix.toLowerCase()}: ${action.toLowerCase()}`,
      runningTool: action => `A executar ${action.toLowerCase()}`
    },
    titles: {
      browser_click: {
        done: 'Clicou num elemento da página',
        pending: 'A clicar num elemento da página',
        pendingAction: 'A clicar'
      },
      browser_fill: {
        done: 'Preencheu um campo do formulário',
        pending: 'A preencher um campo do formulário',
        pendingAction: 'A preencher'
      },
      browser_navigate: { done: 'Abriu a página', pending: 'A abrir a página', pendingAction: 'A abrir' },
      browser_snapshot: {
        done: 'Capturou um instantâneo da página',
        pending: 'A capturar um instantâneo da página',
        pendingAction: 'A capturar'
      },
      browser_take_screenshot: {
        done: 'Capturou uma captura de ecrã',
        pending: 'A fazer uma captura de ecrã',
        pendingAction: 'A capturar'
      },
      browser_type: { done: 'Escreveu na página', pending: 'A escrever na página', pendingAction: 'A escrever' },
      clarify: { done: 'Fez uma pergunta', pending: 'A fazer uma pergunta', pendingAction: 'A perguntar' },
      cronjob: {
        done: 'Tarefa agendada',
        pending: 'A agendar a tarefa',
        pendingAction: 'A agendar'
      },
      edit_file: { done: 'Editou o ficheiro', pending: 'A editar o ficheiro', pendingAction: 'A editar' },
      execute_code: { done: 'Executou código', pending: 'A programar', pendingAction: 'A programar' },
      image_generate: { done: 'Gerou uma imagem', pending: 'A gerar uma imagem', pendingAction: 'A gerar' },
      list_files: { done: 'Listou ficheiros', pending: 'A listar ficheiros', pendingAction: 'A listar' },
      memory: { done: 'Guardou na memória', pending: 'A guardar na memória', pendingAction: 'A guardar' },
      patch: { done: 'Corrigiu o ficheiro', pending: 'A corrigir o ficheiro', pendingAction: 'A corrigir' },
      read_file: { done: 'Leu o ficheiro', pending: 'A ler o ficheiro', pendingAction: 'A ler' },
      search_files: {
        done: 'Pesquisou ficheiros',
        pending: 'A pesquisar ficheiros',
        pendingAction: 'A pesquisar'
      },
      session_search_recall: {
        done: 'Pesquisou o histórico de sessões',
        pending: 'A pesquisar o histórico de sessões',
        pendingAction: 'A pesquisar'
      },
      terminal: { done: 'Executou um comando', pending: 'A executar um comando', pendingAction: 'A executar' },
      todo: { done: 'Atualizou as tarefas', pending: 'A atualizar as tarefas', pendingAction: 'A atualizar' },
      vision_analyze: { done: 'Analisou a imagem', pending: 'A analisar a imagem', pendingAction: 'A analisar' },
      web_extract: { done: 'Leu a página web', pending: 'A ler a página web', pendingAction: 'A ler' },
      web_search: { done: 'Pesquisou na web', pending: 'A pesquisar na web', pendingAction: 'A pesquisar' },
      write_file: { done: 'Editou o ficheiro', pending: 'A editar o ficheiro', pendingAction: 'A editar' }
    }
  }
}
