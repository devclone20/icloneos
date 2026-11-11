// iclone os — V3-G 隔離：Dock の「コンテナ」パネル（日本語）。
import { type ConfinementCopy, confinement as english } from '../en/confinement'

export const confinement: ConfinementCopy = {
  title: 'コンテナ',
  tile: 'コンテナ',
  unavailable: 'コンテナはデスクトップアプリで動作します。エージェントがコマンドを実行する場所です。',
  verdict: {
    green: {
      label: '隔離中',
      hint: 'すべてのエージェントのコマンドはプロファイル内で動作します。承認したシェルコマンドだけは例外で、一度だけプロファイルの外で実行されます。隔離されたコマンドが外で試みたことはブロックされ、Refusals に表示されます。隔離中は、MCP サーバー、スケジュールされたジョブのスクリプト、プラグイン・スキル・パッケージのインストール、編集前のファイルのコピー、編集後のコードチェック、委任した作業のコピー、フックはオフです。コンピューター操作は、許可すると署名済みドライバーを通じてプロファイルの外で動作し、「権限を無視」以外のすべてのモードで確認します。隔離は Backends または 設定 › エージェント › 権限 でオフにできます。その前にアプリが確認します。'
    },
    red: { label: '隔離されていません', hint: '隔離は確認されていません。理由は下にあります。' },
    off: {
      label: 'オフ',
      hint: '隔離はオフです：エージェントのコマンドは隔離されず、MCP サーバー、スケジュールされたジョブのスクリプト、インストール、編集前のファイルのコピー、編集後のコードチェック、委任した作業のコピー、フックが再び動作します。'
    }
  },
  kinds: {
    hermes: 'エージェントランタイム',
    'agent-command': 'エージェントのコマンド（隔離なし）',
    tool: 'ツール（MCP サーバー、補助）',
    runtime: english.kinds.runtime
  },
  killed: count => `${count} 個のプロセスを停止しました`,
  killFailed: {
    survivors: count => `${count} 個のプロセスを停止できませんでした`,
    unverified: () => '見えるものは停止しましたが、ほかに残っていないか macOS に確認できませんでした',
    'not-confined': () => '隔離されたプロセスではありません：何も停止していません',
    invalid: () => 'プロセスではありません：何も停止していません'
  },
  scope:
    '隔離対象：ターミナル、コード実行、ファイルツール、メディア処理。それぞれ専用のプロファイル内で動きます。隔離中はオフ：MCP サーバー、スケジュールされたジョブのスクリプト、プラグイン・スキル・パッケージのインストール、キーチェーンからの取り込み、ローカルの音声認識コマンド。コンピューター操作は、許可すると署名済みドライバーを通じてプロファイルの外で動作し、「権限を無視」以外のすべてのモードで確認します。ブラウザーと画面収録も、モードが許可するときはプロファイルの外で動作します。「ウェブ閲覧とネットワーク通信」がオンのとき、ブラウザーは「手動」と「編集を許可」では確認し、「自動」では確認なしで動き、「プラン」ではページを開いて読むことだけを確認なしで行います。画面収録は、スイッチがオンなら、拒否される「プラン」以外のすべてのモードで確認します。「権限を無視」ではどちらも確認しません。',
  backendName: { seatbelt: 'Seatbelt（macOS）', container: 'Apple container' },
  backendStatus: {
    ready: '準備完了',
    'not-installed': '未インストール',
    installed: 'インストール済み',
    unsupported: 'この Mac では不可',
    broken: '動作していません',
    unknown: '確認できません'
  },
  active: '使用中',
  network: { grant: '許可があるときだけネットワーク', never: 'ネットワークなし' },
  reads: '読み取り',
  writes: '書き込み',
  never: count => `常に禁止：${count} 件の秘密とアプリのパス、キーチェーン`,
  classes: {
    research: { name: 'リサーチ', summary: 'プロジェクトを読み、書き込みは作業用フォルダのみ。' },
    project: { name: 'プロジェクト', summary: 'プロジェクトと作業用フォルダに書き込み。' },
    build: { name: 'ビルド', summary: 'プロジェクトとパッケージのキャッシュ。' },
    offline: { name: 'オフライン', summary: 'プロジェクトのみ、ネットワークなし。' },
    media: { name: 'メディア', summary: '入力を読み、出力フォルダ 1 つだけに書き込み。' }
  },
  defaultClass: name => `既定：${name}`,
  unattributed: '不明',
  noSession: 'セッションなし',
  insideCount: count => `内側 ${count}`,
  outsideCount: count => `外側 ${count}`,
  elapsed: seconds =>
    seconds < 60
      ? `${seconds}秒`
      : seconds < 3600
        ? `${Math.floor(seconds / 60)}分`
        : `${Math.floor(seconds / 3600)}時間`,
  reasons: '赤になった理由',
  reason: {
    'backend-not-confining': ({ backend, detail }) =>
      backend === 'container'
        ? 'Apple container はまだ隔離していません'
        : detail === 'probe-timeout'
          ? 'Seatbelt を時間内に確認できませんでした：現在、隔離は確認されていません'
          : detail === 'probe-failed'
            ? 'Seatbelt を確認できませんでした：確認そのものが失敗したため、現在、隔離は確認されていません'
            : 'この Mac では Seatbelt が隔離していません',
    'plugin-not-loaded': () =>
      'シェルをブロック：隔離が読み込まれていません。読み込まれるまで、エージェントのコマンドは拒否されます。',
    'profile-changed': ({ cls }) => `${cls} プロファイルがディスク上で変更されました`,
    'widened-profile': ({ pid }) => `プロセス ${pid} は広げられたプロファイルで動いています`,
    'unknown-profile': ({ pid }) => `プロセス ${pid} はこのアプリが作っていないプロファイルで動いています`,
    'agent-command-outside': ({ pid }) => `エージェントのコマンド ${pid} が隔離の外で動いています`,
    'forged-marker': ({ pid }) =>
      `プロセス ${pid} は隔離されていると名乗っていますが、macOS はそうではないと言っています`,
    'agent-config-unreadable': () =>
      'config.yaml を読み取れなかったため、その中の terminal.backend は適用されていません。コマンドは引き続きサンドボックス内で実行されます。ファイルを修正して再起動してください。',
    'membership-unverified': () =>
      'どのプロセスが隔離されているか macOS に確認できませんでした：ツリーを離れたプロセスは数えられていない可能性があります',
    'hardlink-appeared': ({ path, pid, root }) =>
      `実行 ${pid} の最中に ${root} の外のファイルへのハードリンクが現れました（${path}）：実行後にしか見つけられず、その実行は到達できた可能性があります。許可するまで、そこでの次の実行は拒否されます`,
    'runtime-not-confined': english.reason['runtime-not-confined'],
    'runtime-not-running': english.reason['runtime-not-running'],
    'launcher-down': english.reason['launcher-down'],
    'agent-commands-unavailable': english.reason['agent-commands-unavailable'],
    'settings-ignored': () =>
      'ディスク上の隔離設定ファイルはこのアプリの署名がないため無視しました：隔離は既定のままオンです'
  },
  notes: '注記',
  backendEnforcingOff: '対照プロファイルがテスト用ファイルを拒否しました。',
  backendDetail: {
    enforcing: '有効：対照プロファイルがテスト用ファイルを拒否しました。',
    'not-enforcing': '動きますが有効ではありません：対照プロファイルがテスト用ファイルを拒否しませんでした。',
    'cannot-run': 'プロファイルを実行できません。',
    'binary-missing': 'sandbox-exec がありません：何も隔離できません。',
    'macos-only': 'Seatbelt は macOS にのみあります。',
    'needs-apple-silicon': 'Apple container には Apple シリコンと macOS 26 以降が必要です。',
    'no-version': 'インストール済みですが、バージョン確認に応答しません：インストールが壊れているようです。',
    'not-installed': '未インストール。インストールはあなたの作業で、管理者パスワードが一度必要です：',
    'not-wired': 'このバージョンでは使用しません：icloneOS はコマンドを Seatbelt だけで隔離します。',
    'probe-failed': '確認そのものが失敗しました。',
    'probe-timeout': '確認が時間内に終わりませんでした：この Mac が混雑していた可能性があります。まもなく再確認します。'
  },
  firstScan: dirs => `プロジェクトのフォルダーを確認しています… ${dirs.toLocaleString('ja')} フォルダー`,
  hardlinks: {
    blocked: (root, paths, count) =>
      `${root} では隔離を開始しません：${paths.join('、')}${count > paths.length ? ` ほか ${count - paths.length} 件` : ''}がプロジェクト外のファイルへのハードリンクなので、削除するか下でフォルダごとに許可してください。`,
    cannotScan: (root, paths, count) =>
      `${root} では隔離を開始しません：${paths.join('、')}${count > paths.length ? ` ほか ${count - paths.length} 件` : ''}を一覧できず、そこにハードリンクが隠れている可能性があるため、そのフォルダに読み取り権限を与えてください（chmod u+rx）。`,
    group: (dir, count) => `${dir} の下の ${count} 件のファイル — プロジェクト外へのハードリンク`,
    allow: count => (count === 1 ? 'このファイルを許可' : `${count} 件のファイルを許可`),
    allowTip:
      'コマンドはこれらのファイルを現在の状態のまま読み書きでき、それを通じてリンク先のプロジェクト外のファイルも読み書きできます。新しいリンクは改めて確認します',
    allowed: count => `許可しました：この ${count} 件のファイルの現在の状態のみ`,
    ackFailed: {
      'no-gesture': '許可されていません：ボタンをご自身でクリックしてください',
      'not-in-project': '許可されていません：フォルダがそのプロジェクトにありません',
      'nothing-to-allow': '許可は不要です：そのフォルダの下にハードリンクは残っていません',
      changed: '許可されていません：表示後にそのフォルダの下のファイルが変わりました。読み直してください',
      invalid: '許可されていません：フォルダがありません'
    },
    showAll: (count: number) => `すべて表示（${count.toLocaleString('ja')}）`,
    showMore: (left: number) => `さらに${left.toLocaleString('ja')}件を表示`,
    showFewer: '少なく表示',
    cachesUnscanned:
      'パッケージキャッシュ（npm、pip、cargo、pnpm…）はハードリンクを走査しません：Build のコマンドはいずれにせよそれらを読み書きできます。'
  },
  // The run ledger's words are English in every locale until the translation pass: the app ships in English.
  ledger: english.ledger
}
