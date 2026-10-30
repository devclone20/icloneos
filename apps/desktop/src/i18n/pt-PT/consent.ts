// iCLONE OS — first-launch consent sheet + Settings › Privacy, European Portuguese (front V3-T).
// The policy text itself stays English and binding; these are the sheet's own words.
import { type ConsentBank, PRODUCT_NAME } from '@/i18n/en/enConsent'

export const ptPtConsent: ConsentBank = {
  sheet: {
    eyebrow: (title, version, effective) => `${title} · Versão ${version} · Em vigor desde ${effective}`,
    termsTitle: 'Antes de começar',
    termsLead: `O ${PRODUCT_NAME} executa o seu agente neste Mac. Esta é a versão curta de como trata os seus dados.`,
    updateTitle: 'A nossa política mudou',
    updateLead: `Leia e aceite a nova versão para continuar a usar o ${PRODUCT_NAME}. As suas escolhas de permissões guardadas mantêm-se.`,
    readFull: 'Ler a política completa',
    readOffline: 'Ler offline',
    hideOffline: 'Ocultar o texto completo',
    offlineUnavailable: 'Não foi possível ler a cópia incluída. A política completa está em cloneframe.io/privacy.',
    policyLanguage: 'A política está redigida em inglês; o texto em inglês é a versão vinculativa.',
    aiDisclosure:
      'Quando liga um fornecedor de IA, as suas mensagens, ficheiros, persona e memória, e os resultados das ferramentas, incluindo o ecrã, são enviados diretamente deste Mac para esse fornecedor (política §5).',
    accept: (title, version) =>
      `Li e aceito ${title} v${version}, incluindo o envio para o fornecedor de IA que eu ligar`,
    quit: 'Sair',
    continue: 'Continuar',
    permissionsEyebrow: 'Permissões',
    permissionsTitle: `O que o seu agente e o ${PRODUCT_NAME} podem fazer neste Mac`,
    permissionsFooter:
      'Nada é pedido ao macOS agora. O sistema só pergunta quando uma funcionalidade precisa; altere isto quando quiser em Definições › Privacidade ou Definições do Sistema › Privacidade e segurança.',
    acceptHint: 'Aceite a política para continuar',
    keychainLine: on =>
      on
        ? 'O seu início de sessão no gateway é encriptado com o Porta-chaves do Mac; o macOS pode pedir-lhe autorização uma vez.'
        : 'O seu início de sessão no gateway é guardado neste Mac sem encriptação do Porta-chaves.',
    keychainChange: 'Pode alterar isto em Definições › Gateways; o macOS pode voltar a perguntar aí.',
    skip: 'Ignorar por agora',
    allowAll: 'Permitir tudo',
    allAllowed: 'Tudo permitido',
    allowAllKeychainTitle: 'O Porta-chaves não muda',
    allowAllKeychain:
      'Permitir tudo não altera o Porta-chaves: os seus segredos guardados ficam como definidos em Definições › Gateways (sem encriptação). Ative a encriptação aí.',
    saving: 'A guardar…',
    saveFailed: 'Não foi possível guardar a sua escolha. Tente novamente.',
    step: (n, total) => `Passo ${n} de ${total}`
  },
  groups: {
    capabilities: 'Capacidades do agente',
    capabilitiesHint:
      'O seu agente é informado de cada escolha quando arranca. Quando uma tarefa precisa de uma que deixou desativada, pergunta-lhe aqui primeiro.',
    device: 'Dispositivo',
    deviceHint: 'O macOS só pergunta quando uma funcionalidade precisa.',
    neverUsed: 'Nunca usado',
    neverUsedHint: `Para sua informação: o ${PRODUCT_NAME} não usa isto.`
  },
  // A translated bank names every switch itself: the policy's §9 table is English.
  rows: {
    terminal: {
      name: 'Comandos de terminal',
      purpose:
        'Permitir que o seu agente execute comandos num terminal, com as permissões da sua conta de utilizador. Pode ver o que executa.'
    },
    fileWriting: {
      name: 'Escrita de ficheiros',
      purpose: 'Permitir que o seu agente crie e altere ficheiros neste Mac para uma tarefa'
    },
    webBrowsing: {
      name: 'Navegação na web e chamadas de rede',
      purpose:
        'Permitir que o seu agente navegue na web ou use uma ferramenta online por si, enviando o que a tarefa precisa'
    },
    installSoftware: {
      name: 'Instalar software e pacotes',
      purpose:
        'Permitir que o seu agente instale ferramentas e pacotes (Homebrew, npm, pip) quando uma tarefa precisa deles'
    },
    scheduledTasks: {
      name: 'Tarefas agendadas',
      purpose: 'Permitir que o seu agente crie tarefas que são executadas mais tarde neste Mac'
    },
    sendMessages: {
      name: 'Enviar e-mail e mensagens',
      purpose: 'Permitir que o seu agente envie e-mail do agente em seu nome'
    },
    spendTrade: {
      name: 'Gastar e negociar',
      purpose:
        'Permitir que o seu agente gaste dentro do limite de um cartão, aceite trabalhos no marketplace ou negoceie, apenas com as autorizações que deu'
    },
    microphone: { name: 'Microfone', purpose: 'Permitir falar com o seu agente através do botão de voz' },
    screen: {
      name: 'Ecrã',
      purpose: 'Permitir que o seu agente faça capturas de ecrã ou gravações para uma tarefa'
    },
    automation: {
      name: 'Controlo de outras aplicações',
      purpose: 'Permitir que o seu agente controle outras aplicações para uma tarefa'
    },
    notifications: {
      name: 'Notificações',
      purpose: `Permitir que o ${PRODUCT_NAME} mostre notificações de conversas e do agente`
    },
    clipboard: {
      name: 'Área de transferência',
      purpose: 'Permitir que o seu agente leia e escreva na área de transferência para uma tarefa'
    },
    keychain: { name: 'Porta-chaves', purpose: 'Encriptar o seu início de sessão no gateway com o Porta-chaves do Mac' }
  },
  neverUsed: {
    camera: { name: 'Câmara', line: 'A aplicação não usa a sua câmara.' },
    location: { name: 'Localização', line: 'A aplicação não usa a sua localização.' },
    contacts: { name: 'Contactos', line: 'A aplicação não usa os seus contactos.' }
  },
  effect: {
    terminal: 'Desativado: o seu agente é instruído a não executar comandos de terminal.',
    fileWriting:
      'Desativado: o seu agente é instruído a não criar, alterar nem eliminar ficheiros. A leitura das pastas que escolher não é afetada.',
    webBrowsing: 'Desativado: o seu agente é instruído a não navegar na web nem chamar ferramentas online.',
    installSoftware: 'Desativado: o seu agente é instruído a não instalar software nem pacotes.',
    scheduledTasks: 'Desativado: o seu agente é instruído a não criar tarefas agendadas.',
    sendMessages: 'Desativado: o seu agente é instruído a não enviar e-mail nem mensagens por si.',
    spendTrade: 'Desativado: o seu agente é instruído a não movimentar valor sem si.',
    microphone: 'Desativado: o botão de voz fica desativado e o macOS nunca é questionado.',
    screen:
      'Desativado: a aplicação oculta os títulos das janelas de outras aplicações e o seu agente é instruído a não fazer capturas de ecrã nem gravações.',
    automation: 'Desativado: o seu agente é instruído a não controlar outras aplicações.',
    notifications: `Desativado: o ${PRODUCT_NAME} não mostra notificações de conversas nem do agente.`,
    clipboard:
      'Desativado: o seu agente é instruído a não usar a área de transferência. As suas próprias ações de copiar e colar funcionam sempre.',
    keychain:
      'Os dados de início de sessão no gateway ficam neste Mac; se o Porta-chaves os encripta é mostrado ao lado desta linha e alterado em Definições › Gateways.'
  },
  settings: {
    nav: 'Privacidade',
    policyHeading: 'Política',
    policyRow: version => `${PRODUCT_NAME} Políticas e privacidade v${version}`,
    effective: date => `Em vigor desde ${date}`,
    accepted: date => `Aceite em ${date}`,
    acceptedOlder: version => `v${version} aceite`,
    notAccepted: 'Não aceite',
    openLive: 'Abrir a página online',
    readOffline: 'Ler offline',
    hideOffline: 'Ocultar o texto completo',
    permissionsHeading: 'Permissões',
    notConfigured: 'Não configurado',
    notConfiguredHint:
      'Ignorou este passo. Até escolher, o macOS só pergunta quando uma funcionalidade precisa de uma permissão.',
    permissionsFooter: `Um interruptor regista o que o ${PRODUCT_NAME} pode usar; o macOS continua a perguntar da primeira vez que uma funcionalidade precisa de uma permissão. O microfone, os títulos das janelas e as notificações mudam de imediato; as capacidades do agente chegam ao seu agente da próxima vez que arrancar.`,
    requestsHeading: 'Pedidos do seu agente',
    requestsEmpty:
      'Ainda não há pedidos. Quando uma tarefa precisa de uma permissão que deixou desativada, o seu agente pergunta aqui.',
    requestAnswer: {
      always: 'Sempre permitido',
      once: 'Permitido uma vez',
      denied: 'Recusado',
      timeout: 'Sem resposta'
    },
    requestBy: (inft, date) => `${inft} · ${date}`,
    keychainState: on => (on ? 'Encriptado' : 'Não encriptado'),
    keychainOpen: 'Abrir definições de gateways',
    aiHeading: 'Fornecedor de IA',
    aiRow: 'O que recebe o fornecedor de IA que ligar',
    aiRowDesc:
      'As mensagens, ficheiros, persona e memória, e os resultados das ferramentas, incluindo o ecrã, vão diretamente deste Mac para o fornecedor que ligar (política §5). Aceitou isto com a política.',
    aiWithdrawn: date => `Retirado em ${date}`,
    aiNotRecorded: 'Não registado',
    aiWithdrawnHint: `O ${PRODUCT_NAME} guarda a data em que retirou o consentimento. Não desliga por si só um fornecedor ligado: desligue o fornecedor em Definições › Fornecedores para parar o envio.`,
    aiAcceptAgain: 'Aceitar novamente',
    openProviders: 'Abrir Fornecedores',
    withdraw: 'Retirar o consentimento ao fornecedor de IA',
    withdrawTitle: 'Retirar o consentimento ao fornecedor de IA?',
    withdrawDesc: `O ${PRODUCT_NAME} regista a data em que o retirou. Não desliga por si só um fornecedor ligado: para parar o envio, desligue o fornecedor em Definições › Fornecedores.`,
    withdrawConfirm: 'Retirar',
    saveFailed: 'Não foi possível guardar. Tente novamente.',
    unavailable: 'As definições de privacidade estão disponíveis na aplicação para computador.'
  },
  door: {
    eyebrow: inft => `Pedido de permissão · ${inft}`,
    title: name => `O seu agente precisa de ${name}`,
    reasonLabel: 'Porquê, nas palavras do seu agente',
    hint: `Permitir uma vez dura até o ${PRODUCT_NAME} ser fechado. Permitir sempre ativa o interruptor em Definições › Privacidade.`,
    expires: 'Sem resposta em dois minutos conta como Recusar.',
    deny: 'Recusar',
    once: 'Permitir uma vez',
    always: 'Permitir sempre'
  }
}
