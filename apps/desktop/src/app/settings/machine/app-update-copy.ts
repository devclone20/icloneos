import { type Locale, useI18n } from '@/i18n'
import { formatBytes } from '@/iclone-shared/format'
import { displayVersion } from '@/iclone-shared/version'
import type { AppUpdateLogEntry, AppUpdateState } from '@/types/iclone-app-update'

type AppUpdateErrorKind = NonNullable<AppUpdateState['error']>['kind']
type AppUpdateLogResult = AppUpdateLogEntry['result']

// The app updater's words for About and Updates, keyed by phase, error kind and log result (ruling S28.2):
// the store's English status prose and the updater's error text are never shown.
const en = {
  upToDate: 'This app is up to date',
  checkedAt: (time: string) => `checked at ${time}`,
  checking: 'Looking for a new version…',
  available: (version: string) => `Version ${version} is ready to download`,
  downloading: (version: string, percent: number) => `Downloading version ${version} · ${percent} %`,
  bytesOf: (done: string, total: string) => `${done} of ${total}`,
  downloaded: (version: string) => `Version ${version} is ready; the app will close and reopen`,
  installing: 'Restarting to install the update…',
  inactive: 'This copy updates itself only when it is installed from the signed release',
  idle: 'The app looks for a new version every six hours',
  lastChecked: (time: string) => `Last checked at ${time}`,
  errors: {
    'blocked-runtime': 'The agent is busy updating; try again when it has finished',
    disk: 'There is not enough free space for the update',
    feed: 'The update server did not answer as expected; try again later',
    install: 'The update could not be installed; try again later',
    location: 'Move the app to your applications folder to receive updates',
    offline: 'You are offline; the app will look again when you are back online',
    verify: 'The download did not pass its signature check and was discarded'
  } as Record<AppUpdateErrorKind, string>,
  errorFallback: 'The update could not finish; try again later',
  buttonChecking: 'Checking…',
  buttonUpdate: (version: string) => `Update to ${version}`,
  buttonCancel: 'Cancel',
  buttonRestart: 'Restart to update',
  buttonRestarting: 'Restarting…',
  buttonRetry: 'Try again',
  buttonCheck: 'Check for updates',
  results: { failed: 'Did not install', installed: 'Installed', installing: 'Installing' } as Record<
    AppUpdateLogResult,
    string
  >,
  runtime: (version: string) => `Built-in agent ${version}`
}

type AppUpdateCopy = typeof en

const ja: AppUpdateCopy = {
  upToDate: 'このアプリは最新です',
  checkedAt: time => `${time} に確認`,
  checking: '新しいバージョンを探しています…',
  available: version => `バージョン ${version} をダウンロードできます`,
  downloading: (version, percent) => `バージョン ${version} をダウンロード中 · ${percent} %`,
  bytesOf: (done, total) => `${total} 中 ${done}`,
  downloaded: version => `バージョン ${version} の準備ができました。アプリを閉じて再び開きます`,
  installing: 'アップデートをインストールするため再起動しています…',
  inactive: 'このコピーは、署名済みのリリースからインストールした場合にのみ自動で更新されます',
  idle: 'アプリは 6 時間ごとに新しいバージョンを探します',
  lastChecked: time => `最終確認 ${time}`,
  errors: {
    'blocked-runtime': 'エージェントが更新中です。完了してからもう一度お試しください',
    disk: 'アップデートに必要な空き容量が足りません',
    feed: 'アップデートサーバーが想定どおりに応答しませんでした。後でもう一度お試しください',
    install: 'アップデートをインストールできませんでした。後でもう一度お試しください',
    location: 'アップデートを受け取るには、アプリをアプリケーションフォルダーに移動してください',
    offline: 'オフラインです。オンラインに戻るとアプリが再び確認します',
    verify: 'ダウンロードは署名の確認に合格しなかったため破棄されました'
  },
  errorFallback: 'アップデートを完了できませんでした。後でもう一度お試しください',
  buttonChecking: '確認中…',
  buttonUpdate: version => `${version} に更新`,
  buttonCancel: 'キャンセル',
  buttonRestart: '再起動して更新',
  buttonRestarting: '再起動中…',
  buttonRetry: 'もう一度試す',
  buttonCheck: 'アップデートを確認',
  results: { failed: 'インストールされませんでした', installed: 'インストール済み', installing: 'インストール中' },
  runtime: version => `内蔵エージェント ${version}`
}

