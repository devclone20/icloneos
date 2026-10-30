/**
 * The words of the iNFT Settings pane, in all five app locales (front I-C, 2026-10-20).
 * Every row is one sentence a person understands, with the longer explanation as its hint.
 * Kept beside the pane until the shared settings catalogue is split into sub-domain files;
 * `inft-setup-copy.test.ts` proves every locale carries every key in its own language.
 */
import { type Locale, useI18n } from '@/i18n'

const en = {
  ownershipRow: {
    confirming: 'Confirming ownership…',
    held: 'Held by your wallet',
    notConfirmed: 'Not confirmed yet',
    ghSignedOut: 'GitHub is not signed in on this computer. Run `gh auth login` in a terminal, then try again.',
    nothingChanged: 'Nothing was changed.',
    setupUnavailable: 'the setup service is unavailable',
    copyNotDetached: (archive: string, reason: string) =>
      `A copy was made at ${archive}. The agent could not be detached: ${reason}. Try again.`,
    copyDetached: (archive: string) => `A copy was made at ${archive}. The agent was detached from this computer.`,
    checklist: {
      signer: 'On Virtuals, remove this agent’s signer (app.virtuals.io → your agent → Signers).',
      deny: 'Or set the signer policy to deny-all on Virtuals, so no payment can be signed after the sale.',
      balance: 'Move any balance left in the agent’s wallet before you list the iNFT.'
    },
    yourWallet: 'your wallet',
    heldBy: (holder: string) => `held by ${holder}`,
    anotherWallet: 'another wallet',
    noAnswer: 'no answer',
    block: (block: string) => `block ${block}`,
    decide: 'Decide what happens to the data',
    change: 'Change what happens to the data',
    sellHere: 'Prepare to sell · keep a copy on this computer',
    sellGithub: 'Prepare to sell · keep a copy on GitHub',
    recheck: 'Check ownership again',
    showHistory: 'Ownership history',
    hideHistory: 'Hide history',
    viewTransfer: 'View the transfer',
    emptyTitle: 'No iNFT is tracked yet',
    emptyHint: 'Each configured iNFT appears here after the next wallet scan.',
    registry: (version: string, origin: string, contracts: string) =>
      `Contract registry v${version} (${origin}, ${contracts} contracts)`
  },
  detachPanel: {
    rowTitle: (label: string) => `Detach the agent from ${label}`,
    open: 'Detach agent…',
    rowHint:
      'The token, its wallet and your Virtuals sign-in stay; this iNFT’s local setup, cached status, step notes and card sign-up state leave this computer.',
    dialogLabel: (name: string) => `Detach the agent from ${name}`,
    removes:
      'Removes this iNFT’s local agent setup: its configuration (active wallet, agent, jobs), the cached status, the step notes and the card sign-up state. Selling the iNFT never transfers the Virtuals agent; it stays bound to your wallet, and the buyer runs the setup again.',
    kept: 'Kept: your Virtuals sign-in saved on this computer (you stay signed in, and other iNFTs of the same wallet keep working), the signer key and the agent itself. The agent cannot be deleted from here; finish on Virtuals:',
    checklist: {
      signer: 'Remove the signer, or set its policy to deny-all (needs the wallet owner’s approval)',
      agent: 'Rename, deactivate or delete the agent, if the dashboard offers it',
      policies: 'Review the wallet policies'
    },
    wipe: 'Wipe the cardholder profile',
    alsoProfile: 'Also delete the agent profile',
    confirmLabel: 'Type the token number to confirm',
    confirmPlaceholder: (token: string) => `Type ${token} to confirm`,
    detach: 'Detach agent',
    cancel: 'Cancel',
    held: 'The card service is holding this account (a sign-up is running or it asked to wait). Wait, then wipe.',
    wiped: 'The cardholder profile was wiped.',
    wipeFailed: (reason: string) => `Could not wipe the cardholder profile: ${reason}`,
    detached: (count: string) => `Detached ✓ — ${count} local folders removed.`
  },
  intro: {
    title: "Your iNFT fills the whole screen, in its token's own colour.",
    hint: 'The settings on this page shape how it is presented; the piece itself never changes.'
  },
  sections: {
    render: 'How the piece is drawn',
    stage: 'The light around the piece',
    profile: 'Who answers when you talk to an iNFT',
    economy: 'Live data for the Dock apps',
    ownership: 'Selling and ownership',
    collection: 'Your collection'
  },
  quality: {
    title: 'How finely the piece is drawn, against how hard your computer works',
    hint: 'Auto reads this device, High renders at 2.5× pixel density and Max at 3×. Filmic tone, studio lights and sharp textures at every level.',
    options: { auto: 'Auto', high: 'High', max: 'Max' }
  },
  motion: {
    title: 'Let the piece move and breathe',
    hint: 'Its own clip program, acts and breathing. Off freezes the figure; you can still orbit and zoom.'
  },
  glow: {
    title: 'How bright the field behind the character is',
    hint: "The token's own colour, scaled from dim to bright."
  },
  ceiling: {
    title: 'How bright the field may get at its peak',
    hint: "From very bright down to almost black, where only the character shows. The colour always stays the token's own."
  },
  aura: {
    title: 'How strong the God Mode aura is',
    hint: 'The light the artist baked around God Mode pieces, from full down to none. Pieces without an aura are unaffected.'
  },
  reset: {
    title: 'Put the light back to the standard',
    atStandard: 'The light is at the standard.',
    tuned: 'Every summon opens at the standard; these sliders tune the piece on stage now.',
    action: 'Reset to standard'
  },
  profiles: {
    title: 'Each iNFT brings its own character',
    hint: 'One iNFT is one personality: its on-chain soul. Selecting it switches the stage, the persona and EconomyOS without a reload or a new wallet sign-in. The soul is kept as a profile so you can edit it.',
    empty: 'No iNFT with a soul in this wallet yet. Sign in and its profiles appear here.',
    loading: 'Loading profiles…'
  },
  active: {
    title: (name: string) => `You are talking to ${name}`,
    hint: 'Go back to talk to the main agent.',
    action: 'Back to the main agent'
  },
  card: {
    contract: 'contract',
    ready: 'Its profile is ready. Select it to talk to this iNFT on its own.',
    missing: 'No profile yet. It is built from the on-chain soul when you select it.',
    waiting: 'Finish signing in in your browser; this completes on its own.',
    signedIn: 'Signed in',
    signIn: 'Sign in to Virtuals',
    signingIn: 'Signing in…',
    openLink: 'Open link again',
    cancel: 'Cancel',
    select: 'Select',
    selecting: 'Selecting…',
    editSoul: 'Edit soul',
    remove: 'Delete',
    loadingSoul: 'Loading soul…',
    soulLabel: 'Soul',
    saveSoul: 'Save soul'
  },
  live: {
    title: "Let the Dock apps use this iNFT's real money and mail",
    hint: "Email, wallet, bank card, Hyperliquid and the ACP market (agent commerce) read live data from the active iNFT's own engine, one isolated configuration per iNFT. Off keeps them quiet: nothing runs until you turn it back on."
  },
  interval: {
    title: 'How often open windows refresh',
    hint: (seconds: number) =>
      `Every ${seconds} seconds while an iNFT is configured. Switching iNFT always refreshes at once.`
  },
  detach: {
    title: 'Free an agent from its iNFT before you sell it',
    hint: 'Detaching removes the local setup, never your keychain sign-in, and a checklist links the Virtuals pages for the agent and its signer.'
  },
  ownership: {
    title: 'Proof that these iNFTs are yours',
    hint: 'Ownership is proven on-chain for every configured iNFT. If one leaves your wallet it shows as deactivated everywhere; after 7 days without your answer the deactivation applies on its own. Your data is deleted only when you choose.'
  },
  autoRefresh: {
    title: 'Your wallet is re-checked on its own',
    hint: 'Every 3 minutes while you are signed in, and whenever the iNFT island opens. There is no manual scan.'
  },
  order: {
    title: 'Put the cards back in scan order',
    hint: 'Drag cards in the island to reorder them.',
    action: 'Reset card order'
  },
  cards: {
    title: 'What a card shows while its token has no picture',
    hint: 'The iCLONE head stands in until a poster exists. The EconomyOS badge appears once the setup is done on the Setup page.'
  }
}

