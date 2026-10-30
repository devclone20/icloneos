import type { TranslationOverrides } from '../define-locale'

export const messaging: TranslationOverrides['messaging'] = {
  search: 'Pesquisar mensagens...',
  loading: 'A carregar as plataformas de mensagens...',
  loadFailed: 'Falha ao carregar as plataformas de mensagens',
  states: {
    connected: 'Ligado',
    connecting: 'A ligar',
    disabled: 'Desativado',
    fatal: 'Erro',
    gateway_stopped: 'Serviço de mensagens parado',
    not_configured: 'Requer configuração',
    pending_restart: 'Reinício necessário',
    retrying: 'A tentar novamente',
    startup_failed: 'Falha no arranque'
  },
  unknown: 'Desconhecido',
  hintPendingRestart: 'Reinicie o serviço de mensagens a partir da barra de estado para aplicar esta alteração.',
  hintGatewayStopped: 'Inicie o serviço de mensagens a partir da barra de estado para ligar.',
  credentialsSet: 'Credenciais definidas',
  needsSetup: 'Requer configuração',
  gatewayStopped: 'Serviço de mensagens parado',
  getCredentials: 'Obter os seus dados de acesso',
  openSetupGuide: 'Abrir guia de configuração',
  required: 'O que é preciso para ligar',
  recommended: 'Vale a pena definir',
  advanced: count => `Avançadas (${count})`,
  noTokenNeeded:
    'Esta plataforma não precisa de um token aqui. Siga o guia de configuração acima e depois ative-a abaixo.',
  enabled: 'Ativado',
  disabled: 'Desativado',
  unsavedChanges: 'Alterações por guardar',
  saving: 'A guardar...',
  saveChanges: 'Guardar alterações',
  saved: 'Guardado',
  replaceValue: 'Substituir o valor atual',
  openDocs: 'Abrir documentação',
  clearField: key => `Limpar ${key}`,
  enableAria: name => `Ativar ${name}`,
  disableAria: name => `Desativar ${name}`,
  platformEnabled: name => `${name} ativado`,
  platformDisabled: name => `${name} desativado`,
  restartToApply: 'Esta alteração entra em vigor depois de o serviço de mensagens reiniciar.',
  setupSaved: name => `Configuração de ${name} guardada`,
  restartToReconnect: 'Os novos dados de acesso entram em vigor depois de o serviço de mensagens reiniciar.',
  keyCleared: key => `${key} limpo`,
  setupUpdated: name => `A configuração de ${name} foi atualizada.`,
  failedUpdate: name => `Falha ao atualizar ${name}`,
  failedSave: name => `Falha ao guardar ${name}`,
  failedClear: key => `Falha ao limpar ${key}`,
  pendingRequests: count => `Pedidos pendentes (${count})`,
  pendingAria: count =>
    `${count} ${count === 1 ? 'pedido de emparelhamento pendente' : 'pedidos de emparelhamento pendentes'}`,
  approvedUsers: count => `Utilizadores aprovados (${count})`,
  approve: 'Aprovar',
  approving: 'A aprovar...',
  revoke: 'Revogar',
  revoking: 'A revogar...',
  revokeAria: name => `Revogar ${name}`,
  revokeTitle: 'Revogar acesso',
  revokeDesc: (name: string) => `${name} perderá o acesso e deixará de ser reconhecido na próxima mensagem.`,
  approvedUser: name => `${name} aprovado`,
  approvedHint: 'Será reconhecido automaticamente na próxima mensagem.',
  revokedUser: name => `${name} revogado`,
  failedApprove: name => `Falha ao aprovar ${name}`,
  failedRevoke: name => `Falha ao revogar ${name}`,
  pairingLockedOut: 'Demasiadas aprovações falhadas — esta plataforma está bloqueada. Tente novamente mais tarde.',
  waitingSince: minutes => (minutes < 1 ? 'agora mesmo' : `há ${minutes} min`),
  fieldFallbackLabel: 'Preencha esta definição',
  fieldFallbackName: 'Esta definição',
  fieldCopy: {
    TELEGRAM_BOT_TOKEN: {
      label: 'Cole o token que o seu bot do Telegram lhe dá',
      name: 'Token do bot',
      help: 'Crie um bot com o @BotFather e depois cole o token que ele lhe dá.',
      placeholder: 'Colar o token do bot do Telegram'
    },
    TELEGRAM_ALLOWED_USERS: {
      label: 'Escolha quem pode falar com o seu agente',
      name: 'IDs de utilizador do Telegram permitidos',
      help: 'Recomendado. IDs numéricos separados por vírgulas, obtidos no @userinfobot. Sem isto, qualquer pessoa pode enviar mensagens diretas ao seu bot.'
    },
    TELEGRAM_PROXY: {
      label: 'Introduza o endereço de um proxy se o Telegram estiver bloqueado',
      name: 'URL do proxy',
      help: 'Só é necessário em redes onde o Telegram está bloqueado.'
    },
    DISCORD_BOT_TOKEN: {
      label: 'Cole o token do seu bot do Discord',
      name: 'Token do bot',
      help: 'Crie uma aplicação no Discord Developer Portal, adicione um bot e depois cole o token dele.'
    },
    DISCORD_ALLOWED_USERS: {
      label: 'Escolha quem pode falar com o seu agente',
      name: 'IDs de utilizador do Discord permitidos',
      help: 'Recomendado. IDs de utilizador do Discord separados por vírgulas.'
    },
    DISCORD_REPLY_TO_MODE: {
      label: 'Escolha como as respostas aparecem no Discord',
      name: 'Estilo de resposta',
      help: 'first, all ou off.'
    },
    DISCORD_ALLOW_ALL_USERS: {
      label: 'Permitir todos os utilizadores do Discord',
      name: 'Permitir todos os utilizadores do Discord',
      help: 'Apenas para desenvolvimento. Quando true, qualquer pessoa pode enviar mensagens diretas ao bot sem lista de permissões.'
    },
    DISCORD_HOME_CHANNEL: {
      label: 'Introduza o ID do canal onde o seu agente reporta',
      name: 'ID do canal principal',
      help: 'Canal onde o bot envia mensagens proativas (resultados de tarefas agendadas, lembretes).'
    },
    DISCORD_HOME_CHANNEL_NAME: {
      label: 'Introduza o nome do canal onde o seu agente reporta',
      name: 'Nome do canal principal',
      help: 'Nome apresentado do canal principal nos registos e no estado.'
    },
    BLUEBUBBLES_ALLOW_ALL_USERS: {
      label: 'Permitir todos os utilizadores do iMessage',
      name: 'Permitir todos os utilizadores do iMessage',
      help: 'Quando true, ignora a lista de permissões do BlueBubbles.'
    },
    MATTERMOST_ALLOW_ALL_USERS: {
      label: 'Permitir todos os utilizadores do Mattermost',
      name: 'Permitir todos os utilizadores do Mattermost'
    },
    MATTERMOST_HOME_CHANNEL: { label: 'Introduza o canal onde o seu agente reporta', name: 'Canal principal' },
    QQ_ALLOW_ALL_USERS: { label: 'Permitir todos os utilizadores do QQ', name: 'Permitir todos os utilizadores do QQ' },
    QQBOT_HOME_CHANNEL: {
      label: 'Introduza o canal do QQ onde o seu agente reporta',
      name: 'Canal principal do QQ',
      help: 'Canal ou grupo predefinido para a entrega das tarefas agendadas.'
    },
    QQBOT_HOME_CHANNEL_NAME: {
      label: 'Introduza o nome do canal do QQ onde o seu agente reporta',
      name: 'Nome do canal principal do QQ'
    },
    SLACK_BOT_TOKEN: {
      label: 'Cole o token de bot da sua aplicação do Slack',
      name: 'Token de bot do Slack',
      help: 'Use o token de bot de OAuth & Permissions depois de instalar a sua aplicação do Slack.',
      placeholder: 'Colar o token de bot do Slack'
    },
    SLACK_APP_TOKEN: {
      label: 'Cole o token de nível de aplicação da sua aplicação do Slack',
      name: 'Token de aplicação do Slack',
      help: 'Use o token de nível de aplicação exigido pelo Socket Mode.',
      placeholder: 'Colar o token de aplicação do Slack'
    },
    SLACK_ALLOWED_USERS: {
      label: 'Escolha quem pode falar com o seu agente',
      name: 'IDs de utilizador do Slack permitidos',
      help: 'Recomendado. IDs de utilizador do Slack separados por vírgulas.'
    },
    MATTERMOST_URL: {
      label: 'Introduza o endereço do seu servidor Mattermost',
      name: 'URL do servidor',
      placeholder: 'https://mattermost.example.com'
    },
    MATTERMOST_TOKEN: { label: 'Cole o token do seu bot do Mattermost', name: 'Token do bot' },
    MATTERMOST_ALLOWED_USERS: {
      label: 'Escolha quem pode falar com o seu agente',
      name: 'IDs de utilizador permitidos',
      help: 'Recomendado. IDs de utilizador do Mattermost separados por vírgulas.'
    },
    MATRIX_HOMESERVER: {
      label: 'Introduza o endereço do seu homeserver Matrix',
      name: 'URL do homeserver',
      placeholder: 'https://matrix.org'
    },
    MATRIX_ACCESS_TOKEN: { label: 'Cole o token de acesso da conta do bot', name: 'Token de acesso' },
    MATRIX_USER_ID: {
      label: 'Introduza o ID Matrix da conta do bot',
      name: 'ID de utilizador do bot',
      placeholder: '@agent:example.org'
    },
    MATRIX_ALLOWED_USERS: {
      label: 'Escolha quem pode falar com o seu agente',
      name: 'IDs de utilizador do Matrix permitidos',
      help: 'Recomendado. IDs de utilizador separados por vírgulas, no formato @utilizador:servidor.'
    },
    SIGNAL_HTTP_URL: {
      label: 'Introduza o endereço da sua ponte do Signal',
      name: 'URL da ponte do Signal',
      placeholder: 'http://127.0.0.1:8080',
      help: 'URL de uma ponte REST signal-cli em execução.'
    },
    SIGNAL_ACCOUNT: {
      label: 'Introduza o número de telefone que o seu agente usa no Signal',
      name: 'Número de telefone',
      help: 'O número registado na sua ponte signal-cli.'
    },
    SIGNAL_ALLOWED_USERS: {
      label: 'Escolha quem pode falar com o seu agente',
      name: 'Utilizadores do Signal permitidos',
      help: 'Recomendado. Identificadores do Signal separados por vírgulas.'
    },
    WHATSAPP_ENABLED: {
      label: 'Ativar a ponte do WhatsApp',
      name: 'Ativar a ponte do WhatsApp',
      help: 'Definido automaticamente pelo interruptor abaixo. Não altere, a menos que saiba que precisa.'
    },
    WHATSAPP_MODE: { label: 'Escolha como o WhatsApp se liga', name: 'Modo da ponte' },
    WHATSAPP_ALLOWED_USERS: {
      label: 'Escolha quem pode falar com o seu agente',
      name: 'Utilizadores do WhatsApp permitidos',
      help: 'Recomendado. Números de telefone ou IDs do WhatsApp separados por vírgulas.'
    },
    A2A_AGENT_NAME: { label: 'Introduza o nome que os outros agentes veem', name: 'Nome visto pelos outros agentes' },
    A2A_BEARER_TOKEN: {
      label: 'Cole o token que os outros agentes têm de apresentar',
      name: 'Token de acesso dos outros agentes'
    },
    A2A_HOST: { label: 'Introduza o endereço em que o seu agente escuta', name: 'Endereço de escuta' },
    A2A_PEER_TOKENS: { label: 'Cole os tokens dos agentes em que confia', name: 'Tokens dos agentes de confiança' },
    A2A_PORT: { label: 'Introduza a porta em que o seu agente escuta', name: 'Porta de escuta' },
    API_SERVER_ENABLED: { label: 'Ativar', name: 'Ativar' },
    API_SERVER_HOST: { label: 'Introduza o endereço em que o seu agente escuta', name: 'Endereço de escuta' },
    API_SERVER_KEY: { label: 'Cole a chave que as outras aplicações têm de usar', name: 'Chave de acesso' },
    API_SERVER_MODEL_NAME: {
      label: 'Introduza o nome que as outras aplicações veem',
      name: 'Nome visto pelas outras aplicações'
    },
    API_SERVER_PORT: { label: 'Introduza a porta em que o seu agente escuta', name: 'Porta de escuta' },
    BLUEBUBBLES_ALLOWED_USERS: {
      label: 'Escolha quem pode falar com o seu agente',
      name: 'Pessoas autorizadas a falar com ele'
    },
    BLUEBUBBLES_PASSWORD: {
      label: 'Cole a palavra-passe do seu servidor BlueBubbles',
      name: 'Palavra-passe do servidor'
    },
    BLUEBUBBLES_SERVER_URL: {
      label: 'Introduza o endereço do seu servidor BlueBubbles',
      name: 'Endereço do servidor'
    },
    BUZZ_ALLOWED_USERS: {
      label: 'Escolha quem pode falar com o seu agente',
      name: 'Pessoas autorizadas a falar com ele'
    },
    BUZZ_AUTH_TAG: { label: 'Introduza a etiqueta com que o seu agente inicia sessão', name: 'Etiqueta de acesso' },
    BUZZ_CHANNELS: { label: 'Escolha os canais em que o seu agente entra', name: 'Canais a que aderir' },
    BUZZ_CLI_PATH: { label: 'Introduza onde está instalado o programa Buzz', name: 'Localização do programa Buzz' },
    BUZZ_CREDENTIALS_FILE: { label: 'Introduza onde está o ficheiro de credenciais', name: 'Ficheiro de credenciais' },
    BUZZ_POLL_INTERVAL: {
      label: 'Defina com que frequência o seu agente verifica se há mensagens',
      name: 'Frequência de verificação de mensagens'
    },
    BUZZ_PRIVATE_KEY: { label: 'Cole a chave privada da sua conta Buzz', name: 'Chave privada' },
    BUZZ_RELAY_URL: { label: 'Introduza o endereço do relay', name: 'Endereço do relay' },
    BUZZ_TRANSPORT: { label: 'Escolha como o seu agente se liga', name: 'Modo de ligação' },
    DINGTALK_ALLOWED_USERS: {
      label: 'Escolha quem pode falar com o seu agente',
      name: 'Pessoas autorizadas a falar com ele'
    },
    DINGTALK_CLIENT_ID: { label: 'Introduza o ID de cliente da sua aplicação DingTalk', name: 'ID de cliente' },
    DINGTALK_CLIENT_SECRET: {
      label: 'Cole o segredo de cliente da sua aplicação DingTalk',
      name: 'Segredo de cliente'
    },
    DINGTALK_WEBHOOK_URL: { label: 'Introduza o endereço do robô do grupo', name: 'Endereço do robô do grupo' },
    EMAIL_ADDRESS: { label: 'Introduza o endereço de e-mail que o seu agente usa', name: 'Endereço de e-mail' },
    EMAIL_ALLOWED_USERS: {
      label: 'Escolha que endereços podem escrever ao seu agente',
      name: 'Endereços autorizados a escrever-lhe'
    },
    EMAIL_IMAP_HOST: { label: 'Introduza o servidor que recebe o seu correio', name: 'Servidor de receção' },
    EMAIL_PASSWORD: { label: 'Cole a palavra-passe da caixa de correio', name: 'Palavra-passe da caixa de correio' },
    EMAIL_SMTP_HOST: { label: 'Introduza o servidor que envia o seu correio', name: 'Servidor de envio' },
    EMAIL_SMTP_PORT: { label: 'Introduza a porta do servidor de envio', name: 'Porta de envio' },
    FEISHU_ALLOWED_USERS: {
      label: 'Escolha quem pode falar com o seu agente',
      name: 'Pessoas autorizadas a falar com ele'
    },
    FEISHU_APP_ID: { label: 'Introduza o ID da sua aplicação Feishu', name: 'ID da aplicação' },
    FEISHU_APP_SECRET: { label: 'Cole o segredo da sua aplicação Feishu', name: 'Segredo da aplicação' },
    FEISHU_DOMAIN: { label: 'Escolha entre Feishu e Lark', name: 'Feishu ou Lark' },
    FEISHU_ENCRYPT_KEY: { label: 'Cole a chave que encripta os eventos', name: 'Chave de encriptação de eventos' },
    FEISHU_VERIFICATION_TOKEN: {
      label: 'Cole o token que verifica os eventos',
      name: 'Token de verificação de eventos'
    },
    GOOGLE_CHAT_ALLOWED_USERS: {
      label: 'Escolha quem pode falar com o seu agente',
      name: 'Pessoas autorizadas a falar com ele'
    },
    GOOGLE_CHAT_HTTP_EVENTS_AUDIENCE: {
      label: 'Introduza a quem os eventos se destinam',
      name: 'Destinatário dos eventos'
    },
    GOOGLE_CHAT_HTTP_EVENTS_SERVICE_ACCOUNT_EMAIL: {
      label: 'Introduza a conta de serviço que envia os eventos',
      name: 'Conta de serviço que envia os eventos'
    },
    GOOGLE_CHAT_HTTP_EVENTS_URL: {
      label: 'Introduza o endereço para onde o Google Chat envia os eventos',
      name: 'Endereço de destino dos eventos do Google Chat'
    },
    GOOGLE_CHAT_PROJECT_ID: {
      label: 'Introduza o ID do seu projeto Google Cloud',
      name: 'ID do projeto Google Cloud'
    },
    GOOGLE_CHAT_SERVICE_ACCOUNT_JSON: {
      label: 'Introduza onde está o ficheiro da conta de serviço',
      name: 'Ficheiro da conta de serviço'
    },
    GOOGLE_CHAT_SUBSCRIPTION_NAME: {
      label: 'Introduza a subscrição Pub/Sub que o seu agente lê',
      name: 'Subscrição Pub/Sub'
    },
    HASS_TOKEN: {
      label: 'Cole um token de acesso de longa duração do Home Assistant',
      name: 'Token de acesso de longa duração'
    },
    HASS_URL: { label: 'Introduza o endereço do seu Home Assistant', name: 'Endereço do Home Assistant' },
    IRC_ALLOWED_USERS: {
      label: 'Escolha quem pode falar com o seu agente',
      name: 'Pessoas autorizadas a falar com ele'
    },
    IRC_CHANNEL: { label: 'Introduza o canal em que o seu agente entra', name: 'Canal a que aderir' },
    IRC_NICKNAME: { label: 'Introduza a alcunha que o seu agente usa', name: 'Alcunha' },
    IRC_NICKSERV_PASSWORD: { label: 'Cole a palavra-passe dessa alcunha', name: 'Palavra-passe da alcunha' },
    IRC_PORT: { label: 'Introduza a porta do servidor IRC', name: 'Porta do servidor' },
    IRC_SERVER: { label: 'Introduza o endereço do servidor IRC', name: 'Endereço do servidor' },
    IRC_SERVER_PASSWORD: { label: 'Cole a palavra-passe do servidor IRC', name: 'Palavra-passe do servidor' },
    IRC_USE_TLS: { label: 'Usar uma ligação encriptada', name: 'Usar uma ligação encriptada' },
    LINE_ALLOWED_GROUPS: {
      label: 'Escolha que grupos podem falar com o seu agente',
      name: 'Grupos autorizados a falar com ele'
    },
    LINE_ALLOWED_ROOMS: {
      label: 'Escolha que salas podem falar com o seu agente',
      name: 'Salas autorizadas a falar com ele'
    },
    LINE_ALLOWED_USERS: {
      label: 'Escolha quem pode falar com o seu agente',
      name: 'Pessoas autorizadas a falar com ele'
    },
    LINE_CHANNEL_ACCESS_TOKEN: {
      label: 'Cole o token de acesso do seu canal LINE',
      name: 'Token de acesso do canal'
    },
    LINE_CHANNEL_SECRET: { label: 'Cole o segredo do seu canal LINE', name: 'Segredo do canal' },
    LINE_HOST: { label: 'Introduza o endereço em que o seu agente escuta', name: 'Endereço de escuta' },
    LINE_PORT: { label: 'Introduza a porta em que o seu agente escuta', name: 'Porta de escuta' },
    LINE_PUBLIC_URL: {
      label: 'Introduza o endereço público para onde o LINE envia as mensagens',
      name: 'Endereço público de destino do LINE'
    },
    LINE_SLOW_RESPONSE_THRESHOLD: {
      label: 'Defina quantos segundos passam até ele avisar que ainda está a trabalhar',
      name: 'Segundos até avisar que ainda está a trabalhar'
    },
    MATRIX_DEVICE_ID: { label: 'Introduza o ID do dispositivo da conta do bot', name: 'ID do dispositivo' },
    MATRIX_PASSWORD: { label: 'Cole a palavra-passe da conta do bot', name: 'Palavra-passe' },
    MATRIX_RECOVERY_KEY: {
      label: 'Cole a chave de recuperação das salas encriptadas',
      name: 'Chave de recuperação das salas encriptadas'
    },
    NTFY_ALLOWED_USERS: {
      label: 'Escolha quem pode falar com o seu agente',
      name: 'Pessoas autorizadas a falar com ele'
    },
    NTFY_MARKDOWN: { label: 'Formatar as respostas com Markdown', name: 'Formatar as respostas com Markdown' },
    NTFY_PUBLISH_TOPIC: { label: 'Introduza o tópico em que o seu agente responde', name: 'Tópico de resposta' },
    NTFY_SERVER_URL: { label: 'Introduza o endereço do seu servidor ntfy', name: 'Endereço do servidor' },
    NTFY_TOKEN: { label: 'Cole o token de acesso do seu servidor ntfy', name: 'Token de acesso' },
    NTFY_TOPIC: { label: 'Introduza o tópico que o seu agente escuta', name: 'Tópico de escuta' },
    PHOTON_ALLOWED_USERS: {
      label: 'Escolha quem pode falar com o seu agente',
      name: 'Pessoas autorizadas a falar com ele'
    },
    PHOTON_DASHBOARD_HOST: { label: 'Introduza o endereço do painel', name: 'Endereço do painel' },
    PHOTON_MARKDOWN: { label: 'Formatar as respostas com Markdown', name: 'Formatar as respostas com Markdown' },
    PHOTON_MENTION_PATTERNS: {
      label: 'Escolha as palavras que chamam o seu agente num grupo',
      name: 'Palavras que o chamam num grupo'
    },
    PHOTON_NODE_BIN: { label: 'Introduza onde está instalado o Node.js', name: 'Localização do Node.js' },
    PHOTON_PROJECT_ID: { label: 'Introduza o ID do seu projeto Photon', name: 'ID do projeto' },
    PHOTON_PROJECT_SECRET: { label: 'Cole o segredo do seu projeto Photon', name: 'Segredo do projeto' },
    PHOTON_REACTIONS: { label: 'Reagir às mensagens', name: 'Reagir às mensagens' },
    PHOTON_SIDECAR_AUTOSTART: {
      label: 'Iniciar o programa auxiliar automaticamente',
      name: 'Iniciar o programa auxiliar automaticamente'
    },
    PHOTON_SIDECAR_PORT: { label: 'Introduza a porta do programa auxiliar', name: 'Porta do programa auxiliar' },
    PHOTON_SPECTRUM_HOST: { label: 'Introduza o endereço do Spectrum', name: 'Endereço do Spectrum' },
    PHOTON_TELEMETRY: {
      label: 'Partilhar dados de utilização com a Photon',
      name: 'Partilhar dados de utilização com a Photon'
    },
    QQ_ALLOWED_USERS: {
      label: 'Escolha quem pode falar com o seu agente',
      name: 'Pessoas autorizadas a falar com ele'
    },
    QQ_APP_ID: { label: 'Introduza o ID da sua aplicação QQ', name: 'ID da aplicação' },
    QQ_CLIENT_SECRET: { label: 'Cole o segredo de cliente da sua aplicação QQ', name: 'Segredo de cliente' },
    QQ_GROUP_ALLOWED_USERS: {
      label: 'Escolha que grupos podem falar com o seu agente',
      name: 'Grupos autorizados a falar com ele'
    },
    QQ_SANDBOX: { label: 'Usar o ambiente de testes', name: 'Usar o ambiente de testes' },
    RAFT_PROFILE: {
      label: 'Escolha o perfil de espaço de trabalho que o seu agente usa',
      name: 'Perfil do espaço de trabalho'
    },
    SIMPLEX_ALLOWED_USERS: {
      label: 'Escolha quem pode falar com o seu agente',
      name: 'Pessoas autorizadas a falar com ele'
    },
    SIMPLEX_AUTO_ACCEPT: {
      label: 'Aceitar novos contactos automaticamente',
      name: 'Aceitar novos contactos automaticamente'
    },
    SIMPLEX_GROUP_ALLOWED: { label: 'Deixá-lo responder em grupos', name: 'Deixá-lo responder em grupos' },
    SIMPLEX_WS_URL: { label: 'Introduza o endereço do programa SimpleX', name: 'Endereço do programa SimpleX' },
    TEAMS_ALLOWED_USERS: {
      label: 'Escolha quem pode falar com o seu agente',
      name: 'Pessoas autorizadas a falar com ele'
    },
    TEAMS_CLIENT_ID: { label: 'Introduza o ID de cliente da sua aplicação Teams', name: 'ID de cliente' },
    TEAMS_CLIENT_SECRET: { label: 'Cole o segredo de cliente da sua aplicação Teams', name: 'Segredo de cliente' },
    TEAMS_HOST: { label: 'Introduza o endereço em que o seu agente escuta', name: 'Endereço de escuta' },
    TEAMS_PORT: { label: 'Introduza a porta em que o seu agente escuta', name: 'Porta de escuta' },
    TEAMS_TENANT_ID: { label: 'Introduza o ID do seu inquilino Microsoft', name: 'ID do inquilino' },
    TWILIO_ACCOUNT_SID: { label: 'Introduza o SID da sua conta Twilio', name: 'SID da conta' },
    TWILIO_AUTH_TOKEN: { label: 'Cole o token de autenticação da sua conta Twilio', name: 'Token de autenticação' },
    TWILIO_PHONE_NUMBER: {
      label: 'Introduza o número de telefone que envia as SMS',
      name: 'Número de telefone de envio de SMS'
    },
    WEBHOOK_ENABLED: { label: 'Ativar', name: 'Ativar' },
    WEBHOOK_PORT: { label: 'Introduza a porta em que o seu agente escuta', name: 'Porta de escuta' },
    WEBHOOK_SECRET: { label: 'Cole o segredo que assina cada pedido', name: 'Segredo de assinatura' },
    WECOM_BOT_ID: { label: 'Cole a chave do robô do grupo', name: 'Chave do robô do grupo' },
    WECOM_CALLBACK_AGENT_ID: { label: 'Introduza o ID de agente da sua aplicação WeCom', name: 'ID de agente' },
    WECOM_CALLBACK_CORP_ID: { label: 'Introduza o ID da sua empresa', name: 'ID da empresa' },
    WECOM_CALLBACK_CORP_SECRET: { label: 'Cole o segredo da sua aplicação WeCom', name: 'Segredo da aplicação' },
    WECOM_CALLBACK_ENCODING_AES_KEY: {
      label: 'Cole a chave que encripta as mensagens',
      name: 'Chave de encriptação das mensagens'
    },
    WECOM_CALLBACK_TOKEN: { label: 'Cole o token do callback', name: 'Token do callback' },
    WECOM_SECRET: { label: 'Cole o segredo da sua aplicação WeCom', name: 'Segredo da aplicação' },
    WEIXIN_ACCOUNT_ID: { label: 'Introduza o ID da sua conta Weixin', name: 'ID da conta' },
    WEIXIN_BASE_URL: { label: 'Introduza o endereço do servidor', name: 'Endereço do servidor' },
    WEIXIN_TOKEN: { label: 'Cole o token de acesso da sua conta Weixin', name: 'Token de acesso' },
    WHATSAPP_DM_POLICY: {
      label: 'Escolha quem pode enviar mensagens diretas ao seu agente',
      name: 'Quem lhe pode enviar mensagens diretas'
    }
  },
  platformIntro: {
    api_server:
      'Defina uma chave de acesso e depois aponte o Open WebUI, o LobeChat ou qualquer aplicação ao estilo OpenAI para o endereço apresentado.',
    bluebubbles:
      'Execute o BlueBubbles Server num Mac com sessão iniciada no iMessage. Depois introduza o endereço e a palavra-passe do servidor.',
    dingtalk:
      'Crie uma aplicação DingTalk na consola de programador. Depois copie para aqui o ID de cliente e o segredo de cliente.',
    discord:
      'No Discord Developer Portal, crie uma aplicação, adicione um bot e copie o token dele. Depois convide o bot para o seu servidor.',
    email:
      'Use uma caixa de correio só para o seu agente. No Gmail, crie uma palavra-passe de aplicação e use os servidores de correio do Gmail.',
    feishu:
      'Crie uma aplicação Feishu ou Lark com a funcionalidade de bot ativada. Depois copie o ID da aplicação, o segredo da aplicação e as chaves de eventos.',
    homeassistant:
      'No Home Assistant, abra o seu perfil e crie um token de acesso de longa duração. Cole-o aqui com o endereço do seu Home Assistant.',
    matrix:
      'Inicie sessão no seu homeserver com a conta do bot. Depois copie o token de acesso, o ID de utilizador e o endereço do homeserver.',
    mattermost:
      'No seu servidor Mattermost, crie uma conta de bot ou um token de acesso pessoal. Depois cole aqui o endereço do servidor e o token.',
    qqbot: 'Registe uma aplicação na QQ Open Platform. Depois copie o ID da aplicação e o segredo de cliente.',
    signal:
      'Execute uma ponte do Signal num local acessível a este computador. Depois introduza o endereço dela e o número de telefone registado.',
    slack:
      'Crie uma aplicação do Slack, ative o Socket Mode e instale-a no seu espaço de trabalho. Depois copie o token de bot e o token de aplicação.',
    sms: 'Na consola da Twilio, copie o SID da conta e o token de autenticação, e escolha um número de telefone que possa enviar SMS.',
    telegram:
      'No Telegram, envie uma mensagem ao @BotFather, crie um novo bot e copie o token que ele lhe dá. Depois obtenha o seu ID de utilizador numérico no @userinfobot.',
    webhook:
      'Outros serviços enviam eventos para o endereço apresentado. Use o segredo para confirmar que cada um é genuíno.',
    wecom:
      'Adicione um robô de grupo no WeCom e copie a chave de webhook dele. Só pode enviar; escolha WeCom (aplicação) para comunicar nos dois sentidos.',
    wecom_callback:
      'Configure a sua própria aplicação WeCom com um endereço de callback. Depois introduza o ID da empresa, o segredo, o ID de agente e a chave AES.',
    weixin:
      'Ative a plataforma e confirme o código QR com a sua conta pessoal do WeChat. A sessão fica guardada para a próxima vez.',
    whatsapp: 'Ative a plataforma e leia o código QR com o WhatsApp na primeira ligação.'
  },
  platformSummary: {
    a2a: 'Permite que outros agentes falem diretamente com o seu agente.',
    api_server: 'Permite que outras aplicações de conversa usem o seu agente como se fosse um modelo da OpenAI.',
    bluebubbles: 'Fale com o seu agente no iMessage através de um servidor BlueBubbles.',
    buzz: 'Fale com o seu agente através do Buzz.',
    dingtalk: 'Fale com o seu agente em grupos do DingTalk.',
    discord: 'Fale com o seu agente em mensagens, canais e threads do Discord.',
    email: 'Escreva ao seu agente por e-mail e receba as respostas dele.',
    feishu: 'Fale com o seu agente no Feishu ou no Lark.',
    google_chat: 'Fale com o seu agente no Google Chat.',
    homeassistant: 'Permite que o seu agente controle a sua casa inteligente através do Home Assistant.',
    irc: 'Fale com o seu agente num canal IRC ou em mensagens privadas.',
    line: 'Fale com o seu agente no LINE.',
    matrix: 'Fale com o seu agente em salas e mensagens diretas do Matrix.',
    mattermost: 'Fale com o seu agente em canais e mensagens diretas do Mattermost.',
    msgraph_webhook: 'Permite que o Microsoft 365 informe o seu agente sobre novas reuniões e e-mails.',
    ntfy: 'Fale com o seu agente através de notificações ntfy.',
    photon: 'Fale com o seu agente no iMessage através do serviço gerido da Photon.',
    qqbot: 'Fale com o seu agente através de um bot do QQ.',
    raft: 'Permite que o seu agente se junte a um espaço de trabalho Raft.',
    relay: 'Ligue o seu agente através de um serviço de relay, ainda em testes.',
    signal: 'Fale com o seu agente no Signal através de uma ponte do Signal gerida por si.',
    simplex: 'Fale com o seu agente em privado no SimpleX Chat.',
    slack: 'Fale com o seu agente no Slack, apenas com os membros que autorizar.',
    sms: 'Envie SMS ao seu agente e receba respostas por SMS através da Twilio.',
    teams: 'Fale com o seu agente em conversas do Microsoft Teams.',
    telegram: 'Fale com o seu agente em conversas, grupos e tópicos do Telegram.',
    webhook: 'Permite que o GitHub, o GitLab e outros serviços enviem eventos ao seu agente.',
    wecom: 'Permite que o seu agente publique num grupo do WeCom, sem respostas.',
    wecom_callback: 'Fale com o seu agente nos dois sentidos no WeCom através da sua própria aplicação.',
    weixin: 'Fale com o seu agente a partir de uma conta pessoal do WeChat.',
    whatsapp: 'Fale com o seu agente no WhatsApp depois de ler um código QR uma vez.',
    whatsapp_cloud: 'Fale com o seu agente através do serviço WhatsApp alojado pela Meta.',
    yuanbao: 'Fale com o seu agente no Tencent Yuanbao.'
  },
  noPlatforms: 'Nenhuma plataforma de mensagens encontrada',
  noMatch: query => `Nenhuma plataforma corresponde a “${query}”`,
  draftSecretNotKept: 'Não foi guardado no rascunho — escreva-o novamente:'
}
