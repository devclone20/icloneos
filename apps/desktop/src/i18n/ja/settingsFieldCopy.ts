import { defineFieldCopy } from '@/app/settings/field-copy'

export const fieldLabels = defineFieldCopy({
  'stt.echoTranscripts': '口述した内容をそのままチャットに表示する',
  'tts.deepinfra.model': '話す DeepInfra のエンジン',
  'tts.deepinfra.voice': '話す DeepInfra の音声',
  'voice.clientDirect': '最速で返信できるよう、このコンピューターから直接音声を送る',
  'browser.headed': 'エージェントの閲覧を見えるウィンドウで見る',
  'browser.recordSessions': 'エージェントがブラウザで行ったことを録画しておく',
  'browser.useRealProfile': 'サイトにサインイン済みのあなたとして閲覧する',
  'browser.engine': 'エージェントが操作するブラウザ',
  model: 'デフォルトモデル',
  modelContextLength: 'エージェントが会話をどこまで覚えておくか',
  fallbackProviders: 'メインのモデルが使えないときに誰が答えるか',
  toolsets: 'エージェントが使えるツールのセット',
  timezone: 'エージェントが基準にする時計',
  display: {
    personality: 'エージェントが新しいチャットを始めるときのキャラクター',
    showReasoning: 'エージェントが答えにたどり着いた過程を表示する'
  },
  desktop: {
    repoScanEnabled: 'このコンピューター上のプロジェクトを自動で見つける',
    repoScanRoots: 'プロジェクトを探す場所',
    repoScanExcludePaths: '探すときに除外するフォルダ'
  },
  agent: {
    maxTurns: 'エージェントが止まって報告するまでのステップ数',
    imageInputMode: '添付した画像をどのようにモデルへ渡すか',
    apiMaxRetries: 'モデルが応答しないときに再試行する回数',
    serviceTier: 'モデルの優先速度に料金を払うかどうか',
    toolUseEnforcement: 'エージェントにツールの使用をどれだけ厳しく求めるか'
  },
  terminal: {
    cwd: 'エージェントが標準で作業するフォルダ',
    backend: 'エージェントのコマンドが実際に動く場所',
    timeout: '1 つのコマンドが止められるまでに動ける時間',
    persistentShell: 'コマンドの間で 1 つのターミナルを維持する',
    envPassthrough: 'エージェントのツールが参照できるこのマシンの設定',
    dockerImage: 'コマンドを動かす Docker イメージ',
    singularityImage: 'コマンドを動かす Singularity イメージ',
    modalImage: 'コマンドを動かす Modal イメージ',
    daytonaImage: 'コマンドを動かす Daytona イメージ'
  },
  fileReadMaxChars: 'エージェントが 1 回に読むファイルの量',
  toolOutput: {
    maxBytes: 'エージェントが読むコマンド出力の量',
    maxLines: 'エージェントが一度に読むファイルの行数',
    maxLineLength: '1 行が切り詰められるまでの最大の長さ'
  },
  codeExecution: {
    mode: 'エージェントが現在のプロジェクトの外でどこまでコードを実行できるか'
  },
  approvals: {
    mode: 'エージェントが行動する前にあなたに確認すべきとき',
    timeout: '許可のリクエストがあなたを待つ時間',
    mcpReloadConfirm: '接続したツールを再読み込みする前に確認する'
  },
  commandAllowlist: 'エージェントが確認なしで実行できるコマンド',
  security: {
    redactSecrets: 'パスワードやキーをモデルから隠す',
    allowPrivateUrls: '自分のネットワーク上のアドレスをエージェントに開かせる'
  },
  browser: {
    allowPrivateUrls: '自分のネットワーク上のアドレスをエージェントに開かせる',
    autoLocalForPrivateUrls: 'プライベートなアドレスにはこのコンピューターのブラウザを使う'
  },
  checkpoints: {
    enabled: 'エージェントが編集する前にすべてのファイルのコピーを保存する',
    maxSnapshots: '保存しておくファイルのコピーの数'
  },
  voice: {
    recordKey: '押している間に話せるキー',
    maxRecordingSeconds: '1 回の録音の最大の長さ',
    autoTts: 'すべての返信を自動で読み上げる'
  },
  stt: {
    enabled: '話した内容をアプリにテキストにさせる',
    provider: '誰が聞き取るか',
    local: {
      model: 'オフライン時にこのコンピューターがどれだけ丁寧に聞き取るか',
      language: '口述する言語'
    },
    openai: {
      model: '聞き取りに使う OpenAI のエンジン'
    },
    groq: {
      model: '聞き取りに使う Groq のエンジン'
    },
    mistral: {
      model: '聞き取りに使う Mistral のエンジン'
    },
    elevenlabs: {
      modelId: '聞き取りに使う ElevenLabs のエンジン',
      languageCode: 'ElevenLabs が想定する言語',
      tagAudioEvents: '書き起こしに笑い声や物音を記す',
      diarize: '書き起こしで話者を区別する'
    }
  },
  tts: {
    provider: '返信を読み上げる音声',
    edge: {
      voice: '話す Edge の音声'
    },
    openai: {
      model: '話す OpenAI の音声エンジン',
      voice: '話す OpenAI の音声'
    },
    elevenlabs: {
      voiceId: '話す ElevenLabs の音声',
      modelId: '話す ElevenLabs のエンジン'
    },
    xai: {
      voiceId: '話す Grok の音声',
      language: 'その音声が話す言語',
      speed: 'その音声が話す速さ',
      autoSpeechTags: '合う場面で笑い声やため息を音声に加えさせる',
      optimizeStreamingLatency: '早く話すか、きれいに話すか',
      sampleRate: '読み上げ音声の細かさ',
      bitRate: '読み上げ音声ファイルの大きさ'
    },
    minimax: {
      model: '話す MiniMax のエンジン',
      voiceId: '話す MiniMax の音声'
    },
    mistral: {
      model: '話す Mistral のエンジン',
      voiceId: '話す Mistral の音声'
    },
    gemini: {
      model: '話す Gemini のエンジン',
      voice: '話す Gemini の音声'
    },
    neutts: {
      model: '話す NeuTTS のエンジン',
      device: 'NeuTTS がグラフィックチップとプロセッサのどちらで話すか'
    },
    kittentts: {
      model: '話す KittenTTS のエンジン',
      voice: '話す KittenTTS の音声'
    },
    piper: {
      voice: '話す Piper の音声'
    }
  },
  memory: {
    memoryEnabled: 'チャットをまたいでエージェントに覚えさせる',
    userProfileEnabled: 'あなたの仕事の好みを短いメモとしてエージェントに残させる',
    memoryCharLimit: 'エージェントが覚えておける量',
    userCharLimit: 'あなたについてのメモの最大の長さ',
    provider: 'その記憶をどこに保存するか'
  },
  context: {
    engine: 'チャットが長くなりすぎたときにエージェントがどうするか'
  },
  compression: {
    enabled: '長いチャットの古い部分を捨てずに要約する',
    threshold: 'チャットがどこまで埋まったら要約するか',
    targetRatio: '要約をどこまで短くするか',
    protectLastN: '要約しない直近のメッセージの数'
  },
  delegation: {
    model: 'エージェントのヘルパーが使うモデル',
    provider: 'ヘルパーを動かすプロバイダー',
    maxIterations: '各ヘルパーが進むステップ数',
    maxConcurrentChildren: '同時に動くヘルパーの数',
    childTimeoutSeconds: 'ヘルパーが止められるまでに作業できる時間',
    reasoningEffort: 'ヘルパーがどれだけ深く考えるか'
  },
  updates: {
    nonInteractiveLocalChanges: 'アプリが自動更新するとき、あなた自身の編集をどうするか'
  }
})

