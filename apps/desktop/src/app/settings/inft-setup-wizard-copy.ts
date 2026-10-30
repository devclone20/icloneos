/**
 * The words of the iNFT setup wizard (the Setup pane), in all five app locales (front I-C, 2026-10-20).
 * Each step is one row: its title is one sentence a person understands, the detail is its hint.
 * The briefings handed to Hermes ("ask hermes") are prompts for the agent, not interface words, and stay here
 * out of the catalogue on purpose. `inft-setup-wizard-copy.test.ts` proves every locale carries every key.
 */
import { type Locale, useI18n } from '@/i18n'

import type { CardErrorCode, CardErrorInfo, CardRefusalCode, SignupGate } from './inft-setup-card-signup'

const en = {
  gate: {
    title: 'Each iNFT gets its own agent, wallet, email, bank card and trading account',
    hint: 'Everything is created through Virtuals in a separate, private setup for each iNFT. The agent can help at every step.',
    scanning: 'Looking for iNFTs in your wallet…',
    scanFailed: 'The wallet scan did not finish',
    scanFailedHint: (reason: string) => `${reason} It tries again when the collection panel opens.`,
    scanFailedReason: 'The scan stopped before it found anything.',
    none: 'No iNFTs were found in this wallet yet',
    noneHint: 'The setup lists every iNFT it finds there.',
    signedOut: 'Connect your wallet to set up your iNFTs',
    signedOutHint: 'The setup lists every iNFT it finds in it.',
    connect: 'Connect wallet'
  },
  picker: {
    title: 'Choose the iNFT to set up',
    hint: 'Once set up, the iNFT acts on this economy itself from Message: it sends mail, checks balances and hires agents.',
    refresh: 'Check this iNFT again',
    ready: 'Ready',
    needed: 'Setup needed'
  },
  step: {
    ask: 'Ask the agent',
    askTip: 'Ask the agent about this step',
    resume: 'Resume',
    notes: (text: string) => `Your notes: ${text}`,
    addNotes: 'Add notes',
    editNotes: 'Edit notes',
    notesLabel: 'Notes for this step',
    notesPlaceholder:
      'Your notes for this step. They travel with “Ask the agent”, and you review the message before it is sent.',
    saveNotes: 'Save notes',
    deleteNotes: 'Delete notes',
    cancel: 'Cancel',
    masked: 'Something that looked like a secret was hidden before it was saved.',
    done: 'Done'
  },
  cli: {
    title: 'Install the Virtuals connector',
    hint: 'It downloads from npm when you choose Install. Nothing installs without your click.',
    ready: (version: string) => (version ? `Version ${version} is ready.` : 'The connector is ready.'),
    taught: (count: number, trees: number) => `Your agent has learned it (${count} skills in ${trees} folders).`,
    notTaught: (reason: string) => `Your agent has not learned it yet: ${reason}`,
    unknownError: 'the reason is unknown.',
    checking: 'Checking what your agent knows…',
    reteach: 'Teach the agent again',
    keychain:
      'After a reinstall of this build, your computer asks once per iNFT before the app may read its saved sign-in. Choose “Always Allow” when it asks.',
    checkUpdate: 'Check for updates',
    updateAvailable: (version: string) => `Version ${version} is available.`,
    updateNow: 'Update now',
    install: 'Install now'
  },
  profile: {
    title: 'Give this iNFT its own agent profile, if you want one',
    hint: 'The profile is built from the personality stored in the token.',
    noSoul: 'This token carries no personality to build a profile from.',
    select: 'Use this profile',
    remove: 'Delete profile',
    build: 'Build profile'
  },
  auth: {
    title: 'Sign in to your Virtuals account',
    hint: 'The sign-in opens in your browser and stays private to this iNFT.',
    again: 'Sign in again',
    start: 'Sign in'
  },
  agent: {
    title: "Create this iNFT's agent",
    hint: 'The agent belongs to this iNFT alone.',
    name: 'Agent name',
    create: 'Create agent',
    bound: (name: string) => `${name} is bound to this iNFT.`,
    fallback: 'The agent'
  },
  signer: {
    title: 'Let the agent sign within strict limits',
    hint: 'Adds a signing key with a restricted policy. Registering the agent’s public identity is optional.',
    armed: 'Signing is on; the agent acts within the limits you set.',
    add: 'Add signer',
    addAnother: 'Add another signer',
    register: 'Register identity',
    registerTip: 'Register this agent on the ERC-8004 identity registry (Base). This signs one transaction.'
  },
  wallet: {
    title: "See the agent's wallets",
    hint: 'One EVM and one Solana address, created for this agent.',
    evm: (address: string) => `EVM ${address}`,
    sol: (address: string) => `Solana ${address}`,
    balance: 'Check balance'
  },
  email: {
    title: 'Give the agent its own email address',
    hint: 'A private inbox the agent reads and sends from.',
    provision: 'Create email'
  },
  card: {
    title: "Set up the agent's virtual bank card",
    hint: 'Sign in by link, add a profile and a payment method, then set a spending limit.',
    waiting: (secs: string) => `Waiting for the sign-in link to be opened · next check in ${secs} s`,
    cooling: (secs: string) => `Please wait · ${secs} s`,
    unconfirmed: 'No clear answer · check the card again',
    resume: 'Resume · check the sign-in',
    openLink: 'Open sign-in link',
    send: '1 · Send sign-in link',
    sendNew: 'Send a new link',
    resend: 'Resend sign-in link',
    resent: 'A fresh sign-in link was sent to the agent inbox. Open it, then check the card.',
    confirmNew: 'Confirm · send a new link',
    payment: '3 · Payment method',
    probe: 'Check card',
    first: 'First name',
    last: 'Last name',
    phone: 'Phone number',
    profile: '2 · Profile',
    limit: 'Spending limit (USD)',
    setLimit: '4 · Spending limit',
    readLimit: 'Read limit',
    service: (hint: string) => `Card service: ${hint}`,
    issue: 'Ask the agent to issue a card for an amount.',
    expired: 'Still waiting for the sign-in link to be opened. Press Resume when done.',
    refusal: {
      'already-signed-in': 'The card is already signed in.',
      'resend-wait': (at: string) => `A sign-in link went out less than a minute ago. The next one can go at ${at}.`,
      'service-refused':
        'The card service refused this account (blocked or limited). Do not sign up again: open the sign-in link already in the agent inbox, wait, or ask the agent.',
      'held-until': (at: string) =>
        `The card service put a hold on the last sign-up. Nothing is sent again before ${at}.`,
      unconfirmed: (at: string) =>
        `The sign-up at ${at} got no clear answer and may have reached the service. The card is checked again before another is sent.`,
      cooling: 'The card service asked for a pause. Please wait.',
      'state-unknown': 'The card state is unknown right now. Check the card again before signing up.',
      'link-waiting': (at: string) => `A sign-in link was sent at ${at}. Waiting for it; no other is sent.`,
      'link-sending': 'A sign-up for this iNFT is still waiting for the card service to answer. No other is sent.',
      'link-replaces':
        'A sign-in link is already waiting in the agent inbox. A new one replaces it; press again to confirm.'
    },
    error: {
      held: (at: string) =>
        `The card service is holding sign-ups for this iNFT. Nothing was sent; do not sign up again before ${at}. Open the sign-in link from the agent inbox, or wait.`,
      'rate-limited': 'The card service is limiting this account. Wait a minute; nothing was lost.',
      blocked:
        'The card service refused this account (blocked or locked). Do not sign up again: open the sign-in link from the agent inbox, wait 15 minutes, or ask the agent.',
      'link-waiting': 'A sign-in link is already waiting in the agent inbox. Open it, then resume.',
      'not-ready': 'This iNFT is not ready for the card. Finish sign-in, agent and email first.',
      timeout:
        'The card service did not answer in time. The call may still have reached it; the card is checked again before anything is sent.',
      'no-state': 'The card service answered without a sign-in state. The card is checked again first.',
      'sent-unanswered':
        'A sign-up was sent and its answer never came back here. Check the card again; do not send another.',
      busy: 'Another card call is still running for this iNFT. Try again when it finishes.',
      'resend-wait': (at: string) =>
        `A sign-in link for this iNFT went out less than a minute ago. Nothing was sent; the next one can go at ${at}.`,
      failed: (detail: string) => (detail ? `The card call failed (${detail}).` : 'The card call failed.')
    }
  },
  hl: {
    title: 'Trade on Hyperliquid through the agent',
    hint: 'Fund it from the agent wallet, then trade from Message.',
    status: 'Check status',
    deposit: 'Ask the agent to move funds from the agent wallet to Hyperliquid.'
  },
  market: {
    title: 'Browse the Virtuals agent market',
    hint: 'Find agents, offerings and jobs to trade with.',
    browse: 'Browse agents',
    offerings: 'My offerings',
    jobs: 'My jobs'
  },
  live: {
    title: 'Bring the iNFT to life on the home screen',
    hint: 'Shows the 3D piece and switches the conversation to this iNFT.',
    summon: 'Go live',
    configured: (name: string) =>
      `From Message, ask ${name} directly: “send an email to…”, “what is my balance?”, “hire an agent for…”. It acts on this economy itself.`,
    yourInft: 'your iNFT',
    noModel: 'This token has no 3D model.'
  }
}

