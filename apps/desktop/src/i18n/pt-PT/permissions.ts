// iclone os — V3-F modos de permissão (pt-PT): Definições › Agente › Permissões e o pedido de permissão na folha de
// consentimento. A forma é a de PermissionsCopy; quem decide é o processo principal, estas palavras só explicam.
import { PRODUCT_NAME } from '@/i18n/en/enConsent'
import type { PermissionsCopy } from '@/i18n/en/enPermissions'
import { FUNCTION_COPY } from '@/iclone-shared/permission-function-copy'

export const ptPtPermissions: PermissionsCopy = {
  title: 'Permissões',
  lead: `O que o seu agente pode fazer neste Mac sem lhe perguntar. Um modo muda com um clique nesta app, não com um pedido do agente nem com uma atualização; em Ignorar permissões, com o controlo do computador ligado, o agente também pode clicar.`,
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
      'O modo que escolher dura até fechar o icloneOS e depois volta a Manual: a definição do Porta-chaves está desligada, por isso não pode ser guardado protegido. Para o manter, ligue o Porta-chaves em Definições › Máquina › Gateways › «Guardar as palavras-passe no porta-chaves do sistema».',
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
      short: 'Nunca pergunta',
      summary:
        'Não pergunta nada, incluindo gastar dinheiro, mover iNFTs, enviar chaves, a palavra-passe de administrador e as próprias permissões. Além do confinamento enquanto estiver ligado, ficam cinco verificações: destruir o disco inteiro, a pasta pessoal ou o sistema, um apagamento recursivo cujo alvo inteiro é uma variável ou a saída de um comando que não consegue ler, ou um apagamento recursivo que consiga ler como dirigido ao disco, a uma pasta pessoal ou ao sistema, também quando uma variável deixada vazia o faria, ou por um comando cujo nome não consegue ler, ou um apagamento recursivo cujos alvos ou opções não consegue ler por inteiro, uma chamada ilegível demais para verificar (um patch cujos ficheiros não consegue nomear, uma escrita que não nomeia nenhum ficheiro, ou argumentos que não consegue ler), as regras de recusa que escreveu, e as ferramentas de ficheiros sobre os arquivos do próprio runtime (escrever em state.db, sessões, tokens, emparelhamento, cofre, perfil do browser e o .env do próprio runtime; ler tokens, cofre, perfil do browser, auth.json, auth.lock, esse .env e subscrições de webhooks). O controlo do computador, a gravação do ecrã e o browser correm fora do Seatbelt, e as ferramentas de ficheiros escrevem ficheiros na sua pasta pessoal fora dele, um ficheiro de cada vez.'
    },
    manual: {
      name: 'Manual',
      short: 'Pergunta antes de agir',
      summary:
        'Pergunta antes de cada escrita fora do seu próprio perfil iNFT (SOUL, memórias, a sua pasta) e antes de cada comando, acesso à rede, mensagem, instalação e eliminação. Ler no projeto não pergunta, um ficheiro noutro ponto da pasta pessoal pode perguntar, e um comando confinado só lê uma pasta quando corre nela.'
    },
    automatic: {
      name: 'Automático',
      short: 'Edita, corre comandos seguros',
      summary: 'Escreve no projeto, executa comandos seguros e usa a web sozinho. Para o resto, pergunta.'
    },
    plan: {
      name: 'Plano',
      short: 'Lê e planeia',
      summary:
        'Lê e planeia na conversa. Não altera nada além do seu próprio perfil iNFT (SOUL, memórias, a sua pasta).'
    },
    acceptEdits: {
      name: 'Aceitar edições',
      short: 'Edita sem perguntar',
      summary: 'Edita sozinho os ficheiros do projeto. Para tudo o resto, pergunta.'
    }
  },
  menu: {
    title: 'Esta conversa',
    trigger: (mode: string) => `Modo de permissões desta conversa: ${mode}`,
    triggerNotInForce: (inForce: string, chosen: string) =>
      `Modo de permissões desta conversa: ${inForce}. ${chosen} está escolhido, sem efeito`,
    appliesToSession:
      'Só esta conversa, a partir da próxima mensagem. Predefinição em Definições › Agente › Permissões.',
    appliesToNewChat: 'Só esta nova conversa. Predefinição em Definições › Agente › Permissões.',
    ignoreNote: {
      confined: 'Ainda há cinco recusas. Detalhes nas Definições.',
      unconfined: 'Seatbelt desligado: só cinco verificações da app.'
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
  chosenNotInForce: 'Escolhido, sem efeito',
  choose: 'Usar',
  scope: {
    label: 'Aplica-se a',
    standing: 'Predefinição para novas sessões',
    standingNote:
      'Uma conversa aberta com modo próprio mantém-no; altere-o na barra de mensagem dela. Uma conversa sem modo próprio nem do seu projeto segue esta predefinição.',
    project: (path: string) => `Este projeto · ${path}`,
    noProject: 'Abra um projeto para lhe dar um modo próprio.'
  },
  refused: {
    gesture: 'O modo só muda com um clique nesta app.',
    invalid: 'Este modo não pode ser escolhido aqui.',
    unavailable: `Os modos de permissão precisam da aplicação para computador do ${PRODUCT_NAME}.`
  },
  floor: {
    title: 'O que continua a ser verificado',
    items: [
      'Em todos os modos, incluindo Ignorar permissões, recusa apagar o disco, a sua pasta pessoal ou pastas do sistema, ou formatar uma unidade.',
      'Fora de Ignorar permissões, não pode mover um iNFT, enviar as suas chaves, escrever a palavra-passe de administrador nem alterar as próprias permissões sem a sua resposta, e nenhuma permissão dispensa isso.',
      'Em Ignorar permissões nada pergunta, por isso pode fazer tudo isto.',
      'Estas são verificações na app, não uma barreira no kernel: um programa pode contorná-las.'
    ]
  },
  // V3-F2: the Functions matrix (shared with main's native raise confirm).
  functions: FUNCTION_COPY['pt-PT'],
  // FX-6: what confinement really does (on by default, V3-G); the pane picks the line for the live state.
  shellNote: {
    on: 'O confinamento está ligado e pode desligá-lo. Os comandos do agente são executados confinados (Seatbelt) em todos os modos, incluindo Ignorar permissões: só escrevem no projeto e numa pasta temporária, e só acedem à rede quando o modo ou uma permissão o permite. Um comando de shell que aprove é executado uma vez fora do confinamento.',
    off: 'O confinamento está desligado: os comandos correm em seu nome, em todos os modos, e podem ler e alterar tudo a que tem acesso.',
    // V3-FX M2: main's live verdict is red (on but not working), or not read yet.
    red: 'O confinamento não está a funcionar agora (Contentores mostra porquê): até estar, um comando em qualquer modo pode ler e alterar tudo a que tem acesso.',
    pending: 'A ler o estado do confinamento…'
  },
  grants: {
    title: 'Permissões que concedeu',
    empty: 'Nenhuma. Quando permitir algo por mais do que uma vez, aparece aqui.',
    scope: { session: 'esta conversa', project: 'este projeto', standing: 'em todo o lado' },
    revoke: 'Revogar',
    folderTitle: 'Pasta que permitiu',
    folderHint: 'os comandos podem escrever aqui quando um modo o permite',
    removeFolder: 'Remover'
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
    chainOk: (count: number) => `${count.toLocaleString()} ${count === 1 ? 'registo' : 'registos'} · cadeia intacta`,
    chainBroken: `O registo tem uma falha ou foi alterado fora do ${PRODUCT_NAME}.`,
    chainVerifying: 'A verificar os registos…',
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
      standingIgnore: 'Recusado por uma versão anterior: Ignorar permissões não podia então ser a predefinição',
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
    folderLabel: 'Na pasta',
    expand: 'Mostrar tudo',
    collapse: 'Mostrar menos',
    reasonLabel: 'Porquê, nas palavras do seu agente',
    heldFile:
      'Este é um ficheiro a partir do qual o shell, o git ou o launchd executam, ou guarda chaves. O que o agente escrever aqui pode ser executado mais tarde com o seu acesso. Leia o caminho antes de permitir.',
    outsideFilePatch:
      'Permitir lê este ficheiro e depois escreve-o, fora do Seatbelt. O agente vê as linhas que altera:',
    effects: {
      R: 'Vai ler isto e não altera nada.',
      Wp: 'Vai criar ou alterar este ficheiro dentro do projeto.',
      Wo: 'Vai criar ou alterar este ficheiro fora do projeto. Enquanto o Seatbelt estiver ligado, os ficheiros desta app ficam fechados, e o agente é informado de que deve usar um comando de shell, que lê por inteiro primeiro.',
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
    laterConfined:
      'Só este comando vai para fora. Os comandos seguintes que nenhuma verificação trava correm sem perguntar e ficam dentro do Seatbelt, por isso um que precise de mais é recusado. Revogue isto em Definições › Agente › Permissões para voltar a ser perguntado.',
    heldRead:
      'Este ficheiro ou pasta guarda chaves ou tokens, ou corre a partir da sua shell. Com o Seatbelt desligado nada mais impede: permitir dá ao agente tudo o que lá está, e o que ele lê vai para o modelo.',
    covers: {
      session: (what: string) => `Permite todos os pedidos para ${what} nesta conversa, não só este.`,
      project: (what: string) => `Permite todos os pedidos para ${what} neste projeto, não só este.`,
      standing: (what: string) => `Permite todos os pedidos para ${what}, em todo o lado, até os revogar.`
    },
    deny: 'Recusar',
    allow: 'Permitir',
    expires: 'Sem resposta em dois minutos conta como Recusar.'
  },
  modeReset: {
    standing: (mode: string) =>
      `A sua predefinição voltou a ${mode} porque o registo estava em falta. Escolha-a de novo.`,
    project: (mode: string | null) =>
      mode === null
        ? 'O modo próprio de um projeto foi removido porque o registo estava em falta. Escolha-o de novo.'
        : `O modo de um projeto voltou a ${mode} porque o registo estava em falta. Escolha-o de novo.`,
    session: (mode: string | null) =>
      mode === null
        ? 'O modo próprio de uma conversa foi removido porque o registo estava em falta. Escolha-o de novo.'
        : `O modo de uma conversa voltou a ${mode} porque o registo estava em falta. Escolha-o de novo.`,
    dismiss: 'Fechar'
  },
  approvalPointer: 'À espera da sua permissão — responda no pedido no topo.'
}
