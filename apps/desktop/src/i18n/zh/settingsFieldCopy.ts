import { defineFieldCopy } from '@/app/settings/field-copy'

export const fieldLabels = defineFieldCopy({
  'stt.echoTranscripts': '在对话中逐字显示你口述的内容',
  'tts.deepinfra.model': '使用哪个 DeepInfra 引擎',
  'tts.deepinfra.voice': '使用哪个 DeepInfra 语音',
  'voice.clientDirect': '直接从这台电脑发送语音，回复最快',
  'browser.headed': '在可见窗口中观看你的智能体浏览网页',
  'browser.recordSessions': '保留你的智能体在浏览器中操作的录像',
  'browser.useRealProfile': '以你的身份浏览，已登录你的网站',
  'browser.engine': '你的智能体操控哪个浏览器',
  model: '默认模型',
  modelContextLength: '你的智能体能记住多少对话内容',
  fallbackProviders: '主模型不可用时由谁来回答',
  toolsets: '你的智能体可以使用哪些工具集',
  timezone: '你的智能体按哪个时区工作',
  display: {
    personality: '你的智能体开始新对话时的性格',
    showReasoning: '显示你的智能体是如何得出答案的'
  },
  desktop: {
    repoScanEnabled: '自动找到你在这台电脑上的项目',
    repoScanRoots: '在哪里查找这些项目',
    repoScanExcludePaths: '查找时跳过的文件夹'
  },
  agent: {
    maxTurns: '你的智能体停下来汇报前最多走多少步',
    imageInputMode: '你附加的图片如何传给模型',
    apiMaxRetries: '模型没有回应时重试多少次',
    serviceTier: '是否为模型的优先速度付费',
    toolUseEnforcement: '你的智能体必须多严格地使用其工具'
  },
  terminal: {
    cwd: '你的智能体默认工作的文件夹',
    backend: '你的智能体的命令实际在哪里运行',
    timeout: '单个命令在被停止前最多运行多久',
    persistentShell: '在命令之间保持同一个终端运行',
    envPassthrough: '智能体的工具可以看到你电脑上的哪些设置',
    dockerImage: '运行这些命令的 Docker 镜像',
    singularityImage: '运行这些命令的 Singularity 镜像',
    modalImage: '运行这些命令的 Modal 镜像',
    daytonaImage: '运行这些命令的 Daytona 镜像'
  },
  fileReadMaxChars: '你的智能体每次读取单个文件的多少内容',
  toolOutput: {
    maxBytes: '你的智能体读取多少命令输出',
    maxLines: '你的智能体一次读取文件的多少行',
    maxLineLength: '单行最长多少字符后会被截断'
  },
  codeExecution: {
    mode: '你的智能体可以在当前项目之外多大范围内运行代码'
  },
  approvals: {
    mode: '你的智能体何时必须先征求你的同意',
    timeout: '权限请求等待你多久',
    mcpReloadConfirm: '重新加载已连接的工具前先询问'
  },
  commandAllowlist: '你的智能体无需询问即可运行的命令',
  security: {
    redactSecrets: '对模型隐藏你的密码和密钥',
    allowPrivateUrls: '允许你的智能体打开你自己网络上的地址'
  },
  browser: {
    allowPrivateUrls: '允许你的智能体打开你自己网络上的地址',
    autoLocalForPrivateUrls: '访问你的私有地址时使用这台电脑的浏览器'
  },
  checkpoints: {
    enabled: '在你的智能体编辑每个文件前先保存一份副本',
    maxSnapshots: '保留多少份这样的文件副本'
  },
  voice: {
    recordKey: '按住即可说话的按键',
    maxRecordingSeconds: '单次录音最长可以多久',
    autoTts: '自动朗读每一条回复'
  },
  stt: {
    enabled: '让应用把你说的话转成文字',
    provider: '由谁负责听写',
    local: {
      model: '这台电脑离线时听写得有多仔细',
      language: '你口述时使用的语言'
    },
    openai: {
      model: '由哪个 OpenAI 引擎听写'
    },
    groq: {
      model: '由哪个 Groq 引擎听写'
    },
    mistral: {
      model: '由哪个 Mistral 引擎听写'
    },
    elevenlabs: {
      modelId: '由哪个 ElevenLabs 引擎听写',
      languageCode: 'ElevenLabs 应预期哪种语言',
      tagAudioEvents: '在转录中标出笑声和杂音',
      diarize: '在转录中区分不同的说话人'
    }
  },
  tts: {
    provider: '由哪个语音朗读回复',
    edge: {
      voice: '使用哪个 Edge 语音'
    },
    openai: {
      model: '使用哪个 OpenAI 语音引擎',
      voice: '使用哪个 OpenAI 语音'
    },
    elevenlabs: {
      voiceId: '使用哪个 ElevenLabs 语音',
      modelId: '使用哪个 ElevenLabs 引擎'
    },
    xai: {
      voiceId: '使用哪个 Grok 语音',
      language: '该语音使用哪种语言',
      speed: '该语音说话的速度',
      autoSpeechTags: '让语音在合适的地方加入笑声和叹息',
      optimizeStreamingLatency: '说得更快，还是说得更好',
      sampleRate: '朗读音频的细腻程度',
      bitRate: '朗读音频文件的大小'
    },
    minimax: {
      model: '使用哪个 MiniMax 引擎',
      voiceId: '使用哪个 MiniMax 语音'
    },
    mistral: {
      model: '使用哪个 Mistral 引擎',
      voiceId: '使用哪个 Mistral 语音'
    },
    gemini: {
      model: '使用哪个 Gemini 引擎',
      voice: '使用哪个 Gemini 语音'
    },
    neutts: {
      model: '使用哪个 NeuTTS 引擎',
      device: 'NeuTTS 使用显卡芯片还是处理器来朗读'
    },
    kittentts: {
      model: '使用哪个 KittenTTS 引擎',
      voice: '使用哪个 KittenTTS 语音'
    },
    piper: {
      voice: '使用哪个 Piper 语音'
    }
  },
  memory: {
    memoryEnabled: '让你的智能体在不同对话之间记住事情',
    userProfileEnabled: '让你的智能体记下你喜欢的工作方式',
    memoryCharLimit: '你的智能体最多可以记住多少内容',
    userCharLimit: '关于你的那条笔记最长可以多长',
    provider: '这些记忆保存在哪里'
  },
  context: {
    engine: '对话太长装不下时你的智能体怎么做'
  },
  compression: {
    enabled: '把长对话中较早的部分总结起来，而不是丢弃',
    threshold: '对话占满到什么程度时开始总结',
    targetRatio: '总结最终要压缩到多短',
    protectLastN: '最近有多少条消息永远不被总结'
  },
  delegation: {
    model: '你的智能体的助手使用哪个模型',
    provider: '由谁运行这些助手',
    maxIterations: '每个助手最多走多少步',
    maxConcurrentChildren: '同时工作的助手数量',
    childTimeoutSeconds: '助手在被停止前最多工作多久',
    reasoningEffort: '这些助手思考得有多深入'
  },
  updates: {
    nonInteractiveLocalChanges: '应用自动更新时你自己的修改会怎样'
  }
})

