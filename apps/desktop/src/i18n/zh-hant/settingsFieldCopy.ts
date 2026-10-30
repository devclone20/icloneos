import { defineFieldCopy } from '@/app/settings/field-copy'

export const fieldLabels = defineFieldCopy({
  'stt.echoTranscripts': '在對話中逐字顯示你口述的內容',
  'tts.deepinfra.model': '使用哪個 DeepInfra 引擎',
  'tts.deepinfra.voice': '使用哪個 DeepInfra 語音',
  'voice.clientDirect': '直接從這台電腦傳送語音，回覆最快',
  'browser.headed': '在可見視窗中觀看你的智慧代理瀏覽網頁',
  'browser.recordSessions': '保留你的智慧代理在瀏覽器中操作的錄影',
  'browser.useRealProfile': '以你的身分瀏覽，已登入你的網站',
  'browser.engine': '你的智慧代理操控哪個瀏覽器',
  model: '預設模型',
  modelContextLength: '你的智慧代理能記住多少對話內容',
  fallbackProviders: '主模型無法使用時由誰來回答',
  toolsets: '你的智慧代理可以使用哪些工具集',
  timezone: '你的智慧代理按哪個時區工作',
  display: {
    personality: '你的智慧代理開始新對話時的個性',
    showReasoning: '顯示你的智慧代理是如何得出答案的'
  },
  desktop: {
    repoScanEnabled: '自動找到你在這台電腦上的專案',
    repoScanRoots: '在哪裡尋找這些專案',
    repoScanExcludePaths: '尋找時略過的資料夾'
  },
  agent: {
    maxTurns: '你的智慧代理停下來回報前最多走多少步',
    imageInputMode: '你附加的圖片如何傳給模型',
    apiMaxRetries: '模型沒有回應時重試多少次',
    serviceTier: '是否為模型的優先速度付費',
    toolUseEnforcement: '你的智慧代理必須多嚴格地使用其工具'
  },
  terminal: {
    cwd: '你的智慧代理預設工作的資料夾',
    backend: '你的智慧代理的指令實際在哪裡執行',
    timeout: '單一指令在被停止前最多執行多久',
    persistentShell: '在指令之間保持同一個終端機執行',
    envPassthrough: '智慧代理的工具可以看到你電腦上的哪些設定',
    dockerImage: '執行這些指令的 Docker 映像檔',
    singularityImage: '執行這些指令的 Singularity 映像檔',
    modalImage: '執行這些指令的 Modal 映像檔',
    daytonaImage: '執行這些指令的 Daytona 映像檔'
  },
  fileReadMaxChars: '你的智慧代理每次讀取單一檔案的多少內容',
  toolOutput: {
    maxBytes: '你的智慧代理讀取多少指令輸出',
    maxLines: '你的智慧代理一次讀取檔案的多少行',
    maxLineLength: '單行最長多少字元後會被截斷'
  },
  codeExecution: {
    mode: '你的智慧代理可以在目前專案之外多大範圍內執行程式碼'
  },
  approvals: {
    mode: '你的智慧代理何時必須先徵求你的同意',
    timeout: '權限請求等待你多久',
    mcpReloadConfirm: '重新載入已連接的工具前先詢問'
  },
  commandAllowlist: '你的智慧代理無須詢問即可執行的指令',
  security: {
    redactSecrets: '對模型隱藏你的密碼和金鑰',
    allowPrivateUrls: '允許你的智慧代理開啟你自己網路上的位址'
  },
  browser: {
    allowPrivateUrls: '允許你的智慧代理開啟你自己網路上的位址',
    autoLocalForPrivateUrls: '存取你的私人位址時使用這台電腦的瀏覽器'
  },
  checkpoints: {
    enabled: '在你的智慧代理編輯每個檔案前先儲存一份副本',
    maxSnapshots: '保留多少份這樣的檔案副本'
  },
  voice: {
    recordKey: '按住即可說話的按鍵',
    maxRecordingSeconds: '單次錄音最長可以多久',
    autoTts: '自動朗讀每一則回覆'
  },
  stt: {
    enabled: '讓應用程式把你說的話轉成文字',
    provider: '由誰負責聽寫',
    local: {
      model: '這台電腦離線時聽寫得有多仔細',
      language: '你口述時使用的語言'
    },
    openai: {
      model: '由哪個 OpenAI 引擎聽寫'
    },
    groq: {
      model: '由哪個 Groq 引擎聽寫'
    },
    mistral: {
      model: '由哪個 Mistral 引擎聽寫'
    },
    elevenlabs: {
      modelId: '由哪個 ElevenLabs 引擎聽寫',
      languageCode: 'ElevenLabs 應預期哪種語言',
      tagAudioEvents: '在逐字稿中標出笑聲和雜音',
      diarize: '在逐字稿中區分不同的說話者'
    }
  },
  tts: {
    provider: '由哪個語音朗讀回覆',
    edge: {
      voice: '使用哪個 Edge 語音'
    },
    openai: {
      model: '使用哪個 OpenAI 語音引擎',
      voice: '使用哪個 OpenAI 語音'
    },
    elevenlabs: {
      voiceId: '使用哪個 ElevenLabs 語音',
      modelId: '使用哪個 ElevenLabs 引擎'
    },
    xai: {
      voiceId: '使用哪個 Grok 語音',
      language: '該語音使用哪種語言',
      speed: '該語音說話的速度',
      autoSpeechTags: '讓語音在合適的地方加入笑聲和嘆息',
      optimizeStreamingLatency: '說得更快，還是說得更好',
      sampleRate: '朗讀音訊的細膩程度',
      bitRate: '朗讀音訊檔案的大小'
    },
    minimax: {
      model: '使用哪個 MiniMax 引擎',
      voiceId: '使用哪個 MiniMax 語音'
    },
    mistral: {
      model: '使用哪個 Mistral 引擎',
      voiceId: '使用哪個 Mistral 語音'
    },
    gemini: {
      model: '使用哪個 Gemini 引擎',
      voice: '使用哪個 Gemini 語音'
    },
    neutts: {
      model: '使用哪個 NeuTTS 引擎',
      device: 'NeuTTS 使用顯示晶片還是處理器來朗讀'
    },
    kittentts: {
      model: '使用哪個 KittenTTS 引擎',
      voice: '使用哪個 KittenTTS 語音'
    },
    piper: {
      voice: '使用哪個 Piper 語音'
    }
  },
  memory: {
    memoryEnabled: '讓你的智慧代理在不同對話之間記住事情',
    userProfileEnabled: '讓你的智慧代理記下你喜歡的工作方式',
    memoryCharLimit: '你的智慧代理最多可以記住多少內容',
    userCharLimit: '關於你的那則筆記最長可以多長',
    provider: '這些記憶儲存在哪裡'
  },
  context: {
    engine: '對話太長裝不下時你的智慧代理怎麼做'
  },
  compression: {
    enabled: '把長對話中較早的部分摘要起來，而不是捨棄',
    threshold: '對話佔滿到什麼程度時開始摘要',
    targetRatio: '摘要最終要壓縮到多短',
    protectLastN: '最近有多少則訊息永遠不被摘要'
  },
  delegation: {
    model: '你的智慧代理的助手使用哪個模型',
    provider: '由誰執行這些助手',
    maxIterations: '每個助手最多走多少步',
    maxConcurrentChildren: '同時工作的助手數量',
    childTimeoutSeconds: '助手在被停止前最多工作多久',
    reasoningEffort: '這些助手思考得有多深入'
  },
  updates: {
    nonInteractiveLocalChanges: '應用程式自動更新時你自己的修改會怎樣'
  }
})

