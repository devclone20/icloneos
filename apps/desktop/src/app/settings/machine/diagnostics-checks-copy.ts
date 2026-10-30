import { type Locale, useI18n } from '@/i18n'

import type { DoctorStatus } from '../diagnostics-settings-model'

// The words of each diagnostics check and fix, keyed by the runner's ids (ruling S28.2). The runner's own titles,
// details, plans and errors are never shown; an id without a sentence falls back to its pack's sentence.
export interface DiagnosticsCheckCopy {
  checks: Record<string, string>
  fixes: Record<string, string>
  status: Record<DoctorStatus, string>
  fixFallback: string
  fixFailed: string
  needsConsent: string
  planCount(n: number): string
}

const en: DiagnosticsCheckCopy = {
  checks: {
    'acp.wrapper': 'The marketplace command is in place',
    'acp.registry': 'Your list of agents can be read',
    'acp.private_files': 'Your private keys can be read only by you',
    'gateway.updates_check': 'The agent never updates itself behind your back',
    'gateway.port': "No old process is blocking the agent's connection",
    'gateway.health': 'The agent answers when the app calls it',
    'gateway.state_db': 'Your saved conversations are intact',
    'gateway.wal_orphan': 'No leftover files are holding back your conversations',
    'native.codesign': 'The app is signed and approved by the system',
    'native.location': 'The app is installed where it can update itself',
    'native.abi': "The app's built-in parts match this version",
    'native.spawn_helper': 'The terminal inside the app can start',
    'native.rosetta': 'The app runs natively on this computer',
    'native.renderer_cache': "The app's temporary files have not grown too large",
    'network.online': 'This computer is online',
    'network.dns': 'Web addresses can be found from this computer',
    'network.time': "This computer's clock is set correctly",
    'network.quality': 'The connection is fast enough for the agent',
    'network.hermes_doctor': 'The agent can reach your AI providers',
    'permissions.consent_file': 'Your privacy choices are saved and can be read',
    'permissions.media': 'The app may use the microphone and the screen',
    'permissions.accessibility': 'The app may control other windows for you',
    'runtime.venv_python': "The agent's engine can start",
    'runtime.venv_home': "The agent's engine points to the right place",
    'runtime.tcc_anchor': 'The permissions you gave stay with the agent',
    'storage.ownership': 'The records of the agents you own are intact',
    'storage.private_modes': 'Your local records can be read only by you',
    'storage.disk': 'There is enough free space on this computer',
    'storage.crash_dumps': 'The app has not been crashing lately',
    'wallet.safe_storage': 'This computer can keep your secrets encrypted',
    'wallet.privy_session': 'You are still signed in'
  },
  fixes: {
    'acp.rewrite_wrapper': 'Reinstall the command',
    'acp.rerender_registry': 'Rebuild the list',
    'acp.chmod_private': 'Make them private',
    'gateway.updates_check_off': 'Turn self-updates off',
    'gateway.free_port': 'Stop the old process',
    'gateway.restore_state_db': 'Restore from the newest backup',
    'gateway.quarantine_wal': 'Move the leftover files aside',
    'native.install_release': 'Install the signed release',
    'native.chmod_spawn_helper': 'Let the terminal start',
    'native.clear_cache': 'Clear the temporary files',
    'permissions.quarantine_consent': 'Set the unreadable record aside',
    'permissions.open_privacy': "Open the system's privacy settings",
    'permissions.reset_accessibility': 'Reset the permission',
    'runtime.venv_repair': 'Repair the engine',
    'storage.restore_ownership': 'Restore from the copy',
    'storage.chmod_private': 'Make them private',
    'wallet.sign_in_again': 'Sign in again'
  },
  status: {
    pass: 'Nothing to do',
    warn: 'Worth a look when you have a moment',
    fail: 'Needs fixing',
    skip: 'Not checked this time'
  },
  fixFallback: 'Fix it',
  fixFailed: 'The fix could not finish; try again or send a report',
  needsConsent: 'This fix needs a permission you have not given; turn it on in Privacy first',
  planCount: n => `${n} changes will be made on this computer`
}