export const fieldDescriptions = defineFieldCopy({
  // U1-p2b-05: plain hints in the voice of the titles (override the upstream config descriptions).
  'tts.deepinfra.model': '返信を読み上げる音声モデルです。',
  'tts.kittentts.model': '返信を読み上げる音声モデルです。',
  'tts.neutts.model': '返信を読み上げる音声モデルです。',
  'tts.gemini.model': '返信を読み上げる音声モデルです。',
  'tts.mistral.model': '返信を読み上げる音声モデルです。',
  'tts.minimax.model': '返信を読み上げる音声モデルです。',
  'tts.elevenlabs.modelId': '返信を読み上げる音声モデルです。',
  'tts.openai.model': '返信を読み上げる音声モデルです。',
  'tts.deepinfra.voice': 'エージェントが話すときの声です。',
  'tts.piper.voice': 'エージェントが話すときの声です。',
  'tts.kittentts.voice': 'エージェントが話すときの声です。',
  'tts.gemini.voice': 'エージェントが話すときの声です。',
  'tts.mistral.voiceId': 'エージェントが話すときの声です。',
  'tts.minimax.voiceId': 'エージェントが話すときの声です。',
  'tts.elevenlabs.voiceId': 'エージェントが話すときの声です。',
  'tts.openai.voice': 'エージェントが話すときの声です。',
  'tts.edge.voice': 'エージェントが話すときの声です。',
  'tts.neutts.device': '声を生成するコンピューターの部品です。',
  'tts.xai.bitRate': 'MP3 音声にのみ適用され、値が高いほど音質が上がります。',
  'tts.xai.sampleRate': '値を高くすると音質が上がり、ファイルも大きくなります。',
  'tts.xai.optimizeStreamingLatency': '0 で最高の音質、2 で最速の応答になります。',
  'tts.xai.autoSpeechTags': '話す前に、モデルが笑いやため息などの表現を加えます。',
  'tts.xai.speed': '1.0 が通常の速さで、低くすると遅く、高くすると速くなります。',
  'tts.xai.language': 'en や pt-BR などの言語コード、または自動検出の auto です。',
  'tts.xai.voiceId': 'eve などの声の名前、またはあなた独自の声です。',
  'tts.provider':
    'Edge は無料でキー不要です。ElevenLabs は最速の有料オプションです。そのほかはクラウドまたは完全オフラインの音声です。',
  'delegation.reasoningEffort': '深く考えるほど良い答えになりますが、時間と費用が増えます。',
  'delegation.childTimeoutSeconds': '単位は秒です。',
  'delegation.maxConcurrentChildren': 'ヘルパーが多いほど早く終わりますが、一度にかかる費用が増えます。',
  'delegation.maxIterations': 'ヘルパーはこのステップ数に達すると止まります。',
  'delegation.provider': '空のままにするとメインのプロバイダーを使います。',
  'delegation.model': '空のままにするとメインのモデルを使います。',
  'toolOutput.maxLineLength': '非常に長い行は、ほかの内容を押し出さないよう短くされます。',
  'toolOutput.maxLines': '必要なときは、エージェントが続きを読み込めます。',
  'toolOutput.maxBytes': 'それより長い出力は切り詰められ、チャットが速く安く保たれます。',
  toolsets: 'セットをオフにすると、そのツールはすべてのチャットから外れます。',
  'browser.engine': '一部のブラウザは開いたページのスクリーンショットを撮れません。',
  'browser.autoLocalForPrivateUrls':
    '自分のネットワーク上のページは、リモートではなくこのコンピューターのブラウザで開きます。',
  'browser.allowPrivateUrls': '自宅や職場のルーター、プリンター、その他の機器が含まれます。',
  'browser.useRealProfile':
    'エージェントはブラウザのログイン情報のコピーで閲覧し、あなた自身のプロファイルは開きません。Chrome、Edge、Brave で使えます。',
  'browser.recordSessions': '各閲覧セッションの動画が保存され、後で見返せます。',
  'browser.headed': 'ウィンドウが開き、エージェントが訪れる各ページを見ることができます。',
  commandAllowlist: 'このリストにあるコマンドは承認の確認なしで実行されます。',
  'voice.clientDirect':
    'オンにすると、このアプリは音声をエージェント経由ではなく音声サービスへ直接送ります。往復とも最も速い経路です。この端末から直接届かない場合を除き、オンのままにしてください。',
  model: 'コンポーザーで別のモデルを選ばない限り、新しいチャットで使用されます。',
  modelContextLength: '0 のままにすると、選択したモデルから検出されたコンテキストウィンドウを使用します。',
  fallbackProviders: 'メインのモデルが応答しなくなったとき、エージェントはこれらを順番に試します。',
  display: {
    personality: '新しいチャットを始めるときのエージェントの口調。',
    showReasoning: 'モデルが考えた過程を共有したときに、その内容を表示します。'
  },
  desktop: {
    repoScanEnabled: 'フォルダーを調べて、コードのプロジェクトを「プロジェクト」に並べます。',
    repoScanRoots: 'スキャンするフォルダです。空のままにするとホームフォルダをスキャンします。',
    repoScanExcludePaths: 'プロジェクトを探すときに飛ばすフォルダー。中身もすべて飛ばします。'
  },
  timezone: 'エージェントが現地時刻を必要とするときに使います。空欄ならシステムのタイムゾーンを使います。',
  agent: {
    toolUseEnforcement: '厳しくすると、ツールで正確な答えが得られる場面でエージェントが推測しなくなります。',
    serviceTier: 'プロバイダーが提供している場合、より速い回答を高めの料金で受けられます。',
    apiMaxRetries: '再試行のたびに、前回より少し長く待ちます。',
    imageInputMode: '添付した画像をどのように渡すか。',
    maxTurns: 'エージェントが 1 回の実行を止めるまでに使うツール手順の上限です。'
  },
  terminal: {
    daytonaImage: 'エージェントのコマンドを Daytona で実行する場合にのみ使います。',
    modalImage: 'エージェントのコマンドを Modal で実行する場合にのみ使います。',
    singularityImage: 'エージェントのコマンドを Singularity で実行する場合にのみ使います。',
    dockerImage: 'エージェントのコマンドを Docker で実行する場合にのみ使います。',
    timeout: '単位は秒です。',
    backend: '既定ではこのコンピューターです。設定したコンテナやリモートマシンも選べます。',
    cwd: 'ツールとターミナル作業のデフォルトプロジェクトフォルダーです。',
    persistentShell: 'あるコマンドのフォルダや設定が次のコマンドに引き継がれます。',
    envPassthrough: 'エージェントのコマンドが見てよい、このコンピューターの設定。'
  },
  codeExecution: {
    mode: 'エージェントのコードが、今のプロジェクトの外にどこまで手を伸ばしてよいか。'
  },
  fileReadMaxChars: 'エージェントが 1 つのファイルから一度に読む最大文字数です。',
  approvals: {
    mcpReloadConfirm: '接続したツールを再起動する前に、エージェントがあなたに確認します。',
    mode: 'コマンドにあなたの許可が必要なとき、エージェントがどうするか。',
    timeout: '許可の求めが「いいえ」と扱われるまで待つ時間。'
  },
  security: {
    allowPrivateUrls: '自宅や職場のルーター、プリンター、その他の機器が含まれます。',
    redactSecrets: 'エージェントが読む内容に含まれるパスワードや鍵は、エージェントから隠されます。'
  },
  checkpoints: {
    maxSnapshots: '新しいコピーを作ると、いちばん古いコピーが削除されます。',
    enabled:
      'エージェントがファイルを変える前にコピーを残すので、あとで戻せます。エージェントが隔離されている間はオフです。使うには「コンテナ」で「この Mac」を選んでください。'
  },
  memory: {
    provider: '内蔵のメモリは設定なしで使えます。',
    userCharLimit: 'メモが長いほど好みを多く覚えますが、メッセージごとの費用が少し増えます。',
    memoryCharLimit: '上限に達すると、古い記憶が要約されて空きが作られます。',
    memoryEnabled: 'エージェントが学んだことを次のチャットのために覚えておきます。',
    userProfileEnabled: 'あなたの仕事の進め方を、エージェントが短いメモにして覚えておきます。'
  },
  context: {
    engine: '長いチャットが入りきらなくなったとき、エージェントがどう空きを作るか。'
  },
  compression: {
    protectLastN: 'これらのメッセージは常にそのまま残ります。',
    targetRatio: '要約が短いほど余裕が増えますが、残る詳細は少なくなります。',
    threshold: '長いチャットは要約され、エージェントはモデルの上限内で作業を続けます。',
    enabled: '長いチャットの古い部分を要約して、エージェントが続けられるようにします。'
  },
  voice: {
    maxRecordingSeconds: '録音はこの秒数が経つと自動で止まります。',
    recordKey: '入力欄からの音声入力を開始・停止するキーボードショートカットです。',
    autoTts: 'エージェントが答えを声に出して読みます。'
  },
  stt: {
    'mistral.model': 'あなたの話した言葉を文字に変えるモデルです。',
    'groq.model': 'あなたの話した言葉を文字に変えるモデルです。',
    'openai.model': 'あなたの話した言葉を文字に変えるモデルです。',
    'local.language': '空のままにすると言語を自動で検出します。',
    'local.model': '大きなモデルほど正確ですが遅くなります。base がちょうどよいバランスです。',
    provider:
      '未設定のままにするとエージェントが選びます。コンピューター上の音声認識が使えればそれを、なければキーを持っているクラウドサービスを使います。',
    echoTranscripts: '音声メッセージを送ると、その文字起こしがチャットに表示されます。',
    enabled: 'ローカルまたはプロバイダーによる音声文字起こしを有効にします。',
    elevenlabs: {
      modelId: 'あなたの話した言葉を文字に変えるモデルです。',
      diarize: '文字起こしで話者ごとにラベルが付きます。',
      tagAudioEvents: '笑い声などの音が括弧付きで表示されます。',
      languageCode: '任意の ISO-639-3 言語コードです。空欄なら ElevenLabs が自動検出します。'
    }
  },
  updates: {
    nonInteractiveLocalChanges:
      'アプリからエージェントを更新するとき、あなたがファイルに加えた変更を残すか破棄するかを選べます。ターミナルからの更新では必ず確認されます。'
  }
})