export const fieldDescriptions = defineFieldCopy({
  // U1-p2b-05: plain hints in the voice of the titles (override the upstream config descriptions).
  'tts.deepinfra.model': '朗讀回覆的語音模型。',
  'tts.kittentts.model': '朗讀回覆的語音模型。',
  'tts.neutts.model': '朗讀回覆的語音模型。',
  'tts.gemini.model': '朗讀回覆的語音模型。',
  'tts.mistral.model': '朗讀回覆的語音模型。',
  'tts.minimax.model': '朗讀回覆的語音模型。',
  'tts.elevenlabs.modelId': '朗讀回覆的語音模型。',
  'tts.openai.model': '朗讀回覆的語音模型。',
  'tts.deepinfra.voice': '你的智慧代理說話時使用的聲音。',
  'tts.piper.voice': '你的智慧代理說話時使用的聲音。',
  'tts.kittentts.voice': '你的智慧代理說話時使用的聲音。',
  'tts.gemini.voice': '你的智慧代理說話時使用的聲音。',
  'tts.mistral.voiceId': '你的智慧代理說話時使用的聲音。',
  'tts.minimax.voiceId': '你的智慧代理說話時使用的聲音。',
  'tts.elevenlabs.voiceId': '你的智慧代理說話時使用的聲音。',
  'tts.openai.voice': '你的智慧代理說話時使用的聲音。',
  'tts.edge.voice': '你的智慧代理說話時使用的聲音。',
  'tts.neutts.device': '用於產生聲音的電腦元件。',
  'tts.xai.bitRate': '僅適用於 MP3 音訊，數值越高音質越好。',
  'tts.xai.sampleRate': '數值越高音質越好，檔案也越大。',
  'tts.xai.optimizeStreamingLatency': '0 為最佳音質，2 為最快回應。',
  'tts.xai.autoSpeechTags': '模型在說話前會加入笑聲、嘆氣等表達。',
  'tts.xai.speed': '1.0 為正常語速，調低變慢，調高變快。',
  'tts.xai.language': '語言代碼，例如 en 或 pt-BR，或用 auto 自動偵測。',
  'tts.xai.voiceId': '例如 eve 這樣的聲音名稱，或你自己的聲音。',
  'tts.provider': 'Edge 免費且無需金鑰。ElevenLabs 是最快的付費選項。其他為雲端或完全離線的語音。',
  'delegation.reasoningEffort': '思考越深入，答案越好，但耗時更長、費用更高。',
  'delegation.childTimeoutSeconds': '以秒為單位。',
  'delegation.maxConcurrentChildren': '助手越多完成越快，但同時產生的費用也越高。',
  'delegation.maxIterations': '助手達到這個步數時就會停止。',
  'delegation.provider': '留空則使用你的主服務商。',
  'delegation.model': '留空則使用你的主模型。',
  'toolOutput.maxLineLength': '過長的行會被縮短，以免擠佔其他內容。',
  'toolOutput.maxLines': '需要更多內容時，你的智慧代理可以繼續讀取下一部分。',
  'toolOutput.maxBytes': '更長的輸出會被截斷，讓對話保持快速且經濟。',
  toolsets: '關閉某一組後，這些工具會從所有對話中移除。',
  'browser.engine': '有些瀏覽器無法擷取所開啟頁面的截圖。',
  'browser.autoLocalForPrivateUrls': '你自己網路上的頁面會在這台電腦的瀏覽器中開啟，而不是遠端瀏覽器。',
  'browser.allowPrivateUrls': '包括你家中或辦公室的路由器、印表機和其他裝置。',
  'browser.useRealProfile':
    '你的智慧代理使用瀏覽器登入資訊的副本進行瀏覽，絕不會開啟你自己的設定檔。適用於 Chrome、Edge 和 Brave。',
  'browser.recordSessions': '每次瀏覽都會儲存影片，方便你稍後回看。',
  'browser.headed': '會開啟一個視窗，讓你看到智慧代理造訪的每個頁面。',
  commandAllowlist: '此清單中的命令無需核准即可執行。',
  'voice.clientDirect':
    '開啟後，本應用程式會把音訊直接傳送到語音服務，而不是經由你的智慧代理中轉——雙向都是最快的路徑。除非這台裝置無法直接連線，否則請保持開啟。',
  model: '除非你在輸入框選擇其他模型，否則新聊天會使用此模型。',
  modelContextLength: '保留 0 會使用所選模型偵測到的上下文視窗。',
  fallbackProviders: '當主模型不再回應時，你的智慧代理會依序嘗試這些。',
  display: {
    personality: '智慧代理開始每個新聊天時的語氣。',
    showReasoning: '當模型提供思考過程時，顯示它是如何得出答案的。'
  },
  desktop: {
    repoScanEnabled: '搜尋你的資料夾，把程式專案列入「專案」。',
    repoScanRoots: '要掃描的資料夾。留空則掃描你的主資料夾。',
    repoScanExcludePaths: '搜尋專案時略過的資料夾，包括其中的全部內容。'
  },
  timezone: '當智慧代理需要你的本機時間時使用。留空則使用系統時區。',
  agent: {
    toolUseEnforcement: '設定越嚴格，你的智慧代理越不會在工具能給出真實答案時去猜測。',
    serviceTier: '在服務商提供時，可獲得更快的回答，按更高費率計費。',
    apiMaxRetries: '每次重試的等待時間都比上一次略長。',
    imageInputMode: '你附加的圖片如何被傳遞。',
    maxTurns: '智慧代理停止一次執行前可執行的工具步驟上限。'
  },
  terminal: {
    daytonaImage: '僅在你的智慧代理命令在 Daytona 上執行時使用。',
    modalImage: '僅在你的智慧代理命令在 Modal 上執行時使用。',
    singularityImage: '僅在你的智慧代理命令在 Singularity 中執行時使用。',
    dockerImage: '僅在你的智慧代理命令在 Docker 中執行時使用。',
    timeout: '以秒為單位。',
    backend: '預設是你的電腦，也可以是你設定的容器或遠端機器。',
    cwd: '工具與終端機操作的預設專案資料夾。',
    persistentShell: '上一個命令的資料夾和設定會延續到下一個。',
    envPassthrough: '智慧代理的指令可以看到的、這台電腦上的設定。'
  },
  codeExecution: {
    mode: '智慧代理的程式碼可以觸及目前專案之外多遠。'
  },
  fileReadMaxChars: '智慧代理單次從一個檔案讀取的最大字元數。',
  approvals: {
    mcpReloadConfirm: '在重新啟動你連接的工具之前，你的智慧代理會先詢問你。',
    mode: '當指令需要你同意時，智慧代理怎麼做。',
    timeout: '徵求你同意的請求等待多久後視為「否」。'
  },
  security: {
    allowPrivateUrls: '包括你家中或辦公室的路由器、印表機和其他裝置。',
    redactSecrets: '智慧代理讀到的內容中出現的密碼和金鑰會對它隱藏。'
  },
  checkpoints: {
    maxSnapshots: '建立新副本時，最舊的副本會被刪除。',
    enabled:
      '智慧代理更動檔案前先留一份副本，方便你回復。智慧代理處於隔離時此項關閉：要使用它，請在「容器」中選擇「這台 Mac」。'
  },
  memory: {
    provider: '內建記憶無需任何設定即可使用。',
    userCharLimit: '筆記越長，記住的偏好越多，每則訊息的費用也略高。',
    memoryCharLimit: '達到上限時，較早的記憶會被壓縮以騰出空間。',
    memoryEnabled: '智慧代理把學到的內容留給下一次聊天。',
    userProfileEnabled: '智慧代理用一段簡短的筆記記住你的工作習慣。'
  },
  context: {
    engine: '當長聊天放不下時，智慧代理如何騰出空間。'
  },
  compression: {
    protectLastN: '這些訊息始終會逐字保留。',
    targetRatio: '摘要越短，剩餘空間越多，但保留的細節越少。',
    threshold: '長對話會被摘要，讓你的智慧代理在模型的限制內繼續工作。',
    enabled: '把長聊天中較早的部分做成摘要，讓智慧代理繼續工作。'
  },
  voice: {
    maxRecordingSeconds: '錄音達到這個秒數後會自動停止。',
    recordKey: '在輸入框中開始和停止聽寫的鍵盤快速鍵。',
    autoTts: '智慧代理朗讀它的回答。'
  },
  stt: {
    'mistral.model': '把你的語音轉成文字的模型。',
    'groq.model': '把你的語音轉成文字的模型。',
    'openai.model': '把你的語音轉成文字的模型。',
    'local.language': '留空則自動偵測語言。',
    'local.model': '模型越大越準確，但速度越慢；base 是很好的平衡。',
    provider: '不設定則由你的智慧代理選擇：可用時使用電腦上的語音辨識，否則使用你有金鑰的雲端服務。',
    echoTranscripts: '傳送語音訊息後，其文字記錄會顯示在對話中。',
    enabled: '啟用本機或提供方支援的語音轉寫。',
    elevenlabs: {
      modelId: '把你的語音轉成文字的模型。',
      diarize: '文字記錄中每位說話者都會有標籤。',
      tagAudioEvents: '笑聲等聲音會以括號標出。',
      languageCode: '可選的 ISO-639-3 語言代碼。留空讓 ElevenLabs 自動偵測。'
    }
  },
  updates: {
    nonInteractiveLocalChanges:
      '從應用程式中更新智慧代理時，可以保留或捨棄你對其檔案所做的修改。從終端機啟動的更新總會詢問你。'
  }
})