const ja: DiagnosticsCheckCopy = {
  checks: {
    'acp.wrapper': 'マーケットプレイスのコマンドが使える状態です',
    'acp.registry': 'エージェントの一覧を読み取れます',
    'acp.private_files': '秘密鍵はあなただけが読み取れます',
    'gateway.updates_check': 'エージェントが勝手に更新されることはありません',
    'gateway.port': '古いプロセスがエージェントの接続を妨げていません',
    'gateway.health': 'アプリが呼びかけるとエージェントが応答します',
    'gateway.state_db': '保存された会話は壊れていません',
    'gateway.wal_orphan': '会話を妨げる残りファイルはありません',
    'native.codesign': 'アプリは署名され、システムに承認されています',
    'native.location': 'アプリは自動で更新できる場所にインストールされています',
    'native.abi': 'アプリの内蔵部品がこのバージョンと一致しています',
    'native.spawn_helper': 'アプリ内のターミナルを起動できます',
    'native.rosetta': 'アプリはこのコンピューターでネイティブに動作しています',
    'native.renderer_cache': 'アプリの一時ファイルは大きくなりすぎていません',
    'network.online': 'このコンピューターはオンラインです',
    'network.dns': 'このコンピューターから Web アドレスを見つけられます',
    'network.time': 'このコンピューターの時計は正しく設定されています',
    'network.quality': '接続はエージェントに十分な速さです',
    'network.hermes_doctor': 'エージェントは AI プロバイダーに接続できます',
    'permissions.consent_file': 'プライバシーの選択は保存され、読み取れます',
    'permissions.media': 'アプリはマイクと画面を使用できます',
    'permissions.accessibility': 'アプリはあなたの代わりに他のウインドウを操作できます',
    'runtime.venv_python': 'エージェントのエンジンを起動できます',
    'runtime.venv_home': 'エージェントのエンジンは正しい場所を指しています',
    'runtime.tcc_anchor': '付与した権限はエージェントに保持されます',
    'storage.ownership': '所有するエージェントの記録は壊れていません',
    'storage.private_modes': 'ローカルの記録はあなただけが読み取れます',
    'storage.disk': 'このコンピューターに十分な空き容量があります',
    'storage.crash_dumps': 'アプリは最近クラッシュしていません',
    'wallet.safe_storage': 'このコンピューターは秘密情報を暗号化して保存できます',
    'wallet.privy_session': 'まだサインインしています'
  },
  fixes: {
    'acp.rewrite_wrapper': 'コマンドを再インストール',
    'acp.rerender_registry': '一覧を作り直す',
    'acp.chmod_private': '非公開にする',
    'gateway.updates_check_off': '自動更新をオフにする',
    'gateway.free_port': '古いプロセスを停止',
    'gateway.restore_state_db': '最新のバックアップから復元',
    'gateway.quarantine_wal': '残りファイルを移動',
    'native.install_release': '署名済みリリースをインストール',
    'native.chmod_spawn_helper': 'ターミナルを起動できるようにする',
    'native.clear_cache': '一時ファイルを消去',
    'permissions.quarantine_consent': '読み取れない記録を移動',
    'permissions.open_privacy': 'システムのプライバシー設定を開く',
    'permissions.reset_accessibility': '権限をリセット',
    'runtime.venv_repair': 'エンジンを修復',
    'storage.restore_ownership': 'コピーから復元',
    'storage.chmod_private': '非公開にする',
    'wallet.sign_in_again': 'もう一度サインイン'
  },
  status: {
    pass: '対応は不要です',
    warn: '時間のあるときに確認してください',
    fail: '修正が必要です',
    skip: '今回は確認していません'
  },
  fixFallback: '修正する',
  fixFailed: '修正を完了できませんでした。もう一度試すか、レポートを送信してください',
  needsConsent: 'この修正にはまだ許可していない権限が必要です。先にプライバシーでオンにしてください',
  planCount: n => `このコンピューターで ${n} 件の変更が行われます`
}

