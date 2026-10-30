// V3-ON — the words of the first-launch Set up step and of Settings › Machine › Set up, in the six shipped locales.
// The agent's levels and the never list reuse the Permissions catalogue's own words (one source for those).
import { type Locale, useI18n } from '@/i18n'
import { PRODUCT_NAME } from '@/i18n/en/enConsent'

import type { SetupPackageState, SetupSection, SetupSystemAction, SetupSystemItem, SetupSystemStatus } from './types'

export type SetupRowId = SetupSystemItem | 'computerUse'
export type ComputerUseState = 'granted' | 'needs' | 'notInstalled' | 'unavailable'

export interface SetupBank {
  sheet: {
    eyebrow: string
    title: string
    lead: string
    done: string
    saving: string
    skip: string
    skipAll: string
    undo: string
    skipped: string
    saveFailed: string
    tryAgain: string
    continueToApp: string
  }
  sections: Record<SetupSection, { title: string; hint: string }>
  packages: {
    state: Record<Exclude<SetupPackageState, 'installing'>, string>
    installing: (percent: number | null) => string
    retry: string
    retrying: string
  }
  system: {
    rows: Record<SetupRowId, { name: string; purpose: string }>
    keychain: { name: string; purpose: string; note: string; on: string; off: string; failed: string }
    status: Record<SetupSystemStatus, string>
    computerUse: Record<ComputerUseState, string>
    action: Record<Exclude<SetupSystemAction, 'none'>, string>
    testNotification: string
    restart: string
    declined: string
    perApp: string
    notification: { title: string; body: string }
  }
  agent: { levels: string; raise: string; unavailable: string }
  settings: { lead: string; again: string; notSetUp: string; agentLine: string; openPermissions: string }
}

const en: SetupBank = {
  sheet: {
    eyebrow: 'Set up',
    title: 'Decide once. Then it stays out of your way.',
    lead: `Everything ${PRODUCT_NAME} and your agent may ask on this Mac, in one place. Choose now or skip: what you skip is asked when it is first used, by macOS or your agent, and can be set up any time in Settings.`,
    done: 'Done',
    saving: 'Saving…',
    skip: 'Skip',
    skipAll: 'Skip all, decide later',
    undo: 'Undo',
    saveFailed: 'Your choices could not be saved. Nothing was changed.',
    tryAgain: 'Try again',
    continueToApp: 'Continue to the app',
    skipped:
      'Skipped. macOS or your agent asks for it when it is first used; set it up any time in Settings › Machine › Set up.'
  },
  sections: {
    packages: {
      title: 'Packages',
      hint: 'Installed with the app. One that did not finish can be installed again here, or later in Settings.'
    },
    system: {
      title: 'System permissions',
      hint: 'Only what macOS lets an app ask in advance. Each one is yours to give, and macOS keeps your answer.'
    },
    agent: {
      title: 'Agent permissions',
      hint: 'How freely your agent acts in each area. The marked level is the one in force; Follow mode, the default, asks before every action.'
    }
  },
  packages: {
    state: { installed: 'Installed', failed: 'Did not install', skipped: 'Skipped' },
    installing: percent => (percent === null ? 'Installing…' : `Installing… ${percent} %`),
    retry: 'Install again',
    retrying: 'Starting…'
  },
  system: {
    rows: {
      microphone: { name: 'Microphone', purpose: 'Voice messages, voice conversation and the wake word.' },
      screen: {
        name: 'Screen recording',
        purpose: 'Lets the HUD and your agent read the titles of the windows on screen. No pixels are kept.'
      },
      notifications: { name: 'Notifications', purpose: 'Tells you when a long task finishes or needs you.' },
      computerUse: {
        name: 'Computer use',
        purpose: 'Accessibility and Screen recording for CuaDriver, the helper that lets your agent use apps.'
      }
    },
    keychain: {
      name: 'Keychain',
      purpose:
        'Lets your agent use the permission modes beyond Manual, the ACP tools and payments: their keys are sealed in the macOS keychain.',
      note: 'Off by default. Turning it on may show the macOS keychain prompt once.',
      on: 'On',
      off: 'Off',
      failed: 'The keychain setting could not be changed.'
    },
    status: {
      granted: 'Allowed',
      denied: 'Not allowed',
      notDetermined: 'Not asked yet',
      notSetUp: 'Not set up',
      restricted: 'Managed by your organisation',
      declined: 'Off in Privacy',
      unknown: 'macOS decides'
    },
    computerUse: {
      granted: 'Allowed',
      needs: 'Not allowed yet',
      notInstalled: 'Not installed',
      unavailable: 'Available once the agent is running'
    },
    action: { request: 'Allow…', openSettings: 'Open System Settings' },
    testNotification: 'Show a test notification',
    restart: `macOS applies a new Screen recording permission after ${PRODUCT_NAME} restarts.`,
    declined: 'Switched off in Settings › Privacy, so the app never asks macOS for it.',
    perApp:
      'Controlling another app and the local network are asked by macOS per app, the first time they are used. No app can ask for them in advance.',
    notification: { title: 'Notifications are on', body: `This is how ${PRODUCT_NAME} will let you know.` }
  },
  agent: {
    levels: 'What each level means',
    raise:
      'With the Keychain on, raising a level is confirmed on a macOS dialog and lowering one applies at once. With it off, your choice is kept; after the restart you confirm it yourself on the system dialog.',
    unavailable: 'Agent permissions are set in the desktop app.'
  },
  settings: {
    lead: 'The choices of the first launch, any time. Nothing here asks on its own.',
    again: 'Set up again',
    notSetUp: 'Not set up',
    agentLine: 'Each area’s level, with the modes and what you allowed.',
    openPermissions: 'Open Permissions'
  }
}