const zh: AppUpdateCopy = {
  upToDate: '此应用已是最新版本',
  checkedAt: time => `于 ${time} 检查`,
  checking: '正在查找新版本…',
  available: version => `版本 ${version} 可以下载了`,
  downloading: (version, percent) => `正在下载版本 ${version} · ${percent} %`,
  bytesOf: (done, total) => `${done} / ${total}`,
  downloaded: version => `版本 ${version} 已就绪；应用将关闭并重新打开`,
  installing: '正在重新启动以安装更新…',
  inactive: '只有从已签名的发行版安装时，此副本才会自行更新',
  idle: '应用每六小时查找一次新版本',
  lastChecked: time => `上次检查于 ${time}`,
  errors: {
    'blocked-runtime': '智能体正在更新；完成后请再试一次',
    disk: '可用空间不足，无法更新',
    feed: '更新服务器没有按预期响应；请稍后再试',
    install: '无法安装更新；请稍后再试',
    location: '请将应用移到应用程序文件夹以接收更新',
    offline: '你已离线；恢复联网后应用会再次查找',
    verify: '下载未通过签名检查，已被丢弃'
  },
  errorFallback: '更新未能完成；请稍后再试',
  buttonChecking: '正在检查…',
  buttonUpdate: version => `更新到 ${version}`,
  buttonCancel: '取消',
  buttonRestart: '重新启动以更新',
  buttonRestarting: '正在重新启动…',
  buttonRetry: '再试一次',
  buttonCheck: '检查更新',
  results: { failed: '未安装', installed: '已安装', installing: '正在安装' },
  runtime: version => `内置智能体 ${version}`
}

const zhHant: AppUpdateCopy = {
  upToDate: '此應用程式已是最新版本',
  checkedAt: time => `於 ${time} 檢查`,
  checking: '正在尋找新版本…',
  available: version => `版本 ${version} 可以下載了`,
  downloading: (version, percent) => `正在下載版本 ${version} · ${percent} %`,
  bytesOf: (done, total) => `${done} / ${total}`,
  downloaded: version => `版本 ${version} 已就緒；應用程式將關閉並重新開啟`,
  installing: '正在重新啟動以安裝更新…',
  inactive: '只有從已簽署的發行版安裝時，此副本才會自行更新',
  idle: '應用程式每六小時尋找一次新版本',
  lastChecked: time => `上次檢查於 ${time}`,
  errors: {
    'blocked-runtime': '代理程式正在更新；完成後請再試一次',
    disk: '可用空間不足，無法更新',
    feed: '更新伺服器沒有如預期回應；請稍後再試',
    install: '無法安裝更新；請稍後再試',
    location: '請將應用程式移到應用程式資料夾以接收更新',
    offline: '你已離線；恢復連線後應用程式會再次尋找',
    verify: '下載未通過簽署檢查，已被捨棄'
  },
  errorFallback: '更新未能完成；請稍後再試',
  buttonChecking: '正在檢查…',
  buttonUpdate: version => `更新到 ${version}`,
  buttonCancel: '取消',
  buttonRestart: '重新啟動以更新',
  buttonRestarting: '正在重新啟動…',
  buttonRetry: '再試一次',
  buttonCheck: '檢查更新',
  results: { failed: '未安裝', installed: '已安裝', installing: '正在安裝' },
  runtime: version => `內建代理程式 ${version}`
}

