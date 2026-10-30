import type { KeysCopy } from './keys-copy'

// Settings › Keys and Providers › API keys in English; the shape and the rules live in keys-copy.tsx.
export const keysCopyEn: KeysCopy = {
  kinds: {
    anotherKey: ['Use another key for this provider', 'Only needed when the first key is not the one you use.'],
    cloudProfile: ['Choose which cloud profile signs you in', ''],
    credentialsFile: ['Point to your credentials file', ''],
    other: ['Change an extra setting for this provider', ''],
    region: ['Choose where your requests run', ''],
    serverAddress: ['Use a different server address', "Leave it empty to use the provider's usual address."]
  },
  lessFields: 'Fewer settings',
  pasteKey: 'Paste your key here',
  apiKeyProviders: {
    anthropic: ['Use your own Anthropic key', 'Paste a key from the Anthropic Console. No browser sign-in needed.']
  },
  providers: {
    'AWS Bedrock': "Models in Amazon's cloud, billed to your AWS account.",
    'Actual Computer': 'Models served by Actual Computer.',
    'Alibaba Cloud (Coding Plan)': "Qwen coding models on Alibaba Cloud's coding plan.",
    Anthropic: 'Claude models, straight from Anthropic.',
    'Arcee AI': 'Small, efficient models from Arcee AI.',
    'Azure Foundry': 'Models deployed in your Microsoft Azure account.',
    CommandCode: 'Coding models served by CommandCode.',
    'DashScope (Qwen)': 'Qwen models from Alibaba Cloud.',
    DeepInfra: 'Open models at low prices on DeepInfra.',
    DeepSeek: "DeepSeek's chat and reasoning models.",
    'Fireworks AI': 'Fast open models served by Fireworks AI.',
    'GLM / Z.AI': 'GLM models from Z.AI.',
    'GMI Cloud': "Open models on GMI Cloud's GPUs.",
    Gemini: 'Gemini models with a key from Google AI Studio.',
    'GitHub Copilot': 'Models included with your GitHub Copilot plan.',
    'Google AI Studio': 'Gemini models with a key from Google AI Studio.',
    'Google Vertex AI': 'Gemini and partner models in your Google Cloud project.',
    'Hugging Face': 'Open models through Hugging Face.',
    HuggingFace: 'Open models through Hugging Face.',
    'Kilo Code': 'Models through your Kilo Code account.',
    'Kimi (China)': 'Kimi models served in mainland China.',
    'Kimi / Kimi Coding Plan': 'Kimi models from Moonshot AI, including the coding plan.',
    'Kimi / Moonshot': 'Kimi models from Moonshot AI.',
    'Kimi / Moonshot (China)': 'Kimi models served in mainland China.',
    'LM Studio': 'Models running on your own computer with LM Studio.',
    'Meta Model API': 'Llama models, straight from Meta.',
    MiniMax: "MiniMax's long-context models.",
    'MiniMax (China)': 'MiniMax models served in mainland China.',
    'NVIDIA NIM': 'Models hosted by NVIDIA.',
    'Nous Portal': 'Models trained by Nous Research.',
    NovitaAI: 'Open models at low prices on Novita AI.',
    'Ollama Cloud': "Open models in Ollama's cloud.",
    'OpenAI API': 'GPT models, straight from OpenAI.',
    'OpenCode Go': 'Models through your OpenCode Go plan.',
    'OpenCode Zen': 'Models picked and tested by OpenCode Zen.',
    OpenRouter: 'Hundreds of models behind one key.',
    'Qwen Cloud': 'Qwen models from Alibaba Cloud.',
    StepFun: 'Step models from StepFun.',
    'StepFun Step Plan': 'Step models from StepFun.',
    'Tencent TokenHub': 'Models served by Tencent TokenHub.',
    'Upstage Solar': 'Solar models from Upstage.',
    'Vercel AI Gateway': 'Many providers behind one Vercel key.',
    'Xiaomi MiMo': 'MiMo models from Xiaomi.',
    'Z.AI (GLM)': 'GLM models from Z.AI.',
    xAI: 'Grok models, straight from xAI.'
  },
  vars: {
    AGENT_BROWSER_ENGINE: [
      'Choose the engine the local browser runs on',
      'Automatic uses Chrome. Lightpanda is faster but cannot take screenshots.'
    ],
    BRAVE_SEARCH_API_KEY: ['Search the web with Brave', 'The free plan covers about 2,000 searches a month.'],
    BROWSERBASE_API_KEY: [
      'Browse in the cloud with Browserbase',
      'Optional. The browser on this computer works without it.'
    ],
    BROWSERBASE_PROJECT_ID: [
      'Tell Browserbase which project to use',
      'Only needed when you browse in the cloud with Browserbase.'
    ],
    BROWSER_USE_API_KEY: [
      'Browse in the cloud with Browser Use',
      'Optional. The browser on this computer works without it.'
    ],
    BRV_API_KEY: [
      'Sync memory to the cloud with ByteRover',
      'Optional. Memory stays on this computer until you add a key.'
    ],
    CAMOFOX_API_KEY: ['Sign in to your remote Camofox browser', 'Only needed when your Camofox server asks for a key.'],
    CAMOFOX_URL: [
      'Browse with Camofox so sites are less likely to block you',
      'The address of your Camofox server, usually on this computer.'
    ],
    ELEVENLABS_API_KEY: [
      'Speak and transcribe with ElevenLabs',
      'Premium voices for speech and accurate transcription.'
    ],
    EXA_API_KEY: ['Search the web with Exa', 'Search built for agents, with page contents in the results.'],
    FAL_KEY: ['Create images and videos with fal', ''],
    FIRECRAWL_API_KEY: [
      'Search and read websites with Firecrawl',
      'Lets your agent search the web and read whole pages.'
    ],
    FIRECRAWL_API_URL: ['Use your own Firecrawl server', 'Optional. Only for a Firecrawl you host yourself.'],
    FIRECRAWL_BROWSER_TTL: [
      'Choose how long a Firecrawl browser session stays open',
      'In seconds. Five minutes when left empty.'
    ],
    FIRECRAWL_GATEWAY_URL: [
      'Send Firecrawl requests through a different subscriber address',
      'For Nous Portal subscribers only. Leave it empty unless support asks.'
    ],
    GATEWAY_ALLOW_ALL_USERS: [
      'Let anyone talk to your messaging bots',
      'Off by default, so only people you allow can reach them.'
    ],
    GATEWAY_PROXY_KEY: [
      'Sign in to the server that answers your messages',
      'It must match the key set on that server.'
    ],
    GATEWAY_PROXY_URL: [
      'Forward your messages to another agent server',
      'When it is set, that server answers your messages instead of this computer.'
    ],
    GITHUB_TOKEN: [
      'Connect GitHub to find and publish skills',
      'Raises the limits GitHub sets when your agent browses and publishes skills.'
    ],
    HERMES_EPHEMERAL_SYSTEM_PROMPT: [
      'Add instructions to every request without saving them',
      'Sent with each request and never stored in your conversations.'
    ],
    HERMES_LANGFUSE_BASE_URL: ['Use your own Langfuse server', 'Leave it empty to use Langfuse Cloud.'],
    HERMES_LANGFUSE_PUBLIC_KEY: [
      "Follow your agent's work step by step in Langfuse",
      'The public key of your Langfuse project.'
    ],
    HERMES_LANGFUSE_SECRET_KEY: [
      'Let your agent write its steps to Langfuse',
      'The secret key of your Langfuse project.'
    ],
    HERMES_PREFILL_MESSAGES_FILE: [
      'Show your agent example messages from a file',
      'Sent before each conversation and never saved.'
    ],
    HINDSIGHT_API_KEY: [
      'Give your agent a lasting memory with Hindsight',
      'A memory that keeps track of how things connect.'
    ],
    HINDSIGHT_API_URL: ['Use a different Hindsight server', 'Leave it empty to use the hosted Hindsight service.'],
    HONCHO_API_KEY: ['Give your agent a lasting memory with Honcho', 'A memory that learns about you over time.'],
    HONCHO_BASE_URL: ['Use your own Honcho server', 'A Honcho you host yourself needs no key.'],
    KEENABLE_API_KEY: ['Search the web quickly with Keenable', 'Optional. Keenable also works without a key.'],
    KREA_API_KEY: ['Create images with Krea', ''],
    MEM0_API_KEY: ['Give your agent a lasting memory with Mem0', 'A memory that finds things by what they mean.'],
    MISTRAL_API_KEY: ['Speak and transcribe with Mistral', ''],
    OPENVIKING_API_KEY: ['Connect to your OpenViking memory', 'Leave it empty when OpenViking runs on this computer.'],
    OPENVIKING_ENDPOINT: ['Use a different OpenViking server', 'Leave it empty to use the one on this computer.'],
    PARALLEL_API_KEY: [
      'Search and read the web with Parallel',
      'Search built for agents, with the useful parts of each page.'
    ],
    PORCUPINE_ACCESS_KEY: [
      'Wake your agent with a spoken word',
      'Optional. A Picovoice key turns on the Porcupine wake word.'
    ],
    RAFT_PROFILE: ['Join a Raft workspace as this agent', 'Filling it in turns the Raft connection on.'],
    RETAINDB_API_KEY: ['Give your agent a lasting memory with RetainDB', ''],
    RETAINDB_BASE_URL: ['Use your own RetainDB server', 'Leave it empty to use the hosted RetainDB service.'],
    SEARXNG_URL: ['Search the web with your own SearXNG', 'Free, private search on a server you run.'],
    SUDO_PASSWORD: [
      'Let terminal commands run as administrator',
      'Kept on this computer. Leave it empty to be asked each time.'
    ],
    SUPERMEMORY_API_KEY: ['Give your agent a lasting memory with Supermemory', 'A memory kept for each conversation.'],
    TAVILY_API_KEY: ['Search and read the web with Tavily', 'Optional. Tavily also works without a key.'],
    TOOL_GATEWAY_DOMAIN: [
      'Point subscriber tools at a different domain',
      'For Nous Portal subscribers only. Leave it empty unless support asks.'
    ],
    TOOL_GATEWAY_SCHEME: [
      'Choose how subscriber tools connect',
      'For Nous Portal subscribers only. Leave it empty unless support asks.'
    ],
    TOOL_GATEWAY_USER_TOKEN: [
      'Sign subscriber tools in with your own token',
      'For Nous Portal subscribers only. Your sign-in is used when it is empty.'
    ],
    VOICE_TOOLS_OPENAI_KEY: ['Speak and transcribe with OpenAI', 'Used for Whisper transcription and OpenAI voices.']
  }
}
