// iclone os — V3-F 権限モード（日本語）。設定 › エージェント › 権限 と、同意シートの権限リクエスト。
import { PRODUCT_NAME } from '@/i18n/en/enConsent'
import type { PermissionsCopy } from '@/i18n/en/enPermissions'
import { FUNCTION_COPY } from '@/iclone-shared/permission-function-copy'

export const jaPermissions: PermissionsCopy = {
  title: '権限',
  lead: `この Mac でエージェントがあなたに確認せずにできること。モードはこのアプリ内のクリックで変わり、エージェントの要求やアップデートでは変わりません。ただし「権限を無視」でコンピューター操作がオンの場合は、エージェントもクリックできます。`,
  enforcement: {
    enforced: '適用中: エージェントのすべてのツール呼び出しは、まずこのルールを通ります。',
    starting: '起動中: エージェントに権限ゲートが読み込まれたか確認しています。',
    'not-enforced': '未適用: 権限ゲートが応答しないため、再起動するまでエージェントのツールは拒否されます。',
    'no-agent': 'エージェントは起動していません。',
    degraded:
      'システムのキーチェーンが記録の鍵を保護できませんでした: 手動のみで、再起動をまたいだ記録は検証できません。',
    // FX-2 r1b: the degraded state's cause when the owner's Keychain setting is off, and the fix.
    'keychain-off':
      '選んだモードは icloneOS を終了するまで有効で、その後は手動に戻ります: キーチェーンの設定がオフのため、保護して保存できません。保持するには、設定 › マシン › ゲートウェイ ›「保存したパスワードをシステムのキーチェーンで保護する」 でキーチェーンをオンにしてください。',
    // V3-FX M1: turned on while the app runs — payments and the ACP tools follow at once, the modes after a restart.
    'keychain-restart':
      'キーチェーンはオンです。権限の鍵は icloneOS の起動時に封印されます。自動、プランなどのモードを使うには icloneOS を再起動してください。支払いと ACP ツールはすでに使えます。'
  },
  // r3/r4: the button beside the modes' restart line (the Keychain turned on since launch), and what it says
  // when main refuses the relaunch.
  restartNow: '今すぐ再起動',
  restartRefused: 'icloneOS を今は再起動できませんでした。モードを使うには、終了してからもう一度開いてください。',
  modes: {
    ignore: {
      name: '権限を無視',
      short: '一切確認しない',
      summary:
        'お金の支払い、iNFT の移動、キーの送信、管理者パスワード、自身の権限を含め、何も確認しません。隔離がオンの間の隔離を除けば、残る確認は5つです: ディスク全体、ホームフォルダー、システムの破壊、対象全体が読み取れない変数やコマンド出力である再帰的な削除や、ディスク、ホームフォルダー、システムを対象とすると読み取れる (空のままの変数でそうなる場合も含む)、または名前を読み取れないコマンドによる、再帰的な削除や、対象またはオプションを完全には読み取れない再帰的な削除、確認できないほど読み取れない呼び出し (ファイルを特定できないパッチ、ファイルを指定しない書き込み、読み取れない引数)、あなたが書いた拒否ルール、ランタイム自身の保存先 (state.db、セッション、トークン、ペアリング、ボールト、ブラウザープロファイル、ランタイム自身の .env への書き込みと、トークン、ボールト、ブラウザープロファイル、auth.json、auth.lock、その .env、webhook サブスクリプションの読み取り) に対するファイルツール。コンピューター操作、画面収録、ブラウザーは Seatbelt の外で動作し、ファイルツールはホームフォルダー内のファイルを Seatbelt の外で 1 つずつ書き込みます。'
    },
    manual: {
      name: '手動',
      short: '実行前に確認',
      summary:
        '自身の iNFT プロファイル (SOUL、メモリー、自身のフォルダー) 以外への書き込み、コマンド、ネットワーク、メッセージ、インストール、削除の前に毎回確認します。プロジェクト内の読み取りは確認せず、ホームフォルダーの他の場所のファイルは確認することがあります。隔離されたコマンドが読めるのは実行中のフォルダーだけです。'
    },
    automatic: {
      name: '自動',
      short: '編集と安全なコマンド',
      summary: 'プロジェクト内への書き込み、安全なコマンド、Web の利用は自分で行い、それ以外は確認します。'
    },
    plan: {
      name: 'プラン',
      short: '読んで計画',
      summary:
        '読んで、チャットで計画します。自身の iNFT プロファイル (SOUL、メモリー、自身のフォルダー) 以外は何も変更しません。'
    },
    acceptEdits: {
      name: '編集を許可',
      short: '確認なしで編集',
      summary: 'プロジェクト内のファイルは自分で編集し、それ以外はすべて確認します。'
    }
  },
  menu: {
    title: 'このチャット',
    trigger: (mode: string) => `このチャットの権限モード: ${mode}`,
    triggerNotInForce: (inForce: string, chosen: string) =>
      `このチャットの権限モード: ${inForce}。${chosen} は選択済みですが有効ではありません`,
    appliesToSession: 'このチャットのみ、次のメッセージから。既定は 設定 › エージェント › 権限 にあります。',
    appliesToNewChat: 'この新しいチャットのみ。既定は 設定 › エージェント › 権限 にあります。',
    ignoreNote: {
      confined: '5つの確認は引き続き拒否します。詳細は設定で。',
      unconfined: 'Seatbelt オフ: アプリ内の確認5つのみ。'
    }
  },
  classes: {
    R: 'ファイルを読む',
    Wp: 'プロジェクト内のファイルに書き込む',
    Wo: 'プロジェクト外のファイルに書き込む',
    X: 'コマンドを実行する',
    N: 'ネットワークを使う',
    $: 'お金を支払う',
    M: 'メッセージを送る',
    S: 'システム権限を要求する',
    I: 'ソフトウェアをインストールする',
    D: 'ファイルを削除する'
  },
  current: '使用中',
  chosenNotInForce: '選択済み・未適用',
  choose: '使う',
  scope: {
    label: '適用範囲',
    standing: '新しいセッションの既定',
    standingNote:
      '独自のモードを持つ開いているチャットはそのモードのままです。変更はそのチャットのメッセージバーから行えます。チャット自身にもそのプロジェクトにも独自のモードがない場合は、この既定に従います。',
    project: path => `このプロジェクト · ${path}`,
    noProject: 'プロジェクトを開くと、そのプロジェクト専用のモードを選べます。'
  },
  refused: {
    gesture: 'モードはこのアプリ内のクリックでのみ変わります。',
    invalid: 'このモードはここでは選べません。',
    unavailable: `権限モードには ${PRODUCT_NAME} のデスクトップアプリが必要です。`
  },
  floor: {
    title: '引き続き確認されること',
    items: [
      '「権限を無視」を含むすべてのモードで、ディスク、ホームフォルダー、システムフォルダーの消去とドライブのフォーマットを拒否します。',
      '「権限を無視」以外では、iNFT の移動、キーの送信、管理者パスワードの入力、自身の権限の変更は、あなたの回答なしには行えず、どの許可でもこれは解除されません。',
      '「権限を無視」では何も確認されないため、これらすべてを実行できます。',
      'これらはアプリ内の確認であり、カーネルの壁ではありません。プログラムが回避することは可能です。'
    ]
  },
  // V3-F2: the Functions matrix (shared with main's native raise confirm).
  functions: FUNCTION_COPY.ja,
  // FX-6: what confinement really does (on by default, V3-G); the pane picks the line for the live state.
  shellNote: {
    on: '隔離はオンで、オフにすることもできます。エージェントのコマンドは、「権限を無視」を含むすべてのモードで隔離されて実行されます（Seatbelt）。書き込めるのはプロジェクトと一時フォルダーだけで、ネットワークにはモードか許可が認めたときだけ接続します。承認したシェルコマンドは、一度だけ隔離の外で実行されます。',
    off: '隔離はオフです。コマンドはすべてのモードであなたとして実行され、あなたが読み書きできるものをすべて読み取り、変更できます。',
    // V3-FX M2: main's live verdict is red (on but not working), or not read yet.
    red: '隔離は今は機能していません（理由は「コンテナ」に表示されます）。機能するまでは、どのモードでもコマンドはあなたが読み書きできるものをすべて読み取り、変更できます。',
    pending: '隔離の状態を読み込んでいます…'
  },
  grants: {
    title: 'あなたが与えた権限',
    empty: 'まだありません。1 回より長く許可したものがここに表示されます。',
    scope: { session: 'このチャット', project: 'このプロジェクト', standing: 'すべて' },
    revoke: '取り消す',
    folderTitle: '許可したフォルダー',
    folderHint: 'モードが許可する場合、コマンドはここに書き込めます',
    removeFolder: '削除'
  },
  // A-1：起動時にメインプロセスが拒否した、または検証できなかった権限状態ファイル。
  integrity: {
    mode: {
      tampered: `ディスク上の権限モードが ${PRODUCT_NAME} の外で変更または破損したため無効です。モードを選び直すまで、すべての場所で手動になります。`,
      unverified:
        '権限モードは以前のバージョン、またはキーチェーンがオフのときに保存されたため検証できません。モードを選び直すまで、すべての場所で手動になります。',
      missing: '権限モードのファイルがありません。モードを選び直すまで、すべての場所で手動になります。'
    },
    functions: {
      tampered: `ディスク上の機能レベルが ${PRODUCT_NAME} の外で変更または破損したため無効です。選び直すまで、すべての機能が手動になります。`,
      unverified:
        '機能レベルは以前のバージョン、またはキーチェーンがオフのときに保存されたため検証できません。手動より広い各レベルは、下で確認するまで手動のままです。',
      missing: '機能レベルのファイルがありません。選び直すまで、すべての機能が手動になります。'
    },
    grants: {
      tampered: `許可した権限が ${PRODUCT_NAME} の外で変更または破損したため無効です。次に求められたときに再度許可してください。`,
      unverified:
        '許可した権限は以前のバージョン、またはキーチェーンがオフのときに保存されたため検証できず、無効です。次に求められたときに再度許可してください。',
      missing:
        '許可した権限のファイルがありません。どれも有効ではありません。次に求められたときに再度許可してください。'
    }
  },
  audit: {
    title: 'アクティビティ',
    empty: 'まだ記録はありません。',
    chainOk: count => `${count.toLocaleString()} 件の記録 · 改ざんなし`,
    chainBroken: `記録に欠落があるか、${PRODUCT_NAME} の外で変更されています。`,
    chainVerifying: '記録を確認しています…',
    otherKind: '権限の記録',
    kinds: {
      use: '許可',
      refuse: '拒否',
      ask: '確認',
      answer: 'あなたの回答',
      timeout: '回答なし',
      mode_set: 'モード変更',
      mode_refused: '変更を拒否',
      grant: '権限を付与',
      revoke: '権限を取り消し',
      gap: '欠落',
      restart: `${PRODUCT_NAME} を起動`,
      fn_level_set: 'レベルを変更',
      fn_level_refused: 'レベル変更を拒否'
    },
    details: {
      denied: 'あなたが拒否しました',
      busy: '待機中の権限リクエストが多すぎました',
      withdrawn: '回答前に取り下げられました',
      noGesture: 'あなた自身のクリックではありません',
      notConfirmed: 'システムダイアログで確認されませんでした',
      standingIgnore: '以前のバージョンで拒否されました：当時は「権限を無視」を既定にできませんでした',
      invalid: '無効な変更です',
      raced: 'ダイアログが開いている間にレベルが変わりました',
      gateNotStarted: pid =>
        pid
          ? `Hermes の権限ゲート (pid ${pid}) は起動しませんでした。そのツール呼び出しは拒否されます`
          : 'Hermes の権限ゲートは起動しませんでした。そのツール呼び出しは拒否されます',
      gateStopped: pid =>
        pid ? `Hermes の権限ゲート (pid ${pid}) が応答しなくなりました` : 'Hermes の権限ゲートが応答しなくなりました',
      unverified: count => `Hermes からの ${count} 行を検証できず、記録しませんでした`,
      missedEvents: count => `権限ゲートからの ${count} 件のイベントが届きませんでした`,
      confinementBurst: count => `その 1 分間のほかの隔離による拒否 ${count} 件は コンテナ › 拒否 にのみ残ります`,
      confined: '隔離によりブロック',
      gap: '記録できなかったものがあります',
      payment: {
        settled: '支払いが決済されました',
        pending: '決済はまだ保留中です',
        failed: '支払いは完了しませんでした',
        ledger: '支払いの記録が検証に通りません',
        limit: 'エコノミー › 支払い の上限を超えています',
        stopped: '緊急停止: すべての支払いを拒否します',
        payee: '許可されていない受取人またはサイトです',
        mandate: '有効なマンデートがありません',
        denied: '権限のリクエストであなたが拒否しました',
        setting: 'エコノミー › 支払い の変更',
        service: '支払いサービスが拒否しました',
        other: '支払い',
        unrecorded: '支払いの記録に残っていない支払い',
        uncertain: '結果不明: 支払いの記録を確認してください',
        stopOff: '緊急停止を解除',
        mandateIssued: 'マンデートを発行',
        mandateRevoked: 'マンデートを取り消し',
        mandateChange: 'マンデートの変更'
      }
    }
  },
  ask: {
    eyebrow: who => `権限のリクエスト · ${who}`,
    title: what => `エージェントが${what}ことを求めています`,
    targetLabel: '対象',
    folderLabel: 'フォルダー',
    expand: 'すべて表示',
    collapse: '折りたたむ',
    reasonLabel: '理由（エージェントの言葉）',
    heldFile:
      'これはシェル、git、launchd が実行に使うファイル、または鍵を保持するファイルです。エージェントがここに書いた内容は、後であなたの権限で実行される可能性があります。許可する前にパスを確認してください。',
    outsideFilePatch:
      '許可すると、Seatbelt の外でこの 1 つのファイルを読み取ってから書き込みます。エージェントは変更する行を見ます：',
    effects: {
      R: 'これを読むだけで、何も変更しません。',
      Wp: 'プロジェクト内でこのファイルを作成または変更します。',
      Wo: 'プロジェクト外でこのファイルを作成または変更します。Seatbelt がオンの間は、このアプリ自身のファイルは閉じたままで、エージェントにはシェルコマンドを使うよう伝えられ、あなたが先に全文を読みます。',
      X: 'この Mac でこのコマンドを実行します。',
      N: 'このリクエストをインターネットに送信します。',
      $: 'この金額をあなたのウォレットまたはカードから移動します。',
      M: 'あなたの名前でこのメッセージを送ります。',
      S: 'macOS にこの権限を求めます。付与するのはシステム設定のあなたです。',
      I: 'このソフトウェアをあなたのユーザーにインストールします。',
      D: 'これを削除します。'
    },
    mode: name => `モード: ${name}`,
    scopeLabel: '許可の範囲',
    scopes: { once: '今回だけ', session: 'このチャット', project: 'このプロジェクト', standing: 'すべて' },
    laterConfined:
      '外に出るのはこのコマンドだけです。以降のコマンドのうちどの確認にも止められないものは確認なしで実行され、Seatbelt の中にとどまるため、それ以上を必要とするものは拒否されます。再び確認するには、設定 › エージェント › 権限 でこれを取り消してください。',
    heldRead:
      'このファイルまたはフォルダーにはキーやトークンが含まれるか、シェルから実行されます。Seatbelt がオフなので他に止めるものはありません。許可するとエージェントはそのすべてを受け取り、読んだ内容はモデルに送られます。',
    covers: {
      session: (what: string) => `このチャットでの「${what}」をすべて許可します（今回の 1 件だけではありません）。`,
      project: (what: string) => `このプロジェクトでの「${what}」をすべて許可します（今回の 1 件だけではありません）。`,
      standing: (what: string) => `あらゆる場所での「${what}」を、取り消すまですべて許可します。`
    },
    deny: '拒否',
    allow: '許可',
    expires: '2 分以内に回答がない場合は拒否になります。'
  },
  modeReset: {
    standing: (mode: string) => `記録が見つからなかったため、デフォルトが${mode}に戻りました。もう一度選んでください。`,
    project: (mode: string | null) =>
      mode === null
        ? '記録が見つからなかったため、プロジェクト独自のモードが削除されました。もう一度選んでください。'
        : `記録が見つからなかったため、プロジェクトのモードが${mode}に戻りました。もう一度選んでください。`,
    session: (mode: string | null) =>
      mode === null
        ? '記録が見つからなかったため、チャット独自のモードが削除されました。もう一度選んでください。'
        : `記録が見つからなかったため、チャットのモードが${mode}に戻りました。もう一度選んでください。`,
    dismiss: '閉じる'
  },
  approvalPointer: 'あなたの許可を待っています。上部のシートで回答してください。'
}