const ar: AppUpdateCopy = {
  upToDate: 'هذا التطبيق محدَّث',
  checkedAt: time => `فُحص عند ${time}`,
  checking: 'جارٍ البحث عن إصدار جديد…',
  available: version => `الإصدار ${version} جاهز للتنزيل`,
  downloading: (version, percent) => `جارٍ تنزيل الإصدار ${version} · ${percent} %`,
  bytesOf: (done, total) => `${done} من ${total}`,
  downloaded: version => `الإصدار ${version} جاهز؛ سيُغلق التطبيق ثم يُفتح من جديد`,
  installing: 'جارٍ إعادة التشغيل لتثبيت التحديث…',
  inactive: 'لا تُحدِّث هذه النسخة نفسها إلا إذا ثُبِّتت من الإصدار الموقَّع',
  idle: 'يبحث التطبيق عن إصدار جديد كل ست ساعات',
  lastChecked: time => `آخر فحص عند ${time}`,
  errors: {
    'blocked-runtime': 'الوكيل منشغل بالتحديث؛ حاول مجدداً بعد أن ينتهي',
    disk: 'لا توجد مساحة فارغة كافية للتحديث',
    feed: 'لم يُجب خادم التحديث كما هو متوقع؛ حاول لاحقاً',
    install: 'تعذّر تثبيت التحديث؛ حاول لاحقاً',
    location: 'انقل التطبيق إلى مجلد التطبيقات لتصلك التحديثات',
    offline: 'أنت غير متصل؛ سيبحث التطبيق مجدداً عند عودة الاتصال',
    verify: 'لم يجتز التنزيل فحص التوقيع فتم تجاهله'
  },
  errorFallback: 'تعذّر إكمال التحديث؛ حاول لاحقاً',
  buttonChecking: 'جارٍ الفحص…',
  buttonUpdate: version => `التحديث إلى ${version}`,
  buttonCancel: 'إلغاء',
  buttonRestart: 'إعادة التشغيل للتحديث',
  buttonRestarting: 'جارٍ إعادة التشغيل…',
  buttonRetry: 'حاول مجدداً',
  buttonCheck: 'البحث عن تحديثات',
  results: { failed: 'لم يُثبَّت', installed: 'مُثبَّت', installing: 'جارٍ التثبيت' },
  runtime: version => `الوكيل المدمج ${version}`
}

const ptPt: AppUpdateCopy = {
  upToDate: 'Esta aplicação está atualizada',
  checkedAt: time => `verificado às ${time}`,
  checking: 'A procurar uma versão nova…',
  available: version => `A versão ${version} está pronta a transferir`,
  downloading: (version, percent) => `A transferir a versão ${version} · ${percent} %`,
  bytesOf: (done, total) => `${done} de ${total}`,
  downloaded: version => `A versão ${version} está pronta; a aplicação vai fechar e voltar a abrir`,
  installing: 'A reiniciar para instalar a atualização…',
  inactive: 'Esta cópia só se atualiza sozinha quando é instalada a partir da versão assinada',
  idle: 'A aplicação procura uma versão nova de seis em seis horas',
  lastChecked: time => `Última verificação às ${time}`,
  errors: {
    'blocked-runtime': 'O agente está ocupado a atualizar-se; tente novamente quando terminar',
    disk: 'Não há espaço livre suficiente para a atualização',
    feed: 'O servidor de atualizações não respondeu como esperado; tente novamente mais tarde',
    install: 'Não foi possível instalar a atualização; tente novamente mais tarde',
    location: 'Mova a aplicação para a pasta Aplicações para receber atualizações',
    offline: 'Está offline; a aplicação volta a procurar quando estiver novamente online',
    verify: 'A transferência não passou na verificação da assinatura e foi descartada'
  },
  errorFallback: 'Não foi possível concluir a atualização; tente novamente mais tarde',
  buttonChecking: 'A verificar…',
  buttonUpdate: version => `Atualizar para ${version}`,
  buttonCancel: 'Cancelar',
  buttonRestart: 'Reiniciar para atualizar',
  buttonRestarting: 'A reiniciar…',
  buttonRetry: 'Tentar novamente',
  buttonCheck: 'Procurar atualizações',
  results: { failed: 'Não instalada', installed: 'Instalada', installing: 'A instalar' },
  runtime: version => `Agente incorporado ${version}`
}

