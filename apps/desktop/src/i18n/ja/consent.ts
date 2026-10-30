// iCLONE OS — first-launch consent sheet + Settings › Privacy, Japanese (U2-p2b-01).
// The policy text itself stays English and binding; these are the sheet's own words.
import { type ConsentBank, PRODUCT_NAME } from '@/i18n/en/enConsent'

export const jaConsent: ConsentBank = {
  sheet: {
    eyebrow: (title, version, effective) => `${title} · バージョン ${version} · 発効日 ${effective}`,
    termsTitle: 'はじめる前に',
    termsLead: `${PRODUCT_NAME} はこの Mac であなたのエージェントを動かします。データの扱い方の要約です。`,
    updateTitle: 'ポリシーが変わりました',
    updateLead: `${PRODUCT_NAME} を使い続けるには、新しいバージョンを読んで同意してください。保存済みの権限の選択はそのまま残ります。`,
    readFull: 'ポリシー全文を読む',
    readOffline: 'オフラインで読む',
    hideOffline: '全文を閉じる',
    offlineUnavailable: '同梱のコピーを読めませんでした。ポリシー全文は cloneframe.io/privacy にあります。',
    policyLanguage: 'ポリシーは英語で書かれています。拘束力を持つのは英語版です。',
    aiDisclosure:
      'AI プロバイダーを接続すると、メッセージ、ファイル、ペルソナとメモリー、画面を含むツールの結果が、この Mac からそのプロバイダーへ直接送られます（ポリシー §5）。',
    accept: (title, version) => `${title} v${version} を読み、接続する AI プロバイダーへの送信を含めて同意します`,
    quit: '終了',
    continue: '続ける',
    permissionsEyebrow: '権限',
    permissionsTitle: `この Mac であなたのエージェントと ${PRODUCT_NAME} ができること`,
    permissionsFooter:
      '今 macOS に何かを求めることはありません。機能が必要とした時にだけシステムが確認します。設定 › プライバシー、またはシステム設定 › プライバシーとセキュリティでいつでも変えられます。',
    acceptHint: '続けるにはポリシーに同意してください',
    keychainLine: on =>
      on
        ? 'ゲートウェイのサインインは Mac のキーチェーンで暗号化されます。macOS が一度だけ許可を求めることがあります。'
        : 'ゲートウェイのサインインは、キーチェーンの暗号化なしでこの Mac に保存されます。',
    keychainChange: '設定 › ゲートウェイで変えられます。macOS がそこで再び確認することがあります。',
    skip: '今はスキップ',
    allowAll: 'すべて許可',
    allAllowed: 'すべて許可済み',
    allowAllKeychainTitle: 'キーチェーンは変わりません',
    allowAllKeychain:
      '「すべて許可」はキーチェーンを変えません。保存済みのシークレットは設定 › ゲートウェイの設定のまま（暗号化なし）です。暗号化はそこでオンにしてください。',
    saving: '保存中…',
    saveFailed: '選択を保存できませんでした。もう一度お試しください。',
    step: (n, total) => `ステップ ${n} / ${total}`
  },
  groups: {
    capabilities: 'エージェントの能力',
    capabilitiesHint:
      'エージェントは起動時に各選択を伝えられます。オフにしたものがタスクに必要になると、まずここであなたに尋ねます。',
    device: 'デバイス',
    deviceHint: 'macOS は機能が必要とした時にだけ確認します。',
    neverUsed: '使いません',
    neverUsedHint: `ご参考まで：${PRODUCT_NAME} はこれらを使いません。`
  },
  rows: {
    terminal: {
      name: 'ターミナルコマンド',
      purpose:
        'あなたのユーザーアカウントの権限で、エージェントがターミナルのコマンドを実行できるようにします。実行内容は確認できます。'
    },
    fileWriting: {
      name: 'ファイルの書き込み',
      purpose: 'タスクのために、エージェントがこの Mac 上でファイルを作成・変更できるようにします'
    },
    webBrowsing: {
      name: 'ウェブ閲覧とネットワーク通信',
      purpose:
        'エージェントがあなたの代わりにウェブを閲覧したりオンラインのツールを使ったりし、タスクに必要なものを送れるようにします'
    },
    installSoftware: {
      name: 'ソフトウェアとパッケージのインストール',
      purpose:
        'タスクに必要な時に、エージェントがツールやパッケージ（Homebrew、npm、pip）をインストールできるようにします'
    },
    scheduledTasks: {
      name: '予約タスク',
      purpose: 'エージェントがこの Mac で後で実行されるジョブを作れるようにします'
    },
    sendMessages: {
      name: 'メールとメッセージの送信',
      purpose: 'エージェントがあなたの代わりにエージェントメールを送れるようにします'
    },
    spendTrade: {
      name: '支出と取引',
      purpose:
        'あなた自身が与えた承認の範囲内でのみ、エージェントがカードの上限内で支出し、マーケットの仕事を受け、取引できるようにします'
    },
    microphone: { name: 'マイク', purpose: '音声ボタンでエージェントに話しかけられるようにします' },
    screen: { name: '画面', purpose: 'タスクのために、エージェントがスクリーンショットや録画を取れるようにします' },
    automation: {
      name: '他のアプリの操作',
      purpose: 'タスクのために、エージェントが他のアプリを操作できるようにします'
    },
    notifications: { name: '通知', purpose: `${PRODUCT_NAME} がチャットとエージェントの通知を表示できるようにします` },
    clipboard: {
      name: 'クリップボード',
      purpose: 'タスクのために、エージェントがクリップボードを読み書きできるようにします'
    },
    keychain: { name: 'キーチェーン', purpose: 'ゲートウェイのサインインを Mac のキーチェーンで暗号化します' }
  },
  neverUsed: {
    camera: { name: 'カメラ', line: 'このアプリはカメラを使いません。' },
    location: { name: '位置情報', line: 'このアプリは位置情報を使いません。' },
    contacts: { name: '連絡先', line: 'このアプリは連絡先を使いません。' }
  },
  effect: {
    terminal: 'オフ：エージェントにターミナルコマンドを実行しないよう伝えます。',
    fileWriting:
      'オフ：エージェントにファイルを作成・変更・削除しないよう伝えます。選んだフォルダーの読み取りには影響しません。',
    webBrowsing: 'オフ：エージェントにウェブを閲覧したりオンラインのツールを呼んだりしないよう伝えます。',
    installSoftware: 'オフ：エージェントにソフトウェアやパッケージをインストールしないよう伝えます。',
    scheduledTasks: 'オフ：エージェントに予約タスクを作らないよう伝えます。',
    sendMessages: 'オフ：エージェントにあなたの代わりにメールやメッセージを送らないよう伝えます。',
    spendTrade: 'オフ：エージェントにあなた抜きで価値を動かさないよう伝えます。',
    microphone: 'オフ：音声ボタンはオフのままで、macOS に確認を求めることはありません。',
    screen:
      'オフ：アプリは他のアプリのウィンドウタイトルを伏せ、エージェントにスクリーンショットや録画を取らないよう伝えます。',
    automation: 'オフ：エージェントに他のアプリを操作しないよう伝えます。',
    notifications: `オフ：${PRODUCT_NAME} はチャットやエージェントの通知を表示しません。`,
    clipboard: 'オフ：エージェントにクリップボードを使わないよう伝えます。あなた自身のコピーと貼り付けは常に使えます。',
    keychain:
      'ゲートウェイのサインイン情報はこの Mac にあります。キーチェーンで暗号化されているかはこの行の横に表示され、設定 › ゲートウェイで変えられます。'
  },
  settings: {
    nav: 'プライバシー',
    policyHeading: 'ポリシー',
    policyRow: version => `${PRODUCT_NAME} ポリシーとプライバシー v${version}`,
    effective: date => `発効日 ${date}`,
    accepted: date => `同意日 ${date}`,
    acceptedOlder: version => `v${version} に同意済み`,
    notAccepted: '未同意',
    openLive: '公開ページを開く',
    readOffline: 'オフラインで読む',
    hideOffline: '全文を閉じる',
    permissionsHeading: '権限',
    notConfigured: '未設定',
    notConfiguredHint:
      'このステップをスキップしました。選ぶまでは、機能が権限を必要とした時にだけ macOS が確認します。',
    permissionsFooter: `スイッチは ${PRODUCT_NAME} が使ってよいものを記録します。機能が初めて権限を必要とする時には、macOS が改めて確認します。`,
    requestsHeading: 'エージェントからのリクエスト',
    requestsEmpty: 'まだリクエストはありません。オフにした権限がタスクに必要になると、エージェントがここで尋ねます。',
    requestAnswer: { always: '常に許可', once: '一度だけ許可', denied: '拒否', timeout: '応答なし' },
    requestBy: (inft, date) => `${inft} · ${date}`,
    keychainState: on => (on ? '暗号化済み' : '暗号化なし'),
    keychainOpen: 'ゲートウェイ設定を開く',
    aiHeading: 'AI プロバイダー',
    aiRow: '接続した AI プロバイダーが受け取るもの',
    aiRowDesc:
      'メッセージ、ファイル、ペルソナとメモリー、画面を含むツールの結果が、この Mac から接続したプロバイダーへ直接送られます（ポリシー §5）。',
    aiWithdrawn: date => `撤回日 ${date}`,
    aiNotRecorded: '記録なし',
    aiWithdrawnHint: `${PRODUCT_NAME} は撤回した日付を保持します。接続中のプロバイダーを自動で切ることはありません。送信を止めるには設定でプロバイダーを切断してください。`,
    aiAcceptAgain: '再び同意する',
    openProviders: 'プロバイダーを開く',
    withdraw: 'AI プロバイダーへの同意を撤回',
    withdrawTitle: 'AI プロバイダーへの同意を撤回しますか？',
    withdrawDesc: `${PRODUCT_NAME} は撤回した日付を記録します。接続中のプロバイダーを自動で切ることはありません。送信を止めるには設定でプロバイダーを切断してください。`,
    withdrawConfirm: '撤回する',
    saveFailed: '保存できませんでした。もう一度お試しください。',
    unavailable: 'プライバシー設定はデスクトップアプリで利用できます。'
  },
  door: {
    eyebrow: inft => `権限のリクエスト · ${inft}`,
    title: name => `エージェントには「${name}」が必要です`,
    reasonLabel: '理由（エージェントの言葉で）',
    hint: `「一度だけ許可」は ${PRODUCT_NAME} を終了するまで有効です。「常に許可」は設定 › プライバシーのスイッチをオンにします。`,
    expires: '2 分以内に応答がなければ「拒否」とみなします。',
    deny: '拒否',
    once: '一度だけ許可',
    always: '常に許可'
  }
}
