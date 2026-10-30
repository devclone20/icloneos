// iclone os — V3-F modos de permissão (pt-PT): Definições › Agente › Permissões e o pedido de permissão na folha de
// consentimento. A forma é a de PermissionsCopy; quem decide é o processo principal, estas palavras só explicam.
import { PRODUCT_NAME } from '@/i18n/en/enConsent'
import type { PermissionsCopy } from '@/i18n/en/enPermissions'
import { FUNCTION_COPY } from '@/iclone-shared/permission-function-copy'

export const ptPtPermissions: PermissionsCopy = {
  title: 'Permissões',
  lead: `O que o seu agente pode fazer neste Mac sem lhe perguntar. Só um clique seu aqui o altera — nunca o agente, nunca uma atualização.`,
  enforcement: {
    enforced: 'Em vigor: cada chamada de ferramenta do seu agente passa primeiro por estas regras.',
    starting: 'A iniciar: a verificar se o controlo de permissões está carregado no seu agente.',
    'not-enforced':
      'Fora de vigor: o controlo de permissões não responde, por isso as ferramentas do seu agente são recusadas até ele reiniciar.',
    'no-agent': 'O seu agente não está em execução.',
    degraded:
      'O porta-chaves do sistema não conseguiu proteger a chave do registo: só Manual, e o registo não pode ser verificado entre reinícios.',
    // FX-2 r1b: the degraded state's cause when the owner's Keychain setting is off, and the fix.
    'keychain-off':
      'Só Manual: a definição do Porta-chaves está desligada, por isso os outros modos não podem ser protegidos. Ligue o Porta-chaves em Definições › Máquina › Gateways › «Guardar as palavras-passe no porta-chaves do sistema» para usar Automático, Plano e os outros modos.',
    // V3-FX M1: turned on while the app runs — payments and the ACP tools follow at once, the modes after a restart.
    'keychain-restart':
      'O Porta-chaves está ligado. A chave das permissões é selada quando o icloneOS arranca: reinicie o icloneOS para usar Automático, Plano e os outros modos. Os pagamentos e as ferramentas ACP já o usam.'
  },
  // r3/r4: the button beside the modes' restart line (the Keychain turned on since launch), and what it says
  // when main refuses the relaunch.
  restartNow: 'Reiniciar agora',
  restartRefused: 'O icloneOS não conseguiu reiniciar agora. Saia e abra-o de novo para usar os modos.',
  modes: {
    ignore: {
      name: 'Ignorar permissões',
      summary:
        'Trabalha sem perguntar, exceto para gastar dinheiro ou pedir uma permissão do sistema. Nunca é a predefinição.'
    },
    manual: {
      name: 'Manual',
      summary: 'Pergunta antes de cada escrita, comando, acesso à rede, mensagem, instalação e eliminação. Ler é livre.'
    },
    automatic: {
      name: 'Automático',
      summary: 'Escreve no projeto, executa comandos seguros e lê a web sozinho. Para o resto, pergunta.'
    },
    plan: {
      name: 'Plano',
      summary: 'Só leitura. O seu agente lê e escreve o plano na conversa; não altera nada.'
    },
    acceptEdits: {
      name: 'Aceitar edições',
      summary: 'Edita sozinho os ficheiros do projeto. Para tudo o resto, pergunta.'
    }
  },
  classes: {
    R: 'ler ficheiros',
    Wp: 'escrever um ficheiro no projeto',
    Wo: 'escrever um ficheiro fora do projeto',
    X: 'executar um comando',
    N: 'usar a rede',
    $: 'gastar dinheiro',
    M: 'enviar uma mensagem',
    S: 'pedir uma permissão do sistema',
    I: 'instalar software',
    D: 'eliminar ficheiros'
  },
  current: 'Em uso',
  choose: 'Usar',
  scope: {
    label: 'Aplica-se a',
    standing: 'Em todo o lado',
    project: (path: string) => `Este projeto · ${path}`,
    noProject: 'Abra um projeto para lhe dar um modo próprio.'
  },
  ignoreConfirm: {
    standingOnly: 'Ignorar permissões nunca é a predefinição para tudo: escolha-o para um projeto.'
  },
  refused: {
    gesture: 'O modo só muda com um clique seu.',
    invalid: 'Este modo não pode ser escolhido aqui.',
    unavailable: `Os modos de permissão precisam da aplicação para computador do ${PRODUCT_NAME}.`
  },
  floor: {
    title: 'Nunca, em nenhum modo nem em nenhum nível',
    items: [
      'Apagar o disco, a sua pasta pessoal ou pastas do sistema, formatar uma unidade ou desligar o Mac',
      'Alterar as próprias permissões, este modo ou o registo do que fez',
      'Ler as suas chaves, palavras-passe, frases de recuperação da carteira ou tokens para os enviar para algum lado',
      `Parar o ${PRODUCT_NAME}, o ambiente de execução do agente ou este controlo de permissões`,
      'Escrever a sua palavra-passe de administrador ou ativar uma permissão do sistema para si próprio',
      'Transferir um iNFT ou assinar uma aprovação para um iNFT'
    ]
  },
  // V3-F2: the Functions matrix (shared with main's native raise confirm).
  functions: FUNCTION_COPY['pt-PT'],
  // FX-6: what confinement really does (on by default, V3-G); the pane picks the line for the live state.
  shellNote: {
    on: 'Os comandos do agente são executados confinados por omissão (Seatbelt), em todos os modos, incluindo Ignorar permissões: só escrevem no projeto e numa pasta temporária, e só acedem à rede quando o modo ou uma permissão o permite. Pode desligar isto em Contentores, escolhendo Este Mac.',
    off: 'O confinamento está desligado (escolheu Este Mac em Contentores): em Ignorar permissões e Automático, um comando pode escrever fora do projeto.',
    // V3-FX M2: main's live verdict is red (on but not working), or not read yet.
    red: 'O confinamento não está a funcionar agora (Contentores mostra porquê): até estar, em Ignorar permissões e Automático um comando pode escrever fora do projeto.',
    pending: 'A ler o estado do confinamento…'
  },
  grants: {
    title: 'Permissões que concedeu',
    empty: 'Nenhuma. Quando permitir algo por mais do que uma vez, aparece aqui.',
    scope: { session: 'esta conversa', project: 'este projeto', standing: 'em todo o lado' },
    revoke: 'Revogar'
  },
  // A-1: um ficheiro de estado das permissões que o processo principal recusou ou não conseguiu verificar no arranque.
  integrity: {
    mode: {
      tampered: `O modo de permissões em disco foi alterado ou danificado fora do ${PRODUCT_NAME} e não está em vigor: Manual em todo o lado até voltar a escolher um modo.`,
      unverified:
        'O modo de permissões foi guardado por uma versão anterior ou com o Keychain desligado, por isso não pôde ser verificado: Manual em todo o lado até voltar a escolher um modo.',
      missing: 'O ficheiro do modo de permissões não existe: Manual em todo o lado até voltar a escolher um modo.'
    },
    functions: {
      tampered: `Os níveis das funções em disco foram alterados ou danificados fora do ${PRODUCT_NAME} e não estão em vigor: todas as funções ficam em Manual até voltar a escolhê-las.`,
      unverified:
        'Os níveis das funções foram guardados por uma versão anterior ou com o Keychain desligado, por isso não puderam ser verificados: cada nível mais largo do que Manual fica em Manual até o confirmar abaixo.',
      missing:
        'O ficheiro dos níveis das funções não existe: todas as funções ficam em Manual até voltar a escolhê-las.'
    },
    grants: {
      tampered: `As permissões que deu foram alteradas ou danificadas fora do ${PRODUCT_NAME} e não estão em vigor: volte a permitir quando lhe for pedido.`,
      unverified:
        'As permissões que deu foram guardadas por uma versão anterior ou com o Keychain desligado, por isso não puderam ser verificadas e não estão em vigor: volte a permitir quando lhe for pedido.',
      missing:
        'O ficheiro das permissões que deu não existe; nenhuma está em vigor: volte a permitir quando lhe for pedido.'
    }
  },
  audit: {
    title: 'Atividade',
    empty: 'Ainda nada registado.',
    chainOk: (count: number) => `${count} ${count === 1 ? 'registo' : 'registos'} · cadeia intacta`,
    chainBroken: `O registo tem uma falha ou foi alterado fora do ${PRODUCT_NAME}.`,
    otherKind: 'Registo de permissões',
    kinds: {
      use: 'Permitido',
      refuse: 'Recusado',
      ask: 'Perguntou-lhe',
      answer: 'Respondeu',
      timeout: 'Sem resposta',
      mode_set: 'Modo alterado',
      mode_refused: 'Alteração recusada',
      grant: 'Permissão concedida',
      revoke: 'Permissão revogada',
      gap: 'Falha',
      restart: `${PRODUCT_NAME} iniciado`,
      fn_level_set: 'Nível alterado',
      fn_level_refused: 'Alteração de nível recusada'
    } as Record<string, string>,
    details: {
      denied: 'Recusado por si',
      busy: 'Já havia demasiados pedidos de permissão em espera',
      withdrawn: 'Retirado antes da sua resposta',
      noGesture: 'Sem um clique seu',
      notConfirmed: 'Sem confirmação na caixa de diálogo do sistema',
      standingIgnore: 'Ignorar permissões não pode ser a predefinição em todo o lado',
      invalid: 'Alteração inválida',
      raced: 'O nível mudou enquanto a caixa de diálogo estava aberta',
      gateNotStarted: (pid: string | null) =>
        pid
          ? `O controlo de permissões no Hermes (pid ${pid}) nunca chegou a arrancar; as respetivas chamadas de ferramenta são recusadas`
          : 'O controlo de permissões no Hermes nunca chegou a arrancar; as respetivas chamadas de ferramenta são recusadas',
      gateStopped: (pid: string | null) =>
        pid
          ? `O controlo de permissões no Hermes (pid ${pid}) deixou de responder`
          : 'O controlo de permissões no Hermes deixou de responder',
      unverified: (count: number) =>
        count === 1
          ? `${count} linha do Hermes não pôde ser verificada e não foi registada`
          : `${count} linhas do Hermes não puderam ser verificadas e não foram registadas`,
      missedEvents: (count: number) =>
        count === 1
          ? `${count} evento do controlo de permissões nunca chegou`
          : `${count} eventos do controlo de permissões nunca chegaram`,
      confinementBurst: (count: number) =>
        count === 1
          ? `Mais ${count} recusa de confinamento nesse minuto fica apenas em Contentores › Recusas`
          : `Mais ${count} recusas de confinamento nesse minuto ficam apenas em Contentores › Recusas`,
      confined: 'Bloqueado pelo confinamento',
      gap: 'Algo não pôde ser registado',
      payment: {
        settled: 'Pagamento liquidado',
        pending: 'Liquidação ainda pendente',
        failed: 'O pagamento não foi concluído',
        ledger: 'O registo de pagamentos não passa na verificação',
        limit: 'Acima de um limite em Economia › Pagamentos',
        stopped: 'Paragem total: todos os pagamentos são recusados',
        payee: 'Destinatário ou site não permitido',
        mandate: 'Sem mandato válido',
        denied: 'Recusado por si no pedido de permissão',
        setting: 'Uma alteração em Economia › Pagamentos',
        service: 'Recusado pelo serviço de pagamentos',
        other: 'Um pagamento',
        unrecorded: 'Um pagamento que não ficou no registo de pagamentos',
        uncertain: 'Resultado desconhecido: verifique o registo de pagamentos',
        stopOff: 'Paragem total levantada',
        mandateIssued: 'Mandato emitido',
        mandateRevoked: 'Mandato revogado',
        mandateChange: 'Uma alteração aos mandatos'
      }
    }
  },
  ask: {
    eyebrow: (who: string) => `Pedido de permissão · ${who}`,
    title: (what: string) => `O seu agente quer ${what}`,
    targetLabel: 'Exatamente isto',
    expand: 'Mostrar tudo',
    collapse: 'Mostrar menos',
    reasonLabel: 'Porquê, nas palavras do seu agente',
    effects: {
      R: 'Vai ler isto e não altera nada.',
      Wp: 'Vai criar ou alterar este ficheiro dentro do projeto.',
      Wo: 'Vai criar ou alterar este ficheiro fora do projeto.',
      X: 'Vai executar este comando neste Mac.',
      N: 'Vai enviar este pedido pela internet.',
      $: 'Vai movimentar este montante da sua carteira ou do seu cartão.',
      M: 'Vai enviar esta mensagem em seu nome.',
      S: 'Vai pedir esta permissão ao macOS; concede-a em Definições do Sistema.',
      I: 'Vai instalar este software para o seu utilizador.',
      D: 'Vai eliminar isto.'
    },
    mode: (name: string) => `Modo: ${name}`,
    scopeLabel: 'Permitir para',
    scopes: { once: 'Só desta vez', session: 'Esta conversa', project: 'Este projeto', standing: 'Em todo o lado' },
    covers: {
      session: (what: string) => `Permite todos os pedidos para ${what} nesta conversa, não só este.`,
      project: (what: string) => `Permite todos os pedidos para ${what} neste projeto, não só este.`,
      standing: (what: string) => `Permite todos os pedidos para ${what}, em todo o lado, até os revogar.`
    },
    deny: 'Recusar',
    allow: 'Permitir',
    expires: 'Sem resposta em dois minutos conta como Recusar.'
  },
  approvalPointer: 'À espera da sua permissão — responda no pedido no topo.'
}