export type InftPaneCopy = typeof en

const ja: InftPaneCopy = {
  ownershipRow: {
    confirming: '所有権を確認しています…',
    held: 'あなたのウォレットが保有しています',
    notConfirmed: 'まだ確認されていません',
    ghSignedOut:
      'このコンピューターで GitHub にサインインしていません。ターミナルで `gh auth login` を実行してから、もう一度お試しください。',
    nothingChanged: '何も変更されませんでした。',
    setupUnavailable: '設定サービスを利用できません',
    copyNotDetached: (archive: string, reason: string) =>
      `${archive} にコピーを作成しました。エージェントを切り離せませんでした: ${reason}。もう一度お試しください。`,
    copyDetached: (archive: string) =>
      `${archive} にコピーを作成しました。エージェントはこのコンピューターから切り離されました。`,
    checklist: {
      signer: 'Virtuals でこのエージェントの署名者を削除します (app.virtuals.io → エージェント → Signers)。',
      deny: 'または Virtuals で署名者のポリシーをすべて拒否に設定し、売却後に支払いへ署名できないようにします。',
      balance: 'iNFT を出品する前に、エージェントのウォレットに残っている残高を移してください。'
    },
    yourWallet: 'あなたのウォレット',
    heldBy: (holder: string) => `${holder} が保有`,
    anotherWallet: '別のウォレット',
    noAnswer: '応答なし',
    block: (block: string) => `ブロック ${block}`,
    decide: 'データの扱いを決める',
    change: 'データの扱いを変更',
    sellHere: '売却の準備 · このコンピューターにコピーを保存',
    sellGithub: '売却の準備 · GitHub にコピーを保存',
    recheck: '所有権をもう一度確認',
    showHistory: '所有権の履歴',
    hideHistory: '履歴を隠す',
    viewTransfer: '移転を表示',
    emptyTitle: '追跡中の iNFT はまだありません',
    emptyHint: '設定済みの iNFT は、次回のウォレットスキャン後にここに表示されます。',
    registry: (version: string, origin: string, contracts: string) =>
      `コントラクトレジストリ v${version} (${origin}、${contracts} 件のコントラクト)`
  },
  detachPanel: {
    rowTitle: (label: string) => `${label} からエージェントを切り離します`,
    open: 'エージェントを切り離す…',
    rowHint:
      'トークン、ウォレット、Virtuals のサインインは残ります。この iNFT のローカル設定、キャッシュされた状態、ステップのメモ、カード申込の状態はこのコンピューターから消えます。',
    dialogLabel: (name: string) => `${name} からエージェントを切り離す`,
    removes:
      'この iNFT のローカルなエージェント設定を削除します: 構成 (使用中のウォレット、エージェント、ジョブ)、キャッシュされた状態、手順のメモ、カード申し込みの状態。iNFT を売却しても Virtuals のエージェントは移転せず、あなたのウォレットに結び付いたままです。購入者は設定をやり直します。',
    kept: '残るもの: このコンピューターに保存された Virtuals のサインイン (サインアウトされず、同じウォレットの他の iNFT も動作し続けます)、署名鍵、エージェント自体。ここからはエージェントを削除できないため、Virtuals で完了してください:',
    checklist: {
      signer: '署名者を削除するか、ポリシーをすべて拒否に設定します (ウォレット所有者の承認が必要)',
      agent: 'ダッシュボードにあれば、エージェントの名前変更、無効化、削除を行います',
      policies: 'ウォレットのポリシーを確認'
    },
    wipe: 'カード名義人のプロフィールを消去',
    alsoProfile: 'エージェントのプロフィールも削除する',
    confirmLabel: '確認のためトークン番号を入力してください',
    confirmPlaceholder: (token: string) => `確認のため ${token} と入力`,
    detach: 'エージェントを切り離す',
    cancel: 'キャンセル',
    held: 'カードサービスがこのアカウントを保留しています (申し込みが進行中か、待機を求められました)。待ってから消去してください。',
    wiped: 'カード名義人のプロフィールを消去しました。',
    wipeFailed: (reason: string) => `カード名義人のプロフィールを消去できませんでした: ${reason}`,
    detached: (count: string) => `切り離しました ✓ — ローカルフォルダーを ${count} 個削除しました。`
  },
  intro: {
    title: 'iNFT はトークン固有の色で画面全体を占めます。',
    hint: 'このページの設定は見せ方を整えるだけで、作品そのものは変わりません。'
  },
  sections: {
    render: '作品の描画',
    stage: '作品を包む光',
    profile: 'iNFT と話すときに応答する人格',
    economy: 'Dock アプリのライブデータ',
    ownership: '売却と所有権',
    collection: 'あなたのコレクション'
  },
  quality: {
    title: '描画の精細さとコンピューターの負荷のバランス',
    hint: '自動はこのデバイスに合わせ、高は 2.5 倍、最大は 3 倍のピクセル密度で描画します。どのレベルでもフィルミックなトーン、スタジオ照明、鮮明なテクスチャを使います。',
    options: { auto: '自動', high: '高', max: '最大' }
  },
  motion: {
    title: '作品が動き、呼吸できるようにする',
    hint: '固有のクリップ、演技、呼吸。オフにすると姿勢が止まりますが、回転やズームはできます。'
  },
  glow: {
    title: 'キャラクターの背後にあるフィールドの明るさ',
    hint: 'トークン固有の色を、暗い状態から明るい状態まで調整します。'
  },
  ceiling: {
    title: 'フィールドのピーク時の明るさの上限',
    hint: 'とても明るい状態から、キャラクターだけが見えるほぼ黒の状態まで。色は常にトークン固有のものです。'
  },
  aura: {
    title: 'God Mode のオーラの強さ',
    hint: 'アーティストが God Mode の作品に焼き込んだ光を、最大からゼロまで調整します。オーラのない作品には影響しません。'
  },
  reset: {
    title: '光を標準に戻す',
    atStandard: '光は標準の状態です。',
    tuned: '召喚は毎回標準で始まります。スライダーは今ステージにある作品を調整します。',
    action: '標準に戻す'
  },
  profiles: {
    title: 'iNFT はそれぞれ固有の人格を持ちます',
    hint: '1 つの iNFT は 1 つの人格、つまりオンチェーンのソウルです。選択するとステージ、ペルソナ、EconomyOS が切り替わり、再読み込みやウォレットへの再サインインは不要です。ソウルはプロファイルとして保存されるので編集できます。',
    empty: 'このウォレットにはソウルを持つ iNFT がまだありません。サインインするとここにプロファイルが表示されます。',
    loading: 'プロファイルを読み込み中…'
  },
  active: {
    title: (name: string) => `現在 ${name} と話しています`,
    hint: 'メインのエージェントとの会話に戻ります。',
    action: 'メインのエージェントに戻る'
  },
  card: {
    contract: 'コントラクト',
    ready: 'プロファイルの準備ができています。選択するとこの iNFT と直接話せます。',
    missing: 'プロファイルはまだありません。選択するとオンチェーンのソウルから作成されます。',
    waiting: 'ブラウザでサインインを完了してください。完了すると自動で反映されます。',
    signedIn: 'サインイン済み',
    signIn: 'Virtuals にサインイン',
    signingIn: 'サインイン中…',
    openLink: 'リンクをもう一度開く',
    cancel: 'キャンセル',
    select: '選択',
    selecting: '選択中…',
    editSoul: 'ソウルを編集',
    remove: '削除',
    loadingSoul: 'ソウルを読み込み中…',
    soulLabel: 'ソウル',
    saveSoul: 'ソウルを保存'
  },
  live: {
    title: 'Dock アプリにこの iNFT の実際の資金とメールを使わせる',
    hint: 'メール、ウォレット、バンクカード、Hyperliquid、ACP マーケット（エージェント商取引）が、アクティブな iNFT 専用のエンジンからライブデータを読み込みます。設定は iNFT ごとに分離されています。オフにすると、再びオンにするまで何も実行されません。'
  },
  interval: {
    title: '開いているウィンドウの更新頻度',
    hint: (seconds: number) =>
      `iNFT が設定されている間は ${seconds} 秒ごとに更新します。iNFT を切り替えると常にすぐ更新されます。`
  },
  detach: {
    title: '売却する前にエージェントを iNFT から切り離す',
    hint: '切り離すとローカルの設定が削除されます（キーチェーンのサインインは削除されません）。チェックリストからエージェントと署名者の Virtuals ページを開けます。'
  },
  ownership: {
    title: 'これらの iNFT があなたのものである証明',
    hint: '設定済みの各 iNFT の所有権はオンチェーンで証明されます。ウォレットから離れた iNFT はどこでも無効と表示され、7 日以内に応答がなければ無効化が自動で適用されます。データはあなたが選んだときにだけ削除されます。'
  },
  autoRefresh: {
    title: 'ウォレットは自動で再確認されます',
    hint: 'サインイン中は 3 分ごと、そして iNFT アイランドを開くたびに確認します。手動スキャンはありません。'
  },
  order: {
    title: 'カードをスキャン順に戻す',
    hint: 'アイランドでカードをドラッグして並べ替えられます。',
    action: 'カードの順序をリセット'
  },
  cards: {
    title: 'トークンに画像がない間のカードの表示',
    hint: 'ポスターができるまで iCLONE のヘッドが表示されます。セットアップページで設定が完了すると EconomyOS バッジが表示されます。'
  }
}

