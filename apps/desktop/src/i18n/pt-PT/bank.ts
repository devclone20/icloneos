import type { TranslationOverrides } from '../define-locale'

export const bank: TranslationOverrides['bank'] = {
  card: {
    cardholder: 'Titular',
    tapToFlip: 'Toque para virar',
    spendLimit: 'Limite de gasto',
    lastSpendLimit: 'Último limite de gasto',
    spent: 'Gasto',
    status: 'Estado',
    funding: 'Financiamento',
    active: 'Ativo',
    locked: 'Bloqueado',
    notSignedUp: 'Sem registo',
    signedOut: 'Sessão terminada',
    showFront: 'Mostrar a frente do cartão',
    showBack: 'Mostrar o verso do cartão'
  },
  gate: {
    notSetUpLabel: 'AgentCard — não configurado',
    signedOutLabel: 'AgentCard — sessão terminada',
    signInRequiredLabel: 'AgentCard — é necessário iniciar sessão',
    noCardTitle: 'Ainda sem cartão',
    noCardHint: agentName =>
      `Configure o AgentCard uma vez e ${agentName} pode pagar as suas próprias compras — aprova o limite e o agente trata do pagamento.`,
    stepSignUp: 'Registar',
    stepSignUpHint: 'cria a conta AgentCard do agente.',
    stepVerify: 'Verificar',
    stepVerifyHint: 'chega uma ligação de início de sessão à caixa de entrada do próprio agente.',
    stepPayment: 'Método de pagamento',
    stepPaymentHint: 'associe um cartão ou uma carteira para o financiar.',
    stepLimit: 'Limite',
    stepLimitHint: 'defina quanto pode gastar sem lhe perguntar.',
    openSetup: 'Abrir configuração',
    signInRequired: 'É necessário iniciar sessão',
    useCardAgain: 'Inicie sessão novamente na Virtuals para usar o cartão',
    readCardAgain: 'Inicie sessão novamente na Virtuals para ler o AgentCard',
    signInAgain: 'Iniciar sessão novamente',
    linkSentAgo: ago => `enviada ${ago}`,
    resendLink: 'Reenviar ligação',
    resendIn: seconds => `Reenviar dentro de ${seconds} s`,
    agentInbox: agentName => `Caixa de entrada de ${agentName}`,
    linkSentCardKnown:
      'Inicie sessão novamente no AgentCard — foi enviada uma ligação de início de sessão para {target}',
    linkSent:
      'Foi enviada uma ligação de início de sessão para {target} — abra a aplicação Email, clique na ligação e continue a configuração.',
    askFetchLink: agentName => `Pedir a ${agentName} que obtenha a ligação`,
    otherPath:
      'Há duas formas de configurar o AgentCard: a configuração aqui, para o cartão deste agente através da Virtuals (acp card); ou a sua própria conta AgentCard num terminal — agentcard signup, depois agentcard setup e agentcard identity para o KYC. São contas separadas.',
    agentcardAccount: {
      signedOut: 'A sua própria conta AgentCard tem a sessão terminada.',
      kycRequired: 'A sua própria conta AgentCard precisa de verificação de identidade (KYC).',
      ready: 'A sua própria conta AgentCard está pronta.'
    },
    linkNotRecorded: 'nada foi enviado — não foi possível registar primeiro o envio'
  },
  notice: {
    tryAgain: 'Tentar novamente'
  },
  account: {
    label: 'Conta',
    unavailable: reason => `Perfil indisponível — ${reason}`,
    onFileHidden: 'Perfil registado — detalhes ocultos.',
    noName: 'Ainda sem nome',
    noPhone: 'ainda sem telefone',
    needsNamePhone: 'O AgentCard precisa de um nome e de um telefone antes dos pagamentos.',
    changeInSetup: 'Alterar na configuração'
  },
  stats: {
    reading: 'A ler…',
    notSet: 'Ainda não definido',
    limitLeft: (left, total) => `Restam ${left} de ${total}`,
    openRequests: 'Pedidos abertos',
    reviewFirst: 'Rever o primeiro',
    nothingWaiting: 'Nada em espera',
    codesWaiting: 'Códigos 3DS em espera',
    codesLive: 'Ativo — minutos restantes'
  },
  toolbar: {
    changeLimit: 'Alterar limite',
    issueCard: 'Emitir um cartão para uma compra',
    readOnly: agentName => `AgentCard · só de leitura — a emissão passa por ${agentName}`
  },
  requests: {
    title: 'Pedidos de gasto',
    tabOpen: 'Abertos',
    tabAll: 'Todos',
    showAll: 'Mostrar todos',
    nothingOpenTitle: 'Nada em aberto',
    nothingOpenHint: agentName => `Tudo o que ${agentName} pediu foi resolvido — nada aguarda por si.`,
    emptyTitle: 'Ainda sem pedidos de gasto',
    emptyHint: (agentName, action) =>
      `Quando ${agentName} paga alguma coisa, o pedido aparece aqui. Inicie um com “${action}”.`,
    colRequest: 'Pedido',
    colCaptured: 'Capturado',
    colStatus: 'Estado',
    colIssued: 'Emitido',
    colExpires: 'Expira',
    expires: ago => `exp. ${ago}`,
    updated: ago => `Atualizado ${ago}`
  },
  detail: {
    title: 'Pedido de gasto',
    close: 'Fechar pedido',
    request: 'Pedido',
    amount: 'Montante',
    status: 'Estado',
    created: 'Criado',
    issued: 'Emitido',
    captured: 'Capturado',
    capturedAt: 'Capturado em',
    expires: 'Expira',
    card: 'Cartão'
  },
  codes: {
    title: 'Códigos 3DS',
    active: count => `${count} ${count === 1 ? 'ativo' : 'ativos'}`,
    none: 'De momento não há códigos 3DS — um código aparece aqui durante cerca de cinco minutos depois de o seu agente iniciar um pagamento.',
    left: time => `Restam ${time}`,
    expired: 'expirado',
    amountNotGiven: 'Montante não indicado'
  },
  checking: 'A verificar o cartão…',
  agentFallback: 'o seu agente'
}