const ptPt: SetupBank = {
  sheet: {
    eyebrow: 'Configurar',
    title: 'Decida uma vez. Depois, não volta a incomodar.',
    lead: `Tudo o que o ${PRODUCT_NAME} e o seu agente podem pedir neste Mac, num só lugar. Escolha agora ou ignore: o que ignorar é pedido na primeira utilização, pelo macOS ou pelo seu agente, e pode ser configurado a qualquer momento nas definições.`,
    done: 'Concluir',
    saving: 'A guardar…',
    skip: 'Ignorar',
    skipAll: 'Ignorar tudo, decidir depois',
    undo: 'Anular',
    saveFailed: 'Não foi possível guardar as suas escolhas. Nada foi alterado.',
    tryAgain: 'Tentar novamente',
    continueToApp: 'Continuar para a aplicação',
    skipped:
      'Ignorado. O macOS ou o seu agente pede-o na primeira utilização; configure-o a qualquer momento em Definições › Máquina › Configurar.'
  },
  sections: {
    packages: {
      title: 'Pacotes',
      hint: 'Instalados com a aplicação. Um que não terminou pode ser instalado novamente aqui ou mais tarde nas definições.'
    },
    system: {
      title: 'Permissões do sistema',
      hint: 'Apenas o que o macOS permite a uma aplicação pedir antecipadamente. Cada uma é sua para dar e o macOS guarda a resposta.'
    },
    agent: {
      title: 'Permissões do agente',
      hint: 'Com que liberdade o seu agente age em cada área. O nível marcado é o que está em vigor; Seguir o modo, a predefinição, pede antes de cada ação.'
    }
  },
  packages: {
    state: { installed: 'Instalado', failed: 'Não foi instalado', skipped: 'Ignorado' },
    installing: percent => (percent === null ? 'A instalar…' : `A instalar… ${percent} %`),
    retry: 'Instalar novamente',
    retrying: 'A iniciar…'
  },
  system: {
    rows: {
      microphone: { name: 'Microfone', purpose: 'Mensagens de voz, conversa por voz e a palavra de ativação.' },
      screen: {
        name: 'Gravação do ecrã',
        purpose: 'Permite ao HUD e ao seu agente ler os títulos das janelas no ecrã. Nenhuma imagem é guardada.'
      },
      notifications: { name: 'Notificações', purpose: 'Avisa quando uma tarefa longa termina ou precisa de si.' },
      computerUse: {
        name: 'Utilização do computador',
        purpose:
          'Acessibilidade e Gravação do ecrã para o CuaDriver, o auxiliar que deixa o seu agente usar aplicações.'
      }
    },
    keychain: {
      name: 'Porta-chaves',
      purpose:
        'Permite ao seu agente usar os modos de permissão além do Manual, as ferramentas ACP e os pagamentos: as respetivas chaves ficam seladas no porta-chaves do macOS.',
      note: 'Desativado por predefinição. Ao ativar, o macOS pode mostrar uma vez o pedido do porta-chaves.',
      on: 'Ativado',
      off: 'Desativado',
      failed: 'Não foi possível alterar a definição do porta-chaves.'
    },
    status: {
      granted: 'Permitido',
      denied: 'Não permitido',
      notDetermined: 'Ainda não pedido',
      notSetUp: 'Não configurado',
      restricted: 'Gerido pela sua organização',
      declined: 'Desativado em Privacidade',
      unknown: 'O macOS decide'
    },
    computerUse: {
      granted: 'Permitido',
      needs: 'Ainda não permitido',
      notInstalled: 'Não instalado',
      unavailable: 'Disponível quando o agente estiver em execução'
    },
    action: { request: 'Permitir…', openSettings: 'Abrir Definições do Sistema' },
    testNotification: 'Mostrar uma notificação de teste',
    restart: `O macOS aplica uma nova permissão de Gravação do ecrã depois de o ${PRODUCT_NAME} reiniciar.`,
    declined: 'Desativado em Definições › Privacidade, por isso a aplicação nunca o pede ao macOS.',
    perApp:
      'Controlar outra aplicação e a rede local são pedidos pelo macOS por aplicação, na primeira utilização. Nenhuma aplicação os pode pedir antecipadamente.',
    notification: { title: 'As notificações estão ativas', body: `É assim que o ${PRODUCT_NAME} o vai avisar.` }
  },
  agent: {
    levels: 'O que significa cada nível',
    raise: 'Subir um nível é confirmado numa caixa de diálogo do macOS. Descer aplica-se de imediato.',
    unavailable: 'As permissões do agente definem-se na aplicação de computador.'
  },
  settings: {
    lead: 'As escolhas do primeiro arranque, a qualquer momento. Nada aqui pede por si.',
    again: 'Configurar novamente',
    notSetUp: 'Não configurado',
    agentLine: 'O nível de cada área, com os modos e o que permitiu.',
    openPermissions: 'Abrir Permissões'
  }
}

