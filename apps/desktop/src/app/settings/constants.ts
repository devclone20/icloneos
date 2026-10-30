import {
  Box,
  Brain,
  Globe,
  type IconComponent,
  Lock,
  MessageCircle,
  Mic,
  Monitor,
  Moon,
  Palette,
  Sun,
  Wrench
} from '@/lib/icons'
import { REASONING_EFFORTS } from '@/lib/reasoning-effort'
import type { ThemeMode } from '@/themes/context'

// Single source of truth for built-in personality names lives in
// lib/personalities (mirrors hermes_cli/personality.py BUILTIN_PERSONALITIES).
export { BUILTIN_PERSONALITIES } from '@/lib/personalities'

import { defineFieldCopy } from './field-copy'
import type { DesktopConfigSection } from './types'

// Provider group definitions used to fold raw env-var names like
// ``XAI_API_KEY`` into a single "xAI" card with a friendly label, short
// description, and signup URL. Membership is determined by longest
// prefix match (see ``providerGroup`` in helpers.ts) so more specific
// prefixes (``MINIMAX_CN_``) correctly beat their general parents
// (``MINIMAX_``). New providers should be added here so they get their
// own card in Settings → Keys instead of being lumped into "Other".
interface ProviderPrefix {
  prefix: string
  name: string
  /** Optional one-line tagline shown beneath the group name. */
  description?: string
  /** Optional canonical signup/console URL surfaced from the card header. */
  docsUrl?: string
  /** Lower numbers float to the top of the providers list. */
  priority: number
}

export const EMPTY_SELECT_VALUE = '__hermes_empty__'
export const CONTROL_TEXT = 'text-xs'

