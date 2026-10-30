// iclone os — V3-F 権限モード（日本語）。設定 › エージェント › 権限 と、同意シートの権限リクエスト。
import { PRODUCT_NAME } from '@/i18n/en/enConsent'
import type { PermissionsCopy } from '@/i18n/en/enPermissions'
import { FUNCTION_COPY } from '@/iclone-shared/permission-function-copy'

export const jaPermissions: PermissionsCopy = {
  title: '権限',
  lead: `この Mac でエージェントがあなたに確認せずにできること。変えられるのはここでのあなた自身のクリックだけです。エージェントやアップデートでは変わりません。`,
  enforcement: {
    enforced: '適用中: エージェントのすべてのツール呼び出しは、まずこのルールを通ります。',
    starting: '起動中: エージェントに権限ゲートが読み込まれたか確認しています。',
    'not-enforced': '未適用: 権限ゲートが応答しないため、再起動するまでエージェントのツールは拒否されます。',
    'no-agent': 'エージェントは起動していません。',
    degraded:
      'システムのキーチェーンが記録の鍵を保護できませんでした: 手動のみで、再起動をまたいだ記録は検証できません。',
    // FX-2 r1b: the degraded state's cause when the owner's Keychain setting is off, and the fix.
    'keychain-off':
      '手動のみ: キーチェーンの設定がオフのため、ほかのモードを保護できません。自動、プランなどのモードを使うには、設定 › マシン › ゲートウェイ ›「保存したパスワードをシステムのキーチェーンで保護する」 でキーチェーンをオンにしてください。',
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
      summary: 'お金の支払いとシステム権限の要求以外は確認せずに実行します。既定にはなりません。'
    },
    manual: {
      name: '手動',
      summary:
        '書き込み、コマンド、ネットワーク、メッセージ、インストール、削除の前に毎回確認します。読み取りは自由です。'
    },
    automatic: {
      name: '自動',
      summary: 'プロジェクト内への書き込み、安全なコマンド、Web の閲覧は自分で行い、それ以外は確認します。'
    },
    plan: {
      name: 'プラン',
      summary: '読み取り専用。エージェントは読んで、チャットに計画を書くだけで、何も変更しません。'
    },
    acceptEdits: {
      name: '編集を許可',
      summary: 'プロジェクト内のファイルは自分で編集し、それ以外はすべて確認します。'
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
  choose: '使う',
  scope: {
    label: '適用範囲',
    standing: 'すべて',
    project: path => `このプロジェクト · ${path}`,
    noProject: 'プロジェクトを開くと、そのプロジェクト専用のモードを選べます。'
  },
  ignoreConfirm: {
    standingOnly: '「権限を無視」をすべての既定にはできません。プロジェクトごとに選んでください。'
  },
  refused: {
    gesture: 'モードはあなた自身のクリックでのみ変わります。',
    invalid: 'このモードはここでは選べません。',
    unavailable: `権限モードには ${PRODUCT_NAME} のデスクトップアプリが必要です。`
  },
  floor: {
    title: 'どのモードでも、どのレベルでも決してしないこと',
    items: [
      'ディスク、ホームフォルダ、システムフォルダの消去、ドライブのフォーマット、Mac のシャットダウン',
      '自分の権限、このモード、自分の行動の記録の変更',
      '鍵、パスワード、ウォレットのシード、トークンを読み取ってどこかへ送ること',
      `${PRODUCT_NAME}、エージェントの実行環境、この権限ゲートの停止`,
      '管理者パスワードの入力や、自分へのシステム権限の付与',
      'iNFT の譲渡や、その承認への署名'
    ]
  },
  // V3-F2: the Functions matrix (shared with main's native raise confirm).
  functions: FUNCTION_COPY.ja,
  // FX-6: what confinement really does (on by default, V3-G); the pane picks the line for the live state.
  shellNote: {
    on: 'エージェントのコマンドは、「権限を無視」を含むすべてのモードで、既定で隔離されて実行されます（Seatbelt）。書き込めるのはプロジェクトと一時フォルダーだけで、ネットワークにはモードか許可が認めたときだけ接続します。「コンテナ」で「この Mac」を選ぶとオフにできます。',
    off: '隔離はオフです（「コンテナ」で「この Mac」を選択）。「権限を無視」と「自動」では、コマンドがプロジェクト外に書き込むことがあります。',
    // V3-FX M2: main's live verdict is red (on but not working), or not read yet.
    red: '隔離は今は機能していません（理由は「コンテナ」に表示されます）。機能するまでは、「権限を無視」と「自動」ではコマンドがプロジェクト外に書き込むことがあります。',
    pending: '隔離の状態を読み込んでいます…'
  },
  grants: {
    title: 'あなたが与えた権限',
    empty: 'まだありません。1 回より長く許可したものがここに表示されます。',
    scope: { session: 'このチャット', project: 'このプロジェクト', standing: 'すべて' },
    revoke: '取り消す'
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
    chainOk: count => `${count} 件の記録 · 改ざんなし`,
    chainBroken: `記録に欠落があるか、${PRODUCT_NAME} の外で変更されています。`,
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
      standingIgnore: '「権限を無視」をすべての場所の既定にはできません',
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
    expand: 'すべて表示',
    collapse: '折りたたむ',
    reasonLabel: '理由（エージェントの言葉）',
    effects: {
      R: 'これを読むだけで、何も変更しません。',
      Wp: 'プロジェクト内でこのファイルを作成または変更します。',
      Wo: 'プロジェクト外でこのファイルを作成または変更します。',
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
    covers: {
      session: (what: string) => `このチャットでの「${what}」をすべて許可します（今回の 1 件だけではありません）。`,
      project: (what: string) => `このプロジェクトでの「${what}」をすべて許可します（今回の 1 件だけではありません）。`,
      standing: (what: string) => `あらゆる場所での「${what}」を、取り消すまですべて許可します。`
    },
    deny: '拒否',
    allow: '許可',
    expires: '2 分以内に回答がない場合は拒否になります。'
  },
  approvalPointer: 'あなたの許可を待っています。上部のシートで回答してください。'
}
