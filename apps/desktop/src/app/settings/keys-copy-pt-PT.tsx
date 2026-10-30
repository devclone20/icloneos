import type { KeysCopy } from './keys-copy'

// Settings › Keys and Providers › API keys in European Portuguese; the shape and the rules live in keys-copy.tsx.
export const keysCopyPtPt: KeysCopy = {
  kinds: {
    anotherKey: ['Usar outra chave para este fornecedor', 'Só é necessário se a primeira chave não for a que usa.'],
    cloudProfile: ['Escolher o perfil da nuvem com que inicia sessão', ''],
    credentialsFile: ['Indicar o seu ficheiro de credenciais', ''],
    other: ['Alterar uma definição extra deste fornecedor', ''],
    region: ['Escolher onde os seus pedidos são processados', ''],
    serverAddress: ['Usar outro endereço de servidor', 'Deixe vazio para usar o endereço habitual do fornecedor.']
  },
  lessFields: 'Menos definições',
  pasteKey: 'Cole aqui a sua chave',
  apiKeyProviders: {
    anthropic: [
      'Usar a sua própria chave da Anthropic',
      'Cole uma chave da Anthropic Console. Não é preciso iniciar sessão no navegador.'
    ]
  },
  providers: {
    'AWS Bedrock': 'Modelos na nuvem da Amazon, faturados na sua conta AWS.',
    'Actual Computer': 'Modelos servidos pela Actual Computer.',
    'Alibaba Cloud (Coding Plan)': 'Modelos de programação Qwen no plano de programação da Alibaba Cloud.',
    Anthropic: 'Modelos Claude, diretamente da Anthropic.',
    'Arcee AI': 'Modelos pequenos e eficientes da Arcee AI.',
    'Azure Foundry': 'Modelos implementados na sua conta Microsoft Azure.',
    CommandCode: 'Modelos de programação servidos pela CommandCode.',
    'DashScope (Qwen)': 'Modelos Qwen da Alibaba Cloud.',
    DeepInfra: 'Modelos abertos a preços baixos na DeepInfra.',
    DeepSeek: 'Modelos de conversa e de raciocínio da DeepSeek.',
    'Fireworks AI': 'Modelos abertos rápidos servidos pela Fireworks AI.',
    'GLM / Z.AI': 'Modelos GLM da Z.AI.',
    'GMI Cloud': 'Modelos abertos nas GPU da GMI Cloud.',
    Gemini: 'Modelos Gemini com uma chave do Google AI Studio.',
    'GitHub Copilot': 'Modelos incluídos no seu plano GitHub Copilot.',
    'Google AI Studio': 'Modelos Gemini com uma chave do Google AI Studio.',
    'Google Vertex AI': 'Modelos Gemini e de parceiros no seu projeto Google Cloud.',
    'Hugging Face': 'Modelos abertos através da Hugging Face.',
    HuggingFace: 'Modelos abertos através da Hugging Face.',
    'Kilo Code': 'Modelos através da sua conta Kilo Code.',
    'Kimi (China)': 'Modelos Kimi servidos na China continental.',
    'Kimi / Kimi Coding Plan': 'Modelos Kimi da Moonshot AI, incluindo o plano de programação.',
    'Kimi / Moonshot': 'Modelos Kimi da Moonshot AI.',
    'Kimi / Moonshot (China)': 'Modelos Kimi servidos na China continental.',
    'LM Studio': 'Modelos a correr no seu próprio computador com o LM Studio.',
    'Meta Model API': 'Modelos Llama, diretamente da Meta.',
    MiniMax: 'Modelos de contexto longo da MiniMax.',
    'MiniMax (China)': 'Modelos MiniMax servidos na China continental.',
    'NVIDIA NIM': 'Modelos alojados pela NVIDIA.',
    'Nous Portal': 'Modelos treinados pela Nous Research.',
    NovitaAI: 'Modelos abertos a preços baixos na Novita AI.',
    'Ollama Cloud': 'Modelos abertos na nuvem do Ollama.',
    'OpenAI API': 'Modelos GPT, diretamente da OpenAI.',
    'OpenCode Go': 'Modelos através do seu plano OpenCode Go.',
    'OpenCode Zen': 'Modelos escolhidos e testados pelo OpenCode Zen.',
    OpenRouter: 'Centenas de modelos com uma só chave.',
    'Qwen Cloud': 'Modelos Qwen da Alibaba Cloud.',
    StepFun: 'Modelos Step da StepFun.',
    'StepFun Step Plan': 'Modelos Step da StepFun.',
    'Tencent TokenHub': 'Modelos servidos pelo Tencent TokenHub.',
    'Upstage Solar': 'Modelos Solar da Upstage.',
    'Vercel AI Gateway': 'Muitos fornecedores com uma só chave Vercel.',
    'Xiaomi MiMo': 'Modelos MiMo da Xiaomi.',
    'Z.AI (GLM)': 'Modelos GLM da Z.AI.',
    xAI: 'Modelos Grok, diretamente da xAI.'
  },
  vars: {
    AGENT_BROWSER_ENGINE: [
      'Escolher o motor do navegador local',
      'Automático usa o Chrome. O Lightpanda é mais rápido, mas não tira capturas de ecrã.'
    ],
    BRAVE_SEARCH_API_KEY: ['Pesquisar na web com o Brave', 'O plano gratuito cobre cerca de 2000 pesquisas por mês.'],
    BROWSERBASE_API_KEY: [
      'Navegar na nuvem com o Browserbase',
      'Opcional. O navegador deste computador funciona sem isto.'
    ],
    BROWSERBASE_PROJECT_ID: [
      'Indicar ao Browserbase que projeto usar',
      'Só é necessário se navegar na nuvem com o Browserbase.'
    ],
    BROWSER_USE_API_KEY: [
      'Navegar na nuvem com o Browser Use',
      'Opcional. O navegador deste computador funciona sem isto.'
    ],
    BRV_API_KEY: [
      'Sincronizar a memória com a nuvem através do ByteRover',
      'Opcional. A memória fica neste computador até adicionar uma chave.'
    ],
    CAMOFOX_API_KEY: [
      'Iniciar sessão no seu navegador Camofox remoto',
      'Só é necessário se o seu servidor Camofox pedir uma chave.'
    ],
    CAMOFOX_URL: [
      'Navegar com o Camofox para que os sites o bloqueiem menos',
      'O endereço do seu servidor Camofox, normalmente neste computador.'
    ],
    ELEVENLABS_API_KEY: ['Falar e transcrever com o ElevenLabs', 'Vozes premium para fala e transcrição precisa.'],
    EXA_API_KEY: [
      'Pesquisar na web com o Exa',
      'Pesquisa feita para agentes, com o conteúdo das páginas nos resultados.'
    ],
    FAL_KEY: ['Criar imagens e vídeos com o fal', ''],
    FIRECRAWL_API_KEY: [
      'Pesquisar e ler sites com o Firecrawl',
      'Permite ao seu agente pesquisar na web e ler páginas inteiras.'
    ],
    FIRECRAWL_API_URL: ['Usar o seu próprio servidor Firecrawl', 'Opcional. Só para um Firecrawl alojado por si.'],
    FIRECRAWL_BROWSER_TTL: [
      'Escolher quanto tempo uma sessão do navegador Firecrawl fica aberta',
      'Em segundos. Cinco minutos se ficar vazio.'
    ],
    FIRECRAWL_GATEWAY_URL: [
      'Enviar os pedidos do Firecrawl por outro endereço de subscritor',
      'Só para subscritores do Nous Portal. Deixe vazio, salvo pedido do suporte.'
    ],
    GATEWAY_ALLOW_ALL_USERS: [
      'Deixar qualquer pessoa falar com os seus bots de mensagens',
      'Desativado por predefinição, para que só as pessoas que permitir os contactem.'
    ],
    GATEWAY_PROXY_KEY: [
      'Iniciar sessão no servidor que responde às suas mensagens',
      'Tem de corresponder à chave definida nesse servidor.'
    ],
    GATEWAY_PROXY_URL: [
      'Encaminhar as suas mensagens para outro servidor de agente',
      'Quando definido, é esse servidor que responde às suas mensagens em vez deste computador.'
    ],
    GITHUB_TOKEN: [
      'Ligar o GitHub para encontrar e publicar competências',
      'Aumenta os limites que o GitHub impõe quando o seu agente explora e publica competências.'
    ],
    HERMES_EPHEMERAL_SYSTEM_PROMPT: [
      'Adicionar instruções a cada pedido sem as guardar',
      'Enviadas com cada pedido e nunca guardadas nas suas conversas.'
    ],
    HERMES_LANGFUSE_BASE_URL: ['Usar o seu próprio servidor Langfuse', 'Deixe vazio para usar o Langfuse Cloud.'],
    HERMES_LANGFUSE_PUBLIC_KEY: [
      'Acompanhar o trabalho do seu agente passo a passo no Langfuse',
      'A chave pública do seu projeto Langfuse.'
    ],
    HERMES_LANGFUSE_SECRET_KEY: [
      'Deixar o seu agente registar os passos no Langfuse',
      'A chave secreta do seu projeto Langfuse.'
    ],
    HERMES_PREFILL_MESSAGES_FILE: [
      'Mostrar ao seu agente mensagens de exemplo de um ficheiro',
      'Enviadas antes de cada conversa e nunca guardadas.'
    ],
    HINDSIGHT_API_KEY: [
      'Dar ao seu agente uma memória duradoura com o Hindsight',
      'Uma memória que acompanha a forma como as coisas se ligam.'
    ],
    HINDSIGHT_API_URL: ['Usar outro servidor Hindsight', 'Deixe vazio para usar o serviço Hindsight alojado.'],
    HONCHO_API_KEY: [
      'Dar ao seu agente uma memória duradoura com o Honcho',
      'Uma memória que aprende sobre si ao longo do tempo.'
    ],
    HONCHO_BASE_URL: ['Usar o seu próprio servidor Honcho', 'Um Honcho alojado por si não precisa de chave.'],
    KEENABLE_API_KEY: [
      'Pesquisar na web rapidamente com o Keenable',
      'Opcional. O Keenable também funciona sem chave.'
    ],
    KREA_API_KEY: ['Criar imagens com o Krea', ''],
    MEM0_API_KEY: [
      'Dar ao seu agente uma memória duradoura com o Mem0',
      'Uma memória que encontra as coisas pelo seu significado.'
    ],
    MISTRAL_API_KEY: ['Falar e transcrever com o Mistral', ''],
    OPENVIKING_API_KEY: ['Ligar à sua memória OpenViking', 'Deixe vazio se o OpenViking correr neste computador.'],
    OPENVIKING_ENDPOINT: ['Usar outro servidor OpenViking', 'Deixe vazio para usar o deste computador.'],
    PARALLEL_API_KEY: [
      'Pesquisar e ler a web com o Parallel',
      'Pesquisa feita para agentes, com as partes úteis de cada página.'
    ],
    PORCUPINE_ACCESS_KEY: [
      'Acordar o seu agente com uma palavra falada',
      'Opcional. Uma chave Picovoice ativa a palavra de ativação Porcupine.'
    ],
    RAFT_PROFILE: ['Entrar num espaço de trabalho Raft como este agente', 'Preenchê-lo ativa a ligação ao Raft.'],
    RETAINDB_API_KEY: ['Dar ao seu agente uma memória duradoura com o RetainDB', ''],
    RETAINDB_BASE_URL: ['Usar o seu próprio servidor RetainDB', 'Deixe vazio para usar o serviço RetainDB alojado.'],
    SEARXNG_URL: [
      'Pesquisar na web com o seu próprio SearXNG',
      'Pesquisa gratuita e privada num servidor gerido por si.'
    ],
    SUDO_PASSWORD: [
      'Deixar os comandos do terminal correr como administrador',
      'Guardada neste computador. Deixe vazio para que lhe seja pedida sempre.'
    ],
    SUPERMEMORY_API_KEY: [
      'Dar ao seu agente uma memória duradoura com o Supermemory',
      'Uma memória guardada para cada conversa.'
    ],
    TAVILY_API_KEY: ['Pesquisar e ler a web com o Tavily', 'Opcional. O Tavily também funciona sem chave.'],
    TOOL_GATEWAY_DOMAIN: [
      'Apontar as ferramentas de subscritor para outro domínio',
      'Só para subscritores do Nous Portal. Deixe vazio, salvo pedido do suporte.'
    ],
    TOOL_GATEWAY_SCHEME: [
      'Escolher como as ferramentas de subscritor se ligam',
      'Só para subscritores do Nous Portal. Deixe vazio, salvo pedido do suporte.'
    ],
    TOOL_GATEWAY_USER_TOKEN: [
      'Iniciar sessão nas ferramentas de subscritor com o seu próprio token',
      'Só para subscritores do Nous Portal. Se estiver vazio, é usada a sua sessão.'
    ],
    VOICE_TOOLS_OPENAI_KEY: [
      'Falar e transcrever com a OpenAI',
      'Usada para a transcrição Whisper e as vozes da OpenAI.'
    ]
  }
}