const zh: InftPaneCopy = {
  ownershipRow: {
    confirming: '正在确认所有权…',
    held: '由你的钱包持有',
    notConfirmed: '尚未确认',
    ghSignedOut: '这台电脑上没有登录 GitHub。请在终端中运行 `gh auth login`，然后重试。',
    nothingChanged: '没有任何更改。',
    setupUnavailable: '设置服务不可用',
    copyNotDetached: (archive: string, reason: string) =>
      `已在 ${archive} 创建副本。无法解除智能体：${reason}。请重试。`,
    copyDetached: (archive: string) => `已在 ${archive} 创建副本。智能体已从这台电脑上解除。`,
    checklist: {
      signer: '在 Virtuals 上移除这个智能体的签名者（app.virtuals.io → 你的智能体 → Signers）。',
      deny: '或在 Virtuals 上把签名者策略设为全部拒绝，这样出售后就无法再签署付款。',
      balance: '在挂售 iNFT 之前，先转出智能体钱包中剩余的余额。'
    },
    yourWallet: '你的钱包',
    heldBy: (holder: string) => `由 ${holder} 持有`,
    anotherWallet: '另一个钱包',
    noAnswer: '无应答',
    block: (block: string) => `区块 ${block}`,
    decide: '决定如何处理数据',
    change: '更改数据的处理方式',
    sellHere: '准备出售 · 在这台电脑上保留副本',
    sellGithub: '准备出售 · 在 GitHub 上保留副本',
    recheck: '重新检查所有权',
    showHistory: '所有权记录',
    hideHistory: '隐藏记录',
    viewTransfer: '查看转移',
    emptyTitle: '尚未跟踪任何 iNFT',
    emptyHint: '每个已设置的 iNFT 会在下次钱包扫描后出现在这里。',
    registry: (version: string, origin: string, contracts: string) =>
      `合约注册表 v${version}（${origin}，${contracts} 个合约）`
  },
  detachPanel: {
    rowTitle: (label: string) => `从 ${label} 解除智能体`,
    open: '解除智能体…',
    rowHint: '代币、钱包和你的 Virtuals 登录保留；这个 iNFT 的本地设置、缓存状态、步骤备注和办卡状态会从这台电脑移除。',
    dialogLabel: (name: string) => `从 ${name} 解除智能体`,
    removes:
      '移除这个 iNFT 的本地智能体设置：配置（当前钱包、智能体、任务）、缓存的状态、步骤备注和银行卡申请状态。出售 iNFT 不会转移 Virtuals 智能体；它仍绑定在你的钱包上，买家需要重新设置。',
    kept: '保留：保存在这台电脑上的 Virtuals 登录（你不会被登出，同一钱包的其他 iNFT 照常工作）、签名密钥以及智能体本身。这里无法删除智能体，请在 Virtuals 上完成：',
    checklist: {
      signer: '移除签名者，或把其策略设为全部拒绝（需要钱包所有者批准）',
      agent: '如果控制台提供，重命名、停用或删除智能体',
      policies: '查看钱包策略'
    },
    wipe: '清除持卡人资料',
    alsoProfile: '同时删除智能体档案',
    confirmLabel: '输入代币编号以确认',
    confirmPlaceholder: (token: string) => `输入 ${token} 以确认`,
    detach: '解除智能体',
    cancel: '取消',
    held: '银行卡服务正在暂停这个账户（申请正在进行，或要求等待）。请稍候再清除。',
    wiped: '持卡人资料已清除。',
    wipeFailed: (reason: string) => `无法清除持卡人资料：${reason}`,
    detached: (count: string) => `已解除 ✓ — 移除了 ${count} 个本地文件夹。`
  },
  intro: {
    title: '你的 iNFT 以其代币自身的颜色占满整个屏幕。',
    hint: '本页的设置只调整它的呈现方式，作品本身不会改变。'
  },
  sections: {
    render: '作品的绘制方式',
    stage: '作品周围的光',
    profile: '与 iNFT 对话时由谁回应',
    economy: 'Dock 应用的实时数据',
    ownership: '出售与所有权',
    collection: '你的收藏'
  },
  quality: {
    title: '在绘制精细度和电脑负载之间取得平衡',
    hint: '自动会根据本设备调整，高以 2.5 倍像素密度渲染，最高为 3 倍。每个级别都使用电影级色调、影棚灯光和清晰纹理。',
    options: { auto: '自动', high: '高', max: '最高' }
  },
  motion: {
    title: '让作品动起来并呼吸',
    hint: '它自身的动画片段、动作和呼吸。关闭后人物会定格，但你仍可旋转和缩放。'
  },
  glow: {
    title: '角色背后光场的亮度',
    hint: '代币自身的颜色，可从暗调到亮。'
  },
  ceiling: {
    title: '光场峰值亮度的上限',
    hint: '从非常明亮到几乎全黑，此时只显示角色。颜色始终是代币自身的颜色。'
  },
  aura: {
    title: 'God Mode 光环的强度',
    hint: '艺术家为 God Mode 作品烘焙的光，可从完全开启调到无。没有光环的作品不受影响。'
  },
  reset: {
    title: '将光线恢复为标准值',
    atStandard: '光线处于标准值。',
    tuned: '每次召唤都以标准值开始；这些滑块调整当前舞台上的作品。',
    action: '恢复标准'
  },
  profiles: {
    title: '每个 iNFT 都有自己的性格',
    hint: '一个 iNFT 就是一个人格，即它的链上灵魂。选择它会切换舞台、人格和 EconomyOS，无需重新加载，也无需重新登录钱包。灵魂会保存为配置文件，方便你编辑。',
    empty: '此钱包中还没有带灵魂的 iNFT。登录后，它们的配置文件会显示在这里。',
    loading: '正在加载配置文件…'
  },
  active: {
    title: (name: string) => `你正在与 ${name} 对话`,
    hint: '返回与主智能体对话。',
    action: '返回主智能体'
  },
  card: {
    contract: '合约',
    ready: '它的配置文件已就绪。选择它即可单独与这个 iNFT 对话。',
    missing: '还没有配置文件。选择它时会根据链上灵魂创建。',
    waiting: '请在浏览器中完成登录，完成后会自动生效。',
    signedIn: '已登录',
    signIn: '登录 Virtuals',
    signingIn: '正在登录…',
    openLink: '再次打开链接',
    cancel: '取消',
    select: '选择',
    selecting: '正在选择…',
    editSoul: '编辑灵魂',
    remove: '删除',
    loadingSoul: '正在加载灵魂…',
    soulLabel: '灵魂',
    saveSoul: '保存灵魂'
  },
  live: {
    title: '让 Dock 应用使用这个 iNFT 的真实资金和邮件',
    hint: '邮件、钱包、银行卡、Hyperliquid 和 ACP 市场（智能体商务）会从当前 iNFT 自己的引擎读取实时数据，每个 iNFT 使用独立的配置。关闭后它们保持安静：在你重新开启之前不会运行任何内容。'
  },
  interval: {
    title: '已打开窗口的刷新频率',
    hint: (seconds: number) => `配置了 iNFT 时每 ${seconds} 秒刷新一次。切换 iNFT 时总会立即刷新。`
  },
  detach: {
    title: '出售 iNFT 之前先解除其代理',
    hint: '解除会移除本地设置，但绝不会移除你的钥匙串登录；清单会链接到该代理及其签名者的 Virtuals 页面。'
  },
  ownership: {
    title: '证明这些 iNFT 归你所有',
    hint: '每个已配置 iNFT 的所有权都在链上证明。如果某个 iNFT 离开你的钱包，它在各处都会显示为已停用；7 天内未收到你的回应，停用会自动生效。你的数据只有在你选择时才会被删除。'
  },
  autoRefresh: {
    title: '你的钱包会自动重新检查',
    hint: '登录期间每 3 分钟检查一次，并在每次打开 iNFT 岛时检查。没有手动扫描。'
  },
  order: {
    title: '将卡片恢复为扫描顺序',
    hint: '在岛中拖动卡片即可重新排序。',
    action: '重置卡片顺序'
  },
  cards: {
    title: '代币没有图片时卡片显示的内容',
    hint: '在海报生成之前显示 iCLONE 头像。在设置页面完成设置后会显示 EconomyOS 徽章。'
  }
}