const zh: DiagnosticsCheckCopy = {
  checks: {
    'acp.wrapper': '市场命令已就位',
    'acp.registry': '你的智能体列表可以读取',
    'acp.private_files': '你的私钥只有你能读取',
    'gateway.updates_check': '智能体不会在你不知情时自行更新',
    'gateway.port': '没有旧进程占用智能体的连接',
    'gateway.health': '应用呼叫时智能体会响应',
    'gateway.state_db': '你保存的对话完好无损',
    'gateway.wal_orphan': '没有遗留文件妨碍你的对话',
    'native.codesign': '应用已签名并获得系统认可',
    'native.location': '应用安装在可以自行更新的位置',
    'native.abi': '应用的内置组件与此版本匹配',
    'native.spawn_helper': '应用内的终端可以启动',
    'native.rosetta': '应用在这台电脑上原生运行',
    'native.renderer_cache': '应用的临时文件没有过大',
    'network.online': '这台电脑已联网',
    'network.dns': '这台电脑可以解析网址',
    'network.time': '这台电脑的时钟设置正确',
    'network.quality': '网络速度足以支持智能体',
    'network.hermes_doctor': '智能体可以连接你的 AI 服务商',
    'permissions.consent_file': '你的隐私选择已保存且可以读取',
    'permissions.media': '应用可以使用麦克风和屏幕',
    'permissions.accessibility': '应用可以替你操作其他窗口',
    'runtime.venv_python': '智能体的引擎可以启动',
    'runtime.venv_home': '智能体的引擎指向正确的位置',
    'runtime.tcc_anchor': '你授予的权限会保留在智能体上',
    'storage.ownership': '你拥有的智能体记录完好无损',
    'storage.private_modes': '你的本地记录只有你能读取',
    'storage.disk': '这台电脑有足够的可用空间',
    'storage.crash_dumps': '应用最近没有崩溃',
    'wallet.safe_storage': '这台电脑可以加密保存你的机密',
    'wallet.privy_session': '你仍处于登录状态'
  },
  fixes: {
    'acp.rewrite_wrapper': '重新安装命令',
    'acp.rerender_registry': '重建列表',
    'acp.chmod_private': '设为私有',
    'gateway.updates_check_off': '关闭自动更新',
    'gateway.free_port': '停止旧进程',
    'gateway.restore_state_db': '从最新备份恢复',
    'gateway.quarantine_wal': '移走遗留文件',
    'native.install_release': '安装已签名的发行版',
    'native.chmod_spawn_helper': '允许终端启动',
    'native.clear_cache': '清除临时文件',
    'permissions.quarantine_consent': '移走无法读取的记录',
    'permissions.open_privacy': '打开系统隐私设置',
    'permissions.reset_accessibility': '重置权限',
    'runtime.venv_repair': '修复引擎',
    'storage.restore_ownership': '从副本恢复',
    'storage.chmod_private': '设为私有',
    'wallet.sign_in_again': '重新登录'
  },
  status: {
    pass: '无需处理',
    warn: '有空时值得看一看',
    fail: '需要修复',
    skip: '这次未检查'
  },
  fixFallback: '修复',
  fixFailed: '修复未能完成；请重试或发送报告',
  needsConsent: '此修复需要你尚未授予的权限；请先在隐私中开启',
  planCount: n => `将在这台电脑上进行 ${n} 项更改`
}