type InftWizardCopy = typeof en

// Every code the card machine can emit has a sentence; `satisfies` makes a missing one a compile error.
en.card.refusal satisfies Record<CardRefusalCode, string | ((at: string) => string)>
en.card.error satisfies Record<CardErrorCode, string | ((arg: string) => string)>

function clock(at: number | undefined): string {
  return at ? new Date(at).toTimeString().slice(0, 5) : '…'
}

/** The minute between two links is too short for hh:mm: it names the second. */
function clockSeconds(at: number | undefined): string {
  return at ? new Date(at).toTimeString().slice(0, 8) : '…'
}

function sentence(entry: string | ((arg: string) => string), arg: string): string {
  return typeof entry === 'function' ? entry(arg) : entry
}

/** The sentence for a failed card call: the hold end for `held`, the service's words for `failed`. */
export function cardErrorSentence(card: InftWizardCopy['card'], info: CardErrorInfo): string {
  if (info.code === 'resend-wait') {
    return sentence(card.error[info.code], clockSeconds(info.resendAt))
  }

  return sentence(card.error[info.code], info.code === 'failed' ? (info.detail ?? '') : clock(info.heldUntil))
}

/** Why the sign-up button is held back; a cooldown repeats the answer that caused it. */
export function cardRefusalSentence(card: InftWizardCopy['card'], gate: SignupGate): string | undefined {
  if (!gate.reason) {
    return undefined
  }

  if (gate.reason === 'cooling' && gate.error) {
    return cardErrorSentence(card, gate.error)
  }

  return sentence(card.refusal[gate.reason], gate.reason === 'resend-wait' ? clockSeconds(gate.at) : clock(gate.at))
}

