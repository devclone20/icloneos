import type { TranslationOverrides } from '../define-locale'

export const messaging: TranslationOverrides['messaging'] = {
  search: 'メッセージングを検索...',
  loading: 'メッセージングプラットフォームを読み込み中...',
  loadFailed: 'メッセージングプラットフォームの読み込みに失敗しました',
  states: {
    connected: '接続済み',
    connecting: '接続中',
    disabled: '無効',
    fatal: 'エラー',
    gateway_stopped: 'メッセージングサービスが停止中',
    not_configured: '設定が必要',
    pending_restart: '再起動が必要',
    retrying: '再試行中',
    startup_failed: '起動失敗'
  },
  unknown: '不明',
  hintPendingRestart: 'この変更を適用するには、ステータスバーからメッセージングサービスを再起動してください。',
  hintGatewayStopped: 'ステータスバーからメッセージングサービスを起動して接続してください。',
  credentialsSet: '認証情報を設定しました',
  needsSetup: '設定が必要',
  gatewayStopped: 'メッセージングサービスが停止中',
  getCredentials: 'サインイン情報を取得する',
  openSetupGuide: 'セットアップガイドを開く',
  required: '接続に必要なもの',
  recommended: '設定しておくとよいもの',
  advanced: count => `詳細設定 (${count})`,
  noTokenNeeded:
    'このプラットフォームはここでトークンが必要ありません。上のセットアップガイドを使用してから、以下で有効にしてください。',
  enabled: '有効',
  disabled: '無効',
  unsavedChanges: '未保存の変更',
  saving: '保存中...',
  saveChanges: '変更を保存',
  saved: '保存しました',
  replaceValue: '現在の値を置き換え',
  openDocs: 'ドキュメントを開く',
  clearField: key => `${key} をクリア`,
  enableAria: name => `${name} を有効にする`,
  disableAria: name => `${name} を無効にする`,
  platformEnabled: name => `${name} を有効にしました`,
  platformDisabled: name => `${name} を無効にしました`,
  restartToApply: 'この変更はメッセージングサービスの再起動後に有効になります。',
  setupSaved: name => `${name} の設定を保存しました`,
  restartToReconnect: '新しいサインイン情報はメッセージングサービスの再起動後に有効になります。',
  keyCleared: key => `${key} をクリアしました`,
  setupUpdated: name => `${name} の設定が更新されました。`,
  failedUpdate: name => `${name} の更新に失敗しました`,
  failedSave: name => `${name} の保存に失敗しました`,
  failedClear: key => `${key} のクリアに失敗しました`,
  fieldFallbackLabel: 'この設定を入力する',
  fieldFallbackName: 'この設定',
  fieldCopy: {
    TELEGRAM_BOT_TOKEN: {
      label: 'ボットトークンを貼り付ける',
      name: 'ボットトークン',
      help: '@BotFather でボットを作成し、表示されたトークンを貼り付けてください。',
      placeholder: 'Telegram ボットトークンを貼り付け'
    },
    TELEGRAM_ALLOWED_USERS: {
      label: 'エージェントと話せる人を選ぶ',
      name: '許可する Telegram ユーザー ID',
      help: '推奨。@userinfobot の数値 ID をカンマ区切りで。設定しないと誰でもボットに DM できます。'
    },
    TELEGRAM_PROXY: {
      label: 'プロキシ URL を入力する',
      name: 'プロキシ URL',
      help: 'Telegram がブロックされているネットワークでのみ必要です。'
    },
    DISCORD_BOT_TOKEN: {
      label: 'ボットトークンを貼り付ける',
      name: 'ボットトークン',
      help: 'Discord Developer Portal でアプリケーションを作成し、ボットを追加してからトークンを貼り付けてください。'
    },
    DISCORD_ALLOWED_USERS: {
      label: 'エージェントと話せる人を選ぶ',
      name: '許可する Discord ユーザー ID',
      help: '推奨。カンマ区切りの Discord ユーザー ID。'
    },
    DISCORD_REPLY_TO_MODE: { label: '返信スタイルを選ぶ', name: '返信スタイル', help: 'first、all、または off。' },
    DISCORD_ALLOW_ALL_USERS: {
      label: 'すべての Discord ユーザーを許可',
      name: 'すべての Discord ユーザーを許可',
      help: '開発用のみ。true にすると、許可リストなしで誰でもボットに DM できます。'
    },
    DISCORD_HOME_CHANNEL: {
      label: 'ホームチャンネル ID を入力する',
      name: 'ホームチャンネル ID',
      help: 'ボットがプロアクティブなメッセージを送信するチャンネル（Cron 出力、リマインダー）。'
    },
    DISCORD_HOME_CHANNEL_NAME: {
      label: 'ホームチャンネル名を入力する',
      name: 'ホームチャンネル名',
      help: 'ログやステータス出力でのホームチャンネルの表示名。'
    },
    BLUEBUBBLES_ALLOW_ALL_USERS: {
      label: 'すべての iMessage ユーザーを許可',
      name: 'すべての iMessage ユーザーを許可',
      help: 'true にすると BlueBubbles の許可リストをスキップします。'
    },
    MATTERMOST_ALLOW_ALL_USERS: {
      label: 'すべての Mattermost ユーザーを許可',
      name: 'すべての Mattermost ユーザーを許可'
    },
    MATTERMOST_HOME_CHANNEL: { label: 'ホームチャンネルを入力する', name: 'ホームチャンネル' },
    QQ_ALLOW_ALL_USERS: { label: 'すべての QQ ユーザーを許可', name: 'すべての QQ ユーザーを許可' },
    QQBOT_HOME_CHANNEL: {
      label: 'QQ ホームチャンネルを入力する',
      name: 'QQ ホームチャンネル',
      help: 'Cron 配信のデフォルトチャンネルまたはグループ。'
    },
    QQBOT_HOME_CHANNEL_NAME: { label: 'QQ ホームチャンネル名を入力する', name: 'QQ ホームチャンネル名' },
    SLACK_BOT_TOKEN: {
      label: 'Slack ボットトークンを貼り付ける',
      name: 'Slack ボットトークン',
      help: 'Slack アプリをインストール後、OAuth & Permissions のボットトークンを使用してください。',
      placeholder: 'Slack ボットトークンを貼り付け'
    },
    SLACK_APP_TOKEN: {
      label: 'Slack アプリトークンを貼り付ける',
      name: 'Slack アプリトークン',
      help: 'Socket Mode に必要なアプリレベルのトークンを使用してください。',
      placeholder: 'Slack アプリトークンを貼り付け'
    },
    SLACK_ALLOWED_USERS: {
      label: 'エージェントと話せる人を選ぶ',
      name: '許可する Slack ユーザー ID',
      help: '推奨。カンマ区切りの Slack ユーザー ID。'
    },
    MATTERMOST_URL: {
      label: 'サーバー URL を入力する',
      name: 'サーバー URL',
      placeholder: 'https://mattermost.example.com'
    },
    MATTERMOST_TOKEN: { label: 'ボットトークンを貼り付ける', name: 'ボットトークン' },
    MATTERMOST_ALLOWED_USERS: {
      label: 'エージェントと話せる人を選ぶ',
      name: '許可するユーザー ID',
      help: '推奨。カンマ区切りの Mattermost ユーザー ID。'
    },
    MATRIX_HOMESERVER: {
      label: 'ホームサーバー URL を入力する',
      name: 'ホームサーバー URL',
      placeholder: 'https://matrix.org'
    },
    MATRIX_ACCESS_TOKEN: { label: 'アクセストークンを貼り付ける', name: 'アクセストークン' },
    MATRIX_USER_ID: {
      label: 'ボットユーザー ID を入力する',
      name: 'ボットユーザー ID',
      placeholder: '@agent:example.org'
    },
    MATRIX_ALLOWED_USERS: {
      label: 'エージェントと話せる人を選ぶ',
      name: '許可する Matrix ユーザー ID',
      help: '推奨。@user:server 形式のカンマ区切りユーザー ID。'
    },
    SIGNAL_HTTP_URL: {
      label: 'Signal ブリッジ URL を入力する',
      name: 'Signal ブリッジ URL',
      placeholder: 'http://127.0.0.1:8080',
      help: '実行中の signal-cli REST ブリッジの URL。'
    },
    SIGNAL_ACCOUNT: { label: '電話番号を入力する', name: '電話番号', help: 'signal-cli ブリッジに登録した番号。' },
    SIGNAL_ALLOWED_USERS: {
      label: 'エージェントと話せる人を選ぶ',
      name: '許可する Signal ユーザー',
      help: '推奨。カンマ区切りの Signal 識別子。'
    },
    WHATSAPP_ENABLED: {
      label: 'WhatsApp ブリッジを有効にする',
      name: 'WhatsApp ブリッジを有効にする',
      help: '以下のトグルで自動的に設定されます。必要な場合を除いてそのままにしてください。'
    },
    WHATSAPP_MODE: { label: 'ブリッジモードを選ぶ', name: 'ブリッジモード' },
    WHATSAPP_ALLOWED_USERS: {
      label: 'エージェントと話せる人を選ぶ',
      name: '許可する WhatsApp ユーザー',
      help: '推奨。カンマ区切りの電話番号または WhatsApp ID。'
    },
    A2A_AGENT_NAME: { label: '他のエージェントに表示される名前を入力する', name: '他のエージェントに表示される名前' },
    A2A_BEARER_TOKEN: {
      label: '他のエージェントが使うアクセストークンを貼り付ける',
      name: '他のエージェントが使うアクセストークン'
    },
    A2A_HOST: { label: '待ち受けるアドレスを入力する', name: '待ち受けるアドレス' },
    A2A_PEER_TOKENS: { label: '信頼するエージェントのトークンを貼り付ける', name: '信頼するエージェントのトークン' },
    A2A_PORT: { label: '待ち受けるポートを入力する', name: '待ち受けるポート' },
    API_SERVER_ENABLED: { label: 'オンにする', name: 'オンにする' },
    API_SERVER_HOST: { label: '待ち受けるアドレスを入力する', name: '待ち受けるアドレス' },
    API_SERVER_KEY: { label: 'アクセスキーを貼り付ける', name: 'アクセスキー' },
    API_SERVER_MODEL_NAME: { label: '他のアプリに表示される名前を入力する', name: '他のアプリに表示される名前' },
    API_SERVER_PORT: { label: '待ち受けるポートを入力する', name: '待ち受けるポート' },
    BLUEBUBBLES_ALLOWED_USERS: { label: 'エージェントと話せる人を選ぶ', name: '話しかけられる人' },
    BLUEBUBBLES_PASSWORD: { label: 'サーバーのパスワードを貼り付ける', name: 'サーバーのパスワード' },
    BLUEBUBBLES_SERVER_URL: { label: 'サーバーのアドレスを入力する', name: 'サーバーのアドレス' },
    BUZZ_ALLOWED_USERS: { label: 'エージェントと話せる人を選ぶ', name: '話しかけられる人' },
    BUZZ_AUTH_TAG: { label: 'サインインタグを入力する', name: 'サインインタグ' },
    BUZZ_CHANNELS: { label: '参加するチャンネルを選ぶ', name: '参加するチャンネル' },
    BUZZ_CLI_PATH: { label: 'Buzz プログラムの場所を入力する', name: 'Buzz プログラムの場所' },
    BUZZ_CREDENTIALS_FILE: { label: '認証情報ファイルを入力する', name: '認証情報ファイル' },
    BUZZ_POLL_INTERVAL: { label: 'メッセージを確認する間隔を設定する', name: 'メッセージを確認する間隔' },
    BUZZ_PRIVATE_KEY: { label: '秘密鍵を貼り付ける', name: '秘密鍵' },
    BUZZ_RELAY_URL: { label: '中継サーバーのアドレスを入力する', name: '中継サーバーのアドレス' },
    BUZZ_TRANSPORT: { label: '接続方法を選ぶ', name: '接続方法' },
    DINGTALK_ALLOWED_USERS: { label: 'エージェントと話せる人を選ぶ', name: '話しかけられる人' },
    DINGTALK_CLIENT_ID: { label: 'クライアント ID を入力する', name: 'クライアント ID' },
    DINGTALK_CLIENT_SECRET: { label: 'クライアントシークレットを貼り付ける', name: 'クライアントシークレット' },
    DINGTALK_WEBHOOK_URL: { label: 'グループロボットのアドレスを入力する', name: 'グループロボットのアドレス' },
    EMAIL_ADDRESS: { label: 'メールアドレスを入力する', name: 'メールアドレス' },
    EMAIL_ALLOWED_USERS: { label: '書き込みを許可するアドレスを選ぶ', name: '書き込みを許可するアドレス' },
    EMAIL_IMAP_HOST: { label: '受信メールサーバーを入力する', name: '受信メールサーバー' },
    EMAIL_PASSWORD: { label: 'メールボックスのパスワードを貼り付ける', name: 'メールボックスのパスワード' },
    EMAIL_SMTP_HOST: { label: '送信メールサーバーを入力する', name: '送信メールサーバー' },
    EMAIL_SMTP_PORT: { label: '送信メールのポートを入力する', name: '送信メールのポート' },
    FEISHU_ALLOWED_USERS: { label: 'エージェントと話せる人を選ぶ', name: '話しかけられる人' },
    FEISHU_APP_ID: { label: 'アプリ ID を入力する', name: 'アプリ ID' },
    FEISHU_APP_SECRET: { label: 'アプリシークレットを貼り付ける', name: 'アプリシークレット' },
    FEISHU_DOMAIN: { label: 'Feishu または Lark を選ぶ', name: 'Feishu または Lark' },
    FEISHU_ENCRYPT_KEY: { label: 'イベント暗号化キーを貼り付ける', name: 'イベント暗号化キー' },
    FEISHU_VERIFICATION_TOKEN: { label: 'イベント検証トークンを貼り付ける', name: 'イベント検証トークン' },
    GOOGLE_CHAT_ALLOWED_USERS: { label: 'エージェントと話せる人を選ぶ', name: '話しかけられる人' },
    GOOGLE_CHAT_HTTP_EVENTS_AUDIENCE: { label: 'イベントの宛先を入力する', name: 'イベントの宛先' },
    GOOGLE_CHAT_HTTP_EVENTS_SERVICE_ACCOUNT_EMAIL: {
      label: 'イベントを送るサービスアカウントを入力する',
      name: 'イベントを送るサービスアカウント'
    },
    GOOGLE_CHAT_HTTP_EVENTS_URL: {
      label: 'Google Chat がイベントを送るアドレスを入力する',
      name: 'Google Chat がイベントを送るアドレス'
    },
    GOOGLE_CHAT_PROJECT_ID: {
      label: 'Google Cloud のプロジェクト ID を入力する',
      name: 'Google Cloud のプロジェクト ID'
    },
    GOOGLE_CHAT_SERVICE_ACCOUNT_JSON: {
      label: 'サービスアカウントのファイルを入力する',
      name: 'サービスアカウントのファイル'
    },
    GOOGLE_CHAT_SUBSCRIPTION_NAME: {
      label: 'Pub/Sub のサブスクリプションを入力する',
      name: 'Pub/Sub のサブスクリプション'
    },
    HASS_TOKEN: { label: '長期アクセストークンを貼り付ける', name: '長期アクセストークン' },
    HASS_URL: { label: 'Home Assistant のアドレスを入力する', name: 'Home Assistant のアドレス' },
    IRC_ALLOWED_USERS: { label: 'エージェントと話せる人を選ぶ', name: '話しかけられる人' },
    IRC_CHANNEL: { label: '参加するチャンネルを入力する', name: '参加するチャンネル' },
    IRC_NICKNAME: { label: 'ニックネームを入力する', name: 'ニックネーム' },
    IRC_NICKSERV_PASSWORD: { label: 'ニックネームのパスワードを貼り付ける', name: 'ニックネームのパスワード' },
    IRC_PORT: { label: 'サーバーのポートを入力する', name: 'サーバーのポート' },
    IRC_SERVER: { label: 'サーバーのアドレスを入力する', name: 'サーバーのアドレス' },
    IRC_SERVER_PASSWORD: { label: 'サーバーのパスワードを貼り付ける', name: 'サーバーのパスワード' },
    IRC_USE_TLS: { label: '暗号化接続を使う', name: '暗号化接続を使う' },
    LINE_ALLOWED_GROUPS: { label: '話しかけられるグループを選ぶ', name: '話しかけられるグループ' },
    LINE_ALLOWED_ROOMS: { label: '話しかけられるルームを選ぶ', name: '話しかけられるルーム' },
    LINE_ALLOWED_USERS: { label: 'エージェントと話せる人を選ぶ', name: '話しかけられる人' },
    LINE_CHANNEL_ACCESS_TOKEN: { label: 'チャネルアクセストークンを貼り付ける', name: 'チャネルアクセストークン' },
    LINE_CHANNEL_SECRET: { label: 'チャネルシークレットを貼り付ける', name: 'チャネルシークレット' },
    LINE_HOST: { label: '待ち受けるアドレスを入力する', name: '待ち受けるアドレス' },
    LINE_PORT: { label: '待ち受けるポートを入力する', name: '待ち受けるポート' },
    LINE_PUBLIC_URL: { label: 'LINE が送信する公開アドレスを入力する', name: 'LINE が送信する公開アドレス' },
    LINE_SLOW_RESPONSE_THRESHOLD: { label: '作業中と伝えるまでの秒数を設定する', name: '作業中と伝えるまでの秒数' },
    MATRIX_DEVICE_ID: { label: 'デバイス ID を入力する', name: 'デバイス ID' },
    MATRIX_PASSWORD: { label: 'パスワードを貼り付ける', name: 'パスワード' },
    MATRIX_RECOVERY_KEY: { label: '暗号化ルームの回復キーを貼り付ける', name: '暗号化ルームの回復キー' },
    NTFY_ALLOWED_USERS: { label: 'エージェントと話せる人を選ぶ', name: '話しかけられる人' },
    NTFY_MARKDOWN: { label: '返信を Markdown で整形する', name: '返信を Markdown で整形する' },
    NTFY_PUBLISH_TOPIC: { label: '返信するトピックを入力する', name: '返信するトピック' },
    NTFY_SERVER_URL: { label: 'サーバーのアドレスを入力する', name: 'サーバーのアドレス' },
    NTFY_TOKEN: { label: 'アクセストークンを貼り付ける', name: 'アクセストークン' },
    NTFY_TOPIC: { label: '待ち受けるトピックを入力する', name: '待ち受けるトピック' },
    PHOTON_ALLOWED_USERS: { label: 'エージェントと話せる人を選ぶ', name: '話しかけられる人' },
    PHOTON_DASHBOARD_HOST: { label: 'ダッシュボードのアドレスを入力する', name: 'ダッシュボードのアドレス' },
    PHOTON_MARKDOWN: { label: '返信を Markdown で整形する', name: '返信を Markdown で整形する' },
    PHOTON_MENTION_PATTERNS: { label: 'グループで呼びかける言葉を選ぶ', name: 'グループで呼びかける言葉' },
    PHOTON_NODE_BIN: { label: 'Node.js の場所を入力する', name: 'Node.js の場所' },
    PHOTON_PROJECT_ID: { label: 'プロジェクト ID を入力する', name: 'プロジェクト ID' },
    PHOTON_PROJECT_SECRET: { label: 'プロジェクトシークレットを貼り付ける', name: 'プロジェクトシークレット' },
    PHOTON_REACTIONS: { label: 'メッセージにリアクションする', name: 'メッセージにリアクションする' },
    PHOTON_SIDECAR_AUTOSTART: { label: '補助プログラムを自動で起動する', name: '補助プログラムを自動で起動する' },
    PHOTON_SIDECAR_PORT: { label: '補助プログラムのポートを入力する', name: '補助プログラムのポート' },
    PHOTON_SPECTRUM_HOST: { label: 'Spectrum のアドレスを入力する', name: 'Spectrum のアドレス' },
    PHOTON_TELEMETRY: { label: 'Photon に利用データを共有する', name: 'Photon に利用データを共有する' },
    QQ_ALLOWED_USERS: { label: 'エージェントと話せる人を選ぶ', name: '話しかけられる人' },
    QQ_APP_ID: { label: 'アプリ ID を入力する', name: 'アプリ ID' },
    QQ_CLIENT_SECRET: { label: 'クライアントシークレットを貼り付ける', name: 'クライアントシークレット' },
    QQ_GROUP_ALLOWED_USERS: { label: '話しかけられるグループを選ぶ', name: '話しかけられるグループ' },
    QQ_SANDBOX: { label: 'テスト環境を使う', name: 'テスト環境を使う' },
    RAFT_PROFILE: { label: 'ワークスペースのプロファイルを選ぶ', name: 'ワークスペースのプロファイル' },
    SIMPLEX_ALLOWED_USERS: { label: 'エージェントと話せる人を選ぶ', name: '話しかけられる人' },
    SIMPLEX_AUTO_ACCEPT: { label: '新しい連絡先を自動で承認する', name: '新しい連絡先を自動で承認する' },
    SIMPLEX_GROUP_ALLOWED: { label: 'グループでの返信を許可する', name: 'グループでの返信を許可する' },
    SIMPLEX_WS_URL: { label: 'SimpleX プログラムのアドレスを入力する', name: 'SimpleX プログラムのアドレス' },
    TEAMS_ALLOWED_USERS: { label: 'エージェントと話せる人を選ぶ', name: '話しかけられる人' },
    TEAMS_CLIENT_ID: { label: 'クライアント ID を入力する', name: 'クライアント ID' },
    TEAMS_CLIENT_SECRET: { label: 'クライアントシークレットを貼り付ける', name: 'クライアントシークレット' },
    TEAMS_HOST: { label: '待ち受けるアドレスを入力する', name: '待ち受けるアドレス' },
    TEAMS_PORT: { label: '待ち受けるポートを入力する', name: '待ち受けるポート' },
    TEAMS_TENANT_ID: { label: 'テナント ID を入力する', name: 'テナント ID' },
    TWILIO_ACCOUNT_SID: { label: 'アカウント SID を入力する', name: 'アカウント SID' },
    TWILIO_AUTH_TOKEN: { label: '認証トークンを貼り付ける', name: '認証トークン' },
    TWILIO_PHONE_NUMBER: { label: 'SMS を送る電話番号を入力する', name: 'SMS を送る電話番号' },
    WEBHOOK_ENABLED: { label: 'オンにする', name: 'オンにする' },
    WEBHOOK_PORT: { label: '待ち受けるポートを入力する', name: '待ち受けるポート' },
    WEBHOOK_SECRET: { label: '署名シークレットを貼り付ける', name: '署名シークレット' },
    WECOM_BOT_ID: { label: 'グループロボットのキーを貼り付ける', name: 'グループロボットのキー' },
    WECOM_CALLBACK_AGENT_ID: { label: 'エージェント ID を入力する', name: 'エージェント ID' },
    WECOM_CALLBACK_CORP_ID: { label: '企業 ID を入力する', name: '企業 ID' },
    WECOM_CALLBACK_CORP_SECRET: { label: 'アプリシークレットを貼り付ける', name: 'アプリシークレット' },
    WECOM_CALLBACK_ENCODING_AES_KEY: { label: 'メッセージ暗号化キーを貼り付ける', name: 'メッセージ暗号化キー' },
    WECOM_CALLBACK_TOKEN: { label: 'コールバックトークンを貼り付ける', name: 'コールバックトークン' },
    WECOM_SECRET: { label: 'アプリシークレットを貼り付ける', name: 'アプリシークレット' },
    WEIXIN_ACCOUNT_ID: { label: 'アカウント ID を入力する', name: 'アカウント ID' },
    WEIXIN_BASE_URL: { label: 'サーバーのアドレスを入力する', name: 'サーバーのアドレス' },
    WEIXIN_TOKEN: { label: 'アクセストークンを貼り付ける', name: 'アクセストークン' },
    WHATSAPP_DM_POLICY: { label: '直接メッセージを送れる人を選ぶ', name: '直接メッセージを送れる人' }
  },
  platformIntro: {
    api_server: 'アクセスキーを設定し、Open WebUI、LobeChat などの OpenAI 互換アプリを表示されたアドレスに向けます。',
    bluebubbles:
      'iMessage にサインインした Mac で BlueBubbles Server を動かします。次にそのアドレスとサーバーのパスワードを入力します。',
    dingtalk:
      '開発者コンソールで DingTalk アプリを作成します。次にクライアント ID とクライアントシークレットをここにコピーします。',
    discord:
      'Discord Developer Portal でアプリケーションを作成し、ボットを追加してトークンをコピーします。次にボットをサーバーに招待します。',
    email:
      'エージェント専用のメールボックスを使います。Gmail の場合はアプリパスワードを作成し、Gmail のメールサーバーを使います。',
    feishu:
      'ボット機能を有効にした Feishu または Lark のアプリを作成します。次にアプリ ID、アプリシークレット、イベントキーをコピーします。',
    homeassistant:
      'Home Assistant でプロフィールを開き、長期アクセストークンを作成します。Home Assistant のアドレスと一緒にここに貼り付けます。',
    matrix:
      'ボットアカウントでホームサーバーにサインインします。次にアクセストークン、ユーザー ID、ホームサーバーのアドレスをコピーします。',
    mattermost:
      'Mattermost サーバーでボットアカウントまたは個人用アクセストークンを作成します。次にサーバーのアドレスとトークンをここに貼り付けます。',
    qqbot: 'QQ オープンプラットフォームでアプリを登録します。次にアプリ ID とクライアントシークレットをコピーします。',
    signal:
      'このコンピューターから届く場所で Signal ブリッジを動かします。次にそのアドレスと登録済みの電話番号を入力します。',
    slack:
      'Slack アプリを作成し、Socket Mode をオンにしてワークスペースにインストールします。次にボットトークンとアプリトークンをコピーします。',
    sms: 'Twilio コンソールでアカウント SID と認証トークンをコピーし、SMS を送れる電話番号を選びます。',
    telegram:
      'Telegram で @BotFather にメッセージを送り、新しいボットを作成して表示されたトークンをコピーします。次に @userinfobot で数字のユーザー ID を確認します。',
    webhook: '他のサービスは表示されたアドレスにイベントを送ります。シークレットで各イベントが本物か確認します。',
    wecom:
      'WeCom でグループロボットを追加し、Webhook キーをコピーします。送信のみです。双方向には WeCom（アプリ）を選びます。',
    wecom_callback:
      'コールバックアドレスを持つ自分の WeCom アプリを設定します。次に企業 ID、シークレット、エージェント ID、AES キーを入力します。',
    weixin:
      'プラットフォームをオンにし、個人の WeChat アカウントで QR コードを確認します。サインインは次回のために保存されます。',
    whatsapp: 'プラットフォームをオンにし、最初の接続時に WhatsApp で QR コードを読み取ります。'
  },
  platformSummary: {
    a2a: '他のエージェントがあなたのエージェントと直接話せます。',
    api_server: '他のチャットアプリから、エージェントを OpenAI のモデルのように使えます。',
    bluebubbles: 'BlueBubbles サーバー経由で、iMessage でエージェントと話せます。',
    buzz: 'Buzz 経由でエージェントと話せます。',
    dingtalk: 'DingTalk のグループでエージェントと話せます。',
    discord: 'Discord のメッセージ、チャンネル、スレッドでエージェントと話せます。',
    email: 'メールでエージェントに書き、返信を受け取れます。',
    feishu: 'Feishu または Lark の中でエージェントと話せます。',
    google_chat: 'Google Chat でエージェントと話せます。',
    homeassistant: 'Home Assistant を通じて、エージェントがスマートホームを操作できます。',
    irc: 'IRC のチャンネルまたはプライベートメッセージでエージェントと話せます。',
    line: 'LINE でエージェントと話せます。',
    matrix: 'Matrix のルームとダイレクトメッセージでエージェントと話せます。',
    mattermost: 'Mattermost のチャンネルとダイレクトメッセージでエージェントと話せます。',
    msgraph_webhook: 'Microsoft 365 が新しい会議やメールをエージェントに知らせます。',
    ntfy: 'ntfy の通知でエージェントと話せます。',
    photon: 'Photon の管理サービス経由で、iMessage でエージェントと話せます。',
    qqbot: 'QQ ボット経由でエージェントと話せます。',
    raft: 'エージェントが Raft のワークスペースに参加できます。',
    relay: 'テスト中の中継サービス経由でエージェントを接続します。',
    signal: '自分で動かす Signal ブリッジ経由で、Signal でエージェントと話せます。',
    simplex: 'SimpleX Chat でエージェントとプライベートに話せます。',
    slack: 'Slack で、許可したメンバーだけがエージェントと話せます。',
    sms: 'Twilio 経由の SMS でエージェントにメッセージを送り、返信を受け取れます。',
    teams: 'Microsoft Teams のチャットでエージェントと話せます。',
    telegram: 'Telegram のチャット、グループ、トピックでエージェントと話せます。',
    webhook: 'GitHub、GitLab などのサービスがエージェントにイベントを送れます。',
    wecom: 'エージェントが WeCom のグループに投稿できます。返信は受け取りません。',
    wecom_callback: '自分のアプリを通じて、WeCom でエージェントと双方向に話せます。',
    weixin: '個人の WeChat アカウントからエージェントと話せます。',
    whatsapp: '一度 QR コードを読み取れば、WhatsApp でエージェントと話せます。',
    whatsapp_cloud: 'Meta がホストする WhatsApp サービス経由でエージェントと話せます。',
    yuanbao: 'Tencent Yuanbao でエージェントと話せます。'
  },
  noPlatforms: 'メッセージ プラットフォームが見つかりません',
  noMatch: query => `「${query}」に一致するプラットフォームはありません`,
  draftSecretNotKept: '下書きには保存されません — もう一度入力してください:',
  pendingRequests: count => `保留中のリクエスト (${count})`,
  pendingAria: count => `保留中のペアリングリクエスト ${count} 件`,
  approvedUsers: count => `承認済みのユーザー (${count})`,
  approve: '承認',
  approving: '承認中...',
  revoke: '取り消す',
  revoking: '取り消し中...',
  revokeAria: name => `${name} のアクセスを取り消す`,
  revokeTitle: 'アクセスを取り消す',
  revokeDesc: name => `${name} はアクセスを失い、次のメッセージから認識されなくなります。`,
  approvedUser: name => `${name} を承認しました`,
  approvedHint: '次のメッセージから自動で認識されます。',
  revokedUser: name => `${name} のアクセスを取り消しました`,
  failedApprove: name => `${name} を承認できませんでした`,
  failedRevoke: name => `${name} のアクセスを取り消せませんでした`,
  pairingLockedOut:
    '承認の失敗が多すぎるため、このプラットフォームはロックされています。しばらくしてからもう一度お試しください。',
  waitingSince: minutes => (minutes < 1 ? 'たった今' : `${minutes} 分前`)
}
