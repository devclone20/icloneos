/** The words of the Billing Settings pane (front I-C, 2026-10-20). */
import type { BillingSettingsCopy } from '../en/billingSettings'

export const jaBillingSettings: BillingSettingsCopy = {
  sections: {
    plan: 'ご利用中のプラン',
    payment: '支払い方法とクレジット',
    usage: '残高と利用状況',
    invoices: '請求書'
  },
  providerBilling: {
    title: '請求は接続したモデルプロバイダーで行われます',
    hint: 'このアプリは追加したキーで動くため、使用量と費用はそのプロバイダー側にあります。Nous Portal のサブスクリプションにサインインすると、プランと使用量がここに表示されます。',
    openProviders: 'プロバイダーを開く'
  },
  empty: {
    title: 'この接続には請求するものがありません',
    hint: '請求は Nous Portal がホストするアカウントに属します。このアプリはご自身のキーで動作しているため、ここで計測や請求するものはありません。利用量と費用はモデルプロバイダー側で管理されます。'
  },
  summary: {
    balance: '残高',
    plan: 'プラン',
    refill: '自動チャージ',
    enabled: '有効',
    off: 'オフ'
  },
  notice: {
    openPortal: 'ポータルを開く ↗',
    noCardTitle: '支払い方法が登録されていません',
    noCardMessage: 'カードが登録されるまで、クレジットの購入と自動チャージは使えません。ポータルで追加してください。',
    addCard: 'カードを追加 ↗'
  },
  payment: {
    title: 'お支払いに使うカード',
    hint: 'チャージとサブスクリプションの更新に使われます。',
    noneHint: 'まだカードが登録されていません。',
    add: '支払い方法を追加',
    update: '更新'
  },
  buy: {
    title: '今すぐクレジットを購入',
    hint: 'カードへの 1 回の請求で、今日の残高に加算されます。',
    action: '購入',
    customAmount: '任意のクレジット額'
  },
  refill: {
    title: '残高が少なくなったら自動でチャージします',
    generic: '残高がしきい値を下回ったら自動で補充します。',
    manage: '管理',
    manageOnPortal: '自動チャージはポータルで管理します。',
    turnOnPortal: '自動チャージはポータルでオンにします',
    reconcile: '照合 ↗',
    differentCard: '別のカード',
    threshold: '自動チャージのしきい値',
    reloadTo: '自動チャージの補充額',
    distinctCaption: (card: string) => `自動チャージは ${card} に請求されます。ポータルで照合してください`,
    charges: (reloadTo: string, threshold: string) =>
      `残高が ${threshold} を下回ると、自動で ${reloadTo} を請求します。`
  },
  plan: {
    currentTitle: (tier: string) => `${tier} プランをご利用中です`,
    free: '無料',
    unavailable: 'サブスクリプションの詳細を取得できませんが、ポータルは開けます。',
    noSubscription: '有効なサブスクリプションはありません。有料モデルはチャージ済みクレジットを消費します。',
    change: 'プランを変更',
    view: 'プランを見る',
    adjust: 'プランを調整 ↗',
    choose: '選択 ↗',
    back: '請求に戻る',
    changesTo: (tier: string, when: string) => `${when} に ${tier} へ変更されます。`,
    cancels: (when: string) => `${when} に解約されます。`,
    renews: (date: string) => `${date} に更新`
  },
  usage: {
    left: (left: string, total: string) => `${total} のうち残り ${left}`,
    over: (amount: string) => `${amount} 超過`,
    used: (spent: string, limit: string) => `${limit} のうち ${spent} 使用`,
    subscriptionRemaining: 'サブスクリプションの残りクレジット',
    subscription: 'サブスクリプションで残っているクレジット',
    noExpiry: '有効期限はありません。',
    topup: 'ご自身で購入したクレジット',
    capUsed: '月間利用上限の使用量',
    defaultCeiling: 'アカウントの既定の上限です。',
    monthlyRemote: 'このアプリで毎月使う金額を数えます。',
    cap: '月間上限のうち使った金額',
    resets: (date: string) => `${date} にリセット`
  },
  header: '請求',
  actions: {
    save: '保存',
    saving: '保存中…',
    cancel: 'キャンセル',
    undo: '元に戻す',
    undoing: '元に戻しています…',
    tryAgain: 'もう一度試す',
    dismiss: '閉じる',
    openPortal: 'ポータルを開く',
    verify: '確認して続ける',
    openVerification: '確認ページを開く',
    turnOff: 'オフにする'
  },
  status: {
    processing: '支払いを処理しています…',
    added: (amount: string) => `${amount} を追加しました。残高を更新しています。`,
    waitingLink: '確認リンクを待っています…'
  },
  autoRefill: {
    thresholdShort: '下回ったら',
    reloadToShort: 'チャージ後の残高',
    confirmOff: '自動チャージをオフにしますか？',
    updated: '自動チャージを更新しました。',
    turnedOff: '自動チャージをオフにしました。',
    thresholdName: 'しきい値',
    reloadToName: 'チャージ額',
    badFormat: (name: string) => `${name}には小数点以下 2 桁までのドル金額を入力してください。`,
    notPositive: (name: string) => `${name}は $0 より大きくしてください。`,
    belowMin: (name: string, min: string) => `${name}は ${min} 以上にしてください。`,
    aboveMax: (name: string, max: string) => `${name}は ${max} 以下にしてください。`,
    order: 'チャージ額はしきい値より大きくしてください。'
  },
  provenance: {
    autoRefill: '自動チャージに使用',
    customerDefault: '既定のカード',
    subPin: 'サブスクリプションに使用'
  },
  plans: {
    titleUpgrade: (tier: string) => `${tier} プランにアップグレードする`,
    titleDowngrade: (tier: string) => `${tier} プランにダウングレードする`,
    titleScheduled: (tier: string) => `今期の終わりに ${tier} プランへ切り替わります`,
    title: 'プラン',
    empty: '現在、変更できる他のプランはありません。',
    current: '現在のプラン',
    scheduled: '予定済み',
    downgrade: 'ダウングレード',
    checking: 'この変更を確認しています…',
    blocked: 'この変更はここでは行えません。',
    noOp: (tier: string) => `すでに ${tier} をご利用中のため、変更はありません。`,
    scheduledChange: (tier: string, when: string) =>
      `${when} に ${tier} へ変更されます。今は請求されず、それまでは現在のプランをご利用いただけます。`,
    creditsChange: (delta: string) => `月間クレジットが ${delta} 変わります。`,
    cannotSchedule: 'この変更はここでは予約できません。',
    confirm: 'ダウングレードを確定',
    scheduling: '予約しています…',
    perMonth: (amount: string) => `${amount}/月`,
    creditsPerMonth: (amount: string) => `毎月 ${amount} 分のクレジット`
  },
  refusal: {
    consentTitle: 'ポータルでこのカードを承認してください',
    consentMessage: 'このアプリがカードに請求する前に、ポータルでの承認が必要です。',
    scopeTitle: 'まずこのデバイスでの支出を許可してください',
    scopeMessage: 'チャージを開始してこのデバイスからの支出を許可し、もう一度お試しください。',
    stoppedTitle: 'このデバイスからの支出は停止されました',
    stoppedByAdmin: '管理者がこのデバイスからの支出を停止しました。許可するには再度サインインしてください。',
    stoppedByYou: 'このデバイスからの支出を停止しました。許可するには再度サインインしてください。',
    sessionTitle: 'サインアウトされました',
    sessionMessage: '請求を引き続き使うには、再度サインインしてください。',
    disabledTitle: 'このアプリからの支出はオフになっています',
    disabledMessage: '請求管理者がポータルからオンにできます。',
    roleTitle: '資金を追加できるのは管理者のみです',
    roleMessage: '組織の管理者またはオーナーに依頼するか、ポータルで請求を管理してください。',
    conflictTitle: '新しいチャージを開始してください',
    conflictMessage: 'このチャージは別の金額ですでに使用されています。新しく開始してください。',
    noCardTitle: 'まずポータルでカードを保存してください',
    noCardMessage: '一度だけのクレジット購入では再利用できるカードは保存されません。ポータルで追加してください。',
    orgTitle: 'この組織は管理できません',
    orgMessage: 'このサインインは、あなたが管理する組織に紐づいていません。',
    capTitle: '月間の支出上限に達しました',
    capMessage: 'ポータルで上限を引き上げるか、リセットされるまでお待ちください。',
    capRemaining: (amount: string) => `月間上限まであと ${amount} です。`,
    busyTitle: '同時に請求が多すぎます',
    busyMessage: '支払いの失敗ではありません。少し待ってからもう一度お試しください。',
    retryIn: (minutes: number) => `約 ${minutes} 分後にもう一度お試しください。`,
    paymentServiceTitle: '決済サービスに問題が発生しています',
    paymentServiceMessage: '少し待ってからもう一度お試しください。',
    planLimitTitle: '本日はプランの変更回数が多すぎます',
    planLimitMessage: '明日もう一度お試しください。',
    unavailableTitle: 'ここでは請求を利用できません',
    unavailableMessage: 'この接続は請求に対応していません。後でもう一度お試しください。',
    timeoutTitle: '請求の応答に時間がかかりすぎました',
    timeoutMessage: '接続を確認して、もう一度お試しください。',
    offlineTitle: '請求に接続できませんでした',
    offlineMessage: '接続を確認して、もう一度お試しください。',
    failedTitle: 'この請求リクエストを完了できませんでした',
    failedMessage: '少し待ってからもう一度お試しください。'
  },
  charge: {
    added: (amount: string) => `${amount} を残高に追加しました。`,
    addedGeneric: 'クレジットを残高に追加しました。',
    failedTitle: '支払いが完了しませんでした',
    bankCheck: '銀行による支払いの確認が必要です。ポータルで完了してください。',
    expired: 'カードの有効期限が切れています。ポータルで更新してください。',
    declined: 'カードが拒否されました。ポータルで別のカードをお試しください。',
    failedGeneric: 'もう一度試すか、ポータルで別のカードをお使いください。',
    unconfirmedTitle: '前回の支払いはまだ確認されていません',
    unconfirmed: 'もう一度試す前に、ポータルで残高をご確認ください。',
    checkFailedTitle: '支払いを確認できませんでした',
    untrackedTitle: 'この支払いは追跡できません',
    untrackedMessage: '支払いは受け付けられましたが追跡できません。ポータルで残高をご確認ください。',
    slowTitle: '支払いはまだ処理中です',
    slowMessage: 'まだ完了する可能性があります。もう一度試す前にポータルをご確認ください。'
  },
  stepUp: {
    deniedTitle: '確認は承認されませんでした',
    deniedMessage: 'このデバイスからの支出はまだ許可されていません。',
    doneTitle: '確認が完了しました',
    doneMessage: 'このデバイスからアカウントで支出できるようになりました。'
  },
  devFixture: '請求プレビュー用データ (開発専用)'
}
