import type { TranslationOverrides } from '../../define-locale'
import type { SettingsAgentTranslations } from '../../types/settings/agent'
import { ptPtPermissions } from '../permissions'

export const settingsAgent: Pick<NonNullable<TranslationOverrides['settings']>, keyof SettingsAgentTranslations> = {
  mcp: {
    loading: 'A carregar servidores MCP...',
    failedLoad: 'Falha ao carregar a configuração MCP',
    nameRequiredTitle: 'Nome obrigatório',
    nameRequiredMessage: 'Atribua uma chave de configuração a este servidor MCP.',
    objectRequired: 'A configuração do servidor tem de ser um objeto JSON',
    invalidJson: 'JSON MCP inválido',
    saveFailed: 'Falha ao guardar',
    removeFailed: 'Falha ao remover',
    gatewayUnavailableTitle: 'Gateway indisponível',
    gatewayUnavailableMessage: 'Volte a ligar o gateway antes de recarregar o MCP.',
    reloadedTitle: 'Ferramentas MCP recarregadas',
    reloadedMessage: 'Os novos esquemas de ferramentas aplicam-se aos próximos turnos.',
    reloadFailed: 'Falha ao recarregar o MCP',
    savedTitle: 'Servidor MCP guardado',
    savedMessage: name => `${name} aplica-se depois de recarregar o MCP.`,
    newServer: 'Novo servidor',
    reload: 'Recarregar MCP',
    reloading: 'A recarregar...',
    emptyTitle: 'Sem servidores MCP',
    emptyDesc: 'Adicione um servidor stdio ou HTTP para expor ferramentas MCP.',
    disabled: 'desativado',
    editServer: 'Editar servidor',
    name: 'Nome',
    serverJson: 'JSON do servidor',
    remove: 'Remover',
    saveServer: 'Guardar servidor',
    test: 'Testar ligação',
    testing: 'A testar...',
    testOk: count => `Ligado — ${count} ${count === 1 ? 'ferramenta disponível' : 'ferramentas disponíveis'}`,
    testFailed: 'Falha na ligação',
    enableServer: name => `Ativar ${name}`,
    disableServer: name => `Desativar ${name}`,
    serverEnabled: name => `${name} ativado — aplica-se a novas sessões.`,
    serverDisabled: name => `${name} desativado — aplica-se a novas sessões.`,
    toggleFailed: (name, enabled) => `Não foi possível ${enabled ? 'ativar' : 'desativar'} ${name}`,
    tabServers: 'Servidores',
    tabCatalog: 'Catálogo',
    catalogLoading: 'A carregar o catálogo MCP...',
    catalogLoadFailed: 'Falha ao carregar o catálogo MCP',
    catalogEmpty: 'Não há entradas disponíveis no catálogo.',
    catalogInstalled: 'Instalado',
    catalogEnabled: 'Ativado',
    catalogNeedsInstall: 'Requer compilação',
    catalogInstall: 'Instalar',
    catalogInstalling: 'A instalar...',
    catalogInstallStarted: name => `A instalar ${name}... aplica-se a novas sessões quando terminar.`,
    catalogInstallFailed: name => `Falha ao instalar ${name}`,
    catalogEnvPrompt: name => `${name} requer credenciais`,
    catalogEnvRequired: 'Preencha os valores obrigatórios antes de instalar.',
    capabilitySummary: (tools, prompts, resources) =>
      `${[`${tools} ferramentas`, ...(prompts ? [`${prompts} prompts`] : []), ...(resources ? [`${resources} recursos`] : [])].join(', ')} ativados`,
    costTokens: tokens => `~${tokens} tok/chamada`,
    usage30d: uses => `${uses} usos/30d`,
    unusedPill: 'sem uso',
    statusConnecting: 'A ligar…',
    statusNeedsAuth: 'Requer autenticação',
    statusError: 'Erro',
    statusOff: 'Desligado',
    allServers: 'Todos os servidores',
    authenticatedTitle: 'Autenticado',
    authenticatedMessage: (server, count) => `${server}: ${count} ferramentas`,
    waitingForBrowser: 'A aguardar o navegador…',
    authenticate: 'Autenticar',
    unsavedConnect: 'Não guardado — guarde o mcp.json para ligar.',
    enableTool: tool => `Ativar ${tool}`,
    disableTool: tool => `Desativar ${tool}`,
    noOutput: 'Ainda sem resultados.',
    deepLinkTitle: 'Adicionar servidor MCP?',
    deepLinkDescription:
      'Uma ligação pediu para adicionar este servidor MCP ao agente. Reveja a configuração exata abaixo — vem da ligação, não do iclone os.',
    deepLinkStdioWarning:
      'Este servidor executa um processo local no seu computador com o comando mostrado abaixo. Continue apenas se confiar na origem.',
    deepLinkConfirm: 'Adicionar servidor',
    deepLinkNameInvalid: 'Os nomes usam de 1 a 64 letras, algarismos, pontos, hífenes ou sublinhados.',
    deepLinkNameConflict: name => `Já existe um servidor chamado ${name} — escolha outro nome ou cancele.`,
    deepLinkErrorTitle: 'Ligação de instalação MCP rejeitada',
    deepLinkErrorName: 'O nome do servidor na ligação está em falta ou é inválido.',
    deepLinkErrorConfig: 'A configuração da ligação não é JSON válido codificado em base64.',
    deepLinkErrorShape: 'A configuração tem de ser um objeto JSON com um campo `url` ou `command` em texto.',
    deepLinkErrorUrl: 'Só são permitidos URLs de servidor http:// e https://.',
    deepLinkErrorTooLarge: 'A configuração excede o limite de 32KB.',
    importButton: 'Importar',
    importPlaceholder:
      'Cole um excerto de mcp.json, um comando npx/docker, uma linha claude mcp add, um URL ou uma ligação do Cursor…',
    importNoMatch: 'Não foi reconhecida nenhuma configuração de servidor no texto colado.',
    importConfirm: 'Adicionar ao mcp.json',
    importConfirmMany: count => `Adicionar ${count} servidores ao mcp.json`
  },
  permissions: ptPtPermissions,
  engine: {
    otherTitle: (provider: string) => `Executar o seu agente em ${provider}`,
    title: 'Escolha o que responde ao seu agente',
    nousTitle: 'Executar o seu agente no motor padrão',
    nousDescription: 'O motor predefinido com que todos os agentes começam, respondido por modelos do Nous Portal.',
    otherDescription: (model: string) => `Usa o fornecedor escolhido em Modelo${model ? `, com ${model}` : ''}.`,
    claudeTitle: 'Executar o seu agente no seu plano Claude Code',
    claudeDescription: 'Usa o Claude Code com sessão já iniciada neste computador. Sem chave de API, sem créditos.',
    active: 'Ativo',
    use: 'Usar',
    model: 'Que modelo Claude o seu agente usa',
    statusTitle: 'Verificar se o Claude Code está pronto',
    checking: 'A verificar o Claude Code…',
    notInstalled: 'O Claude Code não está instalado neste computador.',
    notLoggedIn: 'O Claude Code está instalado, mas sem sessão iniciada.',
    loggedIn: (plan: string) =>
      `O Claude Code tem sessão iniciada e está pronto${plan ? ` no seu plano ${plan}` : ''}.`,
    version: (version: string) => `Versão ${version}`,
    window: (five: string, resets: string, seven: string) =>
      [five ? `janela de 5 horas ${five}` : '', resets ? `reinicia ${resets}` : '', seven ? `7 dias ${seven}` : '']
        .filter(Boolean)
        .join(' · '),
    windowUnknown: 'A janela de utilização aparece após a primeira resposta.',
    start: 'Iniciar uma conversa',
    startDescription: 'Abre uma nova conversa respondida pelo Claude Code no seu plano.',
    installHelp: 'Instale o Claude Code uma vez a partir de um terminal',
    loginHelp: 'Inicie sessão no Claude Code uma vez a partir de um terminal',
    copy: 'Copiar',
    copied: 'Copiado',
    recheck: 'Verificar novamente',
    rechecking: 'A verificar…',
    checkedAt: (time: string) => `verificado ${time}`,
    statusUnavailable: 'Não foi possível ler o estado do Claude Code.',
    notReadyHint: 'Instale primeiro o Claude Code e inicie sessão; a verificação abaixo mostra o que falta.',
    privacyTitle: 'O Claude Code guarda o histórico de conversas neste computador',
    privacy: 'Se o Claude Code estiver indisponível, a resposta vem do motor que usava antes.',
    switchFailed: 'Não foi possível mudar de motor.',
    switchFailedReason: (reason: string) => `Não foi possível mudar de motor: ${reason}`,
    noModel: 'não há nenhum modelo registado para esse motor',
    confirmTitle: 'Confirmar a mudança',
    confirmFallback: 'Confirme este modelo antes de o motor mudar.',
    confirm: 'Confirmar',
    cancel: 'Cancelar',
    fallback: 'Desta vez, o seu agente respondeu com outro fornecedor.',
    fix: 'Porquê?',
    dismiss: 'Dispensar'
  },
  sessionsBots: {
    newChatHintUnbound: 'Clique com o botão direito na linha para abrir a conversa ao lado da atual.',
    title: 'As suas conversas e os seus bots, numa só página',
    hint: 'As páginas completas, aqui nas Definições. O botão Mensagem no Dock continua a ser o acesso rápido.',
    sessionsHeading: 'As suas conversas, como a barra lateral as mostra',
    botsHeading: 'Os seus bots, cada um com uma conversa própria',
    botsUnavailable: 'Os seus bots não estão carregados nesta janela',
    botsUnavailableHint: 'Os bots não estão em execução nesta janela.',
    sessions: [
      [
        'Iniciar uma nova conversa no espaço de trabalho atual',
        'Prima {shortcut} ou clique com o botão direito na linha para abrir a conversa ao lado da atual.'
      ],
      [
        'Encontrar qualquer conversa pelas suas palavras',
        'Encontra correspondências enquanto escreve, em todas as conversas que guardou.'
      ],
      [
        'Manter no topo as conversas que mais usa',
        'Clique com Shift numa conversa para a afixar; arraste as conversas afixadas para as reordenar em todos os dispositivos.'
      ],
      [
        'Ver todas as conversas, soltas ou agrupadas por projeto',
        'Pode retomar cada conversa, mudar-lhe o nome, afixá-la, ramificá-la, arquivá-la, eliminá-la ou abri-la ao lado de outra. O cabeçalho acrescenta filtros, agrupamento, ordem e o arquivo.'
      ],
      [
        'Começar a trabalhar num projeto na sua própria cópia',
        'Cada projeto tem um botão Começar trabalho, um menu para lhe mudar o nome, o estilo ou o eliminar, e indicadores de revisão em tempo real.'
      ],
      [
        'Ler conversas das suas aplicações de mensagens',
        'O Telegram, o Slack e as restantes têm cada uma a sua secção.'
      ],
      ['Ver as tarefas agendadas', 'Execute uma agora, altere-a ou abra as execuções anteriores com um clique.'],
      ['Escolher que perfil a lista mostra', 'O seletor na parte inferior mostra um perfil ou todos.'],
      [
        'Abrir as outras páginas sobre as Definições',
        'Capacidades, Mensagens, Artefactos e Tarefas agendadas abrem aqui como janelas; ✕ ou Esc traz de volta. Clique com o botão direito para abrir uma ao lado das Definições.'
      ]
    ],
    bots: [
      [
        'Cada bot mantém uma conversa própria',
        'Um bot é um perfil de agente. Clique nele para abrir a sua conversa; os bots falam entre si com menções @.'
      ],
      [
        'Criar um bot ou uma conversa de grupo de bots',
        'Dê a um novo agente um nome, imagem, modelo, competências e ferramentas, ou junte dois ou mais bots numa conversa.'
      ],
      [
        'Alterar a imagem, as palavras, o modelo e as competências de um bot',
        'Clique com o botão direito num bot para editar o seu perfil.'
      ],
      [
        'Copiar, ocultar ou eliminar um bot',
        'Eliminar remove o bot e o seu perfil; o bot predefinido não pode ser eliminado.'
      ],
      [
        'Ver que bots estão a trabalhar neste momento',
        'A faixa Ativos agora mostra-os; o sino ativa ou desativa os alertas de mensagens.'
      ],
      ['Dar a um bot tarefas agendadas', 'Faça a gestão a partir do painel lateral do bot com que está a conversar.']
    ]
  },
  model: {
    restartTitle: 'Reinicie o seu agente para concluir a atualização',
    otherProviders: 'outros fornecedores',
    staleAux: (count: number, names: string, provider: string) =>
      `${count === 1 ? 'Uma pequena tarefa' : `${count} pequenas tarefas`} (${names}) ainda ${count === 1 ? 'é executada' : 'são executadas'} em ${provider}, não no seu modelo principal.`,
    providerFallback: 'fornecedor',
    signsIn: (name: string) =>
      `${name} inicia sessão através do seu navegador; a aplicação trata do início de sessão por si.`,
    needsKey: (name: string) => `${name} precisa de uma chave. Adicione-a para escolher um modelo.`,
    pasteKey: (name: string) => `Cole a sua chave de ${name}`,
    setUp: (name: string) => `Configurar ${name}`,
    activating: 'A ativar…',
    activate: 'Ativar',
    fastHint: 'Usa a via mais rápida do fornecedor, que pode custar mais.',
    fastTitle: 'Responder mais depressa quando o fornecedor o permite',
    reasoningHint: 'Mais raciocínio ajuda nas perguntas difíceis, mas demora mais.',
    reasoningTitle: 'Quanto o seu agente pensa antes de responder',
    mainModelHint:
      'As novas conversas começam com ele. Para mudar a conversa em que está, use o menu de modelos onde escreve.',
    mainModelTitle: 'Que modelo o seu agente usa',
    mainProviderHint:
      'A empresa ou o servidor que executa o modelo. Inicie sessão ou adicione uma chave uma vez e fica pronto.',
    mainProviderTitle: 'Que fornecedor responde ao seu agente',
    auxiliarySentence:
      'Ponha modelos mais baratos nas tarefas pequenas, para guardar o principal para o trabalho a sério',
    moaTitle: 'Mistura de agentes',
    moaSentence: 'Pergunte a vários modelos ao mesmo tempo e junte as respostas numa só',
    moaDesc:
      'Cada predefinição aparece como um modelo no fornecedor Mistura de agentes. O agregador escreve a resposta final.',
    moaEnabled: 'Usar esta predefinição',
    moaPresetTitle: 'Escolha a predefinição que quer editar',
    moaPresetPlaceholder: 'Predefinição',
    moaSetDefault: 'Tornar padrão',
    moaDelete: 'Eliminar',
    moaNewTitle: 'Guardar esta configuração como nova predefinição',
    moaNewPlaceholder: 'Nome da predefinição',
    moaAdd: 'Adicionar predefinição',
    moaRemove: 'Remover',
    moaAddReference: 'Adicionar modelo de referência',
    moaAddReferenceTitle: 'Pedir a mais um modelo uma resposta de referência',
    moaAggregatorTitle: 'Que modelo escreve a resposta final',
    moaAggregatorHint: 'Lê todas as respostas de referência e age por si.',
    moaReference: (n: number) => `Que modelo dá a resposta de referência ${n}`,
    moaReferenceToggle: (n: number) => `Usar o modelo de referência ${n}`,
    provider: 'Fornecedor',
    model: 'Modelo',
    applying: 'A aplicar...',
    reasoningOff: 'Desligado',
    defaultsFailed: 'Falha ao guardar as predefinições do modelo',
    loadFailed: 'Não foi possível carregar a configuração do modelo.',
    restartRequired:
      'O agente foi atualizado enquanto estava em execução. Reinicie-o para carregar a nova versão — uma resposta em curso será interrompida.',
    restartBackend: 'Reiniciar',
    restartingBackend: 'A reiniciar…',
    restartFailed: 'O agente não reiniciou. Tente novamente, ou feche e volte a abrir a aplicação.',
    auxiliaryTitle: 'Modelos para as tarefas pequenas',
    resetAllToMain: 'Repor tudo no principal',
    auxiliaryDesc:
      'As tarefas auxiliares usam o modelo principal por predefinição. Atribua um modelo dedicado a qualquer tarefa para o substituir.',
    setToMain: 'Usar o principal',
    change: 'Alterar',
    autoUseMain: 'Igual ao modelo principal',
    providerDefault: '(predefinição do fornecedor)',
    fallbackAdd: 'Adicionar alternativa',
    fallbackEmpty: 'Sem modelos alternativos — é usado o modelo predefinido, a não ser que falhe.',
    tasks: {
      vision: {
        name: 'Imagens',
        label: 'Que modelo lê imagens',
        hint: 'Usado quando uma conversa inclui uma imagem ou uma captura de ecrã.'
      },
      compression: {
        name: 'Encurtamento',
        label: 'Que modelo encurta conversas longas',
        hint: 'As conversas longas são resumidas para continuarem a caber.'
      },
      skills_hub: {
        name: 'Pesquisa de competências',
        label: 'Que modelo encontra competências por si',
        hint: 'Procura uma competência adequada ao que pediu.'
      },
      approval: {
        name: 'Aprovação automática',
        label: 'Que modelo aprova ações seguras por si',
        hint: 'Usado quando a aprovação automática está definida como Inteligente.'
      },
      mcp: {
        name: 'Escolha de ferramenta',
        label: 'Que modelo escolhe entre as ferramentas ligadas',
        hint: 'Escolhe a ferramenta certa entre os serviços que ligou.'
      },
      title_generation: {
        name: 'Títulos',
        label: 'Que modelo dá nome às suas conversas',
        hint: 'Escreve o título curto mostrado na lista de conversas.'
      },
      review: {
        name: 'Revisão',
        label: 'Que modelo revê o trabalho do agente',
        hint: 'É executado quando pede uma revisão.'
      },
      curator: {
        name: 'Verificação de competências',
        label: 'Que modelo verifica como as competências são usadas',
        hint: 'Identifica as competências que ajudam e as que não ajudam.'
      }
    }
  },
  sessions: {
    archivedTitle: 'Conversas que arquivou',
    archivedIntro:
      'As conversas arquivadas saem da barra lateral, mas mantêm todas as mensagens. Ative o arquivo automático acima e as conversas inativas passam para aqui sozinhas.',
    emptyArchivedTitle: 'Nada arquivado',
    unarchive: 'Desarquivar',
    deletePermanently: 'Eliminar definitivamente',
    messages: count => `${count} ${count === 1 ? 'mensagem' : 'mensagens'}`,
    restored: 'Restaurada',
    deleteConfirm: title => `Eliminar definitivamente "${title}"? Esta ação não pode ser anulada.`,
    autoArchiveTitle: 'Arquivar conversas que não abre há algum tempo',
    autoArchiveDesc:
      'Arquiva automaticamente as conversas em que não toca há algum tempo. As conversas afixadas nunca são arquivadas e nada é eliminado — as conversas arquivadas apenas passam para aqui.',
    autoArchiveDaysLabel: 'Quantos dias sem atividade até uma conversa ser arquivada',
    autoArchiveDaysUnit: 'dias',
    autoArchiveFailed: 'Não foi possível atualizar o arquivo automático',
    defaultDirTitle: 'A pasta onde as novas conversas começam',
    defaultDirDesc: 'Ainda não escolhida, por isso as novas conversas começam na sua pasta pessoal.',
    defaultDirUpdated: 'Pasta predefinida atualizada. As novas conversas começam aí.',
    change: 'Alterar',
    choose: 'Escolher',
    clear: 'Limpar',
    failedLoad: 'Não foi possível carregar as sessões arquivadas',
    unarchiveFailed: 'Falha ao desarquivar',
    deleteFailed: 'Falha ao eliminar',
    updateDirFailed: 'Não foi possível atualizar a pasta predefinida',
    clearDirFailed: 'Não foi possível limpar a pasta predefinida'
  },
  toolsets: {
    loadingConfig: 'A carregar a configuração',
    savedTitle: 'Credencial guardada',
    savedMessage: key => `${key} atualizada.`,
    removedTitle: 'Credencial removida',
    removedMessage: key => `${key} removida.`,
    failedSave: key => `Falha ao guardar ${key}`,
    failedRemove: key => `Falha ao remover ${key}`,
    failedReveal: key => `Falha ao mostrar ${key}`,
    removeConfirm: key => `Remover ${key} do .env?`,
    set: 'Definida',
    notSet: 'Não definida',
    selectedTitle: 'Fornecedor selecionado',
    selectedMessage: provider => `${provider} está agora ativo.`,
    failedSelect: provider => `Falha ao selecionar ${provider}`,
    failedLoad: 'Falha ao carregar a configuração das ferramentas',
    noProviders: 'Não há fornecedores disponíveis para este conjunto de ferramentas neste momento.',
    ready: 'Pronto',
    needsSignIn: 'Requer início de sessão',
    needsSetup: 'Configuração necessária',
    activeBackend: 'Ativo',
    activeBackendHint: 'Este é o seu backend ativo',
    useBackend: 'Usar este backend',
    nousIncluded: 'Incluído numa subscrição do Nous Portal — inicie sessão no Nous Portal para ativar.',
    nousAuthNeededTitle: 'Iniciar sessão no Nous Portal',
    nousAuthNeededMessage: provider =>
      `${provider} está guardado, mas só fica ativo quando iniciar sessão no Nous Portal.`,
    nousAuthSignIn: 'Iniciar sessão',
    nousAuthDoneTitle: 'Nous Portal ligado',
    nousAuthDoneMessage: 'Os backends da sua subscrição estão agora ativos.',
    nousAuthFailed: 'O início de sessão no Nous Portal não foi concluído',
    noApiKeyRequired: 'Não é necessária chave de API.',
    postSetupHint: step =>
      `Este backend precisa de uma instalação única (${step}). É executada neste computador — pode demorar alguns minutos.`,
    postSetupInstalledHint: 'Instalado. Volte a executar a configuração só se algo não funcionar.',
    postSetupRun: 'Executar configuração',
    postSetupRerun: 'Repetir configuração',
    postSetupInstalled: 'Instalado',
    postSetupRunning: 'A instalar…',
    postSetupStarting: 'A iniciar…',
    postSetupCompleteTitle: 'Configuração concluída',
    postSetupCompleteMessage: step => `${step} instalado.`,
    postSetupErrorTitle: 'A configuração terminou com erros',
    postSetupErrorMessage: step => `Consulte o registo de ${step}.`,
    postSetupFailed: step => `Falha ao executar a configuração de ${step}`,
    webSearchActive: backend => `Pesquisa: ${backend}`,
    webExtractActive: backend => `Extração: ${backend}`,
    webCapabilityUnset: 'não definido',
    webUseForSearch: 'Usar para pesquisa',
    webUseForExtract: 'Usar para extração',
    webUsedForSearch: 'Backend de pesquisa',
    webUsedForExtract: 'Backend de extração',
    webCapabilitySelectedMessage: (provider, capability) =>
      `Na web, ${provider} trata agora da ${capability === 'search' ? 'pesquisa' : capability === 'extract' ? 'extração' : capability}.`,
    failedSelectCapability: provider => `Falha ao definir ${provider}`,
    loadingModels: 'A carregar o catálogo de modelos...',
    modelSectionTitle: 'Modelo',
    modelCount: count => `${count} ${count === 1 ? 'modelo' : 'modelos'}`,
    modelInUse: 'Em uso',
    modelDefault: 'predefinido',
    modelInactiveHint: 'Selecione primeiro este backend para alterar o modelo.',
    modelSelectedTitle: 'Modelo selecionado',
    modelSelectedMessage: model => `${model} aplica-se a novas sessões.`,
    failedSelectModel: model => `Falha ao selecionar ${model}`,
    terminalBackend: {
      sectionTitle: 'Backend de execução',
      loading: 'A verificar os backends de execução…',
      failedLoad: 'Não foi possível carregar os backends do terminal',
      ready: 'Pronto',
      needsSetup: 'Requer configuração',
      unavailable: 'Indisponível',
      inUse: 'Em uso',
      selectedTitle: 'Backend selecionado',
      selectedMessage: backend =>
        `Os comandos do terminal são agora executados via ${backend}. Aplica-se a novas sessões.`,
      failedSelect: backend => `Falha ao selecionar ${backend}`,
      needsSetupHint: 'Pode selecionar este backend já — os comandos falharão até a configuração estar concluída.'
    }
  }
}