const zhHant: DiagnosticsCheckCopy = {
  checks: {
    'acp.wrapper': '市集指令已就位',
    'acp.registry': '你的代理程式清單可以讀取',
    'acp.private_files': '你的私密金鑰只有你能讀取',
    'gateway.updates_check': '代理程式不會在你不知情時自行更新',
    'gateway.port': '沒有舊程序佔用代理程式的連線',
    'gateway.health': '應用程式呼叫時代理程式會回應',
    'gateway.state_db': '你儲存的對話完好無損',
    'gateway.wal_orphan': '沒有遺留檔案妨礙你的對話',
    'native.codesign': '應用程式已簽署並獲得系統認可',
    'native.location': '應用程式安裝在可以自行更新的位置',
    'native.abi': '應用程式的內建元件與此版本相符',
    'native.spawn_helper': '應用程式內的終端機可以啟動',
    'native.rosetta': '應用程式在這台電腦上原生執行',
    'native.renderer_cache': '應用程式的暫存檔案沒有過大',
    'network.online': '這台電腦已連線',
    'network.dns': '這台電腦可以解析網址',
    'network.time': '這台電腦的時鐘設定正確',
    'network.quality': '網路速度足以支援代理程式',
    'network.hermes_doctor': '代理程式可以連線你的 AI 供應商',
    'permissions.consent_file': '你的隱私選擇已儲存且可以讀取',
    'permissions.media': '應用程式可以使用麥克風和螢幕',
    'permissions.accessibility': '應用程式可以替你操作其他視窗',
    'runtime.venv_python': '代理程式的引擎可以啟動',
    'runtime.venv_home': '代理程式的引擎指向正確的位置',
    'runtime.tcc_anchor': '你授予的權限會保留在代理程式上',
    'storage.ownership': '你擁有的代理程式紀錄完好無損',
    'storage.private_modes': '你的本機紀錄只有你能讀取',
    'storage.disk': '這台電腦有足夠的可用空間',
    'storage.crash_dumps': '應用程式最近沒有當機',
    'wallet.safe_storage': '這台電腦可以加密儲存你的機密',
    'wallet.privy_session': '你仍處於登入狀態'
  },
  fixes: {
    'acp.rewrite_wrapper': '重新安裝指令',
    'acp.rerender_registry': '重建清單',
    'acp.chmod_private': '設為私密',
    'gateway.updates_check_off': '關閉自動更新',
    'gateway.free_port': '停止舊程序',
    'gateway.restore_state_db': '從最新備份還原',
    'gateway.quarantine_wal': '移走遺留檔案',
    'native.install_release': '安裝已簽署的發行版',
    'native.chmod_spawn_helper': '允許終端機啟動',
    'native.clear_cache': '清除暫存檔案',
    'permissions.quarantine_consent': '移走無法讀取的紀錄',
    'permissions.open_privacy': '開啟系統隱私設定',
    'permissions.reset_accessibility': '重設權限',
    'runtime.venv_repair': '修復引擎',
    'storage.restore_ownership': '從副本還原',
    'storage.chmod_private': '設為私密',
    'wallet.sign_in_again': '重新登入'
  },
  status: {
    pass: '無需處理',
    warn: '有空時值得看一看',
    fail: '需要修復',
    skip: '這次未檢查'
  },
  fixFallback: '修復',
  fixFailed: '修復未能完成；請重試或傳送報告',
  needsConsent: '此修復需要你尚未授予的權限；請先在隱私中開啟',
  planCount: n => `將在這台電腦上進行 ${n} 項變更`
}