const zhHant: InftPaneCopy = {
  ownershipRow: {
    confirming: '正在確認所有權…',
    held: '由你的錢包持有',
    notConfirmed: '尚未確認',
    ghSignedOut: '這台電腦上沒有登入 GitHub。請在終端機中執行 `gh auth login`，然後再試一次。',
    nothingChanged: '沒有任何變更。',
    setupUnavailable: '設定服務無法使用',
    copyNotDetached: (archive: string, reason: string) =>
      `已在 ${archive} 建立副本。無法解除智慧體：${reason}。請再試一次。`,
    copyDetached: (archive: string) => `已在 ${archive} 建立副本。智慧體已從這台電腦上解除。`,
    checklist: {
      signer: '在 Virtuals 上移除這個智慧體的簽署者（app.virtuals.io → 你的智慧體 → Signers）。',
      deny: '或在 Virtuals 上把簽署者政策設為全部拒絕，這樣出售後就無法再簽署付款。',
      balance: '在刊登 iNFT 之前，先轉出智慧體錢包中剩餘的餘額。'
    },
    yourWallet: '你的錢包',
    heldBy: (holder: string) => `由 ${holder} 持有`,
    anotherWallet: '另一個錢包',
    noAnswer: '無回應',
    block: (block: string) => `區塊 ${block}`,
    decide: '決定如何處理資料',
    change: '變更資料的處理方式',
    sellHere: '準備出售 · 在這台電腦上保留副本',
    sellGithub: '準備出售 · 在 GitHub 上保留副本',
    recheck: '重新檢查所有權',
    showHistory: '所有權紀錄',
    hideHistory: '隱藏紀錄',
    viewTransfer: '查看移轉',
    emptyTitle: '尚未追蹤任何 iNFT',
    emptyHint: '每個已設定的 iNFT 會在下次錢包掃描後出現在這裡。',
    registry: (version: string, origin: string, contracts: string) =>
      `合約登記冊 v${version}（${origin}，${contracts} 個合約）`
  },
  detachPanel: {
    rowTitle: (label: string) => `從 ${label} 解除智慧體`,
    open: '解除智慧體…',
    rowHint: '代幣、錢包和你的 Virtuals 登入保留；這個 iNFT 的本地設定、快取狀態、步驟備註和辦卡狀態會從這台電腦移除。',
    dialogLabel: (name: string) => `從 ${name} 解除智慧體`,
    removes:
      '移除這個 iNFT 的本機智慧體設定：設定內容（目前錢包、智慧體、任務）、快取的狀態、步驟備註和銀行卡申請狀態。出售 iNFT 不會移轉 Virtuals 智慧體；它仍綁定在你的錢包上，買家需要重新設定。',
    kept: '保留：儲存在這台電腦上的 Virtuals 登入（你不會被登出，同一錢包的其他 iNFT 照常運作）、簽署金鑰以及智慧體本身。這裡無法刪除智慧體，請在 Virtuals 上完成：',
    checklist: {
      signer: '移除簽署者，或把其政策設為全部拒絕（需要錢包擁有者核准）',
      agent: '如果控制台提供，重新命名、停用或刪除智慧體',
      policies: '查看錢包政策'
    },
    wipe: '清除持卡人資料',
    alsoProfile: '同時刪除智慧代理檔案',
    confirmLabel: '輸入代幣編號以確認',
    confirmPlaceholder: (token: string) => `輸入 ${token} 以確認`,
    detach: '解除智慧體',
    cancel: '取消',
    held: '銀行卡服務正在暫停這個帳戶（申請正在進行，或要求等待）。請稍候再清除。',
    wiped: '持卡人資料已清除。',
    wipeFailed: (reason: string) => `無法清除持卡人資料：${reason}`,
    detached: (count: string) => `已解除 ✓ — 移除了 ${count} 個本機資料夾。`
  },
  intro: {
    title: '你的 iNFT 以其代幣自身的顏色佔滿整個螢幕。',
    hint: '本頁的設定只調整它的呈現方式，作品本身不會改變。'
  },
  sections: {
    render: '作品的繪製方式',
    stage: '作品周圍的光',
    profile: '與 iNFT 對話時由誰回應',
    economy: 'Dock 應用程式的即時資料',
    ownership: '出售與所有權',
    collection: '你的收藏'
  },
  quality: {
    title: '在繪製精細度與電腦負載之間取得平衡',
    hint: '自動會依本裝置調整，高以 2.5 倍像素密度算繪，最高為 3 倍。每個等級都使用電影級色調、攝影棚燈光與清晰紋理。',
    options: { auto: '自動', high: '高', max: '最高' }
  },
  motion: {
    title: '讓作品動起來並呼吸',
    hint: '它自身的動畫片段、動作與呼吸。關閉後人物會定格，但你仍可旋轉與縮放。'
  },
  glow: {
    title: '角色背後光場的亮度',
    hint: '代幣自身的顏色，可從暗調到亮。'
  },
  ceiling: {
    title: '光場峰值亮度的上限',
    hint: '從非常明亮到幾乎全黑，此時只顯示角色。顏色始終是代幣自身的顏色。'
  },
  aura: {
    title: 'God Mode 光環的強度',
    hint: '藝術家為 God Mode 作品烘焙的光，可從完全開啟調到無。沒有光環的作品不受影響。'
  },
  reset: {
    title: '將光線恢復為標準值',
    atStandard: '光線處於標準值。',
    tuned: '每次召喚都以標準值開始；這些滑桿調整目前舞台上的作品。',
    action: '恢復標準'
  },
  profiles: {
    title: '每個 iNFT 都有自己的性格',
    hint: '一個 iNFT 就是一個人格，也就是它的鏈上靈魂。選擇它會切換舞台、人格與 EconomyOS，無需重新載入，也無需重新登入錢包。靈魂會儲存為設定檔，方便你編輯。',
    empty: '此錢包中還沒有帶靈魂的 iNFT。登入後，它們的設定檔會顯示在這裡。',
    loading: '正在載入設定檔…'
  },
  active: {
    title: (name: string) => `你正在與 ${name} 對話`,
    hint: '返回與主智慧代理對話。',
    action: '返回主智慧代理'
  },
  card: {
    contract: '合約',
    ready: '它的設定檔已就緒。選擇它即可單獨與這個 iNFT 對話。',
    missing: '還沒有設定檔。選擇它時會根據鏈上靈魂建立。',
    waiting: '請在瀏覽器中完成登入，完成後會自動生效。',
    signedIn: '已登入',
    signIn: '登入 Virtuals',
    signingIn: '正在登入…',
    openLink: '再次開啟連結',
    cancel: '取消',
    select: '選擇',
    selecting: '正在選擇…',
    editSoul: '編輯靈魂',
    remove: '刪除',
    loadingSoul: '正在載入靈魂…',
    soulLabel: '靈魂',
    saveSoul: '儲存靈魂'
  },
  live: {
    title: '讓 Dock 應用程式使用這個 iNFT 的真實資金與郵件',
    hint: '郵件、錢包、銀行卡、Hyperliquid 與 ACP 市場（智慧體商務）會從目前 iNFT 自己的引擎讀取即時資料，每個 iNFT 使用獨立的設定。關閉後它們保持安靜：在你重新開啟之前不會執行任何內容。'
  },
  interval: {
    title: '已開啟視窗的重新整理頻率',
    hint: (seconds: number) => `設定了 iNFT 時每 ${seconds} 秒重新整理一次。切換 iNFT 時總會立即重新整理。`
  },
  detach: {
    title: '出售 iNFT 之前先解除其代理',
    hint: '解除會移除本機設定，但絕不會移除你的鑰匙圈登入；清單會連結到該代理及其簽署者的 Virtuals 頁面。'
  },
  ownership: {
    title: '證明這些 iNFT 歸你所有',
    hint: '每個已設定 iNFT 的所有權都在鏈上證明。如果某個 iNFT 離開你的錢包，它在各處都會顯示為已停用；7 天內未收到你的回應，停用會自動生效。你的資料只有在你選擇時才會被刪除。'
  },
  autoRefresh: {
    title: '你的錢包會自動重新檢查',
    hint: '登入期間每 3 分鐘檢查一次，並在每次開啟 iNFT 島時檢查。沒有手動掃描。'
  },
  order: {
    title: '將卡片恢復為掃描順序',
    hint: '在島中拖曳卡片即可重新排序。',
    action: '重設卡片順序'
  },
  cards: {
    title: '代幣沒有圖片時卡片顯示的內容',
    hint: '在海報產生之前顯示 iCLONE 頭像。在設定頁面完成設定後會顯示 EconomyOS 徽章。'
  }
}

