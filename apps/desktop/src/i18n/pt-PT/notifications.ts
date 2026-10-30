import type { TranslationOverrides } from '../define-locale'

export const notifications: TranslationOverrides['notifications'] = {
  region: 'Notificações',
  hide: 'Ocultar',
  show: 'Mostrar',
  more: count => `mais ${count} ${count === 1 ? 'notificação' : 'notificações'}`,
  clearAll: 'Limpar tudo',
  dismiss: 'Dispensar notificação',
  details: 'Detalhes',
  copyDetail: 'Copiar detalhe',
  copyDetailFailed: 'Não foi possível copiar o detalhe da notificação',
  backendOutOfDateTitle: 'Backend desatualizado',
  backendOutOfDateMessage:
    'O backend do seu agente é mais antigo do que esta versão de secretária e pode não funcionar corretamente. Atualize para os alinhar.',
  installMethodUnsupportedTitle: 'Método de instalação não suportado',
  updateHermes: 'Atualizar o agente',
  updateReadyTitle: 'Atualização pronta',
  updateReadyMessage: count =>
    `${count} ${count === 1 ? 'nova alteração disponível' : 'novas alterações disponíveis'}.`,
  updateReadyMessageUnknown: 'Está disponível uma nova atualização.',
  seeWhatsNew: 'Ver as novidades',
  mcp: {
    needsAuthTitle: 'O servidor MCP precisa de nova autenticação',
    needsAuthMessage: name => `O MCP ${name} precisa de nova autenticação.`,
    errorTitle: 'Servidor MCP inacessível',
    errorMessage: name => `O MCP ${name} falhou a verificação de estado.`,
    signIn: 'Iniciar sessão',
    view: 'Ver'
  },
  errors: {
    elevenLabsNeedsKey: 'O STT da ElevenLabs precisa de ELEVENLABS_API_KEY.',
    elevenLabsRejectedKey: 'A ElevenLabs rejeitou a chave de API (401).',
    diskFull: 'Disco cheio — liberte algum espaço e tente novamente.',
    gatewayAuthFailed: 'A autenticação do gateway falhou — verifique a sua API_SERVER_KEY.',
    methodNotAllowed:
      'O backend de secretária rejeitou esse pedido (405 Method Not Allowed). Experimente reiniciar o iclone os.',
    microphonePermission: 'A permissão do microfone foi recusada.',
    openaiRejectedApiKey: 'A OpenAI rejeitou a chave de API.',
    openaiRejectedApiKeyWithStatus: status => `A OpenAI rejeitou a chave de API (${status} invalid_api_key).`,
    openaiTtsNeedsKey: 'O TTS da OpenAI precisa de VOICE_TOOLS_OPENAI_KEY ou OPENAI_API_KEY.'
  },
  voice: {
    configureSpeechToText: 'Configure a conversão de voz em texto para usar o modo de voz.',
    couldNotStartSession: 'Não foi possível iniciar a sessão de voz',
    microphoneAccessDenied: 'Acesso ao microfone recusado.',
    microphoneConstraintsUnsupported: 'As restrições do microfone não são suportadas por este dispositivo.',
    microphoneFailed: 'O microfone falhou',
    microphoneInUse: 'O microfone já está a ser usado por outra aplicação.',
    microphonePermissionDenied: 'A permissão do microfone foi recusada.',
    microphoneStartFailed: 'Não foi possível iniciar a gravação do microfone.',
    microphoneUnsupported: 'Este ambiente de execução não suporta a gravação do microfone.',
    noMicrophone: 'Não foi encontrado nenhum microfone.',
    noSpeechDetected: 'Não foi detetada fala',
    playbackFailed: 'A reprodução de voz falhou',
    recordingFailed: 'A gravação de voz falhou',
    sayStopToEnd: phrase => `Diga "${phrase}" para terminar a conversa de voz.`,
    transcriptionFailed: 'A transcrição de voz falhou',
    transcriptionUnavailable: 'A transcrição de voz ainda não está disponível.',
    tryRecordingAgain: 'Experimente gravar novamente.',
    unavailable: 'Voz indisponível'
  },
  native: {
    approvalTitle: 'Aprovação necessária',
    inputTitle: 'Resposta necessária',
    inputBody: 'O agente está à espera da sua resposta.',
    turnDoneTitle: 'O agente terminou',
    turnDoneBody: '',
    turnErrorTitle: 'O turno falhou',
    backgroundDoneTitle: 'Tarefa em segundo plano concluída',
    backgroundFailedTitle: 'A tarefa em segundo plano falhou',
    creditsTitle: 'Créditos'
  }
}
