import type { TranslationOverrides } from '../../define-locale'
import type { SettingsProfileTranslations } from '../../types/settings/profile'

export const settingsProfile: Pick<NonNullable<TranslationOverrides['settings']>, keyof SettingsProfileTranslations> = {
  credentials: {
    pasteKey: 'Colar chave',
    pasteLabelKey: label => `Colar chave de ${label}`,
    optional: 'Opcional',
    enterValueFirst: 'Introduza primeiro um valor.',
    couldNotSave: 'Não foi possível guardar a credencial.',
    remove: 'Remover',
    getKey: 'Obter uma chave',
    saving: 'A guardar'
  },
  envActions: {
    actions: 'Ações',
    manageInKeys: 'Gerir em Chaves de API',
    docs: 'Documentação',
    hideValue: 'Ocultar valor',
    revealValue: 'Mostrar valor',
    replace: 'Substituir',
    set: 'Definir'
  },
  keys: {
    failedLoad: 'Falha ao carregar as chaves de API',
    empty: 'Ainda não há nada configurado nesta categoria.'
  },
  providers: {
    connectAccount: 'Ligar uma conta',
    haveApiKey: 'Tem antes uma chave de API?',
    intro:
      'Inicie sessão com uma conta que já tem; não há nenhuma chave para copiar. O início de sessão abre no seu navegador e termina aqui.',
    connected: 'Ligado',
    collapse: 'Recolher',
    connectAnother: 'Ligar outro fornecedor',
    otherProviders: 'Outros fornecedores',
    claudeSubscription: 'Subscrição Claude (requer créditos de utilização adicionais)',
    disconnect: 'Desligar',
    disconnectInTerminal: 'Desligar (executa o comando de remoção no terminal)',
    removeExternalGeneric: provider => `${provider} é gerido pela sua própria CLI — remova-o aí.`,
    removeKeyManaged: provider =>
      `${provider} está configurado a partir de uma chave de API. Remova-o em Chaves de API.`,
    removeTerminalRunning: provider => `A executar a desligação de ${provider} no terminal…`,
    removedTitle: 'Conta removida',
    removedMessage: provider => `${provider} foi removido.`,
    noProviderKeys: 'Não há chaves de API de fornecedores disponíveis.',
    searchKeys: 'Pesquisar fornecedores…',
    noKeysMatch: 'Nenhum fornecedor corresponde à sua pesquisa.',
    manage: provider => `Gerir ${provider}`,
    endpoints: {
      heading: 'Servidores de modelos próprios',
      addHeading: 'Adicionar um servidor',
      editHeading: 'Editar este servidor',
      name: 'Como chamar a este servidor',
      nameHint: 'O nome que verá ao escolher um modelo.',
      providerId: 'Um id curto para este servidor',
      providerIdHint: 'Letras minúsculas, números e hífenes; a aplicação usa-o para distinguir os servidores.',
      url: 'Onde o servidor responde',
      urlHint: 'O seu endereço web; os servidores compatíveis com OpenAI terminam normalmente em /v1.',
      model: 'Com que modelo responde por predefinição',
      context: 'Quanto de uma conversa o modelo consegue reter',
      contextHint: 'Deixe em Auto e a aplicação pergunta ao servidor.',
      apiKey: 'A chave que o servidor espera',
      apiKeyHint: 'Só se o servidor pedir uma.',
      useForNewChats: 'Iniciar novas conversas neste servidor',
      discoverModels: 'Encontrar os modelos que oferece ao testá-lo',
      discoverModelsHint: 'A lista preenche o campo de modelo acima.'
    },
    featuredPitch: 'Uma subscrição para mais de 300 modelos de topo.',
    moreFields: count => `Mais definições (${count})`,
    localEndpoint: {
      title: 'Usar um servidor de modelos próprio',
      description: 'Qualquer servidor compatível com OpenAI funciona, como vLLM, llama.cpp ou Ollama.',
      action: 'Configurar'
    }
  }
}
