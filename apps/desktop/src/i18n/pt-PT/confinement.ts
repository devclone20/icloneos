// iclone os — V3-G confinamento: o painel Contentores do Dock (pt-PT). O processo principal resume o estado; estas
// palavras só o explicam.
import { type ConfinementCopy, confinement as english } from '../en/confinement'

export const confinement: ConfinementCopy = {
  title: 'Contentores',
  tile: 'Contentores',
  unavailable: 'Os contentores funcionam na aplicação para computador, onde o seu agente executa os comandos.',
  verdict: {
    green: {
      label: 'Confinado',
      hint: 'Cada comando do agente é executado dentro do respetivo perfil, exceto um comando de shell que aprove, que é executado uma vez fora dele. O que um comando confinado tenta fora é bloqueado e fica listado em Refusals. Enquanto confinado, os servidores MCP, os scripts de tarefas agendadas, a instalação de plugins, competências e pacotes, as cópias dos ficheiros antes de editar, as verificações de código depois de editar, as cópias do trabalho delegado e os seus hooks ficam desligados. O controlo do computador, depois de o autorizar, é executado fora do perfil através do controlador assinado, e pergunta em todos os modos exceto Ignorar permissões. Pode desligar o isolamento em Backends ou em Definições › Agente › Permissões; a app pergunta primeiro.'
    },
    red: { label: 'Não confinado', hint: 'O confinamento não está verificado. As razões estão abaixo.' },
    off: {
      label: 'Desligado',
      hint: 'O confinamento está desligado: os comandos do agente são executados sem confinamento, e os servidores MCP, os scripts de tarefas agendadas, as instalações, as cópias dos ficheiros antes de editar, as verificações de código depois de editar, as cópias do trabalho delegado e os seus hooks voltam a funcionar.'
    }
  },
  kinds: {
    hermes: 'Runtime do agente',
    'agent-command': 'Comando do agente, não confinado',
    tool: 'Ferramenta (servidor MCP, auxiliar)',
    runtime: english.kinds.runtime
  },
  killed: count => (count === 1 ? '1 processo parado' : `${count} processos parados`),
  killFailed: {
    survivors: count =>
      count === 1 ? 'Não foi possível parar 1 processo' : `Não foi possível parar ${count} processos`,
    unverified: () => 'Parou o que conseguia ver, mas não conseguiu perguntar ao macOS se mais alguma parte sobrevive',
    'not-confined': () => 'Não é um processo confinado: nada foi parado',
    invalid: () => 'Não é um processo: nada foi parado'
  },
  scope:
    'Confinados: o terminal, a execução de código, as ferramentas de ficheiros e os programas de multimédia, cada um dentro do seu perfil. Desligados enquanto confinado: servidores MCP, scripts de tarefas agendadas, instalação de plugins, competências e pacotes, importação do porta-chaves e comandos locais de reconhecimento de voz. O controlo do computador, depois de o autorizar, é executado fora do perfil através do controlador assinado, e pergunta em todos os modos exceto Ignorar permissões. O navegador e a gravação de ecrã também são executados fora do perfil, quando o modo o permite. Com «Navegação na web e chamadas de rede» ligada, o navegador pergunta em Manual e Aceitar edições, funciona sem perguntar em Automático e, em Plano, abre e lê páginas sem perguntar. Com o respetivo interruptor ligado, a gravação de ecrã pergunta em todos os modos exceto Plano, que a recusa. Em Ignorar permissões, nenhum dos dois pergunta.',
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
    'agent-config-unreadable': () =>
      'Não foi possível ler o config.yaml, por isso nenhum terminal.backend nele foi aplicado. Os comandos continuam a correr na sandbox. Corrija o ficheiro e reinicie.',
    'membership-unverified': () =>
      'Não foi possível perguntar ao macOS que processos estão confinados: um processo que saiu da respetiva árvore pode não ser contado',
    'hardlink-appeared': ({ path, pid, root }) =>
      `Apareceu uma ligação física para um ficheiro fora de ${root} durante a execução ${pid} (${path}): só pôde ser encontrada depois da execução, que pode ter chegado a esse ficheiro; a próxima execução aí é recusada até a permitir`,
    'runtime-not-confined': english.reason['runtime-not-confined'],
    'runtime-not-running': english.reason['runtime-not-running'],
    'launcher-down': english.reason['launcher-down'],
    'agent-commands-unavailable': english.reason['agent-commands-unavailable'],
    'settings-ignored': () =>
      'O ficheiro de definições do confinamento no disco não foi assinado por esta aplicação, por isso foi ignorado: o confinamento continua ativo, com as predefinições'
  },
  notes: 'Nota',
  backendEnforcingOff: 'Um perfil de controlo recusou o respetivo canário.',
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
  firstScan: dirs =>
    dirs === 1
      ? 'A verificar a pasta do projeto… 1 pasta'
      : `A verificar a pasta do projeto… ${dirs.toLocaleString('pt-PT')} pastas`,
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
    showAll: (count: number) => `Mostrar todos (${count.toLocaleString('pt-PT')})`,
    showMore: (left: number) => `Mostrar mais ${left.toLocaleString('pt-PT')}`,
    showFewer: 'Mostrar menos',
    cachesUnscanned:
      'As caches de pacotes (npm, pip, cargo, pnpm…) não são analisadas à procura de ligações físicas: um comando de Compilação pode lê-las e preenchê-las na mesma.'
  },
  // The run ledger's words are English in every locale until the translation pass: the app ships in English.
  ledger: english.ledger
}
