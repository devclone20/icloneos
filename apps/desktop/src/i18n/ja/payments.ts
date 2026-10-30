// iclone os — V3-J 設定 › エコノミー › 支払い (ja)。
import type { PaymentsTranslations } from '../types/payments'

export const payments: PaymentsTranslations = {
  navLabel: '支払い',
  keywords: ['x402', 'USDC', '支出', '上限', '停止', 'マンデート'],
  intro:
    'エージェントが何に、誰に、1 日にいくらまで支払えるか。上限の引き上げや支払先の追加は先に確認します。引き下げはすぐに適用されます。',
  desktopOnly: '支払いはこの Mac に鍵を保管するデスクトップアプリで動作します。',
  status: {
    title: '状態',
    ready: '準備完了',
    off: 'オフ',
    readyHint: 'エージェントは、あなたが署名したマンデートのもとで、下の上限内で支払えます。',
    pocket: 'ポケットのアドレス',
    pocketHint: 'この Mac 上のエージェント用ウォレット。入金は 1 日の上限までにしてください。',
    noPocket: 'ポケットはまだありません',
    today: '本日の署名額 (UTC)',
    todayValue: (amount, cap) => `${cap} USDC 中 ${amount}`,
    ledgerBroken: '支払い記録を検証できません。修復されるまで、すべての支払いを拒否します。',
    unprotected: '保護されていないプロファイル',
    unprotectedHint:
      'アプリは、これらのプロファイルで支払いスキルがオフになっていることを確認できませんでした（フォルダまたは config.yaml が Hermes のホームの外にある、または読み書きできない）。これらのエージェントは支払えません。',
    notReady: {
      sealing_off:
        '支払いはオフです: キーチェーンの設定がオフのため、支払いキーを封印できません。支払いを使うには、設定 › マシン › ゲートウェイ ›「保存したパスワードをシステムのキーチェーンで保護する」 でキーチェーンをオンにしてください。',
      keys_unavailable: '封印された支払いキーを使えないため、支払いはオフです。',
      disabled: '支払いはオフです。',
      socket_down: 'エージェントが支払いに使う接続が動作していません。'
    }
  },
  caps: {
    title: '支出の上限',
    perTx: '1 回の支払い',
    perTxHint: 'これを超える 1 回の支払いは拒否されます。',
    perDay: '1 日',
    perDayHint: 'すべてのエージェントの合計、UTC の 1 日ごと。',
    perAgentDay: 'エージェントごと、1 日',
    perAgentDayHint: '各エージェント自身の上限。侵害されたエージェントが 1 日に使える最大額です。',
    save: '上限を保存',
    invalid: 'USDC の金額を小数点以下 6 桁までで入力してください。',
    note: '上限の引き上げは許可シートで確認します。引き下げはすぐに適用されます。'
  },
  stop: {
    title: '緊急停止',
    label: 'すべての支払いを停止',
    hint: '処理中のものも含め、すべての支払いを拒否します。オフにするときは許可シートで確認します。'
  },
  allowlist: {
    title: 'エージェントの支払先',
    payees: '支払先',
    payeesHint: 'エージェントが支払えるアドレス。1 件もなければ誰にも支払えません。',
    origins: 'サイト',
    originsHint: 'エージェントが支払い要求に応じてよいサイト。1 件もなければどれにも応じません。',
    add: '追加',
    remove: '削除',
    invalidPayee: 'アドレスではありません。0x の後に 16 進数 40 文字が必要です。',
    invalidOrigin: 'サイトのアドレスではありません。https:// か http:// で始めてください。',
    full: max => `リストがいっぱいです（${max} 件）。先に 1 件削除してください。`,
    listed: 'すでにリストにあります。',
    empty: 'まだありません',
    problems: {
      notList: list => `${list}: リストではありません。`,
      tooMany: (list, count, max) => `${list}: ${count} 件 (最大 ${max} 件)。`,
      entries: (list, entries, more) => `${list}: ${entries}${more > 0 ? ` (ほか ${more} 件)` : ''}`
    }
  },
  issue: {
    title: '新しいマンデート',
    intro:
      'マンデートは、1 つのエージェントに支払いを許可するあなたの署名です。合計額、1 回の額、支払先、期限を定めます。マンデートがなければエージェントは支払えません。',
    agent: 'エージェント',
    agentHint: 'エージェントのプロファイル名(例: inft-alpha)。',
    budget: '予算',
    budgetHint: 'このマンデートでの支払いの合計の上限。初期値はエージェントごとの 1 日の上限です。',
    min: '最小の支払い',
    max: '最大の支払い',
    rangeHint: '各支払いはこの範囲内でなければなりません。最大の初期値は 1 回あたりの上限です。',
    payees: '支払先',
    payeesHint: '上のリストにある支払先だけを選べます。',
    noPayees: 'まず上のリストに支払先を追加してください。',
    starts: '支払いの開始',
    ends: '支払いの終了',
    expires: 'マンデートの有効期限',
    datesHint: '現地時刻です。マンデートは最長 90 日です。',
    review: '署名する内容',
    payee: '支払先',
    summary: {
      agent: agent => `${agent} 用`,
      budget: budget => `合計 ${budget} USDC まで`,
      range: (min, max) => `各支払いは ${min}〜${max} USDC`,
      payees: count => `支払先 ${count} 件:`,
      window: (from, to) => `支払いできる期間: ${from} 〜 ${to}`,
      expires: at => `マンデートの有効期限: ${at}`,
      caps: (perTx, perDay, perAgentDay) =>
        `上限は引き続き適用されます: 1 回 ${perTx} USDC、1 日 ${perDay} USDC、エージェントごとに 1 日 ${perAgentDay} USDC。`
    },
    problems: {
      agent: 'エージェントのプロファイル名を入力してください(小文字、数字、- と _)。',
      amount: '金額を確認してください: 0 より大きく、小数点以下 6 桁まで、最小 ≤ 最大 ≤ 予算。',
      dates: '日時を確認してください: 開始は終了より前、終了は有効期限まで、有効期限は未来かつ 90 日以内です。',
      payees: 'リストから支払先を 1 つ以上選んでください。'
    },
    sign: 'マンデートに署名…',
    signHint: 'すべての条件を表示する許可シートで、もう一度確認します。後からの取り消しは即時です。',
    signed: 'マンデートに署名しました。'
  },
  mandates: {
    title: 'マンデート',
    empty: 'マンデートはありません。エージェントはあなたが署名したマンデートのもとでのみ支払えます。',
    forAgent: agent => `${agent} 用`,
    terms: (budget, expires) => `予算 ${budget} USDC · 有効期限 ${expires}`,
    revoked: '取り消し済み',
    revoke: '取り消す'
  },
  saved: '保存しました',
  refusals: {
    allowlist: '変更なし: 各リストには有効な項目を重複なしで 50 件まで登録できます。',
    door_denied: '変更なし: 許可シートが拒否されたか、時間切れになりました。',
    gesture: '変更なし: この変更にはあなた自身のクリックが必要です。',
    invalid: '変更なし: 要求が正しくありません。',
    ledger: '変更なし: 支払い記録に書き込めませんでした。',
    no_door: '変更なし: 許可シートを利用できません。',
    not_ready: '支払いは利用できません。',
    settings_moved: 'その間に設定が変わりました。確認してからもう一度お試しください。',
    unavailable: 'このバージョンでは利用できません。',
    unknown: '問題が発生しました。何も変更されていません。'
  }
}