const BY_LOCALE: Record<Locale, AppUpdateCopy> = { ar, en, ja, 'pt-PT': ptPt, zh, 'zh-hant': zhHant }
const HISTORY_ROWS = 20

interface AppUpdateWords {
  copy: AppUpdateCopy
  locale: Locale
}

export function appUpdateWords(locale: Locale): AppUpdateWords {
  return { copy: BY_LOCALE[locale] ?? en, locale }
}

export function useAppUpdateWords(): AppUpdateWords {
  return appUpdateWords(useI18n().locale)
}

const shown = (semver: string) => `v${displayVersion(semver)}`

// English keeps the day-month order and 24-hour clock the updater has always shown.
const dateTag = (locale: Locale) => (locale === 'en' ? 'en-GB' : locale)

function clock(ms: number, locale: Locale): string {
  return new Date(ms).toLocaleTimeString(dateTag(locale), { hour: '2-digit', minute: '2-digit' })
}

/** The status sentence under the app row, by phase. Empty when there is no state. */
export function appUpdateLine({ copy, locale }: AppUpdateWords, state: AppUpdateState | null): string {
  if (!state) {
    return ''
  }

  const version = shown(state.next ?? state.current)
  const checked = state.checkedAt ? ` · ${copy.checkedAt(clock(state.checkedAt, locale))}` : ''

  switch (state.phase) {
    case 'up-to-date':
      return `${copy.upToDate}${checked}`

    case 'checking':
      return copy.checking

    case 'available':
      return `${copy.available(version)}${checked}`

    case 'downloading':
      return `${copy.downloading(version, state.progress?.percent ?? 0)}${bytesLine(copy, state.progress)}`

    case 'downloaded':
      return state.error ? appUpdateError(copy, state.error.kind) : copy.downloaded(version)

    case 'installing':
      return copy.installing

    case 'error':
      return state.error ? appUpdateError(copy, state.error.kind) : copy.errorFallback

    case 'inactive':
      return copy.inactive

    default:
      return state.checkedAt ? copy.lastChecked(clock(state.checkedAt, locale)) : copy.idle
  }
}

const MB = { base: 1000, maxUnit: 'GB', minUnit: 'MB' } as const

function bytesLine(copy: AppUpdateCopy, progress: AppUpdateState['progress']): string {
  if (!progress || progress.total <= 0) {
    return ''
  }

  const done = formatBytes(progress.done, MB).replace(/\s*[KMG]B$/, '')

  return ` · ${copy.bytesOf(done, formatBytes(progress.total, MB))}`
}

function appUpdateError(copy: AppUpdateCopy, kind: AppUpdateErrorKind): string {
  return copy.errors[kind] ?? copy.errorFallback
}

/** The label of the one primary button, by phase (the action itself stays the store's appUpdatePrimary). */
export function appUpdateButton({ copy }: AppUpdateWords, state: AppUpdateState | null): string {
  switch (state?.phase) {
    case 'checking':
      return copy.buttonChecking

    case 'available':
      return copy.buttonUpdate(shown(state.next ?? state.current))

    case 'downloading':
      return copy.buttonCancel

    case 'downloaded':
      return copy.buttonRestart

    case 'installing':
      return copy.buttonRestarting

    case 'error':
      return copy.buttonRetry

    default:
      return copy.buttonCheck
  }
}

/** "v0.0.2 → v0.0.3 · 18 Oct 2026 14:05 · Installed" in the reader's language, newest first, at most 20. */
export function appUpdateHistoryRows(
  { copy, locale }: AppUpdateWords,
  entries: readonly AppUpdateLogEntry[]
): string[] {
  return [...entries]
    .reverse()
    .slice(0, HISTORY_ROWS)
    .map(entry => {
      const date = new Date(entry.at).toLocaleDateString(dateTag(locale), {
        day: 'numeric',
        month: 'short',
        year: 'numeric'
      })

      return `${shown(entry.from)} → ${shown(entry.to)} · ${date} ${clock(entry.at, locale)} · ${copy.results[entry.result]}`
    })
}