export const fieldDescriptions = defineFieldCopy({
  // U1-p2b-05: plain hints in the voice of the titles (override the upstream config descriptions).
  'tts.deepinfra.model': '朗读回复的语音模型。',
  'tts.kittentts.model': '朗读回复的语音模型。',
  'tts.neutts.model': '朗读回复的语音模型。',
  'tts.gemini.model': '朗读回复的语音模型。',
  'tts.mistral.model': '朗读回复的语音模型。',
  'tts.minimax.model': '朗读回复的语音模型。',
  'tts.elevenlabs.modelId': '朗读回复的语音模型。',
  'tts.openai.model': '朗读回复的语音模型。',
  'tts.deepinfra.voice': '你的智能体说话时使用的声音。',
  'tts.piper.voice': '你的智能体说话时使用的声音。',
  'tts.kittentts.voice': '你的智能体说话时使用的声音。',
  'tts.gemini.voice': '你的智能体说话时使用的声音。',
  'tts.mistral.voiceId': '你的智能体说话时使用的声音。',
  'tts.minimax.voiceId': '你的智能体说话时使用的声音。',
  'tts.elevenlabs.voiceId': '你的智能体说话时使用的声音。',
  'tts.openai.voice': '你的智能体说话时使用的声音。',
  'tts.edge.voice': '你的智能体说话时使用的声音。',
  'tts.neutts.device': '用于生成声音的电脑部件。',
  'tts.xai.bitRate': '仅适用于 MP3 音频，数值越高音质越好。',
  'tts.xai.sampleRate': '数值越高音质越好，文件也越大。',
  'tts.xai.optimizeStreamingLatency': '0 为最佳音质，2 为最快回应。',
  'tts.xai.autoSpeechTags': '模型在说话前会加入笑声、叹气等表达。',
  'tts.xai.speed': '1.0 为正常语速，调低变慢，调高变快。',
  'tts.xai.language': '语言代码，例如 en 或 pt-BR，或用 auto 自动检测。',
  'tts.xai.voiceId': '例如 eve 这样的声音名称，或你自己的声音。',
  'tts.provider': 'Edge 免费且无需密钥。ElevenLabs 是最快的付费选项。其他为云端或完全离线的语音。',
  'delegation.reasoningEffort': '思考越深入，答案越好，但耗时更长、费用更高。',
  'delegation.childTimeoutSeconds': '以秒为单位。',
  'delegation.maxConcurrentChildren': '助手越多完成越快，但同时产生的费用也越高。',
  'delegation.maxIterations': '助手达到这个步数时就会停止。',
  'delegation.provider': '留空则使用你的主服务商。',
  'delegation.model': '留空则使用你的主模型。',
  'toolOutput.maxLineLength': '过长的行会被缩短，以免挤占其他内容。',
  'toolOutput.maxLines': '需要更多内容时，你的智能体可以继续读取下一部分。',
  'toolOutput.maxBytes': '更长的输出会被截断，让对话保持快速且经济。',
  toolsets: '关闭某一组后，这些工具会从所有对话中移除。',
  'browser.engine': '有些浏览器无法截取所打开页面的截图。',
  'browser.autoLocalForPrivateUrls': '你自己网络上的页面会在这台电脑的浏览器中打开，而不是远程浏览器。',
  'browser.allowPrivateUrls': '包括你家中或办公室的路由器、打印机和其他设备。',
  'browser.useRealProfile':
    '你的智能体使用浏览器登录信息的副本进行浏览，绝不会打开你自己的资料。适用于 Chrome、Edge 和 Brave。',
  'browser.recordSessions': '每次浏览都会保存视频，方便你稍后回看。',
  'browser.headed': '会打开一个窗口，让你看到智能体访问的每个页面。',
  commandAllowlist: '此列表中的命令无需批准即可运行。',
  'voice.clientDirect':
    '开启后，本应用会把音频直接发送到语音服务，而不是经由你的智能体中转——双向都是最快的路径。除非这台设备无法直接访问它们，否则请保持开启。',
  model: '用于新对话，除非你在输入框中选择其他模型。',
  modelContextLength: '保持为 0 则使用所选模型检测到的上下文窗口。',
  fallbackProviders: '当主模型不再回应时，你的智能体会按顺序尝试这些。',
  display: {
    personality: '智能体开始每个新聊天时的语气。',
    showReasoning: '当模型提供思考过程时，显示它是如何得出答案的。'
  },
  desktop: {
    repoScanEnabled: '搜索你的文件夹，把代码项目列入“项目”。',
    repoScanRoots: '要扫描的文件夹。留空则扫描你的主文件夹。',
    repoScanExcludePaths: '搜索项目时跳过的文件夹，包括其中的全部内容。'
  },
  timezone: '当智能体需要你的本地时间时使用。留空则使用系统时区。',
  agent: {
    toolUseEnforcement: '设置越严格，你的智能体越不会在工具能给出真实答案时去猜测。',
    serviceTier: '在服务商提供时，可获得更快的回答，按更高费率计费。',
    apiMaxRetries: '每次重试的等待时间都比上一次略长。',
    imageInputMode: '你附加的图片如何被传递。',
    maxTurns: '智能体停止一次运行前可执行的工具步骤上限。'
  },
  terminal: {
    daytonaImage: '仅在你的智能体命令在 Daytona 上运行时使用。',
    modalImage: '仅在你的智能体命令在 Modal 上运行时使用。',
    singularityImage: '仅在你的智能体命令在 Singularity 中运行时使用。',
    dockerImage: '仅在你的智能体命令在 Docker 中运行时使用。',
    timeout: '以秒为单位。',
    backend: '默认是你的电脑，也可以是你设置的容器或远程机器。',
    cwd: '工具与终端操作的默认项目目录。',
    persistentShell: '上一条命令的文件夹和设置会延续到下一条。',
    envPassthrough: '智能体的命令可以看到的、这台电脑上的设置。'
  },
  codeExecution: {
    mode: '智能体的代码可以触及当前项目之外多远。'
  },
  fileReadMaxChars: '智能体单次从一个文件读取的最大字符数。',
  approvals: {
    mcpReloadConfirm: '在重启你连接的工具之前，你的智能体会先询问你。',
    mode: '当命令需要你同意时，智能体怎么做。',
    timeout: '征求你同意的请求等待多久后按“否”处理。'
  },
  security: {
    allowPrivateUrls: '包括你家中或办公室的路由器、打印机和其他设备。',
    redactSecrets: '智能体读到的内容中出现的密码和密钥会对它隐藏。'
  },
  checkpoints: {
    maxSnapshots: '创建新副本时，最旧的副本会被删除。',
    enabled:
      '智能体改动文件前先留一份副本，方便你回退。智能体处于隔离时此项关闭：要使用它，请在“容器”中选择“这台 Mac”。'
  },
  memory: {
    provider: '内置记忆无需任何设置即可使用。',
    userCharLimit: '笔记越长，记住的偏好越多，每条消息的费用也略高。',
    memoryCharLimit: '达到上限时，较早的记忆会被压缩以腾出空间。',
    memoryEnabled: '智能体把学到的内容留给下一次聊天。',
    userProfileEnabled: '智能体用一段简短的笔记记住你的工作习惯。'
  },
  context: {
    engine: '当长聊天放不下时，智能体如何腾出空间。'
  },
  compression: {
    protectLastN: '这些消息始终会逐字保留。',
    targetRatio: '总结越短，剩余空间越多，但保留的细节越少。',
    threshold: '长对话会被总结，让你的智能体在模型的限制内继续工作。',
    enabled: '把长聊天中较早的部分做成摘要，让智能体继续工作。'
  },
  voice: {
    maxRecordingSeconds: '录音达到这个秒数后会自动停止。',
    recordKey: '在输入框中开始和停止听写的键盘快捷键。',
    autoTts: '智能体朗读它的回答。'
  },
  stt: {
    'mistral.model': '把你的语音转成文字的模型。',
    'groq.model': '把你的语音转成文字的模型。',
    'openai.model': '把你的语音转成文字的模型。',
    'local.language': '留空则自动检测语言。',
    'local.model': '模型越大越准确，但速度越慢；base 是很好的平衡。',
    provider: '不设置则由你的智能体选择：可用时使用电脑上的语音识别，否则使用你有密钥的云服务。',
    echoTranscripts: '发送语音消息后，其文字记录会显示在对话中。',
    enabled: '启用本地或提供方支持的语音转写。',
    elevenlabs: {
      modelId: '把你的语音转成文字的模型。',
      diarize: '文字记录中每位说话者都会有标签。',
      tagAudioEvents: '笑声等声音会以括号标出。',
      languageCode: '可选的 ISO-639-3 语言代码。留空让 ElevenLabs 自动检测。'
    }
  },
  updates: {
    nonInteractiveLocalChanges: '从应用中更新智能体时，可以保留或丢弃你对其文件所做的修改。从终端启动的更新总会询问你。'
  }
})
