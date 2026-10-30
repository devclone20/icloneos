// iclone os — V3-I ACP マーケット › ワーク（日本語）。
import type { AcpWorkTranslations } from '../types/acpWork'

export const acpWork: AcpWorkTranslations = {
  tab: 'ワーク',
  states: {
    offline: 'オフライン',
    starting: '起動中',
    online: 'オンライン',
    draining: '安全にオフラインへ移行中',
    'offline-safe': 'オフライン（すべてのジョブを精算済み）',
    failed: '対応が必要です'
  },
  onlineMeaning:
    'オンラインとは、この Mac からジョブのリスナーが接続していることです。マーケットでオンライン表示されるかはまだ検証されていません。',
  desktopOnly: 'ワークはデスクトップアプリで動作し、あなたの Mac からエージェントをオンラインに保ちます。',
  awakeOnly: 'このウインドウを閉じても、この Mac がスリープしていない間はオンラインのままです。',
  actions: {
    online: 'オンラインにする',
    offline: 'オフラインにする',
    reboot: 'リスナーを再起動',
    refresh: '今すぐジョブを読む'
  },
  autonomy: {
    title: '自律レベル',
    levels: {
      L0: { name: '観察のみ', summary: '仕事を見つけて順位付けします。操作はすべてあなたが行います。' },
      L1: { name: 'ジョブごとに承認', summary: 'ポリシー内のオファーはここであなたの承認を待ちます。' },
      L2: {
        name: 'ポリシー内で行動',
        summary: 'ポリシー内のオファーに自分で見積もりを出します。オンにできるのはあなた自身のクリックだけです。'
      }
    },
    downgrade: {
      'chain-broken': 'ワーク台帳を検証できないため、確認されるまで観察のみです。',
      'spend-trade-off': '設定 › プライバシーで支出と取引がオフのため、観察のみです。'
    },
    earnOnly: '稼ぐだけ：支出、雇用、チャージは決して行いません。'
  },
  writesOff: 'このビルドでは承認は記録され、見積もりは保留されて送信されません。',
  offers: {
    title: 'オファー',
    empty: 'オファーはまだありません',
    emptyHint: 'この iNFT へのジョブ依頼が、ポリシーの判定とともにここに表示されます。',
    approve: '承認',
    decline: '辞退',
    standing: {
      pending: 'あなたの判断待ち',
      approved: '承認済み',
      declined: '辞退済み',
      refused: 'ポリシーにより拒否',
      seen: '確認済み'
    },
    rules: {
      spend: 'この iNFT に資金の拠出を求めています',
      token: 'ポリシーが受け付けないトークンでの支払いです',
      chain: 'ポリシーが受け付けないチェーン上のものです',
      'requester-denied': '依頼者が拒否リストにあります',
      'requester-unknown': '依頼者が許可リストにありません',
      class: 'ポリシーが受け付けない種類の仕事です',
      'price-floor': '報酬が下限未満か、記載がありません',
      'open-cap': '進行中のジョブが多すぎます',
      oversize: '依頼が上限より大きすぎます'
    },
    price: amount => `報酬 ${amount}`,
    requester: address => `依頼者 ${address}`
  },
  groups: { 'in-flight': '進行中', completed: '完了', payments: '入金', history: '履歴' },
  groupsEmpty: 'まだ何もありません。',
  trace: { offer: 'オファー', job: 'ジョブ', budget: '予算', deliverable: '納品', payment: '入金', gap: '欠落' },
  totals: { earned: '獲得', spent: '支出', escrow: 'エスクロー中' },
  fixes: {
    title: '修復',
    empty: '失敗はありません。',
    causes: {
      'listener-exited': 'リスナーが終了しました',
      'needs-sign-in': 'エージェントの再サインインが必要です',
      'owner-reboot': 'あなたが再起動を求めました',
      'read-failed': 'ジョブ一覧を読めませんでした',
      'tools-missing': 'ACP ツールがインストールされていないか、検証できません'
    },
    actions: {
      'restart-backoff': '再起動中。毎回待ち時間を延ばします（最大 1 分）',
      restarted: 'リスナーを再起動しました',
      'stopped-for-sign-in': '再試行を止めました。セットアップでサインインしてから、オンラインにしてください',
      'retry-next-poll': '次の確認で読み直します',
      'stopped-for-tools': '停止しました — ACP Market で ACP ツールをインストールしてから、オンラインにしてください'
    },
    now: state => `現在：${state}`
  },
  draining: jobs => `リスナーを止める前にジョブ ${jobs} を待っています。`,
  drainUnknown: 'リスナーを止める前に、信頼できるジョブ一覧を待っています。',
  stopReport: (open, escrow) =>
    open === 0 ? '進行中のジョブはありません。' : `${open} 件のジョブがまだ進行中で、${escrow} がエスクロー中です。`,
  readError: detail => `前回の読み込みに失敗しました：${detail}`,
  holds: {
    'signed-out':
      'オフライン：サインアウトしたため、すべてのリスナーを停止しました。サインインしてからオンラインにしてください。',
    'wallet-switch':
      'オフライン：ウォレットが変わったため、すべてのリスナーを停止しました。オンラインにできるのは、この iNFT を保有するウォレットだけです。',
    'ownership-lost': 'オフライン：この iNFT はもうあなたのウォレットにないため、リスナーを停止しました。',
    'ownership-unverified': 'この iNFT がまだあなたのウォレットにあるかを確認してから、オンラインに戻します。'
  },
  repair: {
    action: '台帳を修復',
    hint: '修復では、検証できる記録をすべて残し、破損したファイルを別に保管し、欠落を記録します。「ポリシー内で行動」は選び直す必要があります。'
  },
  chainGaps: count =>
    `中断または修復された書き込みが ${count} 件あります。台帳にはそれぞれ欠落として記録されています。`,
  chainBroken: 'ワーク台帳を検証できません。',
  errors: {
    gesture: 'あなた自身のクリックが必要です。',
    invalid: 'そのジョブはもう受付中のオファーではありません。',
    policy: 'ポリシーがこのオファーを拒否しています。',
    state: '今はできません。観察のみか、オフラインへ移行中です。',
    ownership: 'この iNFT が今あなたのウォレットにあることを確認できませんでした。',
    'sign-in': '先に、この iNFT を保有するウォレットでサインインしてください。',
    busy: '前のリクエストを処理中です。',
    tools: '先に ACP ツールをインストールしてください（ACP Market › インストール）。'
  },
  refusedBy: rule => `拒否：${rule}`
}
