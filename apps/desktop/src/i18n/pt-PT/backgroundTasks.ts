import type { TranslationOverrides } from '../define-locale'

export const backgroundTasks: TranslationOverrides['backgroundTasks'] = {
  doorLabel: (active, died) =>
    `Tarefas em segundo plano: ${active} em execução${died > 0 ? `, ${died} ${died === 1 ? 'morreu' : 'morreram'} sem ninguém reparar` : ''}`,
  title: 'Tarefas em segundo plano',
  tabs: { tasks: 'Tarefas', log: 'Registo de permissões' },
  kinds: {
    agent: 'Agente',
    shell: 'Tarefa de shell',
    cron: 'Execução agendada',
    pane: 'Painel iT',
    action: 'Ação do Desktop'
  },
  states: {
    running: 'Em execução',
    waiting: 'À sua espera',
    done: 'Concluído',
    failed: 'Falhou',
    died: 'Morreu',
    stopped: 'Parado'
  },
  endedBy: { owner: 'Parado por si', rewind: 'Removido ao recuar', session: 'A sessão terminou' },
  startUnknown: 'Hora de início desconhecida: a origem não a indica.',
  stop: 'Parar',
  stopping: 'A parar…',
  didNotStop: detail => (detail ? `Não parou — ${detail}` : 'Não parou'),
  cannotConfirm: 'Impossível confirmar',
  retryStop: 'Tentar novamente',
  cannotStop: {
    agent: 'Ainda não é possível parar um subagente a partir daqui.',
    shell: 'Esta tarefa não pode ser parada a partir daqui.',
    cron: 'Uma execução não pode ser parada; pause a tarefa em Tarefas agendadas.',
    pane: 'Pare-a no respetivo painel iT.',
    action: 'Esta ação não pode ser parada a partir daqui.',
    waiting: 'Responda na conversa.'
  },
  dismiss: 'Dispensar',
  showMore: count => `Mostrar mais ${count}`,
  diedBanner: count =>
    count === 1
      ? '1 tarefa morreu enquanto ninguém estava a ver'
      : `${count} tarefas morreram enquanto ninguém estava a ver`,
  exitCode: code => `saída ${code}`,
  signal: name => `terminado por ${name}`,
  noOutput: 'Ainda sem saída',
  emptyTitle: 'Nada em segundo plano',
  emptyText: 'Os agentes, as tarefas de shell e as execuções agendadas que trabalham fora de vista aparecem aqui.',
  loading: 'A ler o trabalho em segundo plano…',
  sourceError: (source, detail) => `Não foi possível ler ${source}: ${detail}`,
  sources: {
    agent: 'Subagentes',
    shell: 'Tarefas de shell',
    cron: 'Tarefas agendadas',
    perm: 'Registo de permissões',
    pane: 'Painéis iT',
    action: 'Ações do Desktop'
  },
  logEmpty: 'Ainda sem decisões de permissão.',
  logUnavailable: 'O registo de permissões não está disponível nesta versão.'
}