const ar: DiagnosticsCheckCopy = {
  checks: {
    'acp.wrapper': 'أمر السوق في مكانه',
    'acp.registry': 'قائمة وكلائك قابلة للقراءة',
    'acp.private_files': 'مفاتيحك الخاصة لا يقرؤها أحد سواك',
    'gateway.updates_check': 'لا يحدِّث الوكيل نفسه دون علمك',
    'gateway.port': 'لا تعيق عمليةٌ قديمة اتصال الوكيل',
    'gateway.health': 'يستجيب الوكيل عندما يستدعيه التطبيق',
    'gateway.state_db': 'محادثاتك المحفوظة سليمة',
    'gateway.wal_orphan': 'لا توجد ملفات متبقية تعيق محادثاتك',
    'native.codesign': 'التطبيق موقَّع ومعتمد من النظام',
    'native.location': 'التطبيق مثبَّت حيث يمكنه تحديث نفسه',
    'native.abi': 'مكوّنات التطبيق المدمجة تطابق هذا الإصدار',
    'native.spawn_helper': 'يمكن تشغيل الطرفية داخل التطبيق',
    'native.rosetta': 'يعمل التطبيق أصلياً على هذا الحاسوب',
    'native.renderer_cache': 'لم تكبر الملفات المؤقتة للتطبيق أكثر من اللازم',
    'network.online': 'هذا الحاسوب متصل بالإنترنت',
    'network.dns': 'يمكن العثور على عناوين الويب من هذا الحاسوب',
    'network.time': 'ساعة هذا الحاسوب مضبوطة بشكل صحيح',
    'network.quality': 'الاتصال سريع بما يكفي للوكيل',
    'network.hermes_doctor': 'يستطيع الوكيل الوصول إلى مزوّدي الذكاء الاصطناعي لديك',
    'permissions.consent_file': 'خيارات خصوصيتك محفوظة وقابلة للقراءة',
    'permissions.media': 'يمكن للتطبيق استخدام الميكروفون والشاشة',
    'permissions.accessibility': 'يمكن للتطبيق التحكم في النوافذ الأخرى نيابةً عنك',
    'runtime.venv_python': 'يمكن تشغيل محرّك الوكيل',
    'runtime.venv_home': 'يشير محرّك الوكيل إلى المكان الصحيح',
    'runtime.tcc_anchor': 'تبقى الأذونات التي منحتها مع الوكيل',
    'storage.ownership': 'سجلات الوكلاء الذين تملكهم سليمة',
    'storage.private_modes': 'سجلاتك المحلية لا يقرؤها أحد سواك',
    'storage.disk': 'توجد مساحة فارغة كافية على هذا الحاسوب',
    'storage.crash_dumps': 'لم يتعطّل التطبيق مؤخراً',
    'wallet.safe_storage': 'يستطيع هذا الحاسوب حفظ أسرارك مشفّرة',
    'wallet.privy_session': 'ما زلت مسجّل الدخول'
  },
  fixes: {
    'acp.rewrite_wrapper': 'إعادة تثبيت الأمر',
    'acp.rerender_registry': 'إعادة بناء القائمة',
    'acp.chmod_private': 'اجعلها خاصة',
    'gateway.updates_check_off': 'إيقاف التحديث الذاتي',
    'gateway.free_port': 'إيقاف العملية القديمة',
    'gateway.restore_state_db': 'الاستعادة من أحدث نسخة احتياطية',
    'gateway.quarantine_wal': 'نقل الملفات المتبقية جانباً',
    'native.install_release': 'تثبيت الإصدار الموقَّع',
    'native.chmod_spawn_helper': 'السماح بتشغيل الطرفية',
    'native.clear_cache': 'مسح الملفات المؤقتة',
    'permissions.quarantine_consent': 'نقل السجل غير المقروء جانباً',
    'permissions.open_privacy': 'فتح إعدادات الخصوصية في النظام',
    'permissions.reset_accessibility': 'إعادة تعيين الإذن',
    'runtime.venv_repair': 'إصلاح المحرّك',
    'storage.restore_ownership': 'الاستعادة من النسخة',
    'storage.chmod_private': 'اجعلها خاصة',
    'wallet.sign_in_again': 'تسجيل الدخول مجدداً'
  },
  status: {
    pass: 'لا شيء يلزم فعله',
    warn: 'يستحق نظرة عندما يتسنّى لك',
    fail: 'يحتاج إلى إصلاح',
    skip: 'لم يُفحص هذه المرة'
  },
  fixFallback: 'إصلاح',
  fixFailed: 'تعذّر إكمال الإصلاح؛ حاول مجدداً أو أرسل تقريراً',
  needsConsent: 'يحتاج هذا الإصلاح إلى إذن لم تمنحه بعد؛ فعّله في الخصوصية أولاً',
  planCount: n => `سيُجرى ${n} تغييراً على هذا الحاسوب`
}