const ja: InftWizardCopy = {
  gate: {
    title: '各 iNFT に専用のエージェント、ウォレット、メール、銀行カード、取引口座が用意されます',
    hint: 'すべて Virtuals ツールで、iNFT ごとに分かれた非公開の設定として作成されます。どの手順でもエージェントが手伝います。',
    scanning: 'ウォレット内の iNFT を探しています…',
    scanFailed: 'ウォレットのスキャンが完了しませんでした',
    scanFailedHint: (reason: string) => `${reason} コレクションパネルを開くと再試行します。`,
    scanFailedReason: '何も見つかる前にスキャンが止まりました。',
    none: 'このウォレットにはまだ iNFT が見つかりません',
    noneHint: '見つかった iNFT はすべてここに表示されます。',
    signedOut: 'iNFT を設定するにはウォレットを接続してください',
    signedOutHint: 'ウォレット内で見つかった iNFT がすべて表示されます。',
    connect: 'ウォレットを接続'
  },
  picker: {
    title: '設定する iNFT を選んでください',
    hint: '設定が済むと、iNFT はメッセージから自らこの経済圏で動きます。メールを送り、残高を確認し、エージェントを雇います。',
    refresh: 'この iNFT をもう一度確認',
    ready: '準備完了',
    needed: '設定が必要'
  },
  step: {
    ask: 'エージェントに聞く',
    askTip: 'この手順についてエージェントに聞く',
    resume: '再開',
    notes: (text: string) => `あなたのメモ: ${text}`,
    addNotes: 'メモを追加',
    editNotes: 'メモを編集',
    notesLabel: 'この手順のメモ',
    notesPlaceholder: 'この手順のメモです。「エージェントに聞く」と一緒に送られ、送信前にメッセージを確認できます。',
    saveNotes: 'メモを保存',
    deleteNotes: 'メモを削除',
    cancel: 'キャンセル',
    masked: '秘密情報に見える値は保存前に伏せられました。',
    done: '完了'
  },
  cli: {
    title: 'Virtuals コネクタをインストールします',
    hint: '「インストール」を選ぶと npm からダウンロードします。クリックしない限り何もインストールされません。',
    ready: (version: string) => (version ? `バージョン ${version} を使用できます。` : 'コネクタを使用できます。'),
    taught: (count: number, trees: number) =>
      `エージェントは習得済みです（${trees} 個のフォルダーに ${count} 個のスキル）。`,
    notTaught: (reason: string) => `エージェントはまだ習得していません: ${reason}`,
    unknownError: '原因は不明です。',
    checking: 'エージェントの知識を確認しています…',
    reteach: 'エージェントにもう一度教える',
    keychain:
      'このビルドを再インストールした後、アプリが保存済みのサインインを読み取る前に、コンピューターが iNFT ごとに一度確認します。尋ねられたら「常に許可」を選んでください。',
    checkUpdate: 'アップデートを確認',
    updateAvailable: (version: string) => `バージョン ${version} が利用できます。`,
    updateNow: '今すぐアップデート',
    install: '今すぐインストール'
  },
  profile: {
    title: '必要なら、この iNFT 専用のエージェントプロフィールを作成します',
    hint: 'プロフィールはトークンに保存された人格から作られます。',
    noSoul: 'このトークンにはプロフィールの元になる人格がありません。',
    select: 'このプロフィールを使う',
    remove: 'プロフィールを削除',
    build: 'プロフィールを作成'
  },
  auth: {
    title: 'Virtuals アカウントにサインインします',
    hint: 'サインインはブラウザーで開き、この iNFT だけの非公開の情報として保たれます。',
    again: 'もう一度サインイン',
    start: 'サインイン'
  },
  agent: {
    title: 'この iNFT のエージェントを作成します',
    hint: 'エージェントはこの iNFT だけに属します。',
    name: 'エージェント名',
    create: 'エージェントを作成',
    bound: (name: string) => `${name} はこの iNFT に結び付けられています。`,
    fallback: 'エージェント'
  },
  signer: {
    title: 'エージェントが厳しい制限の範囲内で署名できるようにします',
    hint: '制限付きポリシーの署名鍵を追加します。エージェントの公開 ID の登録は任意です。',
    armed: '署名は有効です。エージェントは設定した制限内で動作します。',
    add: '署名者を追加',
    addAnother: '署名者をさらに追加',
    register: 'ID を登録',
    registerTip: 'このエージェントを ERC-8004 ID レジストリ (Base) に登録します。トランザクションに 1 回署名します。'
  },
  wallet: {
    title: 'エージェントのウォレットを確認します',
    hint: 'このエージェント用に作られた EVM と Solana のアドレスが 1 つずつあります。',
    evm: (address: string) => `EVM ${address}`,
    sol: (address: string) => `Solana ${address}`,
    balance: '残高を確認'
  },
  email: {
    title: 'エージェント専用のメールアドレスを用意します',
    hint: 'エージェントが読み書きする非公開の受信箱です。',
    provision: 'メールを作成'
  },
  card: {
    title: 'エージェントのバーチャル銀行カードを設定します',
    hint: 'リンクでサインインし、プロフィールと支払い方法を追加してから、利用限度額を設定します。',
    waiting: (secs: string) => `サインインリンクが開かれるのを待っています · 次の確認まで ${secs} 秒`,
    cooling: (secs: string) => `お待ちください · ${secs} 秒`,
    unconfirmed: '明確な応答がありません · カードをもう一度確認',
    resume: '再開 · サインインを確認',
    openLink: 'サインインリンクを開く',
    send: '1 · サインインリンクを送信',
    sendNew: '新しいリンクを送信',
    resend: 'サインインリンクを再送',
    resent: '新しいサインインリンクをエージェントの受信箱に送りました。開いてからカードを確認してください。',
    confirmNew: '確認 · 新しいリンクを送信',
    payment: '3 · 支払い方法',
    probe: 'カードを確認',
    first: '名',
    last: '姓',
    phone: '電話番号',
    profile: '2 · プロフィール',
    limit: '利用限度額 (USD)',
    setLimit: '4 · 利用限度額',
    readLimit: '限度額を読む',
    service: (hint: string) => `カードサービス: ${hint}`,
    issue: 'エージェントに金額を指定してカードの発行を頼んでください。',
    expired: 'サインインリンクが開かれるのをまだ待っています。済んだら「再開」を押してください。',
    refusal: {
      'already-signed-in': 'カードはすでにサインイン済みです。',
      'resend-wait': (at: string) => `1 分以内にサインインリンクを送りました。次は ${at} に送れます。`,
      'service-refused':
        'カードサービスがこのアカウントを拒否しました（ブロックまたは制限）。再登録はしないでください。受信箱にあるサインインリンクを開くか、待つか、エージェントに頼んでください。',
      'held-until': (at: string) => `カードサービスが前回の登録を保留にしました。${at} までは再送しません。`,
      unconfirmed: (at: string) =>
        `${at} の登録は明確な応答がなく、サービスに届いた可能性があります。次を送る前にカードをもう一度確認します。`,
      cooling: 'カードサービスが少し待つよう求めています。お待ちください。',
      'state-unknown': 'カードの状態が今はわかりません。登録する前にカードをもう一度確認してください。',
      'link-waiting': (at: string) => `${at} にサインインリンクを送りました。待機中のため、別のリンクは送りません。`,
      'link-sending': 'この iNFT の登録はまだカードサービスの応答を待っています。別のリンクは送りません。',
      'link-replaces':
        'サインインリンクはすでにエージェントの受信箱にあります。新しいリンクで置き換えるには、もう一度押して確認してください。'
    },
    error: {
      held: (at: string) =>
        `カードサービスがこの iNFT の登録を保留しています。何も送信されていません。${at} までは再登録しないでください。受信箱のサインインリンクを開くか、お待ちください。`,
      'rate-limited':
        'カードサービスがこのアカウントを制限しています。1 分ほどお待ちください。失われたものはありません。',
      blocked:
        'カードサービスがこのアカウントを拒否しました（ブロックまたはロック）。再登録はせず、受信箱のサインインリンクを開くか、15 分待つか、エージェントに頼んでください。',
      'link-waiting': 'サインインリンクはすでにエージェントの受信箱にあります。開いてから再開してください。',
      'not-ready':
        'この iNFT はまだカードの準備ができていません。先にサインイン、エージェント、メールを済ませてください。',
      timeout:
        'カードサービスが時間内に応答しませんでした。呼び出しは届いている可能性があるため、何かを送る前にカードをもう一度確認します。',
      'no-state': 'カードサービスがサインイン状態なしで応答しました。まずカードをもう一度確認します。',
      'sent-unanswered':
        '登録を送信しましたが、応答がここに戻ってきませんでした。カードをもう一度確認し、別の登録は送らないでください。',
      busy: 'この iNFT では別のカード呼び出しがまだ実行中です。終わってからもう一度お試しください。',
      'resend-wait': (at: string) =>
        `この iNFT のサインインリンクは 1 分以内に送られています。今回は何も送っていません。次は ${at} に送れます。`,
      failed: (detail: string) =>
        detail ? `カードの呼び出しに失敗しました（${detail}）。` : 'カードの呼び出しに失敗しました。'
    }
  },
  hl: {
    title: 'エージェントを通じて Hyperliquid で取引します',
    hint: 'エージェントのウォレットから入金し、メッセージから取引します。',
    status: '状態を確認',
    deposit: 'エージェントのウォレットから Hyperliquid への入金は、エージェントに頼んでください。'
  },
  market: {
    title: 'Virtuals のエージェントマーケットを見ます',
    hint: '取引相手となるエージェント、オファー、ジョブを探します。',
    browse: 'エージェントを見る',
    offerings: '自分のオファー',
    jobs: '自分のジョブ'
  },
  live: {
    title: 'iNFT をホーム画面に呼び出します',
    hint: '3D 作品を表示し、会話をこの iNFT に切り替えます。',
    summon: '公開する',
    configured: (name: string) =>
      `メッセージから ${name} に直接頼めます:「…にメールを送って」「残高は?」「…のためにエージェントを雇って」。この経済圏で自ら動きます。`,
    yourInft: 'あなたの iNFT',
    noModel: 'このトークンには 3D モデルがありません。'
  }
}