const ja: SetupBank = {
  sheet: {
    eyebrow: 'セットアップ',
    title: '一度決めれば、あとは邪魔しません。',
    lead: `${PRODUCT_NAME} とエージェントがこの Mac で求める可能性のあるものを、一か所にまとめました。今決めるか、スキップしてください。スキップした項目は初めて使うときに macOS またはエージェントが確認し、設定からいつでもセットアップできます。`,
    done: '完了',
    saving: '保存中…',
    skip: 'スキップ',
    skipAll: 'すべてスキップして後で決める',
    undo: '元に戻す',
    saveFailed: '選択を保存できませんでした。何も変更されていません。',
    tryAgain: 'もう一度試す',
    continueToApp: 'アプリへ進む',
    skipped:
      'スキップしました。初めて使うときに macOS またはエージェントが確認します。設定 › マシン › セットアップでいつでも設定できます。'
  },
  sections: {
    packages: {
      title: 'パッケージ',
      hint: 'アプリと一緒にインストールされます。完了しなかったものは、ここまたは後で設定から再インストールできます。'
    },
    system: {
      title: 'システムの権限',
      hint: 'macOS がアプリに事前の要求を許すものだけです。どれを与えるかはあなた次第で、macOS が回答を保持します。'
    },
    agent: {
      title: 'エージェントの権限',
      hint: '各領域でエージェントがどこまで自由に動くか。印の付いたレベルが現在有効なものです。既定の「モードに従う」は毎回の操作の前に確認します。'
    }
  },
  packages: {
    state: { installed: 'インストール済み', failed: 'インストールされませんでした', skipped: 'スキップ済み' },
    installing: percent => (percent === null ? 'インストール中…' : `インストール中… ${percent} %`),
    retry: '再インストール',
    retrying: '開始中…'
  },
  system: {
    rows: {
      microphone: { name: 'マイク', purpose: 'ボイスメッセージ、音声会話、ウェイクワード。' },
      screen: {
        name: '画面収録',
        purpose: 'HUD とエージェントが画面上のウインドウのタイトルを読めるようにします。画像は保存されません。'
      },
      notifications: { name: '通知', purpose: '長いタスクが終わったときや対応が必要なときに知らせます。' },
      computerUse: {
        name: 'コンピュータの操作',
        purpose: 'エージェントがアプリを使えるようにする補助ツール CuaDriver のアクセシビリティと画面収録。'
      }
    },
    keychain: {
      name: 'キーチェーン',
      purpose:
        '手動以外の権限モード、ACP ツール、支払いをエージェントが使えるようにします。それらの鍵は macOS のキーチェーンに保護されます。',
      note: '既定ではオフです。オンにすると、macOS のキーチェーンの確認が一度表示されることがあります。',
      on: 'オン',
      off: 'オフ',
      failed: 'キーチェーンの設定を変更できませんでした。'
    },
    status: {
      granted: '許可済み',
      denied: '許可されていません',
      notDetermined: 'まだ確認していません',
      notSetUp: '未設定',
      restricted: '組織が管理しています',
      declined: 'プライバシーでオフ',
      unknown: 'macOS が決定'
    },
    computerUse: {
      granted: '許可済み',
      needs: 'まだ許可されていません',
      notInstalled: '未インストール',
      unavailable: 'エージェントの実行中に利用できます'
    },
    action: { request: '許可…', openSettings: 'システム設定を開く' },
    testNotification: 'テスト通知を表示',
    restart: `新しい画面収録の権限は、${PRODUCT_NAME} の再起動後に macOS が適用します。`,
    declined: '設定 › プライバシーでオフになっているため、アプリが macOS に求めることはありません。',
    perApp:
      '他のアプリの操作とローカルネットワークは、初めて使うときに macOS がアプリごとに尋ねます。事前に求めることはどのアプリにもできません。',
    notification: { title: '通知がオンです', body: `${PRODUCT_NAME} はこのようにお知らせします。` }
  },
  agent: {
    levels: '各レベルの意味',
    raise: 'レベルを上げると macOS のダイアログで確認します。下げる場合はすぐに適用されます。',
    unavailable: 'エージェントの権限はデスクトップアプリで設定します。'
  },
  settings: {
    lead: '初回起動時の選択を、いつでも。ここから自動で尋ねることはありません。',
    again: 'もう一度セットアップ',
    notSetUp: '未設定',
    agentLine: '各領域のレベル、モード、許可した内容。',
    openPermissions: '権限を開く'
  }
}

