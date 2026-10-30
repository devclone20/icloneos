// iclone os — V3-I Mercado ACP › Trabalho (pt-PT). O processo principal decide cada passo; estas palavras só dizem o
// que fez e porquê.
import type { AcpWorkTranslations } from '../types/acpWork'

export const acpWork: AcpWorkTranslations = {
  tab: 'Trabalho',
  states: {
    offline: 'Offline',
    starting: 'A iniciar',
    online: 'Online',
    draining: 'A ficar offline em segurança',
    'offline-safe': 'Offline, todos os trabalhos liquidados',
    failed: 'Precisa de si'
  },
  onlineMeaning:
    'Online significa que o recetor de trabalhos está ligado a partir deste Mac. Ainda não está verificado se o marketplace o mostra online.',
  desktopOnly: 'O Trabalho funciona na aplicação para computador, que mantém o agente online a partir do seu Mac.',
  awakeOnly: 'Fica online com esta janela fechada, enquanto este Mac não estiver em repouso.',
  actions: {
    online: 'Pôr online',
    offline: 'Pôr offline',
    reboot: 'Reiniciar recetor',
    refresh: 'Ler trabalhos agora'
  },
  autonomy: {
    title: 'Autonomia',
    levels: {
      L0: { name: 'Observar', summary: 'Encontra e ordena trabalho. O resto é consigo.' },
      L1: {
        name: 'Aprovar cada trabalho',
        summary: 'As ofertas dentro da sua política esperam aqui pelo seu Aprovar.'
      },
      L2: {
        name: 'Agir dentro da política',
        summary: 'Envia sozinho as cotações das ofertas dentro da sua política. Só um clique seu o ativa.'
      }
    },
    downgrade: {
      'chain-broken': 'O registo de trabalho não se verifica, por isso só observa até isso ser analisado.',
      'spend-trade-off': 'Gastar e negociar está desativado em Definições › Privacidade, por isso só observa.'
    },
    earnOnly: 'Só ganhar: nunca gasta, contrata nem carrega saldo.'
  },
  writesOff: 'Nesta versão, uma aprovação é registada e a cotação fica retida, nunca enviada.',
  offers: {
    title: 'Ofertas',
    empty: 'Ainda sem ofertas',
    emptyHint: 'Os trabalhos pedidos a este iNFT aparecem aqui com o veredicto da política.',
    approve: 'Aprovar',
    decline: 'Recusar',
    standing: {
      pending: 'À sua espera',
      approved: 'Aprovada',
      declined: 'Recusada',
      refused: 'Recusada pela política',
      seen: 'Vista'
    },
    rules: {
      spend: 'pede a este iNFT que adiante dinheiro',
      token: 'pago num token que a política não aceita',
      chain: 'numa rede que a política não aceita',
      'requester-denied': 'o requerente está na lista de bloqueio',
      'requester-unknown': 'o requerente não está na lista de permissão',
      class: 'um tipo de trabalho que a política não aceita',
      'price-floor': 'a comissão está abaixo do mínimo, ou não foi indicada',
      'open-cap': 'já há demasiados trabalhos abertos',
      oversize: 'o pedido é maior do que o limite'
    },
    price: amount => `Comissão ${amount}`,
    requester: address => `De ${address}`
  },
  groups: { 'in-flight': 'Em curso', completed: 'Concluídos', payments: 'Pagamentos', history: 'Histórico' },
  groupsEmpty: 'Ainda nada aqui.',
  trace: {
    offer: 'Oferta',
    job: 'Trabalho',
    budget: 'Orçamento',
    deliverable: 'Entregue',
    payment: 'Pago',
    gap: 'em falta'
  },
  totals: { earned: 'Ganho', spent: 'Gasto', escrow: 'Em garantia' },
  fixes: {
    title: 'Correções',
    empty: 'Nada falhou.',
    causes: {
      'listener-exited': 'O recetor terminou',
      'needs-sign-in': 'O agente tem de iniciar sessão novamente',
      'owner-reboot': 'Pediu um reinício',
      'read-failed': 'Não foi possível ler a lista de trabalhos',
      'tools-missing': 'As ferramentas ACP não estão instaladas ou não foram verificadas'
    },
    actions: {
      'restart-backoff': 'A reiniciá-lo, com uma espera mais longa de cada vez (até um minuto)',
      restarted: 'Recetor reiniciado',
      'stopped-for-sign-in': 'Deixou de tentar — inicie sessão em Configuração e depois ponha-o online',
      'retry-next-poll': 'A ler novamente na próxima verificação',
      'stopped-for-tools': 'Parado — instale as ferramentas ACP no ACP Market e depois ponha-o online'
    },
    now: state => `Agora: ${state}`
  },
  draining: jobs => `À espera do trabalho ${jobs} antes de o recetor parar.`,
  drainUnknown: 'À espera de uma lista de trabalhos fiável antes de o recetor parar.',
  stopReport: (open, escrow) =>
    open === 0
      ? 'Nenhum trabalho está aberto.'
      : `${open} ${open === 1 ? 'trabalho continua aberto' : 'trabalhos continuam abertos'}, ${escrow} em garantia.`,
  readError: detail => `A última leitura falhou: ${detail}`,
  holds: {
    'signed-out':
      'Offline: terminou sessão, por isso todos os recetores pararam. Inicie sessão e depois ponha-o online.',
    'wallet-switch':
      'Offline: a carteira mudou, por isso todos os recetores pararam. Só a carteira que detém este iNFT o pode pôr online.',
    'ownership-lost': 'Offline: este iNFT já não está na sua carteira, por isso o respetivo recetor parou.',
    'ownership-unverified': 'A verificar se este iNFT continua na sua carteira antes de voltar a ficar online.'
  },
  repair: {
    action: 'Reparar registo',
    hint: 'A reparação guarda todos os registos que se verificam, põe de lado o ficheiro danificado e anota a falha. Agir dentro da política tem de ser escolhido novamente.'
  },
  chainGaps: count =>
    count === 1
      ? 'Uma escrita foi interrompida ou reparada. O registo de trabalho anota a falha.'
      : `${count} escritas foram interrompidas ou reparadas. O registo de trabalho anota cada falha.`,
  chainBroken: 'O registo de trabalho não se verifica.',
  errors: {
    gesture: 'Isto precisa de um clique seu.',
    invalid: 'Esse trabalho já não é uma oferta aberta.',
    policy: 'A política recusa esta oferta.',
    state: 'Agora não — o agente está só a observar ou a ficar offline.',
    ownership: 'Não foi possível provar agora que este iNFT está na sua carteira.',
    'sign-in': 'Inicie primeiro sessão com a carteira que detém este iNFT.',
    busy: 'Ainda a tratar do último pedido.',
    tools: 'Instale primeiro as ferramentas ACP (ACP Market › Instalar).'
  },
  refusedBy: rule => `Recusada: ${rule}`
}
