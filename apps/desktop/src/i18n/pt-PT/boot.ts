import type { TranslationOverrides } from '../define-locale'

export const boot: TranslationOverrides['boot'] = {
  ready: 'iclone os está pronto',
  desktopBootFailedWithMessage: message => `O arranque do ambiente de trabalho falhou: ${message}`,
  steps: {
    connectingGateway: 'A ligar ao gateway do ambiente de trabalho',
    preparingAgentDependencies: 'A preparar as dependências do agente…',
    loadingSettings: 'A carregar as definições',
    loadingSessions: 'A carregar as sessões recentes',
    retryingRemoteBackend: 'A voltar a ligar ao backend remoto do agente…',
    startingDesktopConnection: 'A iniciar a ligação do ambiente de trabalho',
    startingHermesDesktop: 'A iniciar o iclone os…'
  },
  errors: {
    backgroundExited: 'O processo do agente em segundo plano terminou.',
    backgroundExitedDuringStartup: 'O processo do agente em segundo plano terminou durante o arranque.',
    backendStopped: 'Backend parado',
    desktopBootFailed: 'O arranque do ambiente de trabalho falhou',
    gatewayConnectionLost: 'Perdeu-se a ligação ao gateway',
    gatewayConnectionLostDetail:
      'Continua a tentar em segundo plano. Pode continuar a ler e a escrever rascunhos — abra as definições do gateway se isto persistir.',
    gatewaySignInRequired: 'É necessário iniciar sessão no gateway',
    ipcBridgeUnavailable: 'A ponte IPC do ambiente de trabalho não está disponível.'
  },
  failure: {
    title: 'Não foi possível iniciar o agente',
    description:
      'O gateway em segundo plano não arrancou. Experimente um dos passos de recuperação abaixo. Nada aqui elimina as suas conversas ou definições.',
    remoteTitle: 'É necessário iniciar sessão no gateway remoto',
    remoteDescription:
      'A sua sessão no gateway remoto expirou. Inicie sessão novamente para voltar a ligar. Nada aqui elimina as suas conversas ou definições.',
    retry: 'Tentar novamente',
    repairInstall: 'Reparar instalação',
    useLocalGateway: 'Usar gateway local',
    gatewaySettings: 'Definições do gateway',
    back: 'Voltar',
    openLogs: 'Abrir registos',
    repairHint: 'A reparação volta a executar o instalador e pode demorar alguns minutos numa máquina nova.',
    remoteSignInHint: signInLabel =>
      `Termina a sessão remota guardada no navegador e depois abre ${signInLabel}. Use o gateway local para mudar para o backend incluído.`,
    signOutAndSignIn: 'Terminar e iniciar sessão',
    remoteFailureHint:
      'Verifique o URL do gateway e o início de sessão nas definições do gateway, ou mude para o gateway local.',
    cloudDownTitle: 'O seu agente na nuvem está em baixo',
    cloudDownDescription:
      'O agente gerido na nuvem a que este gateway se liga está a devolver um erro de servidor. Não pode ser reiniciado a partir daqui — verifique o estado, mude para o gateway local ou peça suporte.',
    cloudDownHint:
      'Os botões abaixo abrem o Nous Portal (estado e controlos da instância) e o nosso Discord para suporte.',
    gateTitle: 'O controlo de permissões não está ativo',
    gateDescription:
      'O icloneOS não iniciou o agente: não foi possível instalar ou carregar o controlo de permissões neste runtime do agente, por isso nenhum comando seria verificado. Nada aqui apaga as suas conversas ou definições.',
    gateHint:
      'Tentar novamente volta a verificar o controlo. Reparar instalação reinstala o runtime do agente e depois o controlo. Se a caixa acima disser que o controlo está desativado na configuração, remova primeiro iclone-permissions e iclone-confinement de plugins.disabled no config.yaml do Hermes e depois tente novamente.',
    gateHintUnmanaged:
      'Este runtime do agente não foi instalado pelo icloneOS (por exemplo, a sua própria cópia de trabalho git do Hermes), por isso o icloneOS apenas o verifica e nunca o altera. Reparar instalação instala a cópia verificada do próprio icloneOS na pasta da aplicação; a sua pasta fica como está.',
    cloudDownCheckPortal: 'Ver estado no Portal',
    cloudDownDiscord: 'Pedir ajuda no Discord',
    hideRecentLogs: 'Ocultar registos recentes',
    showRecentLogs: 'Mostrar registos recentes',
    signedInTitle: 'Sessão iniciada',
    signedInMessage: 'A voltar a ligar ao gateway remoto…',
    signInIncompleteTitle: 'Início de sessão incompleto',
    signInIncompleteMessage: 'A janela de início de sessão fechou antes de a autenticação terminar.',
    signInFailed: 'O início de sessão falhou',
    signInToRemoteGateway: 'Iniciar sessão no gateway remoto',
    signInWithProvider: provider => `Iniciar sessão com ${provider}`,
    identityProvider: 'o seu fornecedor de identidade'
  }
}