const zh: InftWizardCopy = {
  gate: {
    title: '每个 iNFT 都有自己的智能体、钱包、邮箱、银行卡和交易账户',
    hint: '一切都由 Virtuals 工具为每个 iNFT 单独、私密地创建。每一步都可以请智能体帮忙。',
    scanning: '正在钱包中查找 iNFT…',
    scanFailed: '钱包扫描没有完成',
    scanFailedHint: (reason: string) => `${reason} 打开收藏面板时会再次尝试。`,
    scanFailedReason: '扫描在找到任何内容之前停止了。',
    none: '这个钱包里还没有找到 iNFT',
    noneHint: '找到的每个 iNFT 都会列在这里。',
    signedOut: '连接钱包以设置你的 iNFT',
    signedOutHint: '钱包中找到的每个 iNFT 都会列出。',
    connect: '连接钱包'
  },
  picker: {
    title: '选择要设置的 iNFT',
    hint: '设置完成后，iNFT 会在消息中自行参与这个经济：发送邮件、查看余额、雇用智能体。',
    refresh: '重新检查这个 iNFT',
    ready: '已就绪',
    needed: '需要设置'
  },
  step: {
    ask: '询问智能体',
    askTip: '就这一步询问智能体',
    resume: '继续',
    notes: (text: string) => `你的备注：${text}`,
    addNotes: '添加备注',
    editNotes: '编辑备注',
    notesLabel: '这一步的备注',
    notesPlaceholder: '这一步的备注。它会随“询问智能体”一起发送，发送前你可以先检查消息。',
    saveNotes: '保存备注',
    deleteNotes: '删除备注',
    cancel: '取消',
    masked: '看起来像密钥的内容在保存前已被隐藏。',
    done: '已完成'
  },
  cli: {
    title: '安装 Virtuals 连接器',
    hint: '选择“安装”后才会从 npm 下载。没有你的点击，什么都不会安装。',
    ready: (version: string) => (version ? `版本 ${version} 已就绪。` : '连接器已就绪。'),
    taught: (count: number, trees: number) => `你的智能体已掌握（${trees} 个文件夹中的 ${count} 个技能）。`,
    notTaught: (reason: string) => `你的智能体还没有学会：${reason}`,
    unknownError: '原因未知。',
    checking: '正在检查智能体掌握的内容…',
    reteach: '再次教给智能体',
    keychain:
      '重新安装此版本后，应用读取已保存的登录信息之前，电脑会为每个 iNFT 询问一次。出现提示时请选择“始终允许”。',
    checkUpdate: '检查更新',
    updateAvailable: (version: string) => `版本 ${version} 可用。`,
    updateNow: '立即更新',
    install: '立即安装'
  },
  profile: {
    title: '如果需要，为这个 iNFT 建立专属的智能体档案',
    hint: '档案根据代币中保存的人格生成。',
    noSoul: '这个代币没有可用于生成档案的人格。',
    select: '使用此档案',
    remove: '删除档案',
    build: '生成档案'
  },
  auth: {
    title: '登录你的 Virtuals 账户',
    hint: '登录会在浏览器中打开，并且只属于这个 iNFT。',
    again: '重新登录',
    start: '登录'
  },
  agent: {
    title: '创建这个 iNFT 的智能体',
    hint: '这个智能体只属于这个 iNFT。',
    name: '智能体名称',
    create: '创建智能体',
    bound: (name: string) => `${name} 已绑定到这个 iNFT。`,
    fallback: '智能体'
  },
  signer: {
    title: '允许智能体在严格限制内签名',
    hint: '添加一个使用受限策略的签名密钥。登记智能体的公开身份是可选的。',
    armed: '签名已开启；智能体在你设定的限制内行动。',
    add: '添加签名者',
    addAnother: '再添加一个签名者',
    register: '登记身份',
    registerTip: '在 ERC-8004 身份注册表（Base）上登记这个智能体。需要签署一笔交易。'
  },
  wallet: {
    title: '查看智能体的钱包',
    hint: '为这个智能体创建的一个 EVM 地址和一个 Solana 地址。',
    evm: (address: string) => `EVM ${address}`,
    sol: (address: string) => `Solana ${address}`,
    balance: '查看余额'
  },
  email: {
    title: '为智能体提供专属邮箱地址',
    hint: '智能体用来收发邮件的私人收件箱。',
    provision: '创建邮箱'
  },
  card: {
    title: '设置智能体的虚拟银行卡',
    hint: '通过链接登录，添加资料和付款方式，然后设置消费限额。',
    waiting: (secs: string) => `正在等待打开登录链接 · ${secs} 秒后再次检查`,
    cooling: (secs: string) => `请稍候 · ${secs} 秒`,
    unconfirmed: '没有明确的答复 · 再次检查银行卡',
    resume: '继续 · 检查登录',
    openLink: '打开登录链接',
    send: '1 · 发送登录链接',
    sendNew: '发送新链接',
    resend: '重新发送登录链接',
    resent: '新的登录链接已发送到智能体收件箱。请打开它，然后检查卡片。',
    confirmNew: '确认 · 发送新链接',
    payment: '3 · 付款方式',
    probe: '检查银行卡',
    first: '名',
    last: '姓',
    phone: '电话号码',
    profile: '2 · 资料',
    limit: '消费限额（美元）',
    setLimit: '4 · 消费限额',
    readLimit: '读取限额',
    service: (hint: string) => `银行卡服务：${hint}`,
    issue: '请让智能体按金额发行一张卡。',
    expired: '仍在等待登录链接被打开。完成后请按“继续”。',
    refusal: {
      'already-signed-in': '这张卡已经登录。',
      'resend-wait': (at: string) => `不到一分钟前刚发送过登录链接。下一条可在 ${at} 发送。`,
      'service-refused':
        '卡服务拒绝了这个账户（被阻止或受限）。请勿再次注册：打开收件箱中已有的登录链接、等待，或询问智能体。',
      'held-until': (at: string) => `卡服务暂缓了上一次注册。${at} 之前不会再发送。`,
      unconfirmed: (at: string) => `${at} 的注册没有明确答复，可能已送达服务。再次发送前会先重新检查卡。`,
      cooling: '卡服务要求稍作等待。请稍候。',
      'state-unknown': '目前无法确定卡的状态。注册前请再次检查卡。',
      'link-waiting': (at: string) => `登录链接已于 ${at} 发送。正在等待，不会再发送另一条。`,
      'link-sending': '这个 iNFT 的注册仍在等待卡服务答复。不会再发送另一条。',
      'link-replaces': '智能体收件箱中已有一条登录链接。新链接会替换它；再按一次以确认。'
    },
    error: {
      held: (at: string) =>
        `卡服务正在暂缓这个 iNFT 的注册。什么都没有发送；${at} 之前请勿再次注册。请打开收件箱中的登录链接，或等待。`,
      'rate-limited': '卡服务正在限制这个账户。请等一分钟；没有任何损失。',
      blocked:
        '卡服务拒绝了这个账户（被阻止或锁定）。请勿再次注册：打开收件箱中的登录链接、等待 15 分钟，或询问智能体。',
      'link-waiting': '智能体收件箱中已有一条登录链接。打开它，然后继续。',
      'not-ready': '这个 iNFT 尚未准备好使用卡。请先完成登录、智能体和邮箱。',
      timeout: '卡服务未能及时答复。调用可能已送达；发送任何内容前会先重新检查卡。',
      'no-state': '卡服务的答复中没有登录状态。会先重新检查卡。',
      'sent-unanswered': '注册已发送，但答复没有回到这里。请重新检查卡；不要再发送另一条。',
      busy: '这个 iNFT 的另一个卡调用仍在进行中。请在它结束后再试。',
      'resend-wait': (at: string) => `这个 iNFT 的登录链接不到一分钟前刚发送过。本次没有发送；下一条可在 ${at} 发送。`,
      failed: (detail: string) => (detail ? `卡调用失败（${detail}）。` : '卡调用失败。')
    }
  },
  hl: {
    title: '通过智能体在 Hyperliquid 上交易',
    hint: '从智能体钱包充值，然后在消息中交易。',
    status: '查看状态',
    deposit: '请让智能体把资金从智能体钱包转入 Hyperliquid。'
  },
  market: {
    title: '浏览 Virtuals 智能体市场',
    hint: '寻找可以交易的智能体、服务和任务。',
    browse: '浏览智能体',
    offerings: '我的服务',
    jobs: '我的任务'
  },
  live: {
    title: '让 iNFT 在主屏幕上登场',
    hint: '显示 3D 作品，并把对话切换到这个 iNFT。',
    summon: '上线',
    configured: (name: string) =>
      `在消息中直接询问 ${name}：“给…发一封邮件”“我的余额是多少？”“为…雇一个智能体”。它会自行参与这个经济。`,
    yourInft: '你的 iNFT',
    noModel: '这个代币没有 3D 模型。'
  }
}

