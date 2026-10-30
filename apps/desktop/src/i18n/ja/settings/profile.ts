import type { TranslationOverrides } from '../../define-locale'
import type { SettingsProfileTranslations } from '../../types/settings/profile'

export const settingsProfile: Pick<NonNullable<TranslationOverrides['settings']>, keyof SettingsProfileTranslations> = {
  credentials: {
    pasteKey: 'キーを貼り付け',
    pasteLabelKey: label => `${label} キーを貼り付け`,
    optional: '省略可能',
    enterValueFirst: '最初に値を入力してください。',
    couldNotSave: '認証情報を保存できませんでした。',
    remove: '削除',
    getKey: 'キーを取得',
    saving: '保存中'
  },
  envActions: {
    actions: 'アクション',

    manageInKeys: 'API キーで管理',
    docs: 'ドキュメント',
    hideValue: '値を非表示',
    revealValue: '値を表示',
    replace: '置き換え',
    set: '設定'
  },
  keys: {
    failedLoad: 'API キーの読み込みに失敗しました',
    empty: 'このカテゴリーにはまだ設定がありません。'
  },
  providers: {
    connectAccount: 'アカウントを接続',
    haveApiKey: 'API キーをお持ちですか？',
    intro:
      'お持ちのアカウントでサインインします。キーのコピーは不要です。サインインはブラウザーで開き、ここで完了します。',
    connected: '接続済み',
    collapse: '折りたたむ',
    connectAnother: '別のプロバイダーを接続',
    otherProviders: 'その他のプロバイダー',
    claudeSubscription: 'Claude サブスクリプション（追加の利用クレジットが必要）',
    removeKeyManaged: provider => `${provider} は API キーで設定されています。API Keys から削除してください。`,
    removedTitle: 'アカウントを削除しました',
    removedMessage: provider => `${provider} を削除しました。`,
    noProviderKeys: '利用可能なプロバイダー API キーがありません。',
    searchKeys: 'プロバイダーを検索…',
    noKeysMatch: '一致するプロバイダーがありません。',
    manage: provider => `${provider} を管理`,
    endpoints: {
      heading: '自分のモデルサーバー',
      addHeading: 'サーバーを追加',
      editHeading: 'このサーバーを編集',
      name: 'このサーバーの呼び名',
      nameHint: 'モデルを選ぶときに表示される名前です。',
      providerId: 'このサーバーの短い ID',
      providerIdHint: '小文字・数字・ハイフンで。アプリがサーバーを区別するために使います。',
      url: 'サーバーの応答先',
      urlHint: 'Web アドレスです。OpenAI 互換サーバーは通常 /v1 で終わります。',
      model: '既定で応答するモデル',
      context: 'モデルが覚えておける会話の量',
      contextHint: '「自動」のままにすると、アプリがサーバーに問い合わせます。',
      apiKey: 'サーバーが求めるキー',
      apiKeyHint: 'サーバーが求める場合のみ。',
      useForNewChats: '新しいチャットをこのサーバーで始める',
      discoverModels: 'テスト時に提供モデルを探す',
      discoverModelsHint: '見つかった一覧が上のモデル欄に入ります。'
    },
    featuredPitch: '1 つのサブスクリプションで 300 以上の先端モデルを使えます。',
    moreFields: count => `その他の設定（${count}）`,
    localEndpoint: {
      title: '自分のモデルサーバーを使う',
      description: 'vLLM、llama.cpp、Ollama など、OpenAI 互換のサーバーならどれでも使えます。',
      action: '設定する'
    },
    disconnect: '切断',
    disconnectInTerminal: '切断（ターミナルで削除コマンドを実行します）',
    removeExternalGeneric: provider => `${provider} は専用の CLI で管理されています。そちらで削除してください。`,
    removeTerminalRunning: provider => `ターミナルで ${provider} の切断を実行しています…`
  }
}