const zh: SetupBank = {
  sheet: {
    eyebrow: '初始设置',
    title: '一次决定，之后不再打扰。',
    lead: `${PRODUCT_NAME} 和你的智能体在这台 Mac 上可能需要的一切，集中在一处。现在选择或跳过：跳过的项目会在首次使用时由 macOS 或你的智能体询问，也可以随时在设置中设置。`,
    done: '完成',
    saving: '正在保存…',
    skip: '跳过',
    skipAll: '全部跳过，稍后决定',
    undo: '撤销',
    saveFailed: '无法保存你的选择。没有任何更改。',
    tryAgain: '重试',
    continueToApp: '继续进入应用',
    skipped: '已跳过。首次使用时由 macOS 或你的智能体询问；可随时在 设置 › 设备 › 初始设置 中设置。'
  },
  sections: {
    packages: {
      title: '软件包',
      hint: '随应用一起安装。未完成的软件包可以在这里或稍后在设置中重新安装。'
    },
    system: {
      title: '系统权限',
      hint: '仅包含 macOS 允许应用提前请求的权限。是否授予由你决定，macOS 会保存你的回答。'
    },
    agent: {
      title: '智能体权限',
      hint: '你的智能体在每个领域中行动的自由程度。标记的级别即当前生效的级别；默认的“跟随模式”在每次操作前都会询问。'
    }
  },
  packages: {
    state: { installed: '已安装', failed: '未能安装', skipped: '已跳过' },
    installing: percent => (percent === null ? '正在安装…' : `正在安装… ${percent} %`),
    retry: '重新安装',
    retrying: '正在开始…'
  },
  system: {
    rows: {
      microphone: { name: '麦克风', purpose: '语音消息、语音对话和唤醒词。' },
      screen: {
        name: '屏幕录制',
        purpose: '让 HUD 和你的智能体读取屏幕上窗口的标题。不会保存任何画面。'
      },
      notifications: { name: '通知', purpose: '在长任务完成或需要你处理时提醒你。' },
      computerUse: {
        name: '电脑操作',
        purpose: '为 CuaDriver（让你的智能体使用应用的辅助程序）开启辅助功能和屏幕录制。'
      }
    },
    keychain: {
      name: '钥匙串',
      purpose: '让你的智能体使用“手动”以外的权限模式、ACP 工具和支付：它们的密钥封存在 macOS 钥匙串中。',
      note: '默认关闭。开启时 macOS 可能会显示一次钥匙串提示。',
      on: '已开启',
      off: '已关闭',
      failed: '无法更改钥匙串设置。'
    },
    status: {
      granted: '已允许',
      denied: '未允许',
      notDetermined: '尚未询问',
      notSetUp: '未设置',
      restricted: '由你的组织管理',
      declined: '已在隐私中关闭',
      unknown: '由 macOS 决定'
    },
    computerUse: {
      granted: '已允许',
      needs: '尚未允许',
      notInstalled: '未安装',
      unavailable: '智能体运行后可用'
    },
    action: { request: '允许…', openSettings: '打开系统设置' },
    testNotification: '显示测试通知',
    restart: `新的屏幕录制权限会在 ${PRODUCT_NAME} 重启后由 macOS 生效。`,
    declined: '已在 设置 › 隐私 中关闭，因此应用绝不会向 macOS 请求。',
    perApp: '控制其他应用和本地网络由 macOS 在首次使用时按应用询问。任何应用都无法提前请求。',
    notification: { title: '通知已开启', body: `${PRODUCT_NAME} 将通过这种方式提醒你。` }
  },
  agent: {
    levels: '各级别的含义',
    raise: '提高级别需在 macOS 对话框中确认。降低级别立即生效。',
    unavailable: '智能体权限在桌面应用中设置。'
  },
  settings: {
    lead: '首次启动时的选择，随时可改。这里不会自行询问。',
    again: '重新设置',
    notSetUp: '未设置',
    agentLine: '每个领域的级别，以及模式和你允许的内容。',
    openPermissions: '打开权限'
  }
}