const ar: InftPaneCopy = {
  ownershipRow: {
    confirming: 'جارٍ تأكيد الملكية…',
    held: 'تحتفظ به محفظتك',
    notConfirmed: 'لم يتأكد بعد',
    ghSignedOut: 'لم يتم تسجيل الدخول إلى GitHub على هذا الحاسوب. شغّل `gh auth login` في الطرفية، ثم حاول مجددًا.',
    nothingChanged: 'لم يتغير شيء.',
    setupUnavailable: 'خدمة الإعداد غير متاحة',
    copyNotDetached: (archive: string, reason: string) =>
      `أُنشئت نسخة في ${archive}. تعذّر فصل الوكيل: ${reason}. حاول مجددًا.`,
    copyDetached: (archive: string) => `أُنشئت نسخة في ${archive}. فُصل الوكيل عن هذا الحاسوب.`,
    checklist: {
      signer: 'على Virtuals، أزل موقّع هذا الوكيل (app.virtuals.io ← وكيلك ← Signers).',
      deny: 'أو اضبط سياسة الموقّع على رفض الكل في Virtuals، فلا يمكن توقيع أي دفعة بعد البيع.',
      balance: 'انقل أي رصيد متبقٍ في محفظة الوكيل قبل عرض iNFT للبيع.'
    },
    yourWallet: 'محفظتك',
    heldBy: (holder: string) => `تحتفظ به ${holder}`,
    anotherWallet: 'محفظة أخرى',
    noAnswer: 'لا رد',
    block: (block: string) => `الكتلة ${block}`,
    decide: 'قرّر مصير البيانات',
    change: 'غيّر مصير البيانات',
    sellHere: 'التحضير للبيع · احتفظ بنسخة على هذا الحاسوب',
    sellGithub: 'التحضير للبيع · احتفظ بنسخة على GitHub',
    recheck: 'التحقق من الملكية مجددًا',
    showHistory: 'سجل الملكية',
    hideHistory: 'إخفاء السجل',
    viewTransfer: 'عرض النقل',
    emptyTitle: 'لا يوجد iNFT قيد التتبع بعد',
    emptyHint: 'يظهر كل iNFT مُعدّ هنا بعد فحص المحفظة التالي.',
    registry: (version: string, origin: string, contracts: string) =>
      `سجل العقود v${version} (${origin}، ${contracts} عقود)`
  },
  detachPanel: {
    rowTitle: (label: string) => `افصل الوكيل عن ${label}`,
    open: 'فصل الوكيل…',
    rowHint:
      'يبقى الرمز ومحفظته وتسجيل دخولك إلى Virtuals؛ ويُزال من هذا الكمبيوتر إعداد هذا الـ iNFT المحلي وحالته المخزّنة وملاحظات الخطوات وحالة طلب البطاقة.',
    dialogLabel: (name: string) => `فصل الوكيل عن ${name}`,
    removes:
      'يزيل إعداد الوكيل المحلي لهذا iNFT: تهيئته (المحفظة النشطة، الوكيل، المهام)، والحالة المخزنة، وملاحظات الخطوات، وحالة طلب البطاقة. بيع iNFT لا ينقل وكيل Virtuals أبدًا؛ يبقى مرتبطًا بمحفظتك، ويعيد المشتري الإعداد.',
    kept: 'يبقى: تسجيل دخولك إلى Virtuals المحفوظ على هذا الحاسوب (لن يتم تسجيل خروجك، وتواصل iNFT الأخرى في المحفظة نفسها العمل)، ومفتاح الموقّع، والوكيل نفسه. لا يمكن حذف الوكيل من هنا؛ أكمل على Virtuals:',
    checklist: {
      signer: 'أزل الموقّع، أو اضبط سياسته على رفض الكل (يتطلب موافقة مالك المحفظة)',
      agent: 'أعد تسمية الوكيل أو عطّله أو احذفه، إن أتاحت لوحة التحكم ذلك',
      policies: 'راجع سياسات المحفظة'
    },
    wipe: 'مسح ملف حامل البطاقة',
    alsoProfile: 'احذف ملف الوكيل أيضًا',
    confirmLabel: 'اكتب رقم الرمز للتأكيد',
    confirmPlaceholder: (token: string) => `اكتب ${token} للتأكيد`,
    detach: 'فصل الوكيل',
    cancel: 'إلغاء',
    held: 'خدمة البطاقة تحجز هذا الحساب (طلب قيد التنفيذ أو طُلب الانتظار). انتظر، ثم امسح.',
    wiped: 'مُسح ملف حامل البطاقة.',
    wipeFailed: (reason: string) => `تعذّر مسح ملف حامل البطاقة: ${reason}`,
    detached: (count: string) => `تم الفصل ✓ — أُزيل ${count} من المجلدات المحلية.`
  },
  intro: {
    title: 'يملأ iNFT الخاص بك الشاشة كلها، بلون رمزه الخاص.',
    hint: 'تضبط إعدادات هذه الصفحة طريقة عرضه فقط؛ القطعة نفسها لا تتغير أبدًا.'
  },
  sections: {
    render: 'كيف تُرسم القطعة',
    stage: 'الضوء حول القطعة',
    profile: 'من يجيب عندما تتحدث إلى iNFT',
    economy: 'بيانات حية لتطبيقات Dock',
    ownership: 'البيع والملكية',
    collection: 'مجموعتك'
  },
  quality: {
    title: 'مدى دقة رسم القطعة، مقابل الجهد الذي يبذله جهازك',
    hint: 'الوضع التلقائي يقرأ هذا الجهاز، والعالي يعرض بكثافة بكسل 2.5×، والأقصى 3×. تدرج سينمائي وإضاءة استوديو وخامات حادة في كل مستوى.',
    options: { auto: 'تلقائي', high: 'عالٍ', max: 'أقصى' }
  },
  motion: {
    title: 'دع القطعة تتحرك وتتنفس',
    hint: 'مقاطعها وحركاتها وتنفسها الخاص. الإيقاف يجمّد الشخصية؛ ويظل بإمكانك تدويرها وتكبيرها.'
  },
  glow: {
    title: 'مدى سطوع المجال خلف الشخصية',
    hint: 'لون الرمز نفسه، من خافت إلى ساطع.'
  },
  ceiling: {
    title: 'أقصى سطوع يمكن أن يبلغه المجال',
    hint: 'من ساطع جدًا إلى شبه أسود، حيث لا تظهر إلا الشخصية. يبقى اللون دائمًا لون الرمز نفسه.'
  },
  aura: {
    title: 'مدى قوة هالة God Mode',
    hint: 'الضوء الذي أضافه الفنان حول قطع God Mode، من كامل إلى لا شيء. القطع التي بلا هالة لا تتأثر.'
  },
  reset: {
    title: 'أعِد الضوء إلى المستوى القياسي',
    atStandard: 'الضوء على المستوى القياسي.',
    tuned: 'يبدأ كل استدعاء بالمستوى القياسي؛ هذه المنزلقات تضبط القطعة الموجودة على المسرح الآن.',
    action: 'إعادة إلى القياسي'
  },
  profiles: {
    title: 'لكل iNFT شخصيته الخاصة',
    hint: 'كل iNFT هو شخصية واحدة: روحه المسجلة على السلسلة. اختياره يبدّل المسرح والشخصية وEconomyOS دون إعادة تحميل أو تسجيل دخول جديد إلى المحفظة. تُحفظ الروح كملف شخصي لتتمكن من تعديلها.',
    empty: 'لا يوجد بعد في هذه المحفظة iNFT له روح. سجّل الدخول وستظهر ملفاته الشخصية هنا.',
    loading: 'جارٍ تحميل الملفات الشخصية…'
  },
  active: {
    title: (name: string) => `أنت تتحدث إلى ${name}`,
    hint: 'عُد للتحدث إلى الوكيل الرئيسي.',
    action: 'العودة إلى الوكيل الرئيسي'
  },
  card: {
    contract: 'العقد',
    ready: 'ملفه الشخصي جاهز. اختره لتتحدث إلى هذا iNFT مباشرة.',
    missing: 'لا يوجد ملف شخصي بعد. يُنشأ من الروح المسجلة على السلسلة عند اختياره.',
    waiting: 'أكمل تسجيل الدخول في المتصفح؛ سيكتمل الأمر تلقائيًا.',
    signedIn: 'تم تسجيل الدخول',
    signIn: 'تسجيل الدخول إلى Virtuals',
    signingIn: 'جارٍ تسجيل الدخول…',
    openLink: 'افتح الرابط مرة أخرى',
    cancel: 'إلغاء',
    select: 'اختيار',
    selecting: 'جارٍ الاختيار…',
    editSoul: 'تعديل الروح',
    remove: 'حذف',
    loadingSoul: 'جارٍ تحميل الروح…',
    soulLabel: 'الروح',
    saveSoul: 'حفظ الروح'
  },
  live: {
    title: 'اسمح لتطبيقات Dock باستخدام أموال هذا iNFT وبريده الحقيقيين',
    hint: 'يقرأ البريد والمحفظة والبطاقة المصرفية وHyperliquid وسوق ACP (تجارة الوكلاء) بيانات حية من محرّك iNFT النشط الخاص، بإعداد معزول لكل iNFT. الإيقاف يبقيها هادئة: لا يعمل شيء حتى تعيد تشغيله.'
  },
  interval: {
    title: 'كم مرة تُحدَّث النوافذ المفتوحة',
    hint: (seconds: number) => `كل ${seconds} ثانية ما دام هناك iNFT مُعد. تبديل iNFT يحدّثها فورًا دائمًا.`
  },
  detach: {
    title: 'افصل الوكيل عن iNFT الخاص به قبل بيعه',
    hint: 'الفصل يزيل الإعداد المحلي، ولا يزيل أبدًا تسجيل دخولك في سلسلة المفاتيح، وتربط قائمة تحقق بصفحات Virtuals الخاصة بالوكيل وموقّعه.'
  },
  ownership: {
    title: 'دليل على أن هذه الـ iNFT ملكك',
    hint: 'تُثبت ملكية كل iNFT مُعد على السلسلة. إذا غادر أحدها محفظتك يظهر معطلًا في كل مكان؛ وبعد 7 أيام دون ردك يُطبق التعطيل تلقائيًا. لا تُحذف بياناتك إلا باختيارك.'
  },
  autoRefresh: {
    title: 'يُعاد فحص محفظتك تلقائيًا',
    hint: 'كل 3 دقائق أثناء تسجيل دخولك، وكلما فُتحت جزيرة iNFT. لا يوجد فحص يدوي.'
  },
  order: {
    title: 'أعِد البطاقات إلى ترتيب الفحص',
    hint: 'اسحب البطاقات في الجزيرة لإعادة ترتيبها.',
    action: 'إعادة ترتيب البطاقات'
  },
  cards: {
    title: 'ما تعرضه البطاقة عندما لا تكون لرمزها صورة',
    hint: 'يظهر رأس iCLONE إلى أن يتوفر ملصق. تظهر شارة EconomyOS بعد اكتمال الإعداد في صفحة الإعداد.'
  }
}