const zhHant: InftWizardCopy = {
  gate: {
    title: '每個 iNFT 都有自己的智慧體、錢包、電子郵件、銀行卡和交易帳戶',
    hint: '一切都由 Virtuals 工具為每個 iNFT 個別、私密地建立。每一步都可以請智慧代理幫忙。',
    scanning: '正在錢包中尋找 iNFT…',
    scanFailed: '錢包掃描沒有完成',
    scanFailedHint: (reason: string) => `${reason} 開啟收藏面板時會再次嘗試。`,
    scanFailedReason: '掃描在找到任何內容之前停止了。',
    none: '這個錢包裡還沒有找到 iNFT',
    noneHint: '找到的每個 iNFT 都會列在這裡。',
    signedOut: '連接錢包以設定你的 iNFT',
    signedOutHint: '錢包中找到的每個 iNFT 都會列出。',
    connect: '連接錢包'
  },
  picker: {
    title: '選擇要設定的 iNFT',
    hint: '設定完成後，iNFT 會在訊息中自行參與這個經濟：寄送郵件、查看餘額、雇用智慧體。',
    refresh: '重新檢查這個 iNFT',
    ready: '已就緒',
    needed: '需要設定'
  },
  step: {
    ask: '詢問智慧代理',
    askTip: '就這一步詢問智慧代理',
    resume: '繼續',
    notes: (text: string) => `你的備註：${text}`,
    addNotes: '新增備註',
    editNotes: '編輯備註',
    notesLabel: '這一步的備註',
    notesPlaceholder: '這一步的備註。它會隨「詢問智慧代理」一起送出，送出前你可以先檢查訊息。',
    saveNotes: '儲存備註',
    deleteNotes: '刪除備註',
    cancel: '取消',
    masked: '看起來像密鑰的內容在儲存前已被隱藏。',
    done: '已完成'
  },
  cli: {
    title: '安裝 Virtuals 連接器',
    hint: '選擇「安裝」後才會從 npm 下載。沒有你的點擊，什麼都不會安裝。',
    ready: (version: string) => (version ? `版本 ${version} 已就緒。` : '連接器已就緒。'),
    taught: (count: number, trees: number) => `你的智慧體已掌握（${trees} 個資料夾中的 ${count} 個技能）。`,
    notTaught: (reason: string) => `你的智慧體還沒有學會：${reason}`,
    unknownError: '原因不明。',
    checking: '正在檢查智慧體掌握的內容…',
    reteach: '再次教給智慧體',
    keychain:
      '重新安裝此版本後，應用程式讀取已儲存的登入資訊之前，電腦會為每個 iNFT 詢問一次。出現提示時請選擇「永遠允許」。',
    checkUpdate: '檢查更新',
    updateAvailable: (version: string) => `版本 ${version} 可用。`,
    updateNow: '立即更新',
    install: '立即安裝'
  },
  profile: {
    title: '如果需要，為這個 iNFT 建立專屬的智慧代理檔案',
    hint: '檔案根據代幣中儲存的人格產生。',
    noSoul: '這個代幣沒有可用於產生檔案的人格。',
    select: '使用此檔案',
    remove: '刪除檔案',
    build: '產生檔案'
  },
  auth: {
    title: '登入你的 Virtuals 帳戶',
    hint: '登入會在瀏覽器中開啟，並且只屬於這個 iNFT。',
    again: '重新登入',
    start: '登入'
  },
  agent: {
    title: '建立這個 iNFT 的智慧體',
    hint: '這個智慧體只屬於這個 iNFT。',
    name: '智慧體名稱',
    create: '建立智慧體',
    bound: (name: string) => `${name} 已綁定到這個 iNFT。`,
    fallback: '智慧體'
  },
  signer: {
    title: '允許智慧體在嚴格限制內簽署',
    hint: '新增一個使用受限政策的簽署金鑰。登記智慧體的公開身分是選擇性的。',
    armed: '簽署已開啟；智慧體在你設定的限制內行動。',
    add: '新增簽署者',
    addAnother: '再新增一個簽署者',
    register: '登記身分',
    registerTip: '在 ERC-8004 身分登記冊（Base）上登記這個智慧體。需要簽署一筆交易。'
  },
  wallet: {
    title: '查看智慧體的錢包',
    hint: '為這個智慧體建立的一個 EVM 地址和一個 Solana 地址。',
    evm: (address: string) => `EVM ${address}`,
    sol: (address: string) => `Solana ${address}`,
    balance: '查看餘額'
  },
  email: {
    title: '為智慧體提供專屬電子郵件地址',
    hint: '智慧體用來收發郵件的私人收件匣。',
    provision: '建立電子郵件'
  },
  card: {
    title: '設定智慧體的虛擬銀行卡',
    hint: '透過連結登入，新增資料和付款方式，然後設定消費上限。',
    waiting: (secs: string) => `正在等待開啟登入連結 · ${secs} 秒後再次檢查`,
    cooling: (secs: string) => `請稍候 · ${secs} 秒`,
    unconfirmed: '沒有明確的回覆 · 再次檢查銀行卡',
    resume: '繼續 · 檢查登入',
    openLink: '開啟登入連結',
    send: '1 · 傳送登入連結',
    sendNew: '傳送新連結',
    resend: '重新傳送登入連結',
    resent: '新的登入連結已傳送到智慧體收件匣。請開啟它，然後檢查卡片。',
    confirmNew: '確認 · 傳送新連結',
    payment: '3 · 付款方式',
    probe: '檢查銀行卡',
    first: '名',
    last: '姓',
    phone: '電話號碼',
    profile: '2 · 資料',
    limit: '消費上限（美元）',
    setLimit: '4 · 消費上限',
    readLimit: '讀取上限',
    service: (hint: string) => `銀行卡服務：${hint}`,
    issue: '請讓智慧體按金額發行一張卡。',
    expired: '仍在等待登入連結被開啟。完成後請按「繼續」。',
    refusal: {
      'already-signed-in': '這張卡已經登入。',
      'resend-wait': (at: string) => `不到一分鐘前剛傳送過登入連結。下一條可在 ${at} 傳送。`,
      'service-refused':
        '卡服務拒絕了這個帳戶（被封鎖或受限）。請勿再次註冊：開啟收件匣中已有的登入連結、等待，或詢問智慧體。',
      'held-until': (at: string) => `卡服務暫緩了上一次註冊。${at} 之前不會再發送。`,
      unconfirmed: (at: string) => `${at} 的註冊沒有明確答覆，可能已送達服務。再次發送前會先重新檢查卡。`,
      cooling: '卡服務要求稍作等待。請稍候。',
      'state-unknown': '目前無法確定卡的狀態。註冊前請再次檢查卡。',
      'link-waiting': (at: string) => `登入連結已於 ${at} 發送。正在等待，不會再發送另一條。`,
      'link-sending': '這個 iNFT 的註冊仍在等待卡服務答覆。不會再發送另一條。',
      'link-replaces': '智慧體收件匣中已有一條登入連結。新連結會取代它；再按一次以確認。'
    },
    error: {
      held: (at: string) =>
        `卡服務正在暫緩這個 iNFT 的註冊。什麼都沒有發送；${at} 之前請勿再次註冊。請開啟收件匣中的登入連結，或等待。`,
      'rate-limited': '卡服務正在限制這個帳戶。請等一分鐘；沒有任何損失。',
      blocked:
        '卡服務拒絕了這個帳戶（被封鎖或鎖定）。請勿再次註冊：開啟收件匣中的登入連結、等待 15 分鐘，或詢問智慧體。',
      'link-waiting': '智慧體收件匣中已有一條登入連結。開啟它，然後繼續。',
      'not-ready': '這個 iNFT 尚未準備好使用卡。請先完成登入、智慧體和郵件。',
      timeout: '卡服務未能及時答覆。呼叫可能已送達；發送任何內容前會先重新檢查卡。',
      'no-state': '卡服務的答覆中沒有登入狀態。會先重新檢查卡。',
      'sent-unanswered': '註冊已發送，但答覆沒有回到這裡。請重新檢查卡；不要再發送另一條。',
      busy: '這個 iNFT 的另一個卡呼叫仍在進行中。請在它結束後再試。',
      'resend-wait': (at: string) => `這個 iNFT 的登入連結不到一分鐘前剛傳送過。本次沒有傳送；下一條可在 ${at} 傳送。`,
      failed: (detail: string) => (detail ? `卡呼叫失敗（${detail}）。` : '卡呼叫失敗。')
    }
  },
  hl: {
    title: '透過智慧體在 Hyperliquid 上交易',
    hint: '從智慧體錢包儲值，然後在訊息中交易。',
    status: '查看狀態',
    deposit: '請讓智慧體把資金從智慧體錢包轉入 Hyperliquid。'
  },
  market: {
    title: '瀏覽 Virtuals 智慧體市集',
    hint: '尋找可以交易的智慧體、服務和任務。',
    browse: '瀏覽智慧體',
    offerings: '我的服務',
    jobs: '我的任務'
  },
  live: {
    title: '讓 iNFT 在主畫面上登場',
    hint: '顯示 3D 作品，並把對話切換到這個 iNFT。',
    summon: '上線',
    configured: (name: string) =>
      `在訊息中直接詢問 ${name}：「寄一封郵件給…」「我的餘額是多少？」「為…雇一個智慧體」。它會自行參與這個經濟。`,
    yourInft: '你的 iNFT',
    noModel: '這個代幣沒有 3D 模型。'
  }
}

