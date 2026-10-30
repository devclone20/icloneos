// iclone os — V3-G confinamento: o painel Contentores do Dock (pt-PT). O processo principal resume o estado; estas
// palavras só o explicam.
import type { ConfinementCopy } from '../en/confinement'

export const confinement: ConfinementCopy = {
  title: 'Contentores',
  tile: 'Contentores',
  unavailable: 'Os contentores funcionam na aplicação para computador, onde o seu agente executa os comandos.',
  loading: 'A ler o que está em execução neste Mac…',
  verdict: {
    green: {
      label: 'Confinado',
      hint: 'Cada comando do agente é executado dentro do respetivo perfil. Enquanto confinado, os servidores MCP, os scripts de tarefas agendadas, a instalação de plugins, competências e pacotes, o controlo do computador, as cópias dos ficheiros antes de editar, as verificações de código depois de editar, as cópias do trabalho delegado e os seus hooks estão desligados; Este Mac volta a ligá-los.'
    },
    red: { label: 'Não confinado', hint: 'O confinamento não está verificado. As razões estão abaixo.' },
    off: {
      label: 'Desligado',
      hint: 'Escolheu Este Mac: os comandos do agente são executados sem confinamento, e os servidores MCP, os scripts de tarefas agendadas, as instalações, o controlo do computador, as cópias dos ficheiros antes de editar, as verificações de código depois de editar, as cópias do trabalho delegado e os seus hooks voltam a funcionar.'
    }
  },
  tabs: { live: 'Ao vivo', agents: 'Agentes', profiles: 'Perfis', refusals: 'Recusas', backends: 'Mecanismos' },
  inside: 'Dentro',
  outside: 'Fora',
  col: { pid: 'PID', profile: 'Perfil', session: 'Sessão', time: 'Tempo', command: 'Comando', kind: 'O quê' },
  kinds: {
    hermes: 'Hermes',
    'agent-command': 'Comando do agente, não confinado',
    tool: 'Ferramenta (servidor MCP, auxiliar)'
  },
  kill: 'Terminar',
  killTip: pid => `Parar ${pid} e tudo o que iniciou`,
  killed: count => (count === 1 ? '1 processo parado' : `${count} processos parados`),
  killFailed: {
    survivors: count =>
      count === 1 ? 'Não foi possível parar 1 processo' : `Não foi possível parar ${count} processos`,
    unverified: () => 'Parou o que conseguia ver, mas não conseguiu perguntar ao macOS se mais alguma parte sobrevive',
    'not-confined': () => 'Não é um processo confinado: nada foi parado',
    invalid: () => 'Não é um processo: nada foi parado'
  },
  why: 'Porquê',
  follow: 'Seguir',
  following: pid => `A seguir ${pid}`,
  stopFollowing: 'Deixar de seguir',
  empty: {
    inside: 'Nenhum comando do agente em execução.',
    outside: 'Nada do seu agente é executado fora.',
    agents: 'Ainda sem atividade do agente.',
    refusals: 'Ainda nada recusado.'
  },
  scope:
    'Confinados: o terminal, a execução de código, as ferramentas de ficheiros e o navegador e os programas de multimédia que o Hermes corre, todos na mesma sandbox. Desligados enquanto confinado: servidores MCP, scripts de tarefas agendadas, instalação de plugins, competências e pacotes, controlo do computador, importação do porta-chaves e comandos locais de reconhecimento de voz.',
  backendName: { seatbelt: 'Seatbelt (macOS)', container: 'Apple container' },
  backendStatus: {
    ready: 'Pronto',
    'not-installed': 'Não instalado',
    installed: 'Instalado',
    unsupported: 'Não existe neste Mac',
    broken: 'Não funciona',
    unknown: 'Não verificado'
  },
  active: 'Ativo',
  network: { grant: 'Rede só com autorização', never: 'Sem rede' },
  reads: 'Leitura',
  writes: 'Escrita',
  never: count => `Nunca: ${count} caminhos de segredos e da aplicação, o porta-chaves`,
  classes: {
    research: { name: 'Pesquisa', summary: 'Lê o projeto, escreve só no respetivo rascunho.' },
    project: { name: 'Projeto', summary: 'Escreve no projeto e no respetivo rascunho.' },
    build: { name: 'Compilação', summary: 'O projeto mais as caches de pacotes.' },
    offline: { name: 'Sem rede', summary: 'O projeto, nunca a rede.' },
    media: { name: 'Multimédia', summary: 'Lê as entradas, escreve numa única pasta de saída.' }
  },
  defaultClass: name => `Predefinido: ${name}`,
  refusal: { operation: 'Recusado', target: 'Alvo', process: 'Processo' },
  unattributed: 'Sem atribuição',
  noSession: 'Sem sessão',
  insideCount: count => `${count} dentro`,
  outsideCount: count => `${count} fora`,
  elapsed: seconds =>
    seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h`,
  reasons: 'Porque está vermelho',
  reason: {
    'backend-not-confining': ({ backend, detail }) =>
      backend === 'container'
        ? 'O Apple container ainda não está a confinar'
        : detail === 'probe-timeout'
          ? 'Não foi possível verificar o Seatbelt a tempo: o confinamento não está verificado neste momento'
          : detail === 'probe-failed'
            ? 'Não foi possível verificar o Seatbelt: a própria verificação falhou, por isso o confinamento não está verificado neste momento'
            : 'O Seatbelt não está a confinar neste Mac',
    'plugin-not-loaded': () =>
      'Shell bloqueada: o confinamento não está carregado. Os comandos do seu agente são recusados até carregar.',
    'profile-changed': ({ cls }) => `O perfil ${cls} foi alterado no disco`,
    'widened-profile': ({ pid }) => `O processo ${pid} é executado com um perfil alargado`,
    'unknown-profile': ({ pid }) => `O processo ${pid} é executado com um perfil que esta aplicação não criou`,
    'agent-command-outside': ({ pid }) => `O comando do agente ${pid} é executado fora do confinamento`,
    'forged-marker': ({ pid }) => `O processo ${pid} afirma estar confinado, mas o macOS diz que não está`,
    'membership-unverified': () =>
      'Não foi possível perguntar ao macOS que processos estão confinados: um processo que saiu da respetiva árvore pode não ser contado',
    'hardlink-appeared': ({ path, pid, root }) =>
      `Apareceu uma ligação física para um ficheiro fora de ${root} durante a execução ${pid} (${path}): só pôde ser encontrada depois da execução, que pode ter chegado a esse ficheiro; a próxima execução aí é recusada até a permitir`,
    'settings-ignored': () =>
      'O ficheiro de definições do confinamento no disco não foi assinado por esta aplicação, por isso foi ignorado: o confinamento continua ativo, com as predefinições'
  },
  notes: 'Nota',
  backendDetail: {
    enforcing: 'A aplicar: um perfil de controlo recusou o respetivo canário.',
    'not-enforcing': 'É executado mas não aplica: o perfil de controlo não recusou o respetivo canário.',
    'cannot-run': 'Não consegue executar um perfil.',
    'binary-missing': 'Falta o sandbox-exec: nada pode ser confinado.',
    'macos-only': 'O Seatbelt só existe no macOS.',
    'needs-apple-silicon': 'O Apple container precisa de Apple silicon e do macOS 26 ou posterior.',
    'no-version': 'Instalado, mas não respondeu à verificação de versão: a instalação parece danificada.',
    'not-installed': 'Não instalado. A instalação é um passo seu, com a sua palavra-passe de administrador, uma vez:',
    'not-wired': 'Não é usado nesta versão: o icloneOS confina os comandos apenas com o Seatbelt.',
    'probe-failed': 'A própria verificação falhou.',
    'probe-timeout':
      'A verificação não terminou a tempo: este Mac pode ter estado ocupado. Volta a ser feita dentro de momentos.'
  },
  hardlinks: {
    blocked: (root, paths, count) =>
      `O confinamento não arranca em ${root}: ${paths.join(', ')}${count > paths.length ? ` e mais ${count - paths.length}` : ''} ${count === 1 ? 'é uma ligação física' : 'são ligações físicas'} para um ficheiro fora do projeto; remova-${count === 1 ? 'a' : 'as'} ou permita-${count === 1 ? 'a' : 'as'} abaixo, por pasta.`,
    cannotScan: (root, paths, count) =>
      `O confinamento não arranca em ${root}: não consegue listar ${paths.join(', ')}${count > paths.length ? ` e mais ${count - paths.length}` : ''}, por isso uma ligação física pode esconder-se aí; dê permissão de leitura a ${count === 1 ? 'essa pasta' : 'essas pastas'} (chmod u+rx).`,
    group: (dir, count) =>
      `${count === 1 ? 'O ficheiro' : `Os ${count} ficheiros`} em ${dir} — ligações físicas para fora do projeto`,
    allow: count => (count === 1 ? 'Permitir este ficheiro' : `Permitir ${count} ficheiros`),
    allowTip:
      'Os comandos podem ler e escrever exatamente estes ficheiros, tal como estão agora, e através deles os ficheiros de fora a que estão ligados; uma nova ligação volta a perguntar',
    allowed: count =>
      count === 1
        ? 'Permitido: este ficheiro, tal como está agora'
        : `Permitidos: estes ${count} ficheiros, tal como estão agora`,
    ackFailed: {
      'no-gesture': 'Não permitido: clique no botão pessoalmente',
      'not-in-project': 'Não permitido: a pasta não está nesse projeto',
      'nothing-to-allow': 'Nada a permitir: já não há nenhuma ligação física nessa pasta',
      changed: 'Não permitido: os ficheiros nessa pasta mudaram desde que foram mostrados; leia-os novamente',
      invalid: 'Não permitido: a pasta já não existe'
    },
    cachesUnscanned:
      'As caches de pacotes (npm, pip, cargo, pnpm…) não são analisadas à procura de ligações físicas: um comando de Compilação pode lê-las e preenchê-las na mesma.'
  }
}