const zhHant: SetupBank = {
  sheet: {
    eyebrow: '初始設定',
    title: '一次決定，之後不再打擾。',
    lead: `${PRODUCT_NAME} 和你的代理在這台 Mac 上可能需要的一切，集中在一處。現在選擇或略過：略過的項目會在首次使用時由 macOS 或你的代理詢問，也可以隨時在設定中設定。`,
    done: '完成',
    saving: '正在儲存…',
    skip: '略過',
    skipAll: '全部略過，稍後決定',
    undo: '復原',
    saveFailed: '無法儲存你的選擇。沒有任何變更。',
    tryAgain: '再試一次',
    continueToApp: '繼續進入 App',
    skipped: '已略過。首次使用時由 macOS 或你的代理詢問；可隨時在 設定 › 裝置 › 初始設定 中設定。'
  },
  sections: {
    packages: {
      title: '套件',
      hint: '隨 App 一起安裝。未完成的套件可以在這裡或稍後在設定中重新安裝。'
    },
    system: {
      title: '系統權限',
      hint: '僅包含 macOS 允許 App 事先請求的權限。是否授予由你決定，macOS 會保存你的回答。'
    },
    agent: {
      title: '代理權限',
      hint: '你的代理在每個領域中行動的自由程度。標記的層級即目前生效的層級；預設的「跟隨模式」在每次操作前都會詢問。'
    }
  },
  packages: {
    state: { installed: '已安裝', failed: '未能安裝', skipped: '已略過' },
    installing: percent => (percent === null ? '正在安裝…' : `正在安裝… ${percent} %`),
    retry: '重新安裝',
    retrying: '正在開始…'
  },
  system: {
    rows: {
      microphone: { name: '麥克風', purpose: '語音訊息、語音對話和喚醒詞。' },
      screen: {
        name: '螢幕錄製',
        purpose: '讓 HUD 和你的代理讀取螢幕上視窗的標題。不會保存任何畫面。'
      },
      notifications: { name: '通知', purpose: '在長任務完成或需要你處理時提醒你。' },
      computerUse: {
        name: '電腦操作',
        purpose: '為 CuaDriver（讓你的代理使用 App 的輔助程式）開啟輔助使用和螢幕錄製。'
      }
    },
    keychain: {
      name: '鑰匙圈',
      purpose: '讓你的代理使用「手動」以外的權限模式、ACP 工具和付款：它們的金鑰封存在 macOS 鑰匙圈中。',
      note: '預設關閉。開啟時 macOS 可能會顯示一次鑰匙圈提示。',
      on: '已開啟',
      off: '已關閉',
      failed: '無法變更鑰匙圈設定。'
    },
    status: {
      granted: '已允許',
      denied: '未允許',
      notDetermined: '尚未詢問',
      notSetUp: '未設定',
      restricted: '由你的組織管理',
      declined: '已在隱私中關閉',
      unknown: '由 macOS 決定'
    },
    computerUse: {
      granted: '已允許',
      needs: '尚未允許',
      notInstalled: '未安裝',
      unavailable: '代理執行後可用'
    },
    action: { request: '允許…', openSettings: '打開系統設定' },
    testNotification: '顯示測試通知',
    restart: `新的螢幕錄製權限會在 ${PRODUCT_NAME} 重新啟動後由 macOS 生效。`,
    declined: '已在 設定 › 隱私 中關閉，因此 App 絕不會向 macOS 請求。',
    perApp: '控制其他 App 和區域網路由 macOS 在首次使用時按 App 詢問。任何 App 都無法事先請求。',
    notification: { title: '通知已開啟', body: `${PRODUCT_NAME} 將透過這種方式提醒你。` }
  },
  agent: {
    levels: '各級別的含義',
    raise: '提高級別需在 macOS 對話框中確認。降低級別立即生效。',
    unavailable: '代理權限在桌面 App 中設定。'
  },
  settings: {
    lead: '首次啟動時的選擇，隨時可改。這裡不會自行詢問。',
    again: '重新設定',
    notSetUp: '未設定',
    agentLine: '每個領域的級別，以及模式和你允許的內容。',
    openPermissions: '打開權限'
  }
}

