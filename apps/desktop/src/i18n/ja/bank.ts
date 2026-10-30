import type { TranslationOverrides } from '../define-locale'

export const bank: TranslationOverrides['bank'] = {
  card: {
    cardholder: 'カード名義人',
    tapToFlip: 'タップして裏返す',
    spendLimit: '利用上限',
    lastSpendLimit: '前回の利用上限',
    spent: '利用額',
    status: 'ステータス',
    funding: '支払元',
    active: '有効',
    locked: 'ロック中',
    notSignedUp: '未登録',
    signedOut: 'サインアウト済み',
    showFront: 'カードの表を表示',
    showBack: 'カードの裏を表示'
  },
  gate: {
    notSetUpLabel: 'AgentCard — 未設定',
    signedOutLabel: 'AgentCard — サインアウト済み',
    signInRequiredLabel: 'AgentCard — サインインが必要',
    noCardTitle: 'カードはまだありません',
    noCardHint: agentName =>
      `AgentCard を一度設定すれば、${agentName} は自分の購入を支払えます。上限はあなたが承認し、決済はエージェントが行います。`,
    stepSignUp: 'サインアップ',
    stepSignUpHint: 'エージェントの AgentCard アカウントを作成します。',
    stepVerify: '確認',
    stepVerifyHint: 'サインインリンクがエージェント自身の受信箱に届きます。',
    stepPayment: '支払い方法',
    stepPaymentHint: 'カードまたはウォレットを連携して入金します。',
    stepLimit: '上限',
    stepLimitHint: 'あなたに確認せずに使える金額を設定します。',
    openSetup: 'セットアップを開く',
    signInRequired: 'サインインが必要です',
    useCardAgain: 'カードを使うには Virtuals に再度サインインしてください',
    readCardAgain: 'AgentCard を読み込むには Virtuals に再度サインインしてください',
    signInAgain: '再度サインイン',
    linkSentAgo: ago => `${ago}に送信`,
    resendLink: 'リンクを再送信',
    resendIn: seconds => `${seconds} 秒後に再送信`,
    agentInbox: agentName => `${agentName} の受信箱`,
    linkSentCardKnown: 'AgentCard に再度サインインしてください — サインインリンクを {target} に送信しました',
    linkSent:
      'サインインリンクを {target} に送信しました — メールアプリを開いてリンクをクリックし、セットアップを続けてください。',
    askFetchLink: agentName => `${agentName} にリンクを取得させる`,
    otherPath:
      'AgentCard の設定方法は 2 つあります。ここのセットアップでは Virtuals 経由でこのエージェントのカードを設定します（acp card）。もう 1 つはターミナルでのご自身の AgentCard アカウントです — agentcard signup の後、agentcard setup と KYC 用の agentcard identity を実行します。この 2 つは別々のアカウントです。',
    agentcardAccount: {
      signedOut: 'ご自身の AgentCard アカウントはサインアウトしています。',
      kycRequired: 'ご自身の AgentCard アカウントには本人確認（KYC）が必要です。',
      ready: 'ご自身の AgentCard アカウントは準備完了です。'
    },
    linkNotRecorded: '何も送信されていません — 送信前の記録を保存できませんでした'
  },
  notice: {
    tryAgain: '再試行'
  },
  account: {
    label: 'アカウント',
    unavailable: reason => `プロフィールを取得できません — ${reason}`,
    onFileHidden: 'プロフィールは登録済み — 詳細は表示されません。',
    noName: '名前は未登録',
    noPhone: '電話番号は未登録',
    needsNamePhone: 'AgentCard で決済するには名前と電話番号が必要です。',
    changeInSetup: 'セットアップで変更'
  },
  stats: {
    reading: '読み込み中…',
    notSet: '未設定',
    limitLeft: (left, total) => `残り ${left} / ${total}`,
    openRequests: '未処理のリクエスト',
    reviewFirst: '最初のものを確認',
    nothingWaiting: '待機中のものはありません',
    codesWaiting: '待機中の 3DS コード',
    codesLive: '有効 — 残り数分'
  },
  toolbar: {
    changeLimit: '上限を変更',
    issueCard: '購入用のカードを発行',
    readOnly: agentName => `AgentCard · 読み取り専用 — 発行は ${agentName} を通して行います`
  },
  requests: {
    title: '支払いリクエスト',
    tabOpen: '未処理',
    tabAll: 'すべて',
    showAll: 'すべて表示',
    nothingOpenTitle: '未処理のものはありません',
    nothingOpenHint: agentName =>
      `${agentName} のリクエストはすべて処理済みです — あなたの対応を待つものはありません。`,
    emptyTitle: '支払いリクエストはまだありません',
    emptyHint: (agentName, action) =>
      `${agentName} が何かを支払うと、そのリクエストがここに表示されます。「${action}」で始めましょう。`,
    colRequest: 'リクエスト',
    colCaptured: '確定額',
    colStatus: 'ステータス',
    colIssued: '発行',
    colExpires: '有効期限',
    expires: ago => `期限 ${ago}`,
    updated: ago => `更新: ${ago}`
  },
  detail: {
    title: '支払いリクエスト',
    close: 'リクエストを閉じる',
    request: 'リクエスト',
    amount: '金額',
    status: 'ステータス',
    created: '作成',
    issued: '発行',
    captured: '確定額',
    capturedAt: '確定日時',
    expires: '有効期限',
    card: 'カード'
  },
  codes: {
    title: '3DS コード',
    active: count => `${count} 件有効`,
    none: '現在 3DS コードはありません — エージェントが決済を始めると、コードが約 5 分間ここに表示されます。',
    left: time => `残り ${time}`,
    expired: '期限切れ',
    amountNotGiven: '金額の情報なし'
  },
  checking: 'カードを確認中…',
  agentFallback: 'あなたのエージェント'
}