const ar: InftWizardCopy = {
  gate: {
    title: 'لكل iNFT وكيله ومحفظته وبريده وبطاقته المصرفية وحساب تداوله الخاص',
    hint: 'يُنشأ كل شيء بأداة Virtuals في إعداد منفصل وخاص لكل iNFT. يمكن للوكيل المساعدة في كل خطوة.',
    scanning: 'جارٍ البحث عن iNFT في محفظتك…',
    scanFailed: 'لم يكتمل فحص المحفظة',
    scanFailedHint: (reason: string) => `${reason} تتم المحاولة مجددًا عند فتح لوحة المجموعة.`,
    scanFailedReason: 'توقف الفحص قبل أن يجد أي شيء.',
    none: 'لم يُعثر بعد على أي iNFT في هذه المحفظة',
    noneHint: 'يعرض الإعداد كل iNFT يجده هناك.',
    signedOut: 'اربط محفظتك لإعداد iNFT الخاصة بك',
    signedOutHint: 'يعرض الإعداد كل iNFT يجده فيها.',
    connect: 'ربط المحفظة'
  },
  picker: {
    title: 'اختر iNFT الذي تريد إعداده',
    hint: 'بعد الإعداد، يعمل iNFT في هذا الاقتصاد بنفسه من الرسائل: يرسل البريد ويتحقق من الأرصدة ويوظف الوكلاء.',
    refresh: 'التحقق من هذا iNFT مجددًا',
    ready: 'جاهز',
    needed: 'يحتاج إلى إعداد'
  },
  step: {
    ask: 'اسأل الوكيل',
    askTip: 'اسأل الوكيل عن هذه الخطوة',
    resume: 'متابعة',
    notes: (text: string) => `ملاحظاتك: ${text}`,
    addNotes: 'إضافة ملاحظات',
    editNotes: 'تعديل الملاحظات',
    notesLabel: 'ملاحظات هذه الخطوة',
    notesPlaceholder: 'ملاحظاتك لهذه الخطوة. ترافق «اسأل الوكيل»، وتراجع الرسالة قبل إرسالها.',
    saveNotes: 'حفظ الملاحظات',
    deleteNotes: 'حذف الملاحظات',
    cancel: 'إلغاء',
    masked: 'أُخفيت قيمة تبدو سرية قبل الحفظ.',
    done: 'تم'
  },
  cli: {
    title: 'ثبّت موصّل Virtuals',
    hint: 'تُنزَّل من npm عندما تختار «تثبيت». لا يُثبَّت شيء من دون نقرتك.',
    ready: (version: string) => (version ? `الإصدار ${version} جاهز.` : 'الموصّل جاهز.'),
    taught: (count: number, trees: number) => `تعلّمه وكيلك (${count} مهارة في ${trees} مجلدات).`,
    notTaught: (reason: string) => `لم يتعلمها وكيلك بعد: ${reason}`,
    unknownError: 'السبب غير معروف.',
    checking: 'جارٍ التحقق مما يعرفه وكيلك…',
    reteach: 'علّم الوكيل مجددًا',
    keychain:
      'بعد إعادة تثبيت هذا الإصدار، يسأل حاسوبك مرة لكل iNFT قبل أن يقرأ التطبيق تسجيل الدخول المحفوظ. اختر «السماح دائمًا» عند السؤال.',
    checkUpdate: 'البحث عن تحديثات',
    updateAvailable: (version: string) => `الإصدار ${version} متاح.`,
    updateNow: 'التحديث الآن',
    install: 'التثبيت الآن'
  },
  profile: {
    title: 'امنح هذا iNFT ملف وكيل خاصًا به إن أردت',
    hint: 'يُبنى الملف من الشخصية المحفوظة في الرمز.',
    noSoul: 'لا يحمل هذا الرمز شخصية يمكن بناء ملف منها.',
    select: 'استخدام هذا الملف',
    remove: 'حذف الملف',
    build: 'بناء الملف'
  },
  auth: {
    title: 'سجّل الدخول إلى حسابك في Virtuals',
    hint: 'يُفتح تسجيل الدخول في متصفحك ويبقى خاصًا بهذا iNFT.',
    again: 'تسجيل الدخول مجددًا',
    start: 'تسجيل الدخول'
  },
  agent: {
    title: 'أنشئ وكيل هذا iNFT',
    hint: 'ينتمي الوكيل إلى هذا iNFT وحده.',
    name: 'اسم الوكيل',
    create: 'إنشاء الوكيل',
    bound: (name: string) => `${name} مرتبط بهذا iNFT.`,
    fallback: 'الوكيل'
  },
  signer: {
    title: 'اسمح للوكيل بالتوقيع ضمن حدود صارمة',
    hint: 'يضيف مفتاح توقيع بسياسة مقيدة. تسجيل الهوية العامة للوكيل اختياري.',
    armed: 'التوقيع مفعّل؛ يعمل الوكيل ضمن الحدود التي حددتها.',
    add: 'إضافة موقّع',
    addAnother: 'إضافة موقّع آخر',
    register: 'تسجيل الهوية',
    registerTip: 'سجّل هذا الوكيل في سجل الهوية ERC-8004 (Base). يتطلب ذلك توقيع معاملة واحدة.'
  },
  wallet: {
    title: 'اطّلع على محافظ الوكيل',
    hint: 'عنوان EVM وعنوان Solana أُنشئا لهذا الوكيل.',
    evm: (address: string) => `EVM ${address}`,
    sol: (address: string) => `Solana ${address}`,
    balance: 'التحقق من الرصيد'
  },
  email: {
    title: 'امنح الوكيل عنوان بريد إلكتروني خاصًا به',
    hint: 'صندوق وارد خاص يقرأ منه الوكيل ويرسل.',
    provision: 'إنشاء البريد'
  },
  card: {
    title: 'أعدّ البطاقة المصرفية الافتراضية للوكيل',
    hint: 'سجّل الدخول عبر رابط، وأضف ملفًا شخصيًا وطريقة دفع، ثم حدّد سقف الإنفاق.',
    waiting: (secs: string) => `في انتظار فتح رابط تسجيل الدخول · التحقق التالي بعد ${secs} ث`,
    cooling: (secs: string) => `يرجى الانتظار · ${secs} ث`,
    unconfirmed: 'لا توجد إجابة واضحة · تحقق من البطاقة مجددًا',
    resume: 'متابعة · تحقق من تسجيل الدخول',
    openLink: 'فتح رابط تسجيل الدخول',
    send: '1 · إرسال رابط تسجيل الدخول',
    sendNew: 'إرسال رابط جديد',
    resend: 'إعادة إرسال رابط تسجيل الدخول',
    resent: 'أُرسل رابط تسجيل دخول جديد إلى صندوق وارد الوكيل. افتحه، ثم تحقّق من البطاقة.',
    confirmNew: 'تأكيد · إرسال رابط جديد',
    payment: '3 · طريقة الدفع',
    probe: 'التحقق من البطاقة',
    first: 'الاسم الأول',
    last: 'اسم العائلة',
    phone: 'رقم الهاتف',
    profile: '2 · الملف الشخصي',
    limit: 'سقف الإنفاق (دولار أمريكي)',
    setLimit: '4 · سقف الإنفاق',
    readLimit: 'قراءة السقف',
    service: (hint: string) => `خدمة البطاقة: ${hint}`,
    issue: 'اطلب من الوكيل إصدار بطاقة بمبلغ محدد.',
    expired: 'ما زلنا ننتظر فتح رابط تسجيل الدخول. اضغط «استئناف» عند الانتهاء.',
    refusal: {
      'already-signed-in': 'البطاقة مسجّلة الدخول بالفعل.',
      'resend-wait': (at: string) => `أُرسل رابط تسجيل دخول قبل أقل من دقيقة. يمكن إرسال التالي في ${at}.`,
      'service-refused':
        'رفضت خدمة البطاقات هذا الحساب (محظور أو مقيّد). لا تسجّل مرة أخرى: افتح رابط تسجيل الدخول الموجود في صندوق وارد الوكيل، أو انتظر، أو اسأل الوكيل.',
      'held-until': (at: string) => `علّقت خدمة البطاقات آخر تسجيل. لن يُرسل شيء مرة أخرى قبل ${at}.`,
      unconfirmed: (at: string) =>
        `لم يتلقَّ التسجيل في ${at} إجابة واضحة وربما وصل إلى الخدمة. تُفحص البطاقة مرة أخرى قبل إرسال تسجيل آخر.`,
      cooling: 'طلبت خدمة البطاقات انتظارًا قصيرًا. يرجى الانتظار.',
      'state-unknown': 'حالة البطاقة غير معروفة الآن. افحص البطاقة مرة أخرى قبل التسجيل.',
      'link-waiting': (at: string) => `أُرسل رابط تسجيل الدخول في ${at}. ننتظره، ولن يُرسل رابط آخر.`,
      'link-sending': 'ما زال تسجيل هذا iNFT ينتظر رد خدمة البطاقات. لن يُرسل رابط آخر.',
      'link-replaces':
        'يوجد رابط تسجيل دخول في صندوق وارد الوكيل بالفعل. الرابط الجديد يحل محله؛ اضغط مرة أخرى للتأكيد.'
    },
    error: {
      held: (at: string) =>
        `تعلّق خدمة البطاقات تسجيلات هذا iNFT. لم يُرسل شيء؛ لا تسجّل مرة أخرى قبل ${at}. افتح رابط تسجيل الدخول من صندوق وارد الوكيل، أو انتظر.`,
      'rate-limited': 'تقيّد خدمة البطاقات هذا الحساب. انتظر دقيقة؛ لم يُفقد شيء.',
      blocked:
        'رفضت خدمة البطاقات هذا الحساب (محظور أو مقفل). لا تسجّل مرة أخرى: افتح رابط تسجيل الدخول من صندوق وارد الوكيل، أو انتظر 15 دقيقة، أو اسأل الوكيل.',
      'link-waiting': 'يوجد رابط تسجيل دخول في صندوق وارد الوكيل بالفعل. افتحه ثم استأنف.',
      'not-ready': 'هذا iNFT ليس جاهزًا للبطاقة بعد. أكمل تسجيل الدخول والوكيل والبريد أولًا.',
      timeout: 'لم تجب خدمة البطاقات في الوقت المحدد. ربما وصل الطلب إليها؛ تُفحص البطاقة مرة أخرى قبل إرسال أي شيء.',
      'no-state': 'أجابت خدمة البطاقات دون حالة تسجيل دخول. تُفحص البطاقة مرة أخرى أولًا.',
      'sent-unanswered': 'أُرسل التسجيل ولم يعد رده إلى هنا. افحص البطاقة مرة أخرى؛ لا ترسل تسجيلًا آخر.',
      busy: 'ما زال نداء بطاقة آخر قيد التشغيل لهذا الـ iNFT. حاول مرة أخرى عند انتهائه.',
      'resend-wait': (at: string) =>
        `أُرسل رابط تسجيل دخول لهذا الـ iNFT قبل أقل من دقيقة. لم يُرسل شيء؛ يمكن إرسال التالي في ${at}.`,
      failed: (detail: string) => (detail ? `فشل نداء البطاقة (${detail}).` : 'فشل نداء البطاقة.')
    }
  },
  hl: {
    title: 'تداول على Hyperliquid عبر الوكيل',
    hint: 'موّله من محفظة الوكيل، ثم تداول من الرسائل.',
    status: 'التحقق من الحالة',
    deposit: 'اطلب من الوكيل تحويل الأموال من محفظة الوكيل إلى Hyperliquid.'
  },
  market: {
    title: 'تصفّح سوق وكلاء Virtuals',
    hint: 'اعثر على وكلاء وعروض ومهام للتعامل معها.',
    browse: 'تصفّح الوكلاء',
    offerings: 'عروضي',
    jobs: 'مهامي'
  },
  live: {
    title: 'أحضر iNFT إلى الشاشة الرئيسية',
    hint: 'يعرض القطعة ثلاثية الأبعاد وينقل المحادثة إلى هذا iNFT.',
    summon: 'التفعيل',
    configured: (name: string) =>
      `من الرسائل، اطلب من ${name} مباشرة: «أرسل بريدًا إلى…»، «ما رصيدي؟»، «وظّف وكيلًا من أجل…». يعمل في هذا الاقتصاد بنفسه.`,
    yourInft: 'iNFT الخاص بك',
    noModel: 'لا يحتوي هذا الرمز على نموذج ثلاثي الأبعاد.'
  }
}