const ar: SetupBank = {
  sheet: {
    eyebrow: 'الإعداد الأولي',
    title: 'قرّر مرة واحدة، ثم لن يزعجك بعد ذلك.',
    lead: `كل ما قد يطلبه ${PRODUCT_NAME} ووكيلك على هذا الـ Mac، في مكان واحد. اختر الآن أو تخطَّ: ما تتخطاه يسأل عنه macOS أو وكيلك عند أول استخدام، ويمكن إعداده في أي وقت من الإعدادات.`,
    done: 'تم',
    saving: 'جارٍ الحفظ…',
    skip: 'تخطٍّ',
    skipAll: 'تخطَّ الكل وقرّر لاحقًا',
    undo: 'تراجع',
    saveFailed: 'تعذّر حفظ اختياراتك. لم يتغيّر شيء.',
    tryAgain: 'حاول مرة أخرى',
    continueToApp: 'المتابعة إلى التطبيق',
    skipped:
      'تم التخطي. يسأل عنه macOS أو وكيلك عند أول استخدام؛ أعدّه في أي وقت من الإعدادات › الجهاز › الإعداد الأولي.'
  },
  sections: {
    packages: {
      title: 'الحزم',
      hint: 'تُثبَّت مع التطبيق. يمكن إعادة تثبيت ما لم يكتمل هنا، أو لاحقًا من الإعدادات.'
    },
    system: {
      title: 'أذونات النظام',
      hint: 'فقط ما يسمح macOS للتطبيق بطلبه مسبقًا. كل إذن قرارك، وmacOS يحتفظ بإجابتك.'
    },
    agent: {
      title: 'أذونات الوكيل',
      hint: 'مدى حرية وكيلك في كل مجال. المستوى المحدد هو النافذ الآن؛ «اتباع الوضع»، وهو الافتراضي، يسأل قبل كل إجراء.'
    }
  },
  packages: {
    state: { installed: 'مثبّتة', failed: 'لم تُثبَّت', skipped: 'تم تخطيها' },
    installing: percent => (percent === null ? 'جارٍ التثبيت…' : `جارٍ التثبيت… ${percent} %`),
    retry: 'التثبيت مجددًا',
    retrying: 'جارٍ البدء…'
  },
  system: {
    rows: {
      microphone: { name: 'الميكروفون', purpose: 'الرسائل الصوتية والمحادثة الصوتية وكلمة التنبيه.' },
      screen: {
        name: 'تسجيل الشاشة',
        purpose: 'يتيح للـ HUD ولوكيلك قراءة عناوين النوافذ على الشاشة. لا تُحفظ أي صورة.'
      },
      notifications: { name: 'الإشعارات', purpose: 'تخبرك حين تنتهي مهمة طويلة أو تحتاج إليك.' },
      computerUse: {
        name: 'استخدام الكمبيوتر',
        purpose: 'إمكانية الوصول وتسجيل الشاشة لـ CuaDriver، المساعد الذي يتيح لوكيلك استخدام التطبيقات.'
      }
    },
    keychain: {
      name: 'سلسلة المفاتيح',
      purpose:
        'تتيح لوكيلك استخدام أوضاع الأذونات بعد «يدوي» وأدوات ACP والمدفوعات: تُختم مفاتيحها في سلسلة مفاتيح macOS.',
      note: 'متوقفة افتراضيًا. قد يعرض macOS طلب سلسلة المفاتيح مرة واحدة عند تشغيلها.',
      on: 'مفعّلة',
      off: 'متوقفة',
      failed: 'تعذّر تغيير إعداد سلسلة المفاتيح.'
    },
    status: {
      granted: 'مسموح',
      denied: 'غير مسموح',
      notDetermined: 'لم يُطلب بعد',
      notSetUp: 'غير مُعَدّ',
      restricted: 'تديره مؤسستك',
      declined: 'متوقف في الخصوصية',
      unknown: 'يقرّر macOS'
    },
    computerUse: {
      granted: 'مسموح',
      needs: 'غير مسموح بعد',
      notInstalled: 'غير مثبّت',
      unavailable: 'متاح عندما يعمل الوكيل'
    },
    action: { request: 'السماح…', openSettings: 'فتح إعدادات النظام' },
    testNotification: 'عرض إشعار تجريبي',
    restart: `يطبّق macOS إذن تسجيل الشاشة الجديد بعد إعادة تشغيل ${PRODUCT_NAME}.`,
    declined: 'متوقف في الإعدادات › الخصوصية، لذا لا يطلبه التطبيق من macOS أبدًا.',
    perApp:
      'التحكم في تطبيق آخر والشبكة المحلية يسأل عنهما macOS لكل تطبيق عند أول استخدام. لا يمكن لأي تطبيق طلبهما مسبقًا.',
    notification: { title: 'الإشعارات مفعّلة', body: `هكذا سيُعلمك ${PRODUCT_NAME}.` }
  },
  agent: {
    levels: 'معنى كل مستوى',
    raise: 'رفع المستوى يُؤكَّد في نافذة حوار من macOS. خفضه يُطبَّق فورًا.',
    unavailable: 'تُضبط أذونات الوكيل في تطبيق سطح المكتب.'
  },
  settings: {
    lead: 'اختيارات التشغيل الأول، في أي وقت. لا شيء هنا يسأل من تلقاء نفسه.',
    again: 'الإعداد مجددًا',
    notSetUp: 'غير مُعَدّ',
    agentLine: 'مستوى كل مجال، مع الأوضاع وما سمحت به.',
    openPermissions: 'فتح الأذونات'
  }
}

const BANKS: Record<Locale, SetupBank> = { ar, en, ja, 'pt-PT': ptPt, zh, 'zh-hant': zhHant }

export const setupBankFor = (locale: Locale): SetupBank => BANKS[locale] ?? en

export function useSetupCopy(): SetupBank {
  return setupBankFor(useI18n().locale)
}
