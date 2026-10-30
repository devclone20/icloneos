// iclone os — V3-J Definições › Economia › Pagamentos (pt-PT). O processo principal decide cada pagamento; estas
// palavras dizem o que ele permite.
import type { PaymentsTranslations } from '../types/payments'

export const payments: PaymentsTranslations = {
  navLabel: 'Pagamentos',
  keywords: ['x402', 'USDC', 'gastar', 'limite', 'parar', 'mandato'],
  intro:
    'O que os seus agentes podem pagar, a quem e quanto por dia. Aumentar um limite ou adicionar um destinatário exige primeiro a sua confirmação; uma redução aplica-se de imediato.',
  desktopOnly: 'Os pagamentos funcionam na aplicação para computador, que guarda as chaves neste Mac.',
  status: {
    title: 'Estado',
    ready: 'Pronto',
    off: 'Desativado',
    readyHint: 'Os agentes podem pagar ao abrigo de um mandato assinado por si, dentro dos limites abaixo.',
    pocket: 'Endereço da carteira dos agentes',
    pocketHint: 'A carteira dos agentes neste Mac. Não a carregue com mais do que o seu limite diário.',
    noPocket: 'Ainda sem carteira dos agentes',
    today: 'Assinado hoje (UTC)',
    todayValue: (amount, cap) => `${amount} de ${cap} USDC`,
    ledgerBroken:
      'O registo de pagamentos não passa na verificação: todos os pagamentos são recusados até ser reparado.',
    unprotected: 'Perfis desprotegidos',
    unprotectedHint:
      'A aplicação não conseguiu garantir que as competências de pagamento estão desativadas nestes perfis (uma pasta ou um config.yaml fora da pasta principal do Hermes, ou que não conseguiu ler nem escrever): os agentes desses perfis não podem pagar.',
    notReady: {
      sealing_off:
        'Os pagamentos estão desligados: a definição do Porta-chaves está desligada, por isso as chaves de pagamento não podem ser seladas. Ligue o Porta-chaves em Definições › Máquina › Gateways › «Guardar as palavras-passe no porta-chaves do sistema» para usar pagamentos.',
      keys_unavailable: 'Uma chave de pagamento selada não pode ser usada, por isso os pagamentos estão desativados.',
      disabled: 'Os pagamentos estão desativados.',
      socket_down: 'A ligação através da qual os agentes pagam não está em execução.'
    }
  },
  caps: {
    title: 'Limites de gastos',
    perTx: 'Por pagamento',
    perTxHint: 'Um pagamento acima deste valor é recusado.',
    perDay: 'Por dia',
    perDayHint: 'Todos os agentes em conjunto, por dia UTC.',
    perAgentDay: 'Por agente, por dia',
    perAgentDayHint: 'O teto de cada agente: o máximo que um agente comprometido pode gastar num dia.',
    save: 'Guardar limites',
    invalid: 'Introduza um valor em USDC com ponto decimal e até 6 casas decimais (ex.: 12.50).',
    note: 'Aumentar um limite exige a sua confirmação no pedido de permissão. Uma redução aplica-se de imediato.'
  },
  stop: {
    title: 'Paragem total',
    label: 'Parar todos os pagamentos',
    hint: 'Recusa todos os pagamentos, incluindo os que estão em curso. Desativá-la exige a sua confirmação no pedido de permissão.'
  },
  allowlist: {
    title: 'A quem os agentes podem pagar',
    payees: 'Destinatários',
    payeesHint: 'Endereços a que os agentes podem pagar. Sem nenhum na lista, ninguém pode ser pago.',
    origins: 'Sites de origem',
    originsHint:
      'Sites a cujos pedidos de pagamento os agentes podem responder. Sem nenhum na lista, não respondem a nenhum.',
    add: 'Adicionar',
    remove: 'Remover',
    invalidPayee: 'Não é um endereço: 0x seguido de 40 caracteres hexadecimais.',
    invalidOrigin: 'Não é o endereço de um site: comece por https:// ou http://.',
    full: max => `A lista está cheia (${max} entradas). Remova uma primeiro.`,
    listed: 'Já está na lista.',
    empty: 'Ainda nenhum',
    problems: {
      notList: list => `${list}: não é uma lista.`,
      tooMany: (list, count, max) => `${list}: ${count} entradas, no máximo ${max}.`,
      entries: (list, entries, more) => `${list}: ${entries}${more > 0 ? ` (+${more} mais)` : ''}`
    }
  },
  issue: {
    title: 'Novo mandato',
    intro:
      'Um mandato é a sua autorização assinada para um agente pagar: quanto no total, quanto de cada vez, a quem e até quando. Sem mandato, os agentes não podem pagar.',
    agent: 'Agente',
    agentHint: 'O nome do perfil do agente, por exemplo inft-alpha.',
    budget: 'Orçamento',
    budgetHint:
      'O máximo que todos os pagamentos ao abrigo deste mandato podem somar. Por predefinição, é o seu limite diário por agente.',
    min: 'Pagamento mínimo',
    max: 'Pagamento máximo',
    rangeHint:
      'Cada pagamento tem de ficar entre estes valores. Por predefinição, o máximo é o seu limite por pagamento.',
    payees: 'Pode pagar a',
    payeesHint: 'Só pode escolher destinatários da sua lista acima.',
    noPayees: 'Adicione primeiro um destinatário à lista acima.',
    starts: 'Pagamentos a partir de',
    ends: 'Pagamentos até',
    expires: 'O mandato expira',
    datesHint: 'Na sua hora local. Um mandato dura, no máximo, 90 dias.',
    review: 'O que vai assinar',
    payee: 'Destinatário',
    summary: {
      agent: agent => `Para ${agent}`,
      budget: budget => `Até ${budget} USDC no total`,
      range: (min, max) => `Cada pagamento entre ${min} e ${max} USDC`,
      payees: count => (count === 1 ? 'A 1 destinatário:' : `A ${count} destinatários:`),
      window: (from, to) => `Pagamentos permitidos de ${from} a ${to}`,
      expires: at => `O mandato expira a ${at}`,
      caps: (perTx, perDay, perAgentDay) =>
        `Os seus limites continuam a aplicar-se: ${perTx} USDC por pagamento, ${perDay} USDC por dia, ${perAgentDay} USDC por agente por dia.`
    },
    problems: {
      agent: 'Introduza o nome do perfil do agente: letras minúsculas, algarismos, - e _.',
      amount:
        'Verifique os valores: acima de zero, com ponto decimal e até 6 casas decimais, e mínimo ≤ máximo ≤ orçamento.',
      dates:
        'Verifique as datas: os pagamentos começam antes de terminarem e terminam, o mais tardar, na data de expiração, que tem de ser futura e no prazo de 90 dias.',
      payees: 'Escolha pelo menos um destinatário da sua lista.'
    },
    sign: 'Assinar mandato…',
    signHint:
      'Vai confirmar mais uma vez no pedido de permissão, que mostra todos os termos. A revogação posterior é imediata.',
    signed: 'Mandato assinado.'
  },
  mandates: {
    title: 'Mandatos',
    empty: 'Sem mandatos. Um agente só pode pagar ao abrigo de um mandato assinado por si.',
    forAgent: agent => `Para ${agent}`,
    terms: (budget, expires) => `Orçamento ${budget} USDC · expira a ${expires}`,
    revoked: 'Revogado',
    revoke: 'Revogar'
  },
  saved: 'Guardado',
  refusals: {
    allowlist: 'Sem alterações: cada lista aceita até 50 entradas válidas, sem repetições.',
    door_denied: 'Sem alterações: o pedido de permissão foi recusado ou expirou.',
    gesture: 'Sem alterações: a alteração exige um clique seu.',
    invalid: 'Sem alterações: o pedido não era válido.',
    ledger: 'Sem alterações: não foi possível escrever o registo de pagamentos.',
    no_door: 'Sem alterações: o pedido de permissão não está disponível.',
    not_ready: 'Os pagamentos não estão disponíveis.',
    settings_moved: 'As definições mudaram entretanto. Reveja-as e tente novamente.',
    unavailable: 'Indisponível nesta versão.',
    unknown: 'Algo correu mal. Nada foi alterado.'
  }
}
