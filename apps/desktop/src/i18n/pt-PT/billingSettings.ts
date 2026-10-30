/** The words of the Billing Settings pane (front I-C, 2026-10-20), European Portuguese (front V3-T). */
import type { BillingSettingsCopy } from '../en/billingSettings'

export const ptPtBillingSettings: BillingSettingsCopy = {
  sections: {
    plan: 'O seu plano',
    payment: 'Como paga e os seus créditos',
    usage: 'O que tem e o que está a gastar',
    invoices: 'Faturas'
  },
  providerBilling: {
    title: 'A faturação é feita pelo fornecedor de modelos que ligou',
    hint: 'Esta aplicação usa as chaves que adicionou, por isso a utilização e os custos ficam com esse fornecedor. Uma subscrição do Nous Portal mostra aqui o plano e a utilização depois de iniciar sessão.',
    openProviders: 'Abrir fornecedores'
  },
  empty: {
    title: 'Esta ligação não tem nada a faturar',
    hint: 'A faturação pertence a uma conta alojada pelo Nous Portal. Esta aplicação usa as suas próprias chaves, por isso não há nada a medir ou a cobrar aqui; a utilização e os custos ficam com o seu fornecedor de modelos.'
  },
  summary: {
    balance: 'Saldo',
    plan: 'Plano',
    refill: 'Recarga automática',
    enabled: 'Ativada',
    off: 'Desativada'
  },
  notice: {
    openPortal: 'Abrir portal ↗',
    noCardTitle: 'Nenhum método de pagamento registado',
    noCardMessage:
      'A compra de créditos e a recarga automática ficam desativadas até haver um cartão registado. Adicione um no portal.',
    addCard: 'Adicionar cartão ↗'
  },
  payment: {
    title: 'O cartão com que paga',
    hint: 'Usado para carregamentos e renovações da subscrição.',
    noneHint: 'Ainda não há nenhum cartão registado.',
    add: 'Adicionar método de pagamento',
    update: 'Atualizar'
  },
  buy: {
    title: 'Comprar créditos agora',
    hint: 'Uma única cobrança no seu cartão, adicionada hoje ao seu saldo.',
    action: 'Comprar',
    customAmount: 'Montante de créditos personalizado'
  },
  refill: {
    title: 'Carregar automaticamente quando o saldo estiver baixo',
    generic: 'Mantenha o saldo carregado quando descer abaixo do seu limiar.',
    manage: 'Gerir',
    manageOnPortal: 'Faça a gestão da recarga automática no portal.',
    turnOnPortal: 'Ativar a recarga automática no portal',
    reconcile: 'Reconciliar ↗',
    differentCard: 'um cartão diferente',
    threshold: 'Limiar da recarga automática',
    reloadTo: 'Montante a repor na recarga automática',
    distinctCaption: (card: string) => `A recarga automática cobra ${card} — reconcilie no portal`,
    charges: (reloadTo: string, threshold: string) =>
      `Cobra ${reloadTo} automaticamente quando o seu saldo desce abaixo de ${threshold}.`
  },
  plan: {
    currentTitle: (tier: string) => `Está no plano ${tier}`,
    free: 'Gratuito',
    unavailable: 'Os detalhes da subscrição não estão disponíveis; continua a ser possível abrir o portal.',
    noSubscription: 'Nenhuma subscrição ativa — os modelos pagos consomem os créditos carregados.',
    change: 'Mudar de plano',
    view: 'Ver planos',
    adjust: 'Ajustar plano ↗',
    choose: 'Escolher ↗',
    back: 'Voltar à faturação',
    changesTo: (tier: string, when: string) => `Muda para ${tier} a ${when}.`,
    cancels: (when: string) => `É cancelado a ${when}.`,
    renews: (date: string) => `Renova a ${date}`
  },
  usage: {
    left: (left: string, total: string) => `Restam ${left} de ${total}`,
    over: (amount: string) => `${amount} acima do limite`,
    used: (spent: string, limit: string) => `${spent} de ${limit} usados`,
    subscriptionRemaining: 'Créditos da subscrição restantes',
    subscription: 'Créditos restantes da sua subscrição',
    noExpiry: 'Nunca expiram.',
    topup: 'Créditos que comprou',
    capUsed: 'Limite de gasto mensal usado',
    defaultCeiling: 'Este é o limite predefinido da sua conta.',
    monthlyRemote: 'Conta o que gasta a partir desta aplicação em cada mês.',
    cap: 'Quanto do seu limite mensal já gastou',
    resets: (date: string) => `Repõe a ${date}`
  },
  header: 'Faturação',
  actions: {
    save: 'Guardar',
    saving: 'A guardar…',
    cancel: 'Cancelar',
    undo: 'Anular',
    undoing: 'A anular…',
    tryAgain: 'Tentar novamente',
    dismiss: 'Dispensar',
    openPortal: 'Abrir portal',
    verify: 'Verificar para continuar',
    openVerification: 'Abrir a página de verificação',
    turnOff: 'Desativar'
  },
  status: {
    processing: 'A processar a sua cobrança…',
    added: (amount: string) => `Foram adicionados ${amount}. O seu saldo está a ser atualizado.`,
    waitingLink: 'A aguardar a ligação de verificação…'
  },
  autoRefill: {
    thresholdShort: 'Abaixo de',
    reloadToShort: 'Carregar até',
    confirmOff: 'Desativar os carregamentos automáticos?',
    updated: 'Os carregamentos automáticos foram atualizados.',
    turnedOff: 'Os carregamentos automáticos estão desativados.',
    thresholdName: 'O limiar',
    reloadToName: 'O montante do carregamento',
    badFormat: (name: string) => `${name} tem de ser um valor em dólares com até duas casas decimais.`,
    notPositive: (name: string) => `${name} tem de ser superior a $0.`,
    belowMin: (name: string, min: string) => `${name} tem de ser pelo menos ${min}.`,
    aboveMax: (name: string, max: string) => `${name} pode ser no máximo ${max}.`,
    order: 'O montante do carregamento tem de ser superior ao limiar.'
  },
  provenance: {
    autoRefill: 'usado para carregamentos automáticos',
    customerDefault: 'o seu cartão predefinido',
    subPin: 'usado para a sua subscrição'
  },
  plans: {
    titleUpgrade: (tier: string) => `Subir para o plano ${tier}`,
    titleDowngrade: (tier: string) => `Descer para o plano ${tier}`,
    titleScheduled: (tier: string) => `Passa para o plano ${tier} quando este período terminar`,
    title: 'Planos',
    empty: 'Não há outro plano disponível de momento.',
    current: 'Plano atual',
    scheduled: 'Agendado',
    downgrade: 'Descer de plano',
    checking: 'A verificar esta alteração…',
    blocked: 'Esta alteração não pode ser feita aqui.',
    noOp: (tier: string) => `Já está no ${tier}, por isso não há nada a alterar.`,
    scheduledChange: (tier: string, when: string) =>
      `Passa para ${tier} a ${when}. Nada é cobrado agora e mantém o plano atual até lá.`,
    creditsChange: (delta: string) => `Os seus créditos mensais mudam em ${delta}.`,
    cannotSchedule: 'Esta alteração não pode ser agendada aqui.',
    confirm: 'Confirmar descida',
    scheduling: 'A agendar…',
    perMonth: (amount: string) => `${amount}/mês`,
    creditsPerMonth: (amount: string) => `${amount} em créditos por mês`
  },
  refusal: {
    consentTitle: 'Confirme este cartão no portal',
    consentMessage: 'O portal precisa da sua aprovação antes de esta aplicação poder cobrar o cartão.',
    scopeTitle: 'Permita primeiro gastos neste dispositivo',
    scopeMessage: 'Inicie um carregamento para permitir gastos a partir deste dispositivo e tente novamente.',
    stoppedTitle: 'Os gastos a partir deste dispositivo foram parados',
    stoppedByAdmin:
      'Um administrador parou os gastos a partir deste dispositivo. Inicie sessão novamente para os permitir.',
    stoppedByYou: 'Parou os gastos a partir deste dispositivo. Inicie sessão novamente para os permitir.',
    sessionTitle: 'A sua sessão foi terminada',
    sessionMessage: 'Inicie sessão novamente para continuar a usar a faturação.',
    disabledTitle: 'Os gastos a partir desta aplicação estão desativados',
    disabledMessage: 'Um administrador de faturação pode ativá-los no portal.',
    roleTitle: 'Só um administrador pode adicionar fundos',
    roleMessage: 'Peça a um administrador ou proprietário da sua organização, ou faça a gestão da faturação no portal.',
    conflictTitle: 'Inicie um novo carregamento',
    conflictMessage: 'Este carregamento já foi usado para um montante diferente. Inicie um novo.',
    noCardTitle: 'Guarde primeiro um cartão no portal',
    noCardMessage: 'Comprar créditos uma vez não guarda um cartão reutilizável. Adicione um no portal.',
    orgTitle: 'Não pode gerir esta organização',
    orgMessage: 'Esta sessão não está associada a uma organização que gere.',
    capTitle: 'Atingiu o seu limite de gasto mensal',
    capMessage: 'Aumente o limite no portal ou aguarde até ser reposto.',
    capRemaining: (amount: string) => `Restam ${amount} dentro do seu limite mensal.`,
    busyTitle: 'Demasiadas cobranças em simultâneo',
    busyMessage: 'Não se trata de uma falha de pagamento. Aguarde um momento e tente novamente.',
    retryIn: (minutes: number) => `Tente novamente dentro de cerca de ${minutes} min.`,
    paymentServiceTitle: 'O serviço de pagamento está com problemas',
    paymentServiceMessage: 'Aguarde um momento e tente novamente.',
    planLimitTitle: 'Mudou de plano demasiadas vezes hoje',
    planLimitMessage: 'Tente novamente amanhã.',
    unavailableTitle: 'A faturação não está disponível aqui',
    unavailableMessage: 'Esta ligação não oferece faturação. Tente novamente mais tarde.',
    timeoutTitle: 'A faturação demorou demasiado a responder',
    timeoutMessage: 'Verifique a sua ligação e tente novamente.',
    offlineTitle: 'Não foi possível contactar a faturação',
    offlineMessage: 'Verifique a sua ligação e tente novamente.',
    failedTitle: 'A faturação não conseguiu concluir este pedido',
    failedMessage: 'Tente novamente dentro de momentos.'
  },
  charge: {
    added: (amount: string) => `Foram adicionados ${amount} ao seu saldo.`,
    addedGeneric: 'Foram adicionados créditos ao seu saldo.',
    failedTitle: 'A cobrança não foi efetuada',
    bankCheck: 'O seu banco tem de verificar este pagamento. Conclua-o no portal.',
    expired: 'O seu cartão expirou. Atualize-o no portal.',
    declined: 'O seu cartão foi recusado. Experimente outro cartão no portal.',
    failedGeneric: 'Tente novamente ou use outro cartão no portal.',
    unconfirmedTitle: 'A sua última cobrança ainda não está confirmada',
    unconfirmed: 'Verifique o seu saldo no portal antes de tentar novamente.',
    checkFailedTitle: 'Não foi possível verificar a cobrança',
    untrackedTitle: 'Não é possível acompanhar esta cobrança',
    untrackedMessage: 'A cobrança foi aceite, mas não pode ser acompanhada. Verifique o seu saldo no portal.',
    slowTitle: 'A cobrança ainda está a ser processada',
    slowMessage: 'Ainda pode ser efetuada. Verifique o portal antes de tentar novamente.'
  },
  stepUp: {
    deniedTitle: 'A verificação não foi aprovada',
    deniedMessage: 'Os gastos a partir deste dispositivo continuam a não ser permitidos.',
    doneTitle: 'A verificação está concluída',
    doneMessage: 'Este dispositivo já pode gastar a partir da sua conta.'
  },
  devFixture: 'Dados de exemplo da pré-visualização da faturação (só desenvolvimento)'
}
