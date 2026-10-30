import { defineFieldCopy } from '@/app/settings/field-copy'

export const fieldLabels = defineFieldCopy({
  'browser.headed': 'Ver o seu agente a navegar numa janela visível',
  'browser.recordSessions': 'Guardar uma gravação do que o seu agente fez no navegador',
  'browser.engine': 'Que navegador o seu agente controla',
  model: 'Modelo predefinido',
  modelContextLength: 'Quanto da conversa o seu agente tem presente',
  fallbackProviders: 'Quem responde quando o modelo principal está em baixo',
  toolsets: 'Que conjuntos de ferramentas o seu agente pode usar',
  timezone: 'Por que relógio o seu agente se rege',
  display: {
    personality: 'A personagem com que o seu agente começa novas conversas',
    showReasoning: 'Mostrar como o seu agente chegou à resposta'
  },
  desktop: {
    repoScanEnabled: 'Encontrar os seus projetos neste computador por si',
    repoScanRoots: 'Onde procurar esses projetos',
    repoScanExcludePaths: 'Pastas a ignorar durante a procura'
  },
  agent: {
    maxTurns: 'Quantos passos o seu agente dá antes de parar e reportar',
    imageInputMode: 'Como as imagens que anexa chegam ao modelo',
    apiMaxRetries: 'Quantas vezes tentar novamente quando o modelo não responde',
    serviceTier: 'Se paga por velocidade prioritária do modelo',
    toolUseEnforcement: 'Com que rigor o seu agente tem de usar as ferramentas'
  },
  terminal: {
    cwd: 'A pasta onde o seu agente trabalha por predefinição',
    backend: 'Onde os comandos do seu agente são realmente executados',
    timeout: 'Quanto tempo um comando pode correr antes de ser parado',
    persistentShell: 'Manter um terminal ativo entre comandos',
    envPassthrough: 'Que definições da sua máquina as ferramentas do agente podem ver',
    dockerImage: 'A imagem Docker onde esses comandos correm',
    singularityImage: 'A imagem Singularity onde esses comandos correm',
    modalImage: 'A imagem Modal onde esses comandos correm',
    daytonaImage: 'A imagem Daytona onde esses comandos correm'
  },
  fileReadMaxChars: 'Quanto de um ficheiro o seu agente lê de cada vez',
  toolOutput: {
    maxBytes: 'Quanta saída de um comando o seu agente lê',
    maxLines: 'Quantas linhas de um ficheiro o seu agente lê de uma vez',
    maxLineLength: 'Que comprimento uma linha pode ter antes de ser cortada'
  },
  codeExecution: {
    mode: 'Até onde, fora do projeto atual, o seu agente pode executar código'
  },
  approvals: {
    mode: 'Quando o seu agente tem de lhe perguntar antes de agir',
    timeout: 'Quanto tempo um pedido de permissão espera por si',
    mcpReloadConfirm: 'Perguntar antes de recarregar as ferramentas ligadas'
  },
  commandAllowlist: 'Comandos que o seu agente pode executar sem perguntar',
  security: {
    redactSecrets: 'Ocultar as suas palavras-passe e chaves do modelo',
    allowPrivateUrls: 'Permitir que o seu agente abra endereços da sua própria rede'
  },
  browser: {
    allowPrivateUrls: 'Permitir que o seu agente abra endereços da sua própria rede',
    autoLocalForPrivateUrls: 'Usar o navegador deste computador para os seus endereços privados',
    useRealProfile: 'Navegar como si, já com sessão iniciada nos seus sites'
  },
  checkpoints: {
    enabled: 'Guardar uma cópia de cada ficheiro antes de o agente o editar',
    maxSnapshots: 'Quantas dessas cópias de ficheiros são mantidas'
  },
  voice: {
    recordKey: 'A tecla que mantém premida para falar',
    maxRecordingSeconds: 'Quanto tempo pode durar uma gravação',
    autoTts: 'Ler cada resposta em voz alta automaticamente',
    clientDirect: 'Enviar a sua voz diretamente deste computador, para a resposta mais rápida'
  },
  stt: {
    enabled: 'Permitir que a aplicação converta o que diz em texto',
    echoTranscripts: 'Mostrar o que ditou na conversa, palavra por palavra',
    provider: 'Quem faz a escuta',
    local: {
      model: 'Com que cuidado este computador ouve quando trabalha sem ligação',
      language: 'Em que idioma está a ditar'
    },
    openai: {
      model: 'Que motor da OpenAI faz a escuta'
    },
    groq: {
      model: 'Que motor da Groq faz a escuta'
    },
    mistral: {
      model: 'Que motor da Mistral faz a escuta'
    },
    elevenlabs: {
      modelId: 'Que motor da ElevenLabs faz a escuta',
      languageCode: 'Que idioma a ElevenLabs deve esperar',
      tagAudioEvents: 'Marcar risos e ruídos na transcrição',
      diarize: 'Distinguir quem fala na transcrição'
    }
  },
  tts: {
    provider: 'Que voz lê as respostas em voz alta',
    edge: {
      voice: 'Que voz do Edge fala'
    },
    openai: {
      model: 'Que motor de voz da OpenAI fala',
      voice: 'Que voz da OpenAI fala'
    },
    elevenlabs: {
      voiceId: 'Que voz da ElevenLabs fala',
      modelId: 'Que motor da ElevenLabs fala'
    },
    xai: {
      voiceId: 'Que voz do Grok fala',
      language: 'Que idioma essa voz fala',
      speed: 'A que velocidade essa voz fala',
      autoSpeechTags: 'Deixar a voz acrescentar risos e suspiros onde fizer sentido',
      optimizeStreamingLatency: 'Falar mais cedo, ou falar melhor',
      sampleRate: 'Que detalhe tem o áudio falado',
      bitRate: 'Que tamanho atingem os ficheiros de áudio falado'
    },
    minimax: {
      model: 'Que motor da MiniMax fala',
      voiceId: 'Que voz da MiniMax fala'
    },
    mistral: {
      model: 'Que motor da Mistral fala',
      voiceId: 'Que voz da Mistral fala'
    },
    gemini: {
      model: 'Que motor do Gemini fala',
      voice: 'Que voz do Gemini fala'
    },
    neutts: {
      model: 'Que motor do NeuTTS fala',
      device: 'Se o NeuTTS fala com a placa gráfica ou com o processador'
    },
    kittentts: {
      model: 'Que motor do KittenTTS fala',
      voice: 'Que voz do KittenTTS fala'
    },
    piper: {
      voice: 'Que voz do Piper fala'
    },
    deepinfra: {
      model: 'Que motor da DeepInfra fala',
      voice: 'Que voz da DeepInfra fala'
    }
  },
  memory: {
    memoryEnabled: 'Permitir que o seu agente se lembre de coisas entre conversas',
    userProfileEnabled: 'Permitir que o seu agente guarde uma nota curta sobre como gosta de trabalhar',
    memoryCharLimit: 'Quanto o seu agente pode memorizar',
    userCharLimit: 'Que tamanho pode ter essa nota sobre si',
    provider: 'Onde essas memórias são guardadas'
  },
  context: {
    engine: 'O que o seu agente faz quando uma conversa fica longa demais'
  },
  compression: {
    enabled: 'Resumir a parte mais antiga de uma conversa longa em vez de a descartar',
    threshold: 'Quão cheia fica uma conversa antes de ser resumida',
    targetRatio: 'Quão curto deve ficar o resumo',
    protectLastN: 'Quantas mensagens recentes nunca são resumidas'
  },
  delegation: {
    model: 'Que modelo usam os ajudantes do seu agente',
    provider: 'Quem executa esses ajudantes',
    maxIterations: 'Quantos passos dá cada ajudante',
    maxConcurrentChildren: 'Quantos ajudantes trabalham ao mesmo tempo',
    childTimeoutSeconds: 'Quanto tempo um ajudante pode trabalhar antes de ser parado',
    reasoningEffort: 'Com que profundidade esses ajudantes pensam'
  },
  updates: {
    nonInteractiveLocalChanges: 'O que acontece às suas alterações quando a aplicação se atualiza'
  }
})

