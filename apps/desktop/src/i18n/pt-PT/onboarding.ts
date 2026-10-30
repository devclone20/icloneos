import type { TranslationOverrides } from '../define-locale'

export const onboarding: TranslationOverrides['onboarding'] = {
  headerTitle: 'Vamos configurar o iclone os',
  headerDesc: 'Ligue um fornecedor de modelos para começar a conversar. A maioria das opções requer apenas um clique.',
  preparingInstall:
    'O agente está a concluir a instalação. Na primeira execução, demora normalmente menos de um minuto.',
  starting: 'A iniciar o agente…',
  lookingUpProviders: 'A procurar fornecedores...',
  collapse: 'Recolher',
  otherProviders: 'Outros fornecedores',
  haveApiKey: 'Tenho uma chave de API',
  chooseLater: 'Vou escolher um fornecedor mais tarde',
  recommended: 'Recomendado',
  connected: 'Ligado',
  featuredPitch: 'Uma subscrição, mais de 300 modelos de ponta — a forma recomendada de executar o agente',
  fireworksPitch: 'API de modelos direta — modelos de ponta alojados na Fireworks',
  openRouterPitch: 'Uma chave, centenas de modelos — uma boa predefinição',
  apiKeyOptions: {
    fireworks: {
      short: 'API de modelos direta',
      description: 'Acesso direto a modelos alojados pela Fireworks AI.'
    },
    openrouter: {
      short: 'uma chave, muitos modelos',
      description: 'Aloja centenas de modelos com uma única chave. Boa predefinição para novas instalações.'
    },
    openai: { short: 'modelos da classe GPT', description: 'Acesso direto aos modelos da OpenAI.' },
    gemini: { short: 'modelos Gemini', description: 'Acesso direto aos modelos Google Gemini.' },
    xai: { short: 'modelos Grok', description: 'Acesso direto aos modelos xAI Grok.' },
    local: {
      short: 'alojamento próprio',
      description:
        'Aponte o agente para um endpoint local ou de alojamento próprio compatível com OpenAI (vLLM, llama.cpp, Ollama, etc).'
    }
  },
  backToSignIn: 'Voltar ao início de sessão',
  getKey: 'Obter uma chave',
  replaceCurrent: 'Substituir o valor atual',
  pasteApiKey: 'Cole a chave de API',
  localApiKeyPlaceholder: 'Chave de API (opcional — apenas se o seu endpoint a exigir)',
  couldNotSave: 'Não foi possível guardar a credencial.',
  connecting: 'A ligar',
  update: 'Atualizar',
  flowSubtitles: {
    pkce: 'Abre o seu navegador para iniciar sessão e depois continua aqui',
    device_code: 'Abre uma página de verificação no seu navegador — o agente liga-se automaticamente',
    external: 'Inicie sessão uma vez no seu terminal e depois volte para conversar'
  },
  startingSignIn: provider => `A iniciar sessão em ${provider}...`,
  verifyingCode: provider => `A verificar o seu código com ${provider}...`,
  connectedProvider: provider => `${provider} ligado`,
  connectedPicking: provider => `${provider} ligado. A escolher um modelo predefinido...`,
  signInFailed: 'O início de sessão falhou. Tente novamente.',
  pickDifferentProvider: 'Escolher outro fornecedor',
  signInWith: provider => `Iniciar sessão com ${provider}`,
  openedBrowser: provider => `Abrimos ${provider} no seu navegador.`,
  authorizeThere: 'Autorize o agente lá.',
  copyAuthCode: 'Copie o código de autorização e cole-o abaixo.',
  pasteAuthCode: 'Colar código de autorização',
  reopenAuthPage: 'Reabrir a página de autorização',
  autoBrowser: provider =>
    `Abrimos ${provider} no seu navegador. Autorize o agente lá e a ligação é feita automaticamente — não é preciso copiar nem colar nada.`,
  reopenSignInPage: 'Reabrir a página de início de sessão',
  waitingAuthorize: 'A aguardar a sua autorização...',
  externalPending: provider =>
    `${provider} inicia sessão através da sua própria CLI. Execute este comando num terminal e depois volte e escolha "Já iniciei sessão":`,
  signedIn: 'Já iniciei sessão',
  deviceCodeOpened: provider => `Abrimos ${provider} no seu navegador. Introduza lá este código:`,
  reopenVerification: 'Reabrir a página de verificação',
  copy: 'Copiar',
  defaultModel: 'Modelo predefinido',
  freeTier: 'Plano gratuito',
  pro: 'Pago',
  free: 'Gratuito',
  price: (input, output) => `${input} entrada / ${output} saída por Mtok`,
  change: 'Alterar',
  startChatting: 'Começar',
  docs: provider => `Documentação de ${provider}`
}