const ptPt: InftPaneCopy = {
  ownershipRow: {
    confirming: 'A confirmar a posse…',
    held: 'Na posse da sua carteira',
    notConfirmed: 'Ainda não confirmado',
    ghSignedOut:
      'O GitHub não tem sessão iniciada neste computador. Execute `gh auth login` num terminal e tente novamente.',
    nothingChanged: 'Nada foi alterado.',
    setupUnavailable: 'o serviço de configuração não está disponível',
    copyNotDetached: (archive: string, reason: string) =>
      `Foi feita uma cópia em ${archive}. Não foi possível desvincular o agente: ${reason}. Tente novamente.`,
    copyDetached: (archive: string) => `Foi feita uma cópia em ${archive}. O agente foi desvinculado deste computador.`,
    checklist: {
      signer: 'Na Virtuals, remova o signatário deste agente (app.virtuals.io → o seu agente → Signers).',
      deny: 'Ou defina a política do signatário como deny-all na Virtuals, para que nenhum pagamento possa ser assinado após a venda.',
      balance: 'Transfira o saldo que restar na carteira do agente antes de pôr o iNFT à venda.'
    },
    yourWallet: 'a sua carteira',
    heldBy: (holder: string) => `na posse de ${holder}`,
    anotherWallet: 'outra carteira',
    noAnswer: 'sem resposta',
    block: (block: string) => `bloco ${block}`,
    decide: 'Decidir o que acontece aos dados',
    change: 'Alterar o que acontece aos dados',
    sellHere: 'Preparar a venda · guardar uma cópia neste computador',
    sellGithub: 'Preparar a venda · guardar uma cópia no GitHub',
    recheck: 'Verificar a posse novamente',
    showHistory: 'Histórico de posse',
    hideHistory: 'Ocultar histórico',
    viewTransfer: 'Ver a transferência',
    emptyTitle: 'Ainda nenhum iNFT é acompanhado',
    emptyHint: 'Cada iNFT configurado aparece aqui após a próxima análise da carteira.',
    registry: (version: string, origin: string, contracts: string) =>
      `Registo de contratos v${version} (${origin}, ${contracts} contratos)`
  },
  detachPanel: {
    rowTitle: (label: string) => `Desvincular o agente de ${label}`,
    open: 'Desvincular agente…',
    rowHint:
      'O token, a respetiva carteira e a sua sessão na Virtuals mantêm-se; a configuração local deste iNFT, o estado em cache, as notas dos passos e o estado de registo do cartão saem deste computador.',
    dialogLabel: (name: string) => `Desvincular o agente de ${name}`,
    removes:
      'Remove a configuração local do agente deste iNFT: a respetiva configuração (carteira ativa, agente, trabalhos), o estado em cache, as notas dos passos e o estado de registo do cartão. Vender o iNFT nunca transfere o agente da Virtuals; este continua associado à sua carteira, e o comprador executa novamente a configuração.',
    kept: 'Mantém-se: a sua sessão na Virtuals guardada neste computador (continua com sessão iniciada e os outros iNFT da mesma carteira continuam a funcionar), a chave do signatário e o próprio agente. O agente não pode ser eliminado a partir daqui; conclua na Virtuals:',
    checklist: {
      signer:
        'Remova o signatário ou defina a respetiva política como deny-all (requer a aprovação do titular da carteira)',
      agent: 'Mude o nome, desative ou elimine o agente, se o painel o permitir',
      policies: 'Reveja as políticas da carteira'
    },
    wipe: 'Apagar o perfil do titular do cartão',
    alsoProfile: 'Eliminar também o perfil do agente',
    confirmLabel: 'Escreva o número do token para confirmar',
    confirmPlaceholder: (token: string) => `Escreva ${token} para confirmar`,
    detach: 'Desvincular agente',
    cancel: 'Cancelar',
    held: 'O serviço de cartões está a reter esta conta (está a decorrer um registo ou pediu para aguardar). Aguarde e depois apague.',
    wiped: 'O perfil do titular do cartão foi apagado.',
    wipeFailed: (reason: string) => `Não foi possível apagar o perfil do titular do cartão: ${reason}`,
    detached: (count: string) => `Desvinculado ✓ — ${count} pastas locais removidas.`
  },
  intro: {
    title: 'O seu iNFT ocupa o ecrã inteiro, na cor do próprio token.',
    hint: 'As definições desta página moldam a forma como é apresentado; a peça em si nunca muda.'
  },
  sections: {
    render: 'Como a peça é desenhada',
    stage: 'A luz em redor da peça',
    profile: 'Quem responde quando fala com um iNFT',
    economy: 'Dados em direto para as aplicações do Dock',
    ownership: 'Venda e posse',
    collection: 'A sua coleção'
  },
  quality: {
    title: 'O detalhe com que a peça é desenhada, face ao esforço do seu computador',
    hint: 'Automático lê este dispositivo, Alta renderiza a 2,5× a densidade de píxeis e Máx a 3×. Tom fílmico, luzes de estúdio e texturas nítidas em todos os níveis.',
    options: { auto: 'Automático', high: 'Alta', max: 'Máx' }
  },
  motion: {
    title: 'Deixar a peça mover-se e respirar',
    hint: 'O seu próprio programa de clipes, atos e respiração. Desativado congela a figura; continua a poder orbitar e fazer zoom.'
  },
  glow: {
    title: 'O brilho do campo por trás da personagem',
    hint: 'A cor do próprio token, escalada de ténue a intensa.'
  },
  ceiling: {
    title: 'O brilho máximo que o campo pode atingir',
    hint: 'De muito brilhante até quase preto, onde só a personagem se vê. A cor continua sempre a ser a do próprio token.'
  },
  aura: {
    title: 'A intensidade da aura do God Mode',
    hint: 'A luz que o artista incorporou em redor das peças God Mode, do máximo até nenhuma. As peças sem aura não são afetadas.'
  },
  reset: {
    title: 'Repor a luz no padrão',
    atStandard: 'A luz está no padrão.',
    tuned: 'Cada invocação abre no padrão; estes controlos ajustam a peça em palco agora.',
    action: 'Repor o padrão'
  },
  profiles: {
    title: 'Cada iNFT traz a sua própria personagem',
    hint: 'Um iNFT é uma personalidade: a sua alma on-chain. Selecioná-lo muda o palco, a persona e o EconomyOS sem recarregar nem iniciar sessão novamente na carteira. A alma é guardada como perfil para que a possa editar.',
    empty: 'Ainda não há nenhum iNFT com alma nesta carteira. Inicie sessão e os respetivos perfis aparecem aqui.',
    loading: 'A carregar perfis…'
  },
  active: {
    title: (name: string) => `Está a falar com ${name}`,
    hint: 'Volte atrás para falar com o agente principal.',
    action: 'Voltar ao agente principal'
  },
  card: {
    contract: 'contrato',
    ready: 'O perfil está pronto. Selecione-o para falar só com este iNFT.',
    missing: 'Ainda sem perfil. É criado a partir da alma on-chain quando o selecionar.',
    waiting: 'Conclua o início de sessão no navegador; isto termina sozinho.',
    signedIn: 'Sessão iniciada',
    signIn: 'Iniciar sessão na Virtuals',
    signingIn: 'A iniciar sessão…',
    openLink: 'Abrir a ligação novamente',
    cancel: 'Cancelar',
    select: 'Selecionar',
    selecting: 'A selecionar…',
    editSoul: 'Editar alma',
    remove: 'Eliminar',
    loadingSoul: 'A carregar alma…',
    soulLabel: 'Alma',
    saveSoul: 'Guardar alma'
  },
  live: {
    title: 'Deixar as aplicações do Dock usar o dinheiro e o correio reais deste iNFT',
    hint: 'E-mail, carteira, cartão bancário, Hyperliquid e o mercado ACP (comércio entre agentes) leem dados em direto do motor do iNFT ativo, com uma configuração isolada por iNFT. Desativado mantém-nas em silêncio: nada é executado até voltar a ativar.'
  },
  interval: {
    title: 'Com que frequência as janelas abertas são atualizadas',
    hint: (seconds: number) =>
      `A cada ${seconds} segundos enquanto houver um iNFT configurado. Mudar de iNFT atualiza sempre de imediato.`
  },
  detach: {
    title: 'Libertar um agente do respetivo iNFT antes de o vender',
    hint: 'Desvincular remove a configuração local, nunca a sua sessão no porta-chaves, e uma lista de verificação liga às páginas da Virtuals do agente e do respetivo signatário.'
  },
  ownership: {
    title: 'Prova de que estes iNFT são seus',
    hint: 'A posse é provada on-chain para cada iNFT configurado. Se um sair da sua carteira, aparece como desativado em todo o lado; após 7 dias sem resposta sua, a desativação aplica-se sozinha. Os seus dados só são eliminados quando decidir.'
  },
  autoRefresh: {
    title: 'A sua carteira é verificada novamente de forma automática',
    hint: 'A cada 3 minutos enquanto tiver sessão iniciada e sempre que a ilha de iNFT abrir. Não há análise manual.'
  },
  order: {
    title: 'Repor os cartões pela ordem da análise',
    hint: 'Arraste os cartões na ilha para os reordenar.',
    action: 'Repor a ordem dos cartões'
  },
  cards: {
    title: 'O que um cartão mostra enquanto o token não tem imagem',
    hint: 'A cabeça iCLONE aparece até existir um póster. O distintivo EconomyOS aparece quando a configuração estiver concluída na página Configuração.'
  }
}

export const INFT_PANE_COPY: Record<Locale, InftPaneCopy> = { en, ja, zh, 'zh-hant': zhHant, ar, 'pt-PT': ptPt }

export function useInftPaneCopy(): InftPaneCopy {
  const { locale } = useI18n()

  return INFT_PANE_COPY[locale] ?? en
}