export const fieldDescriptions = defineFieldCopy({
  'delegation.reasoningEffort': 'Pensar mais a fundo dá melhores respostas, mas demora mais e custa mais.',
  'delegation.childTimeoutSeconds': 'Medido em segundos.',
  'delegation.maxConcurrentChildren': 'Mais ajudantes terminam mais cedo, mas custam mais de uma só vez.',
  'delegation.maxIterations': 'Um ajudante termina quando atinge este número de passos.',
  'delegation.provider': 'Deixe vazio para usar o seu fornecedor principal.',
  'delegation.model': 'Deixe vazio para usar o seu modelo principal.',
  'toolOutput.maxLineLength': 'As linhas muito longas são encurtadas para não sufocarem o resto.',
  'toolOutput.maxLines': 'O seu agente pode pedir a parte seguinte quando precisar de mais.',
  'toolOutput.maxBytes': 'A saída mais longa é cortada, o que mantém as conversas rápidas e económicas.',
  toolsets: 'Desativar um conjunto remove essas ferramentas de todas as conversas.',
  commandAllowlist: 'Cada comando desta lista é executado sem pedido de aprovação.',
  model: 'Usado em novas conversas, a menos que escolha outro modelo no compositor.',
  modelContextLength: 'Deixe em 0 para usar a janela de contexto detetada do modelo selecionado.',
  fallbackProviders: 'Se o seu modelo principal deixar de responder, o seu agente tenta estes por ordem.',
  display: {
    personality: 'O tom com que o seu agente começa cada nova conversa.',
    showReasoning: 'Mostra como o modelo pensou numa resposta, quando o modelo o partilha.'
  },
  desktop: {
    repoScanEnabled: 'As suas pastas são analisadas à procura de projetos de código para listar em Projetos.',
    repoScanRoots: 'Pastas a analisar. Deixe vazio para analisar a sua pasta pessoal.',
    repoScanExcludePaths: 'Pastas ignoradas na procura de projetos, incluindo tudo o que contêm.'
  },
  timezone: 'O seu fuso horário, como Europe/Lisbon. Deixe em branco para usar o fuso horário do sistema.',
  browser: {
    engine: 'Alguns navegadores não conseguem capturar o ecrã das páginas que abrem.',
    autoLocalForPrivateUrls: 'As páginas da sua própria rede abrem num navegador deste computador e não num remoto.',
    allowPrivateUrls: 'Inclui o seu router, impressoras e outros dispositivos em casa ou no trabalho.',
    recordSessions: 'É guardado um vídeo de cada sessão de navegação para o poder rever mais tarde.',
    headed: 'Abre-se uma janela para que possa ver cada página que o seu agente visita.',
    useRealProfile:
      'O seu agente navega com uma cópia das sessões iniciadas do seu navegador; o seu próprio perfil nunca é aberto. Funciona com Chrome, Edge e Brave.'
  },
  agent: {
    toolUseEnforcement:
      'Uma definição mais rigorosa impede o seu agente de adivinhar quando uma ferramenta daria a resposta real.',
    serviceTier: 'Respostas mais rápidas do modelo, faturadas a uma tarifa mais alta onde o fornecedor o oferece.',
    apiMaxRetries: 'Cada nova tentativa espera um pouco mais do que a anterior.',
    imageInputMode: 'Como as imagens que anexa são encaminhadas.',
    maxTurns: 'O máximo de passos de ferramentas que o seu agente dá antes de parar uma execução.'
  },
  terminal: {
    timeout: 'Medido em segundos.',
    backend: 'O seu computador por predefinição, ou um contentor ou máquina remota que configurar.',
    cwd: 'Pasta de projeto predefinida para o trabalho das ferramentas e do terminal.',
    persistentShell: 'As pastas e definições de um comando passam para o seguinte.',
    envPassthrough: 'Definições do seu computador que os comandos do seu agente podem ver.',
    dockerImage: 'Usada apenas quando os comandos do seu agente correm no Docker.',
    singularityImage: 'Usada apenas quando os comandos do seu agente correm no Singularity.',
    modalImage: 'Usada apenas quando os comandos do seu agente correm no Modal.',
    daytonaImage: 'Usada apenas quando os comandos do seu agente correm no Daytona.'
  },
  codeExecution: {
    mode: 'Até onde, fora do projeto atual, o código do seu agente pode chegar.'
  },
  fileReadMaxChars: 'O máximo de caracteres que o seu agente lê de um ficheiro de cada vez.',
  approvals: {
    mcpReloadConfirm: 'O seu agente pergunta-lhe primeiro antes de reiniciar as ferramentas que ligou.',
    mode: 'O que o seu agente faz quando um comando precisa da sua autorização.',
    timeout: 'Quanto tempo um pedido de autorização espera antes de contar como um não.'
  },
  security: {
    allowPrivateUrls: 'Inclui o seu router, impressoras e outros dispositivos em casa ou no trabalho.',
    redactSecrets: 'As palavras-passe e chaves que aparecem no que o seu agente lê ficam ocultas para ele.'
  },
  checkpoints: {
    maxSnapshots: 'A cópia mais antiga é removida quando é feita uma nova.',
    enabled:
      'É guardada uma cópia de cada ficheiro antes de o seu agente o alterar, para poder voltar atrás. Desligado enquanto o agente está confinado: escolha Este Mac em Contentores para o usar.'
  },
  memory: {
    provider: 'A memória integrada funciona sem configuração.',
    userCharLimit: 'Uma nota mais longa lembra-se de mais preferências suas e custa um pouco mais por mensagem.',
    memoryCharLimit: 'Quando o limite é atingido, as memórias mais antigas são condensadas para dar espaço.',
    memoryEnabled: 'O seu agente guarda o que aprendeu para a próxima conversa.',
    userProfileEnabled: 'O seu agente guarda uma nota curta sobre como gosta de trabalhar.'
  },
  context: {
    engine: 'Como o seu agente arranja espaço quando uma conversa longa já não cabe.'
  },
  compression: {
    protectLastN: 'Estas mensagens são sempre mantidas palavra por palavra.',
    targetRatio: 'Um resumo mais curto deixa mais espaço, mas mantém menos detalhes.',
    threshold:
      'As conversas longas são resumidas para que o seu agente continue a trabalhar dentro do limite do modelo.',
    enabled: 'As partes mais antigas de uma conversa longa são resumidas para que o seu agente possa continuar.'
  },
  voice: {
    autoTts: 'O seu agente lê as respostas em voz alta.',
    recordKey: 'Atalho de teclado que inicia e para o ditado a partir do compositor.',
    maxRecordingSeconds: 'Uma gravação para sozinha ao fim deste número de segundos.',
    clientDirect:
      'Quando ativado, esta aplicação envia o áudio diretamente para os seus serviços de voz em vez de passar pelo seu agente — o caminho mais rápido nos dois sentidos. Mantenha-o ativado, a menos que este dispositivo não os consiga alcançar diretamente.'
  },
  tts: {
    'deepinfra.model': 'O modelo de voz que lê as respostas em voz alta.',
    'kittentts.model': 'O modelo de voz que lê as respostas em voz alta.',
    'gemini.model': 'O modelo de voz que lê as respostas em voz alta.',
    'mistral.model': 'O modelo de voz que lê as respostas em voz alta.',
    'minimax.model': 'O modelo de voz que lê as respostas em voz alta.',
    'elevenlabs.modelId': 'O modelo de voz que lê as respostas em voz alta.',
    'openai.model': 'O modelo de voz que lê as respostas em voz alta.',
    'deepinfra.voice': 'A voz com que o seu agente fala.',
    'piper.voice': 'A voz com que o seu agente fala.',
    'kittentts.voice': 'A voz com que o seu agente fala.',
    'gemini.voice': 'A voz com que o seu agente fala.',
    'mistral.voiceId': 'A voz com que o seu agente fala.',
    'minimax.voiceId': 'A voz com que o seu agente fala.',
    'elevenlabs.voiceId': 'A voz com que o seu agente fala.',
    'openai.voice': 'A voz com que o seu agente fala.',
    'edge.voice': 'A voz com que o seu agente fala.',
    provider:
      'O Edge é gratuito e não precisa de chave. A ElevenLabs é a opção paga mais rápida. As restantes são vozes na nuvem ou totalmente offline.',
    xai: {
      voiceId: 'O nome de uma voz, como eve, ou uma das suas próprias vozes.',
      language: 'Um código de idioma, como en ou pt-PT, ou auto para o detetar.',
      speed: 'Use 1.0 para a velocidade normal, menos para abrandar, mais para acelerar.',
      autoSpeechTags: 'O modelo acrescenta indicações como risos e suspiros antes de falar.',
      optimizeStreamingLatency: 'Use 0 para o melhor som ou 2 para a resposta mais rápida.',
      sampleRate: 'Valores mais altos soam melhor e geram ficheiros maiores.',
      bitRate: 'Aplica-se apenas a áudio MP3; valores mais altos soam melhor.'
    },
    neutts: {
      model: 'O modelo de voz que lê as respostas em voz alta.',
      device: 'A parte do seu computador que gera a voz.'
    }
  },
  stt: {
    'mistral.model': 'O modelo que converte a sua fala em texto.',
    'groq.model': 'O modelo que converte a sua fala em texto.',
    'openai.model': 'O modelo que converte a sua fala em texto.',
    enabled: 'Ativar a transcrição de voz local ou através de um fornecedor.',
    echoTranscripts: 'Depois de enviar uma mensagem de voz, a respetiva transcrição aparece na conversa.',
    provider:
      'Deixe por definir e o seu agente escolhe um: o reconhecimento de voz do seu computador quando estiver disponível; caso contrário, um serviço na nuvem para o qual tenha uma chave.',
    local: {
      language: 'Deixe vazio para detetar o idioma automaticamente.',
      model: 'Os modelos maiores são mais precisos, mas mais lentos; base é um bom equilíbrio.'
    },
    elevenlabs: {
      modelId: 'O modelo que converte a sua fala em texto.',
      diarize: 'Cada interlocutor recebe uma etiqueta na transcrição.',
      tagAudioEvents: 'Os sons, como risos, aparecem entre parênteses retos.',
      languageCode: 'Código de idioma ISO-639-3 opcional. Em branco, a ElevenLabs deteta-o automaticamente.'
    }
  },
  updates: {
    nonInteractiveLocalChanges:
      'Quando o seu agente se atualiza a partir da aplicação, pode manter ou descartar as alterações que fez aos ficheiros dele. As atualizações iniciadas a partir de um terminal perguntam sempre.'
  }
})
