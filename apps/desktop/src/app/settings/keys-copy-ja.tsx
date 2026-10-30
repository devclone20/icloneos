import type { KeysCopy } from './keys-copy'

// Settings › Keys and Providers › API keys in Japanese; the shape and the rules live in keys-copy.tsx.
export const keysCopyJa: KeysCopy = {
  kinds: {
    anotherKey: ['このプロバイダーに別のキーを使う', '最初のキーを使わない場合だけ必要です。'],
    cloudProfile: ['サインインに使うクラウドのプロファイルを選ぶ', ''],
    credentialsFile: ['認証情報ファイルの場所を指定する', ''],
    other: ['このプロバイダーの追加設定を変える', ''],
    region: ['リクエストを処理するリージョンを選ぶ', ''],
    serverAddress: ['別のサーバーアドレスを使う', '空欄にするとプロバイダーの通常のアドレスを使います。']
  },
  lessFields: '設定を閉じる',
  pasteKey: 'ここにキーを貼り付け',
  apiKeyProviders: {
    anthropic: [
      '自分の Anthropic キーを使う',
      'Anthropic Console で作成したキーを貼り付けます。ブラウザでのサインインは不要です。'
    ]
  },
  providers: {
    'AWS Bedrock': 'Amazon のクラウドのモデルを、AWS アカウントへの請求で使えます。',
    'Actual Computer': 'Actual Computer が提供するモデルです。',
    'Alibaba Cloud (Coding Plan)': 'Alibaba Cloud のコーディングプランで使える Qwen のコーディングモデルです。',
    Anthropic: 'Anthropic から直接使える Claude のモデルです。',
    'Arcee AI': 'Arcee AI の小さく効率的なモデルです。',
    'Azure Foundry': 'Microsoft Azure アカウントにデプロイしたモデルです。',
    CommandCode: 'CommandCode が提供するコーディングモデルです。',
    'DashScope (Qwen)': 'Alibaba Cloud の Qwen モデルです。',
    DeepInfra: 'DeepInfra で手頃な価格のオープンモデルを使えます。',
    DeepSeek: 'DeepSeek のチャットと推論のモデルです。',
    'Fireworks AI': 'Fireworks AI が提供する高速なオープンモデルです。',
    'GLM / Z.AI': 'Z.AI の GLM モデルです。',
    'GMI Cloud': 'GMI Cloud の GPU で動くオープンモデルです。',
    Gemini: 'Google AI Studio のキーで使える Gemini のモデルです。',
    'GitHub Copilot': 'GitHub Copilot のプランに含まれるモデルです。',
    'Google AI Studio': 'Google AI Studio のキーで使える Gemini のモデルです。',
    'Google Vertex AI': 'Google Cloud プロジェクトで使える Gemini とパートナーのモデルです。',
    'Hugging Face': 'Hugging Face 経由で使えるオープンモデルです。',
    HuggingFace: 'Hugging Face 経由で使えるオープンモデルです。',
    'Kilo Code': 'Kilo Code アカウント経由で使えるモデルです。',
    'Kimi (China)': '中国本土で提供される Kimi モデルです。',
    'Kimi / Kimi Coding Plan': 'Moonshot AI の Kimi モデルです。コーディングプランも含みます。',
    'Kimi / Moonshot': 'Moonshot AI の Kimi モデルです。',
    'Kimi / Moonshot (China)': '中国本土で提供される Kimi モデルです。',
    'LM Studio': 'LM Studio でこのコンピューター上で動くモデルです。',
    'Meta Model API': 'Meta から直接使える Llama のモデルです。',
    MiniMax: 'MiniMax の長いコンテキストに強いモデルです。',
    'MiniMax (China)': '中国本土で提供される MiniMax モデルです。',
    'NVIDIA NIM': 'NVIDIA がホストするモデルです。',
    'Nous Portal': 'Nous Research が学習させたモデルです。',
    NovitaAI: 'Novita AI で手頃な価格のオープンモデルを使えます。',
    'Ollama Cloud': 'Ollama のクラウドで動くオープンモデルです。',
    'OpenAI API': 'OpenAI から直接使える GPT のモデルです。',
    'OpenCode Go': 'OpenCode Go のプランで使えるモデルです。',
    'OpenCode Zen': 'OpenCode Zen が選んでテストしたモデルです。',
    OpenRouter: '1 つのキーで数百のモデルを使えます。',
    'Qwen Cloud': 'Alibaba Cloud の Qwen モデルです。',
    StepFun: 'StepFun の Step モデルです。',
    'StepFun Step Plan': 'StepFun の Step モデルです。',
    'Tencent TokenHub': 'Tencent TokenHub が提供するモデルです。',
    'Upstage Solar': 'Upstage の Solar モデルです。',
    'Vercel AI Gateway': '1 つの Vercel キーで多くのプロバイダーを使えます。',
    'Xiaomi MiMo': 'Xiaomi の MiMo モデルです。',
    'Z.AI (GLM)': 'Z.AI の GLM モデルです。',
    xAI: 'xAI から直接使える Grok のモデルです。'
  },
  vars: {
    AGENT_BROWSER_ENGINE: [
      'ローカルブラウザーのエンジンを選ぶ',
      '自動では Chrome を使います。Lightpanda は高速ですが、スクリーンショットは撮れません。'
    ],
    BRAVE_SEARCH_API_KEY: ['Brave でウェブを検索する', '無料プランで月に約 2,000 回検索できます。'],
    BROWSERBASE_API_KEY: [
      'Browserbase でクラウド上でブラウズする',
      '任意です。このコンピューターのブラウザーはこれなしでも動きます。'
    ],
    BROWSERBASE_PROJECT_ID: [
      'Browserbase で使うプロジェクトを指定する',
      'Browserbase でクラウド上でブラウズするときだけ必要です。'
    ],
    BROWSER_USE_API_KEY: [
      'Browser Use でクラウド上でブラウズする',
      '任意です。このコンピューターのブラウザーはこれなしでも動きます。'
    ],
    BRV_API_KEY: [
      'ByteRover でメモリーをクラウドに同期する',
      '任意です。キーを追加するまでメモリーはこのコンピューターに残ります。'
    ],
    CAMOFOX_API_KEY: [
      'リモートの Camofox ブラウザーにサインインする',
      'Camofox サーバーがキーを求める場合だけ必要です。'
    ],
    CAMOFOX_URL: [
      'Camofox でブラウズしてサイトにブロックされにくくする',
      'Camofox サーバーのアドレスです。通常はこのコンピューター上にあります。'
    ],
    ELEVENLABS_API_KEY: ['ElevenLabs で読み上げと文字起こしをする', '高品質な音声と正確な文字起こしに使います。'],
    EXA_API_KEY: ['Exa でウェブを検索する', 'エージェント向けの検索で、結果にページの内容も含まれます。'],
    FAL_KEY: ['fal で画像と動画を作成する', ''],
    FIRECRAWL_API_KEY: [
      'Firecrawl でウェブサイトを検索して読む',
      'エージェントがウェブを検索し、ページ全体を読めるようになります。'
    ],
    FIRECRAWL_API_URL: ['自分の Firecrawl サーバーを使う', '任意です。自分でホストしている Firecrawl の場合だけです。'],
    FIRECRAWL_BROWSER_TTL: [
      'Firecrawl のブラウザーセッションを開いておく時間を選ぶ',
      '秒単位です。空欄のときは 5 分です。'
    ],
    FIRECRAWL_GATEWAY_URL: [
      'Firecrawl のリクエストを別の購読者用アドレス経由で送る',
      'Nous Portal の購読者専用です。サポートから指示がない限り空欄にしてください。'
    ],
    GATEWAY_ALLOW_ALL_USERS: [
      '誰でもメッセージボットと話せるようにする',
      '既定ではオフで、許可した人だけが話しかけられます。'
    ],
    GATEWAY_PROXY_KEY: [
      'メッセージに返信するサーバーにサインインする',
      'そのサーバーに設定したキーと一致している必要があります。'
    ],
    GATEWAY_PROXY_URL: [
      'メッセージを別のエージェントサーバーに転送する',
      '設定すると、このコンピューターの代わりにそのサーバーが返信します。'
    ],
    GITHUB_TOKEN: [
      'GitHub に接続してスキルを探し、公開する',
      'エージェントがスキルを探したり公開したりするときの GitHub の上限が上がります。'
    ],
    HERMES_EPHEMERAL_SYSTEM_PROMPT: [
      '保存せずにすべてのリクエストへ指示を加える',
      '各リクエストと一緒に送られ、会話には保存されません。'
    ],
    HERMES_LANGFUSE_BASE_URL: ['自分の Langfuse サーバーを使う', '空欄にすると Langfuse Cloud を使います。'],
    HERMES_LANGFUSE_PUBLIC_KEY: [
      'Langfuse でエージェントの作業を一歩ずつ追う',
      'Langfuse プロジェクトの公開キーです。'
    ],
    HERMES_LANGFUSE_SECRET_KEY: [
      'エージェントが手順を Langfuse に記録できるようにする',
      'Langfuse プロジェクトの秘密キーです。'
    ],
    HERMES_PREFILL_MESSAGES_FILE: ['ファイルの例文をエージェントに見せる', '各会話の前に送られ、保存されません。'],
    HINDSIGHT_API_KEY: ['Hindsight でエージェントに長期記憶を持たせる', '物事のつながりを覚えておく記憶です。'],
    HINDSIGHT_API_URL: ['別の Hindsight サーバーを使う', '空欄にするとホスト型の Hindsight を使います。'],
    HONCHO_API_KEY: ['Honcho でエージェントに長期記憶を持たせる', '時間とともにあなたのことを学ぶ記憶です。'],
    HONCHO_BASE_URL: ['自分の Honcho サーバーを使う', '自分でホストしている Honcho にはキーは不要です。'],
    KEENABLE_API_KEY: ['Keenable でウェブをすばやく検索する', '任意です。Keenable はキーなしでも使えます。'],
    KREA_API_KEY: ['Krea で画像を作成する', ''],
    MEM0_API_KEY: ['Mem0 でエージェントに長期記憶を持たせる', '意味で物事を見つけ出す記憶です。'],
    MISTRAL_API_KEY: ['Mistral で読み上げと文字起こしをする', ''],
    OPENVIKING_API_KEY: [
      'OpenViking のメモリーに接続する',
      'OpenViking がこのコンピューターで動いている場合は空欄のままにします。'
    ],
    OPENVIKING_ENDPOINT: ['別の OpenViking サーバーを使う', '空欄にするとこのコンピューター上のものを使います。'],
    PARALLEL_API_KEY: ['Parallel でウェブを検索して読む', 'エージェント向けの検索で、各ページの要点を取り出します。'],
    PORCUPINE_ACCESS_KEY: [
      '話しかける言葉でエージェントを起動する',
      '任意です。Picovoice のキーで Porcupine のウェイクワードが有効になります。'
    ],
    RAFT_PROFILE: [
      'このエージェントとして Raft のワークスペースに参加する',
      '入力すると Raft への接続が有効になります。'
    ],
    RETAINDB_API_KEY: ['RetainDB でエージェントに長期記憶を持たせる', ''],
    RETAINDB_BASE_URL: ['自分の RetainDB サーバーを使う', '空欄にするとホスト型の RetainDB を使います。'],
    SEARXNG_URL: ['自分の SearXNG でウェブを検索する', '自分で動かすサーバーでの、無料でプライベートな検索です。'],
    SUDO_PASSWORD: [
      'ターミナルのコマンドを管理者として実行できるようにする',
      'このコンピューターに保存されます。毎回確認するには空欄にします。'
    ],
    SUPERMEMORY_API_KEY: ['Supermemory でエージェントに長期記憶を持たせる', '会話ごとに保たれる記憶です。'],
    TAVILY_API_KEY: ['Tavily でウェブを検索して読む', '任意です。Tavily はキーなしでも使えます。'],
    TOOL_GATEWAY_DOMAIN: [
      '購読者向けツールの接続先ドメインを変える',
      'Nous Portal の購読者専用です。サポートから指示がない限り空欄にしてください。'
    ],
    TOOL_GATEWAY_SCHEME: [
      '購読者向けツールの接続方法を選ぶ',
      'Nous Portal の購読者専用です。サポートから指示がない限り空欄にしてください。'
    ],
    TOOL_GATEWAY_USER_TOKEN: [
      '購読者向けツールに自分のトークンでサインインする',
      'Nous Portal の購読者専用です。空欄のときは現在のサインインを使います。'
    ],
    VOICE_TOOLS_OPENAI_KEY: ['OpenAI で読み上げと文字起こしをする', 'Whisper の文字起こしと OpenAI の音声に使います。']
  }
}