export const PROVIDER_GROUPS: ProviderPrefix[] = [
  {
    prefix: 'NOUS_',
    name: 'Nous Portal',
    description: 'Hosted Hermes & Nous-trained models',
    docsUrl: 'https://portal.nousresearch.com',
    priority: 0
  },
  {
    prefix: 'FIREWORKS_',
    name: 'Fireworks AI',
    description: 'OpenAI-compatible direct model API',
    docsUrl: 'https://app.fireworks.ai/settings/users/api-keys',
    // Slot #2 — mirrors CANONICAL_PROVIDERS (after Nous, ahead of OpenRouter).
    // Same numeric priority as OpenRouter; name sort puts Fireworks first.
    priority: 1
  },
  {
    prefix: 'OPENROUTER_',
    name: 'OpenRouter',
    description: 'Aggregator for hundreds of frontier models',
    docsUrl: 'https://openrouter.ai/keys',
    priority: 1
  },
  {
    prefix: 'ANTHROPIC_',
    name: 'Anthropic',
    description: 'Claude API access (Sonnet, Opus, Haiku)',
    docsUrl: 'https://console.anthropic.com/settings/keys',
    priority: 2
  },
  {
    prefix: 'XAI_',
    name: 'xAI',
    description: 'Grok models (use OAuth for SuperGrok / Premium+)',
    docsUrl: 'https://console.x.ai/',
    priority: 3
  },
  {
    prefix: 'GOOGLE_',
    name: 'Gemini',
    description: 'Google AI Studio (Gemini 1.5 / 2.0 / 2.5)',
    docsUrl: 'https://aistudio.google.com/app/apikey',
    priority: 4
  },
  { prefix: 'GEMINI_', name: 'Gemini', priority: 4 },
  {
    prefix: 'DEEPSEEK_',
    name: 'DeepSeek',
    description: 'Direct DeepSeek API (V3.x, R1)',
    docsUrl: 'https://platform.deepseek.com/api_keys',
    priority: 5
  },
  {
    prefix: 'DASHSCOPE_',
    name: 'DashScope (Qwen)',
    description: 'Alibaba Cloud DashScope — Qwen and multi-vendor models',
    docsUrl: 'https://modelstudio.console.alibabacloud.com/',
    priority: 6
  },
  { prefix: 'HERMES_QWEN_', name: 'DashScope (Qwen)', priority: 6 },
  {
    prefix: 'GLM_',
    name: 'GLM / Z.AI',
    description: 'Zhipu GLM-4.6 and Z.AI hosted endpoints',
    docsUrl: 'https://z.ai/',
    priority: 7
  },
  { prefix: 'ZAI_', name: 'GLM / Z.AI', priority: 7 },
  { prefix: 'Z_AI_', name: 'GLM / Z.AI', priority: 7 },
  {
    prefix: 'KIMI_',
    name: 'Kimi / Moonshot',
    description: 'Moonshot Kimi K2 / coding endpoints',
    docsUrl: 'https://platform.moonshot.cn/',
    priority: 8
  },
  {
    prefix: 'KIMI_CN_',
    name: 'Kimi (China)',
    description: 'Moonshot China endpoint',
    docsUrl: 'https://platform.moonshot.cn/',
    priority: 9
  },
  {
    prefix: 'MINIMAX_',
    name: 'MiniMax',
    description: 'MiniMax-M2 and Hailuo international endpoints',
    docsUrl: 'https://www.minimax.io/',
    priority: 10
  },
  {
    prefix: 'MINIMAX_CN_',
    name: 'MiniMax (China)',
    description: 'MiniMax mainland China endpoint',
    docsUrl: 'https://www.minimaxi.com/',
    priority: 11
  },
  {
    prefix: 'HF_',
    name: 'Hugging Face',
    description: 'Inference Providers — 20+ open models via router.huggingface.co',
    docsUrl: 'https://huggingface.co/settings/tokens',
    priority: 12
  },
  {
    prefix: 'OPENCODE_ZEN_',
    name: 'OpenCode Zen',
    description: 'Pay-as-you-go access to curated coding models',
    docsUrl: 'https://opencode.ai/auth',
    priority: 13
  },
  {
    prefix: 'OPENCODE_GO_',
    name: 'OpenCode Go',
    description: '$10/month subscription for open coding models',
    docsUrl: 'https://opencode.ai/auth',
    priority: 14
  },
  {
    prefix: 'NVIDIA_',
    name: 'NVIDIA NIM',
    description: 'build.nvidia.com or your own local NIM endpoint',
    docsUrl: 'https://build.nvidia.com/',
    priority: 15
  },
  {
    prefix: 'OLLAMA_',
    name: 'Ollama Cloud',
    description: 'Cloud-hosted open models from ollama.com',
    docsUrl: 'https://ollama.com/settings',
    priority: 16
  },
  {
    prefix: 'LM_',
    name: 'LM Studio',
    description: 'Local LM Studio server (OpenAI-compatible)',
    docsUrl: 'https://lmstudio.ai/docs/local-server',
    priority: 17
  },
  {
    prefix: 'STEPFUN_',
    name: 'StepFun',
    description: 'StepFun Step Plan coding models',
    docsUrl: 'https://platform.stepfun.com/',
    priority: 18
  },
  {
    prefix: 'XIAOMI_',
    name: 'Xiaomi MiMo',
    description: 'MiMo-V2.5 and Xiaomi proprietary models',
    docsUrl: 'https://platform.xiaomimimo.com',
    priority: 19
  },
  {
    prefix: 'ARCEEAI_',
    name: 'Arcee AI',
    description: 'Arcee-hosted small + medium models',
    docsUrl: 'https://chat.arcee.ai/',
    priority: 20
  },
  { prefix: 'ARCEE_', name: 'Arcee AI', priority: 20 },
  {
    prefix: 'GMI_',
    name: 'GMI Cloud',
    description: 'GMI Cloud GPU + model serving',
    docsUrl: 'https://www.gmicloud.ai/',
    priority: 21
  },
  {
    prefix: 'AZURE_FOUNDRY_',
    name: 'Azure Foundry',
    description: 'Azure AI Foundry custom endpoints (OpenAI / Anthropic-compatible)',
    docsUrl: 'https://ai.azure.com/',
    priority: 22
  },
  {
    prefix: 'AWS_',
    name: 'AWS Bedrock',
    description: 'Authenticate via AWS profile + region',
    docsUrl: 'https://docs.aws.amazon.com/bedrock/latest/userguide/bedrock-regions.html',
    priority: 23
  }
]