const ptPt: DiagnosticsCheckCopy = {
  checks: {
    'acp.wrapper': 'O comando do marketplace está no lugar',
    'acp.registry': 'A sua lista de agentes pode ser lida',
    'acp.private_files': 'As suas chaves privadas só podem ser lidas por si',
    'gateway.updates_check': 'O agente nunca se atualiza sem o seu conhecimento',
    'gateway.port': 'Nenhum processo antigo está a bloquear a ligação do agente',
    'gateway.health': 'O agente responde quando a aplicação o chama',
    'gateway.state_db': 'As suas conversas guardadas estão intactas',
    'gateway.wal_orphan': 'Nenhum ficheiro residual está a travar as suas conversas',
    'native.codesign': 'A aplicação está assinada e aprovada pelo sistema',
    'native.location': 'A aplicação está instalada onde se pode atualizar sozinha',
    'native.abi': 'Os componentes internos da aplicação correspondem a esta versão',
    'native.spawn_helper': 'O terminal dentro da aplicação consegue arrancar',
    'native.rosetta': 'A aplicação corre de forma nativa neste computador',
    'native.renderer_cache': 'Os ficheiros temporários da aplicação não cresceram demasiado',
    'network.online': 'Este computador está online',
    'network.dns': 'Os endereços web podem ser encontrados a partir deste computador',
    'network.time': 'O relógio deste computador está certo',
    'network.quality': 'A ligação é suficientemente rápida para o agente',
    'network.hermes_doctor': 'O agente consegue chegar aos seus fornecedores de IA',
    'permissions.consent_file': 'As suas escolhas de privacidade estão guardadas e podem ser lidas',
    'permissions.media': 'A aplicação pode usar o microfone e o ecrã',
    'permissions.accessibility': 'A aplicação pode controlar outras janelas por si',
    'runtime.venv_python': 'O motor do agente consegue arrancar',
    'runtime.venv_home': 'O motor do agente aponta para o sítio certo',
    'runtime.tcc_anchor': 'As permissões que deu ficam com o agente',
    'storage.ownership': 'Os registos dos agentes que possui estão intactos',
    'storage.private_modes': 'Os seus registos locais só podem ser lidos por si',
    'storage.disk': 'Há espaço livre suficiente neste computador',
    'storage.crash_dumps': 'A aplicação não tem falhado ultimamente',
    'wallet.safe_storage': 'Este computador consegue guardar os seus segredos encriptados',
    'wallet.privy_session': 'Ainda tem sessão iniciada'
  },
  fixes: {
    'acp.rewrite_wrapper': 'Reinstalar o comando',
    'acp.rerender_registry': 'Reconstruir a lista',
    'acp.chmod_private': 'Torná-las privadas',
    'gateway.updates_check_off': 'Desativar as atualizações automáticas',
    'gateway.free_port': 'Parar o processo antigo',
    'gateway.restore_state_db': 'Restaurar a partir da cópia de segurança mais recente',
    'gateway.quarantine_wal': 'Pôr de parte os ficheiros residuais',
    'native.install_release': 'Instalar a versão assinada',
    'native.chmod_spawn_helper': 'Deixar o terminal arrancar',
    'native.clear_cache': 'Limpar os ficheiros temporários',
    'permissions.quarantine_consent': 'Pôr de parte o registo ilegível',
    'permissions.open_privacy': 'Abrir as definições de privacidade do sistema',
    'permissions.reset_accessibility': 'Repor a permissão',
    'runtime.venv_repair': 'Reparar o motor',
    'storage.restore_ownership': 'Restaurar a partir da cópia',
    'storage.chmod_private': 'Torná-los privados',
    'wallet.sign_in_again': 'Iniciar sessão novamente'
  },
  status: {
    pass: 'Nada a fazer',
    warn: 'Vale a pena ver quando tiver um momento',
    fail: 'Precisa de correção',
    skip: 'Não verificado desta vez'
  },
  fixFallback: 'Corrigir',
  fixFailed: 'Não foi possível concluir a correção; tente novamente ou envie um relatório',
  needsConsent: 'Esta correção precisa de uma permissão que não deu; ative-a primeiro em Privacidade',
  planCount: n =>
    n === 1 ? 'Será feita 1 alteração neste computador' : `Serão feitas ${n} alterações neste computador`
}

const BY_LOCALE: Record<Locale, DiagnosticsCheckCopy> = { ar, en, ja, 'pt-PT': ptPt, zh, 'zh-hant': zhHant }

export function diagnosticsCheckCopy(locale: Locale): DiagnosticsCheckCopy {
  return BY_LOCALE[locale] ?? en
}

export function useDiagnosticsCheckCopy(): DiagnosticsCheckCopy {
  return diagnosticsCheckCopy(useI18n().locale)
}
