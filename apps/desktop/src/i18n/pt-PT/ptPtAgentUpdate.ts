import type { AgentUpdateCopy } from '../en'

/** Settings › Updates › Agent (shape: `AgentUpdateCopy` in ../en). */
export const ptPtAgentUpdate: AgentUpdateCopy = {
  appSection: 'iclone os',
  eyebrow: 'Agente de código aberto',
  title: 'Agente',
  intro:
    'O agente que o iclone os executa. Só muda quando o pedir — o iclone os nunca o verifica nem atualiza por iniciativa própria.',
  installed: 'Instalado',
  latest: 'Mais recente na origem',
  verified: 'Verificado com esta versão',
  newer: 'Mais recente do que a versão verificada',
  compatibility: (verdict: string) => `Compatibilidade: ${verdict}`,
  /** The verdict words a person reads; the engine's RED/AMBER/GREEN/UNKNOWN keys never reach the screen. */
  compatibilityWords: {
    AMBER: 'requer verificação',
    GREEN: 'compatível',
    RED: 'sinalizado',
    UNKNOWN: 'ainda não verificado'
  },
  localChanges: 'A pasta do agente tem alterações locais.',
  unmanagedRuntime: 'Runtime não gerido',
  unknown: 'Desconhecido',
  notChecked: 'Ainda não verificado. O iclone os nunca verifica por iniciativa própria.',
  upToDate: 'Tem o agente mais recente.',
  commitsNewer: (count: number) => (count === 1 ? '1 commit mais recente' : `${count} commits mais recentes`),
  countUnavailable: 'Número de commits indisponível',
  releaseTag: (tag: string) => `Etiqueta da versão mais recente ${tag}`,
  checkedAgo: (age: string) => `Verificado ${age}`,
  justNow: 'agora mesmo',
  minAgo: (count: number) => `há ${count} min`,
  hoursAgo: (count: number) => (count === 1 ? 'há 1 hora' : `há ${count} horas`),
  daysAgo: (count: number) => (count === 1 ? 'há 1 dia' : `há ${count} dias`),
  offline: 'Não foi possível contactar a origem das atualizações. Verifique a ligação e tente novamente.',
  unavailable: 'A origem das atualizações não devolveu nenhuma versão. Tente novamente mais tarde.',
  noRuntime: 'Ainda não há nenhum agente instalado para este perfil.',
  failed: 'A verificação não terminou. Tente novamente.',
  doorClosed: 'Nesta versão, as atualizações do agente chegam com as atualizações da aplicação.',
  noBridge: 'Esta compilação do iclone os não consegue atualizar o agente.',
  check: 'Procurar atualizações',
  checking: 'A verificar…',
  update: (version: string) => `Atualizar para ${version}…`,
  updateLatest: 'Atualizar para o agente mais recente…',
  openUpdates: 'Abrir Atualizações',
  restore: (version: string) => `Repor a versão verificada (${version})`,
  confirmTitle: (version: string) => `Atualizar o agente para ${version}?`,
  confirmTitleLatest: 'Atualizar o agente para a versão mais recente?',
  confirmBackup: 'Primeiro é feita uma cópia de segurança completa do agente e dos seus dados.',
  confirmClose: 'O iclone os fecha.',
  confirmFetch: 'O agente é atualizado a partir do seu repositório oficial. Normalmente demora alguns minutos.',
  confirmReopen: 'O iclone os volta a abrir quando a atualização terminar.',
  confirmWindows:
    'No Windows, o iclone os ainda não consegue atualizar o agente sozinho. Saia do iclone os, execute hermes update --backup num terminal e depois volte a abrir o iclone os.',
  confirmUpdate: 'Atualizar',
  cancel: 'Cancelar',
  restoreTitle: (version: string) => `Reverter o agente para ${version}?`,
  restoreBody:
    'Isto é uma reversão. O agente volta à versão com que esta versão do iclone os foi verificada; as alterações mais recentes do agente são removidas. A janela do atualizador mostra o progresso.',
  restoreConfirm: 'Reverter',
  applying: 'A preparar a atualização — o iclone os fecha dentro de momentos.',
  applyErrors: {
    'app-update-pending':
      'Há uma atualização do iclone os à espera. Reinicie primeiro para a aplicar e depois atualize o agente.',
    bridge: 'Esta compilação do iclone os não consegue atualizar o agente.',
    'door-closed': 'Nesta versão, as atualizações do agente chegam com as atualizações da aplicação.',
    'compat-hold': 'Esta versão do agente precisa de uma revisão de compatibilidade antes de poder ser instalada.',
    failed: 'Não foi possível iniciar a atualização. Tente novamente.',
    gesture: 'Prima Atualizar para confirmar.',
    'handoff-failed': 'Não foi possível iniciar o atualizador. Nada foi alterado.',
    'no-check': 'Procure atualizações primeiro.',
    'no-runtime': 'Ainda não há nenhum agente instalado para este perfil.',
    'origin-mismatch':
      'Este agente não vem do repositório oficial, por isso a versão verificada não pode ser instalada. Nada foi alterado.',
    'preflight-failed': 'A verificação prévia à atualização falhou. Nada foi alterado.',
    'stale-check': 'Surgiu um agente mais recente. A verificar novamente…',
    'unsupported-platform': 'Este sistema ainda não consegue atualizar o agente a partir do iclone os.',
    'updater-running': 'Já está a ser executado um atualizador.'
  },
  reviewCompat: 'Rever compatibilidade',
  reviewTitle: (version: string) => `Rever a compatibilidade de ${version}`,
  reviewTitleLatest: 'Rever a compatibilidade do agente mais recente',
  reviewBody: {
    AMBER:
      'Esta versão altera elementos de que o iclone os depende. Aceite as conclusões abaixo para continuar para a atualização.',
    GREEN: 'Esta versão passou na verificação de compatibilidade. Continue para a atualização.',
    RED: 'Esta versão quebra elementos de que o iclone os depende. Para a instalar mesmo assim, prima e mantenha o botão premido durante 3 segundos para aceitar todas as conclusões abaixo.',
    UNKNOWN:
      'Esta versão não foi verificada com o iclone os. Para a instalar mesmo assim, prima e mantenha o botão premido durante 1,5 segundos.'
  },
  reviewAccept: {
    AMBER: 'Aceitar e continuar',
    GREEN: 'Continuar',
    RED: 'Manter para aceitar',
    UNKNOWN: 'Manter para continuar'
  },
  reviewHolding: 'Continue a premir…',
  reviewRecheck: 'Esta revisão expirou. Procure atualizações novamente para rever esta versão.',
  reviewRefused: 'A revisão não foi aceite. Tente novamente.',
  reviewMore: (count: number) => `+${count} adicionais`,
  lastRefusal: (when: string) =>
    `A sua última atualização (${when}) foi retida pela verificação de compatibilidade. Reveja a compatibilidade antes de atualizar.`,
  lastUpdate: 'Última atualização',
  outcomes: {
    failed: 'Falhou',
    partial: 'Aplicada parcialmente',
    running: 'Não terminou',
    success: 'Atualizado',
    unknown: 'Resultado desconhecido'
  },
  backup: (name: string) => `Cópia de segurança ${name}`,
  noBackup: 'Nenhuma cópia de segurança registada',
  reveal: 'Mostrar',
  tookSeconds: (seconds: number) => (seconds < 90 ? `${seconds} s` : `${Math.round(seconds / 60)} min`),
  compatRed:
    'O agente instalado não está verificado para esta versão do iclone os. Reponha a versão verificada ou procure um agente mais recente.',
  compatFlagged: 'O agente verificado com esta versão foi entretanto sinalizado. Procure um agente mais recente.',
  aboutVerified: (version: string) => `Agente ${version} · verificado`,
  aboutNewer: (version: string) => `Agente ${version} · mais recente do que a versão verificada`,
  aboutFlagged: (version: string) => `Agente ${version} · verificado, depois sinalizado`,
  aboutOpen: 'Atualizações do agente',
  searchLabel: 'Atualizar o agente',
  searchDescription: 'Procurar o agente mais recente no repositório oficial e atualizá-lo, apenas quando clicar.'
}