// Schema-side select overrides for desktop-relevant enum fields whose
// backend schema only declares a string type.
export const ENUM_OPTIONS: Record<string, string[]> = {
  'agent.image_input_mode': ['auto', 'native', 'text'],
  'code_execution.mode': ['project', 'strict'],
  'context.engine': ['compressor', 'default', 'custom'],
  // '' = inherit the agent's own effort; the rest is the shared scale.
  'delegation.reasoning_effort': ['', ...REASONING_EFFORTS],
  // NOTE: memory.provider is intentionally NOT listed here. Its options are
  // discovery-driven and served by the backend config schema (merged
  // per-request in web_server._schema_with_dynamic_provider_options), so
  // config-field consumes schema.options directly — a static list here would
  // shadow that and hide user-installed/pip providers (#49513).
  // Terminal execution backends — kept in sync with the dispatch ladder in
  // tools/terminal_tool.py::_create_environment (local/docker/singularity/
  // modal/daytona/ssh). Remote backends need extra env (image, tokens, host).
  'terminal.backend': ['local', 'docker', 'singularity', 'modal', 'daytona', 'ssh'],
  'stt.elevenlabs.model_id': ['scribe_v2', 'scribe_v1'],
  'stt.local.model': ['tiny', 'base', 'small', 'medium', 'large-v3'],
  // Speech-to-text backends — kept in sync with the stt block in
  // hermes_cli/config.py (local/groq/openai/mistral/elevenlabs).
  'stt.provider': ['local', 'groq', 'openai', 'mistral', 'xai', 'elevenlabs'],
  // OpenAI TTS voices — the union across models (per the OpenAI TTS API
  // docs). Model-specific narrowing happens in enumOptionsFor():
  // tts-1 / tts-1-hd support 9 voices; gpt-4o-mini-tts supports all 13.
  // Free-input field — the list is suggestions, not a gate (FREE_INPUT_KEYS).
  'tts.openai.voice': [
    'alloy',
    'ash',
    'ballad',
    'cedar',
    'coral',
    'echo',
    'fable',
    'marin',
    'nova',
    'onyx',
    'sage',
    'shimmer',
    'verse'
  ],
  // Popular Edge neural voices (the full catalog is 400+ — free input).
  'tts.edge.voice': [
    'en-US-AriaNeural',
    'en-US-JennyNeural',
    'en-US-AndrewNeural',
    'en-US-BrianNeural',
    'en-US-GuyNeural',
    'en-GB-SoniaNeural'
  ],
  'tts.gemini.model': ['gemini-2.5-flash-preview-tts', 'gemini-2.5-pro-preview-tts'],
  // Gemini TTS prebuilt voice set.
  'tts.gemini.voice': [
    'Zephyr',
    'Puck',
    'Charon',
    'Kore',
    'Fenrir',
    'Leda',
    'Orus',
    'Aoede',
    'Callirrhoe',
    'Autonoe',
    'Enceladus',
    'Iapetus',
    'Umbriel',
    'Algieba',
    'Despina',
    'Erinome',
    'Algenib',
    'Rasalgethi',
    'Laomedeia',
    'Achernar',
    'Alnilam',
    'Schedar',
    'Gacrux',
    'Pulcherrima',
    'Achird',
    'Zubenelgenubi',
    'Vindemiatrix',
    'Sadachbia',
    'Sadaltager',
    'Sulafat'
  ],
  'tts.xai.voice_id': ['eve'],
  'tts.minimax.model': ['speech-02-hd', 'speech-02-turbo'],
  'tts.mistral.model': ['voxtral-mini-tts-2603'],
  'tts.kittentts.model': [
    'KittenML/kitten-tts-nano-0.8-int8',
    'KittenML/kitten-tts-micro-0.8-int8',
    'KittenML/kitten-tts-mini-0.8-int8'
  ],
  'tts.kittentts.voice': ['Jasper'],
  'tts.piper.voice': ['en_US-lessac-medium', 'en_US-amy-medium', 'en_US-ryan-high', 'en_GB-alan-medium'],
  'tts.neutts.model': ['neuphonic/neutts-air-q4-gguf', 'neuphonic/neutts-air-q8-gguf', 'neuphonic/neutts-air'],
  // Text-to-speech backends — kept in sync with the built-in source of truth
  // (agent/tts_registry.py::_BUILTIN_NAMES / tools/tts_tool.py::
  // BUILTIN_TTS_PROVIDERS). 'xai' is Grok TTS.
  'tts.provider': [
    'edge',
    'elevenlabs',
    'openai',
    'xai',
    'minimax',
    'mistral',
    'gemini',
    'neutts',
    'kittentts',
    'piper'
  ],
  'stt.openai.model': ['whisper-1', 'gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'gpt-transcribe'],
  'stt.mistral.model': ['voxtral-mini-latest', 'voxtral-mini-2602'],
  'tts.openai.model': ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'],
  'tts.elevenlabs.model_id': ['eleven_multilingual_v2', 'eleven_turbo_v2_5', 'eleven_flash_v2_5'],
  // NeuTTS local inference device.
  'tts.neutts.device': ['cpu', 'cuda', 'mps'],
  'updates.non_interactive_local_changes': ['stash', 'discard']
}

// Voice/model name fields render as a free-input combobox (Input + datalist)
// instead of a closed Select: providers accept custom voice IDs (ElevenLabs
// cloned voices, xAI custom voices, Edge's 400+ catalog) and ship new model
// names faster than this list updates. The ENUM_OPTIONS above become
// suggestions rather than a gate for these keys.
export const FREE_INPUT_KEYS = new Set([
  'tts.edge.voice',
  'tts.openai.model',
  'tts.openai.voice',
  'tts.elevenlabs.voice_id',
  'tts.gemini.model',
  'tts.gemini.voice',
  'tts.xai.voice_id',
  'tts.minimax.model',
  'tts.minimax.voice_id',
  'tts.mistral.model',
  'tts.mistral.voice_id',
  'tts.neutts.model',
  'tts.kittentts.model',
  'tts.kittentts.voice',
  'tts.piper.voice',
  'tts.deepinfra.model',
  'tts.deepinfra.voice'
])

export const FIELD_LABELS: Record<string, string> = defineFieldCopy({
  'browser.headed': 'Watch your agent browse in a visible window',
  'browser.recordSessions': 'Keep a recording of what your agent did in the browser',
  'browser.engine': 'Which browser your agent drives',
  model: 'Default Model',
  modelContextLength: 'How much of the conversation your agent keeps in mind',
  fallbackProviders: 'Who answers when your main model is down',
  toolsets: 'Which sets of tools your agent is allowed to use',
  timezone: 'Which clock your agent works to',
  display: {
    personality: 'The character your agent starts new chats with',
    showReasoning: 'Show how your agent got to its answer'
  },
  desktop: {
    repoScanEnabled: 'Find your projects on this computer for you',
    repoScanRoots: 'Where to look for those projects',
    repoScanExcludePaths: 'Folders to leave alone while looking'
  },
  agent: {
    maxTurns: 'How many steps your agent takes before it stops and reports',
    imageInputMode: 'How the pictures you attach reach the model',
    apiMaxRetries: 'How often to try again when the model does not answer',
    serviceTier: 'Whether you pay for priority speed from the model',
    toolUseEnforcement: 'How strictly your agent must use its tools'
  },
  terminal: {
    cwd: 'The folder your agent works in by default',
    backend: "Where your agent's commands actually run",
    timeout: 'How long one command may run before it is stopped',
    persistentShell: 'Keep one terminal alive between commands',
    envPassthrough: "Which of your machine's settings the agent's tools can see",
    dockerImage: 'The Docker image those commands run in',
    singularityImage: 'The Singularity image those commands run in',
    modalImage: 'The Modal image those commands run in',
    daytonaImage: 'The Daytona image those commands run in'
  },
  fileReadMaxChars: 'How much of one file your agent reads at a time',
  toolOutput: {
    maxBytes: 'How much output from a command your agent reads',
    maxLines: 'How many lines of a file your agent reads at once',
    maxLineLength: 'How long a single line can be before it is cut'
  },
  codeExecution: {
    mode: 'How far outside the current project your agent may run code'
  },
  approvals: {
    mode: 'When your agent has to ask you before it acts',
    timeout: 'How long a request for permission waits for you',
    mcpReloadConfirm: 'Ask before reloading your connected tools'
  },
  commandAllowlist: 'Commands your agent may run without asking',
  security: {
    redactSecrets: 'Hide your passwords and keys from the model',
    allowPrivateUrls: 'Let your agent open addresses on your own network'
  },
  browser: {
    allowPrivateUrls: 'Let your agent open addresses on your own network',
    autoLocalForPrivateUrls: "Use this computer's browser for your private addresses",
    useRealProfile: 'Browse as you, already signed in to your sites'
  },
  checkpoints: {
    enabled: 'Save a copy of every file before your agent edits it',
    maxSnapshots: 'How many of those file copies are kept'
  },
  voice: {
    recordKey: 'The key you hold to talk',
    maxRecordingSeconds: 'How long one recording can run',
    autoTts: 'Read every reply out loud automatically',
    clientDirect: 'Send your voice straight from this computer, for the fastest reply'
  },
  stt: {
    enabled: 'Let the app turn what you say into text',
    echoTranscripts: 'Show what you dictated in the chat, word for word',
    provider: 'Who does the listening',
    local: {
      model: 'How carefully this computer listens when it works offline',
      language: 'Which language you are dictating in'
    },
    openai: {
      model: 'Which OpenAI engine does the listening'
    },
    groq: {
      model: 'Which Groq engine does the listening'
    },
    mistral: {
      model: 'Which Mistral engine does the listening'
    },
    elevenlabs: {
      modelId: 'Which ElevenLabs engine does the listening',
      languageCode: 'Which language ElevenLabs should expect',
      tagAudioEvents: 'Mark laughter and noises in the transcript',
      diarize: 'Tell speakers apart in the transcript'
    }
  },
  tts: {
    provider: 'Which voice reads replies out loud',
    edge: {
      voice: 'Which Edge voice speaks'
    },
    openai: {
      model: 'Which OpenAI voice engine speaks',
      voice: 'Which OpenAI voice speaks'
    },
    elevenlabs: {
      voiceId: 'Which ElevenLabs voice speaks',
      modelId: 'Which ElevenLabs engine speaks'
    },
    xai: {
      voiceId: 'Which Grok voice speaks',
      language: 'Which language that voice speaks',
      speed: 'How fast that voice speaks',
      autoSpeechTags: 'Let the voice add laughs and sighs where they fit',
      optimizeStreamingLatency: 'Speak sooner, or speak better',
      sampleRate: 'How detailed the spoken audio is',
      bitRate: 'How large the spoken audio files get'
    },
    minimax: {
      model: 'Which MiniMax engine speaks',
      voiceId: 'Which MiniMax voice speaks'
    },
    mistral: {
      model: 'Which Mistral engine speaks',
      voiceId: 'Which Mistral voice speaks'
    },
    gemini: {
      model: 'Which Gemini engine speaks',
      voice: 'Which Gemini voice speaks'
    },
    neutts: {
      model: 'Which NeuTTS engine speaks',
      device: 'Whether NeuTTS speaks using your graphics chip or the processor'
    },
    kittentts: {
      model: 'Which KittenTTS engine speaks',
      voice: 'Which KittenTTS voice speaks'
    },
    piper: {
      voice: 'Which Piper voice speaks'
    },
    deepinfra: {
      model: 'Which DeepInfra engine speaks',
      voice: 'Which DeepInfra voice speaks'
    }
  },
  memory: {
    memoryEnabled: 'Let your agent remember things between chats',
    userProfileEnabled: 'Let your agent keep a short note on how you like to work',
    memoryCharLimit: 'How much your agent is allowed to remember',
    userCharLimit: 'How long that note about you can get',
    provider: 'Where those memories are kept'
  },
  context: {
    engine: 'What your agent does when a chat gets too long to hold'
  },
  compression: {
    enabled: 'Summarise the older part of a long chat instead of dropping it',
    threshold: 'How full a chat gets before it is summarised',
    targetRatio: 'How short the summary should end up',
    protectLastN: 'How many recent messages are never summarised'
  },
  delegation: {
    model: "Which model your agent's helpers use",
    provider: 'Who runs those helpers',
    maxIterations: 'How many steps each helper takes',
    maxConcurrentChildren: 'How many helpers work at the same time',
    childTimeoutSeconds: 'How long a helper may work before it is stopped',
    reasoningEffort: 'How hard those helpers think'
  },
  updates: {
    nonInteractiveLocalChanges: 'What happens to your own edits when the app updates itself'
  }
})

export const FIELD_DESCRIPTIONS: Record<string, string> = defineFieldCopy({
  'delegation.reasoningEffort': 'Deeper thinking gives better answers but takes longer and costs more.',
  'delegation.childTimeoutSeconds': 'Measured in seconds.',
  'delegation.maxConcurrentChildren': 'More helpers finish sooner but cost more at once.',
  'delegation.maxIterations': 'A helper stops when it reaches this number of steps.',
  'delegation.provider': 'Leave it empty to use your main provider.',
  'delegation.model': 'Leave it empty to use your main model.',
  'toolOutput.maxLineLength': 'Very long lines are shortened so they do not crowd out the rest.',
  'toolOutput.maxLines': 'Your agent can ask for the next part when it needs more.',
  'toolOutput.maxBytes': 'Longer output is cut, which keeps chats fast and affordable.',
  toolsets: 'Turning a set off removes those tools from every chat.',
  commandAllowlist: 'Each command on this list runs without an approval prompt.',
  model: 'Used for new chats unless you pick a different model in the composer.',
  modelContextLength: "Leave at 0 to use the selected model's detected context window.",
  fallbackProviders: 'If your main model stops answering, your agent tries these in order.',
  display: {
    personality: 'The tone your agent starts every new chat with.',
    showReasoning: 'Shows how the model thought through an answer, when the model shares it.'
  },
  desktop: {
    repoScanEnabled: 'Your folders are searched for code projects to list in Projects.',
    repoScanRoots: 'Folders to scan. Leave empty to scan your home directory.',
    repoScanExcludePaths: 'Folders skipped when searching for projects, including everything inside them.'
  },
  timezone: 'Your time zone, such as Europe/Lisbon. Leave it blank to use the system time zone.',
  browser: {
    engine: 'Some browsers cannot take screenshots of the pages they open.',
    autoLocalForPrivateUrls: 'Pages on your own network open in a browser on this computer, not in a remote one.',
    allowPrivateUrls: 'Includes your router, printers and other devices at home or at work.',
    recordSessions: 'A video of each browsing session is saved so you can review it later.',
    headed: 'A window opens so you can see each page your agent visits.',
    useRealProfile:
      "Your agent browses with a copy of your browser's logins; your own profile is never opened. Works with Chrome, Edge and Brave."
  },
  agent: {
    toolUseEnforcement: 'A stricter setting stops your agent from guessing where a tool would give the real answer.',
    serviceTier: 'Faster answers from the model, billed at a higher rate where the provider offers it.',
    apiMaxRetries: 'Each retry waits a little longer than the one before.',
    imageInputMode: 'How the pictures you attach are passed on.',
    maxTurns: 'The most tool steps your agent takes before it stops a run.'
  },
  terminal: {
    timeout: 'Measured in seconds.',
    backend: 'Your computer by default, or a container or remote machine you set up.',
    cwd: 'Default project folder for tool and terminal work.',
    persistentShell: 'Folders and settings from one command carry over to the next.',
    envPassthrough: "Settings from your computer that your agent's commands are allowed to see.",
    dockerImage: "Used only when your agent's commands run in Docker.",
    singularityImage: "Used only when your agent's commands run in Singularity.",
    modalImage: "Used only when your agent's commands run on Modal.",
    daytonaImage: "Used only when your agent's commands run on Daytona."
  },
  codeExecution: {
    mode: "How far outside the current project your agent's code may reach."
  },
  fileReadMaxChars: 'The most characters your agent reads from one file at a time.',
  approvals: {
    mcpReloadConfirm: 'Your agent asks you first before it restarts the tools you connected.',
    mode: 'What your agent does when a command needs your go-ahead.',
    timeout: 'How long a request for your go-ahead waits before it counts as a no.'
  },
  security: {
    allowPrivateUrls: 'Includes your router, printers and other devices at home or at work.',
    redactSecrets: 'Passwords and keys that turn up in what your agent reads are hidden from it.'
  },
  checkpoints: {
    maxSnapshots: 'The oldest copy is removed when a new one is made.',
    enabled:
      'A copy of each file is kept before your agent changes it, so you can go back. Off while your agent is confined: choose This Mac in Containers to use it.'
  },
  memory: {
    provider: 'Built-in memory works with no setup.',
    userCharLimit: 'A longer note remembers more of your preferences and costs a little more per message.',
    memoryCharLimit: 'When the limit is reached, older memories are condensed to make room.',
    memoryEnabled: 'Your agent keeps what it learned for the next chat.',
    userProfileEnabled: 'Your agent keeps a short note of how you like to work.'
  },
  context: {
    engine: 'How your agent makes room when a long chat no longer fits.'
  },
  compression: {
    protectLastN: 'These messages are always kept word for word.',
    targetRatio: 'A shorter summary leaves more room but keeps fewer details.',
    threshold: "Long chats are summarised so your agent keeps working within the model's limit.",
    enabled: 'Older parts of a long chat are summarised so your agent can keep going.'
  },
  voice: {
    autoTts: 'Your agent reads its answers aloud.',
    recordKey: 'Keyboard shortcut that starts and stops dictation from the composer.',
    maxRecordingSeconds: 'A recording stops by itself after this many seconds.',
    clientDirect:
      'When on, this app sends audio straight to your speech services instead of through your agent — the fastest path both ways. Leave it on unless this device cannot reach them directly.'
  },
  tts: {
    'deepinfra.model': 'The speech model that reads replies aloud.',
    'kittentts.model': 'The speech model that reads replies aloud.',
    'gemini.model': 'The speech model that reads replies aloud.',
    'mistral.model': 'The speech model that reads replies aloud.',
    'minimax.model': 'The speech model that reads replies aloud.',
    'elevenlabs.modelId': 'The speech model that reads replies aloud.',
    'openai.model': 'The speech model that reads replies aloud.',
    'deepinfra.voice': 'The voice your agent speaks with.',
    'piper.voice': 'The voice your agent speaks with.',
    'kittentts.voice': 'The voice your agent speaks with.',
    'gemini.voice': 'The voice your agent speaks with.',
    'mistral.voiceId': 'The voice your agent speaks with.',
    'minimax.voiceId': 'The voice your agent speaks with.',
    'elevenlabs.voiceId': 'The voice your agent speaks with.',
    'openai.voice': 'The voice your agent speaks with.',
    'edge.voice': 'The voice your agent speaks with.',
    provider:
      'Edge is free and needs no key. ElevenLabs is the fastest paid option. The others are cloud or fully offline voices.',
    xai: {
      voiceId: 'A voice name such as eve, or one of your own voices.',
      language: 'A language code such as en or pt-BR, or auto to detect it.',
      speed: 'Use 1.0 for normal speed, lower to slow down, higher to speed up.',
      autoSpeechTags: 'The model adds cues such as laughs and sighs before it speaks.',
      optimizeStreamingLatency: 'Use 0 for the best sound or 2 for the quickest reply.',
      sampleRate: 'Higher values sound better and make larger files.',
      bitRate: 'Applies only to MP3 audio; higher values sound better.'
    },
    neutts: {
      model: 'The speech model that reads replies aloud.',
      device: 'The part of your computer that generates the voice.'
    }
  },
  stt: {
    'mistral.model': 'The model that turns your speech into text.',
    'groq.model': 'The model that turns your speech into text.',
    'openai.model': 'The model that turns your speech into text.',
    enabled: 'Enable local or provider-backed speech transcription.',
    echoTranscripts: 'After you send a voice message, its transcript appears in the chat.',
    provider:
      'Leave it unset and your agent picks one: speech recognition on your computer when it is available, otherwise a cloud service you have a key for.',
    local: {
      language: 'Leave it empty to detect the language automatically.',
      model: 'Bigger models are more accurate but slower; base is a good balance.'
    },
    elevenlabs: {
      modelId: 'The model that turns your speech into text.',
      diarize: 'Each speaker gets a label in the transcript.',
      tagAudioEvents: 'Sounds such as laughter appear in brackets.',
      languageCode: 'Optional ISO-639-3 language code. Blank lets ElevenLabs auto-detect.'
    }
  },
  updates: {
    nonInteractiveLocalChanges:
      'When your agent updates itself from the app, it can keep or throw away changes you made to its files. Updates started from a terminal always ask.'
  }
})

// Curated desktop config surface: only fields a user might tune from the app.
export const SECTIONS: DesktopConfigSection[] = [
  {
    id: 'model',
    label: 'Model',
    icon: Box,
    keys: ['model_context_length', 'fallback_providers']
  },
  {
    id: 'chat',
    label: 'Chat',
    icon: MessageCircle,
    keys: ['display.personality', 'timezone', 'display.show_reasoning', 'agent.image_input_mode']
  },
  {
    id: 'appearance',
    label: 'Appearance',
    icon: Palette,
    keys: []
  },
  {
    id: 'workspace',
    label: 'Workspace',
    icon: Monitor,
    keys: [
      'terminal.cwd',
      'desktop.repo_scan_enabled',
      'desktop.repo_scan_roots',
      'desktop.repo_scan_exclude_paths',
      'code_execution.mode',
      'terminal.persistent_shell',
      'terminal.env_passthrough',
      'file_read_max_chars'
    ]
  },
  {
    id: 'safety',
    label: 'Safety',
    icon: Lock,
    // V3-F: approvals.mode and command_allowlist are the app's permission mode now (Settings › Agent ›
    // Permissions); Hermes ignores them while icloneOS owns the policy, so they are not offered here.
    keys: [
      'approvals.timeout',
      'approvals.mcp_reload_confirm',
      'security.redact_secrets',
      'security.allow_private_urls',
      'checkpoints.enabled'
    ]
  },
  {
    id: 'browser',
    label: 'Browser',
    icon: Globe,
    // `headed` and `record_sessions` were reachable only by hand-editing
    // config.yaml, which meant the two things an owner most wants to control
    // about a browsing agent — can I watch it, and is it keeping a video —
    // were invisible. The titlebar glyphs are the quick way; this is the page
    // that explains them. `engine` belongs here too: it is the one setting
    // that silently removes a capability (lightpanda takes no screenshots).
    keys: [
      'browser.headed',
      'browser.record_sessions',
      'browser.use_real_profile',
      'browser.allow_private_urls',
      'browser.auto_local_for_private_urls',
      'browser.engine'
    ]
  },
  {
    id: 'memory',
    label: 'Memory & Context',
    icon: Brain,
    keys: [
      'memory.memory_enabled',
      'memory.user_profile_enabled',
      'memory.memory_char_limit',
      'memory.user_char_limit',
      'memory.provider',
      'context.engine',
      'compression.enabled',
      'compression.threshold',
      'compression.target_ratio',
      'compression.protect_last_n'
    ]
  },
  {
    id: 'voice',
    label: 'Voice',
    icon: Mic,
    keys: [
      'tts.provider',
      'stt.enabled',
      'stt.echo_transcripts',
      'stt.provider',
      'voice.auto_tts',
      'tts.edge.voice',
      'tts.openai.model',
      'tts.openai.voice',
      'tts.elevenlabs.voice_id',
      'tts.elevenlabs.model_id',
      'tts.xai.voice_id',
      'tts.xai.language',
      'tts.xai.speed',
      'tts.xai.auto_speech_tags',
      'tts.xai.optimize_streaming_latency',
      'tts.xai.sample_rate',
      'tts.xai.bit_rate',
      'tts.minimax.model',
      'tts.minimax.voice_id',
      'tts.mistral.model',
      'tts.mistral.voice_id',
      'tts.gemini.model',
      'tts.gemini.voice',
      'tts.neutts.model',
      'tts.neutts.device',
      'tts.kittentts.model',
      'tts.kittentts.voice',
      'tts.piper.voice',
      'tts.deepinfra.model',
      'tts.deepinfra.voice',
      'stt.local.model',
      'stt.local.language',
      'stt.openai.model',
      'stt.groq.model',
      'stt.mistral.model',
      'stt.elevenlabs.model_id',
      'stt.elevenlabs.language_code',
      'stt.elevenlabs.tag_audio_events',
      'stt.elevenlabs.diarize',
      'voice.record_key',
      'voice.max_recording_seconds',
      'voice.client_direct'
    ]
  },
  {
    id: 'advanced',
    label: 'Advanced',
    icon: Wrench,
    keys: [
      'toolsets',
      'terminal.backend',
      'terminal.timeout',
      'terminal.docker_image',
      'terminal.singularity_image',
      'terminal.modal_image',
      'terminal.daytona_image',
      'tool_output.max_bytes',
      'tool_output.max_lines',
      'tool_output.max_line_length',
      'checkpoints.max_snapshots',
      'agent.max_turns',
      'agent.api_max_retries',
      'agent.service_tier',
      'agent.tool_use_enforcement',
      'delegation.model',
      'delegation.provider',
      'delegation.max_iterations',
      'delegation.max_concurrent_children',
      'delegation.child_timeout_seconds',
      'delegation.reasoning_effort',
      'updates.non_interactive_local_changes'
    ]
  }
]

interface ModeOption {
  id: ThemeMode
  label: string
  icon: IconComponent
}

export const MODE_OPTIONS: ModeOption[] = [
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
  { id: 'system', label: 'System', icon: Monitor }
]