const ptPt: InftWizardCopy = {
  gate: {
    title: 'Cada iNFT tem o seu próprio agente, carteira, e-mail, cartão bancário e conta de trading',
    hint: 'Tudo é criado através da Virtuals, numa configuração separada e privada para cada iNFT. O agente pode ajudar em cada passo.',
    scanning: 'A procurar iNFT na sua carteira…',
    scanFailed: 'A análise da carteira não terminou',
    scanFailedHint: (reason: string) => `${reason} Volta a tentar quando o painel da coleção abrir.`,
    scanFailedReason: 'A análise parou antes de encontrar alguma coisa.',
    none: 'Ainda não foram encontrados iNFT nesta carteira',
    noneHint: 'A configuração lista todos os iNFT que lá encontrar.',
    signedOut: 'Ligue a sua carteira para configurar os seus iNFT',
    signedOutHint: 'A configuração lista todos os iNFT que nela encontrar.',
    connect: 'Ligar carteira'
  },
  picker: {
    title: 'Escolha o iNFT a configurar',
    hint: 'Depois de configurado, o iNFT atua nesta economia por si próprio a partir do Message: envia e-mails, consulta saldos e contrata agentes.',
    refresh: 'Verificar este iNFT novamente',
    ready: 'Pronto',
    needed: 'Configuração necessária'
  },
  step: {
    ask: 'Perguntar ao agente',
    askTip: 'Perguntar ao agente sobre este passo',
    resume: 'Retomar',
    notes: (text: string) => `As suas notas: ${text}`,
    addNotes: 'Adicionar notas',
    editNotes: 'Editar notas',
    notesLabel: 'Notas para este passo',
    notesPlaceholder:
      'As suas notas para este passo. Seguem com “Perguntar ao agente”, e revê a mensagem antes de ser enviada.',
    saveNotes: 'Guardar notas',
    deleteNotes: 'Eliminar notas',
    cancel: 'Cancelar',
    masked: 'Algo que parecia um segredo foi ocultado antes de ser guardado.',
    done: 'Concluído'
  },
  cli: {
    title: 'Instalar o conector da Virtuals',
    hint: 'É transferido do npm quando escolher Instalar. Nada é instalado sem o seu clique.',
    ready: (version: string) => (version ? `A versão ${version} está pronta.` : 'O conector está pronto.'),
    taught: (count: number, trees: number) => `O seu agente já o aprendeu (${count} competências em ${trees} pastas).`,
    notTaught: (reason: string) => `O seu agente ainda não o aprendeu: ${reason}`,
    unknownError: 'o motivo é desconhecido.',
    checking: 'A verificar o que o seu agente sabe…',
    reteach: 'Ensinar o agente novamente',
    keychain:
      'Após reinstalar esta compilação, o computador pergunta uma vez por iNFT antes de a aplicação poder ler a sessão guardada. Escolha “Permitir sempre” quando perguntar.',
    checkUpdate: 'Procurar atualizações',
    updateAvailable: (version: string) => `A versão ${version} está disponível.`,
    updateNow: 'Atualizar agora',
    install: 'Instalar agora'
  },
  profile: {
    title: 'Dar a este iNFT o seu próprio perfil de agente, se quiser',
    hint: 'O perfil é criado a partir da personalidade guardada no token.',
    noSoul: 'Este token não traz nenhuma personalidade a partir da qual criar um perfil.',
    select: 'Usar este perfil',
    remove: 'Eliminar perfil',
    build: 'Criar perfil'
  },
  auth: {
    title: 'Iniciar sessão na sua conta Virtuals',
    hint: 'O início de sessão abre no navegador e fica privado para este iNFT.',
    again: 'Iniciar sessão novamente',
    start: 'Iniciar sessão'
  },
  agent: {
    title: 'Criar o agente deste iNFT',
    hint: 'O agente pertence apenas a este iNFT.',
    name: 'Nome do agente',
    create: 'Criar agente',
    bound: (name: string) => `${name} está associado a este iNFT.`,
    fallback: 'O agente'
  },
  signer: {
    title: 'Permitir que o agente assine dentro de limites estritos',
    hint: 'Adiciona uma chave de assinatura com uma política restrita. Registar a identidade pública do agente é opcional.',
    armed: 'A assinatura está ativa; o agente atua dentro dos limites que definir.',
    add: 'Adicionar signatário',
    addAnother: 'Adicionar outro signatário',
    register: 'Registar identidade',
    registerTip: 'Registar este agente no registo de identidade ERC-8004 (Base). Isto assina uma transação.'
  },
  wallet: {
    title: 'Ver as carteiras do agente',
    hint: 'Um endereço EVM e um Solana, criados para este agente.',
    evm: (address: string) => `EVM ${address}`,
    sol: (address: string) => `Solana ${address}`,
    balance: 'Consultar saldo'
  },
  email: {
    title: 'Dar ao agente o seu próprio endereço de e-mail',
    hint: 'Uma caixa de entrada privada que o agente lê e a partir da qual envia.',
    provision: 'Criar e-mail'
  },
  card: {
    title: 'Configurar o cartão bancário virtual do agente',
    hint: 'Inicie sessão por ligação, adicione um perfil e um método de pagamento e depois defina um limite de gastos.',
    waiting: (secs: string) =>
      `A aguardar que a ligação de início de sessão seja aberta · próxima verificação dentro de ${secs} s`,
    cooling: (secs: string) => `Aguarde · ${secs} s`,
    unconfirmed: 'Sem resposta clara · verifique o cartão novamente',
    resume: 'Retomar · verificar o início de sessão',
    openLink: 'Abrir ligação de início de sessão',
    send: '1 · Enviar ligação de início de sessão',
    sendNew: 'Enviar nova ligação',
    resend: 'Reenviar ligação de início de sessão',
    resent:
      'Foi enviada uma nova ligação de início de sessão para a caixa de entrada do agente. Abra-a e depois verifique o cartão.',
    confirmNew: 'Confirmar · enviar nova ligação',
    payment: '3 · Método de pagamento',
    probe: 'Verificar cartão',
    first: 'Nome próprio',
    last: 'Apelido',
    phone: 'Número de telefone',
    profile: '2 · Perfil',
    limit: 'Limite de gastos (USD)',
    setLimit: '4 · Limite de gastos',
    readLimit: 'Ler limite',
    service: (hint: string) => `Serviço de cartões: ${hint}`,
    issue: 'Peça ao agente para emitir um cartão para um montante.',
    expired: 'Ainda a aguardar que a ligação de início de sessão seja aberta. Prima Retomar quando terminar.',
    refusal: {
      'already-signed-in': 'O cartão já tem sessão iniciada.',
      'resend-wait': (at: string) =>
        `Foi enviada uma ligação de início de sessão há menos de um minuto. A próxima pode ser enviada às ${at}.`,
      'service-refused':
        'O serviço de cartões recusou esta conta (bloqueada ou limitada). Não volte a registar-se: abra a ligação de início de sessão que já está na caixa de entrada do agente, aguarde ou pergunte ao agente.',
      'held-until': (at: string) =>
        `O serviço de cartões reteve o último registo. Nada é enviado novamente antes das ${at}.`,
      unconfirmed: (at: string) =>
        `O registo das ${at} não teve resposta clara e pode ter chegado ao serviço. O cartão é verificado novamente antes de ser enviado outro.`,
      cooling: 'O serviço de cartões pediu uma pausa. Aguarde.',
      'state-unknown':
        'O estado do cartão é desconhecido neste momento. Verifique o cartão novamente antes de se registar.',
      'link-waiting': (at: string) =>
        `Foi enviada uma ligação de início de sessão às ${at}. A aguardar por ela; não é enviada outra.`,
      'link-sending':
        'Um registo deste iNFT ainda está a aguardar a resposta do serviço de cartões. Não é enviado outro.',
      'link-replaces':
        'Já há uma ligação de início de sessão à espera na caixa de entrada do agente. Uma nova substitui-a; prima novamente para confirmar.'
    },
    error: {
      held: (at: string) =>
        `O serviço de cartões está a reter os registos deste iNFT. Nada foi enviado; não volte a registar-se antes das ${at}. Abra a ligação de início de sessão na caixa de entrada do agente ou aguarde.`,
      'rate-limited': 'O serviço de cartões está a limitar esta conta. Aguarde um minuto; nada se perdeu.',
      blocked:
        'O serviço de cartões recusou esta conta (bloqueada ou trancada). Não volte a registar-se: abra a ligação de início de sessão na caixa de entrada do agente, aguarde 15 minutos ou pergunte ao agente.',
      'link-waiting':
        'Já há uma ligação de início de sessão à espera na caixa de entrada do agente. Abra-a e depois retome.',
      'not-ready': 'Este iNFT não está pronto para o cartão. Conclua primeiro o início de sessão, o agente e o e-mail.',
      timeout:
        'O serviço de cartões não respondeu a tempo. O pedido pode ter chegado na mesma; o cartão é verificado novamente antes de qualquer envio.',
      'no-state':
        'O serviço de cartões respondeu sem um estado de início de sessão. O cartão é verificado novamente primeiro.',
      'sent-unanswered':
        'Foi enviado um registo e a resposta nunca chegou aqui. Verifique o cartão novamente; não envie outro.',
      busy: 'Outro pedido do cartão ainda está a decorrer para este iNFT. Tente novamente quando terminar.',
      'resend-wait': (at: string) =>
        `Foi enviada uma ligação de início de sessão para este iNFT há menos de um minuto. Nada foi enviado; a próxima pode ser enviada às ${at}.`,
      failed: (detail: string) => (detail ? `O pedido do cartão falhou (${detail}).` : 'O pedido do cartão falhou.')
    }
  },
  hl: {
    title: 'Negociar na Hyperliquid através do agente',
    hint: 'Carregue-a a partir da carteira do agente e depois negoceie a partir do Message.',
    status: 'Verificar estado',
    deposit: 'Peça ao agente para transferir fundos da carteira do agente para a Hyperliquid.'
  },
  market: {
    title: 'Explorar o mercado de agentes da Virtuals',
    hint: 'Encontre agentes, ofertas e trabalhos com que negociar.',
    browse: 'Explorar agentes',
    offerings: 'As minhas ofertas',
    jobs: 'Os meus trabalhos'
  },
  live: {
    title: 'Dar vida ao iNFT no ecrã principal',
    hint: 'Mostra a peça 3D e muda a conversa para este iNFT.',
    summon: 'Ativar em direto',
    configured: (name: string) =>
      `A partir do Message, peça diretamente a ${name}: “envia um e-mail para…”, “qual é o meu saldo?”, “contrata um agente para…”. Atua nesta economia por si próprio.`,
    yourInft: 'o seu iNFT',
    noModel: 'Este token não tem modelo 3D.'
  }
}

export const INFT_WIZARD_COPY: Record<Locale, InftWizardCopy> = { en, ja, zh, 'zh-hant': zhHant, ar, 'pt-PT': ptPt }

export function useInftWizardCopy(): InftWizardCopy {
  const { locale } = useI18n()

  return INFT_WIZARD_COPY[locale] ?? en
}
