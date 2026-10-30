import type { AgentUpdateCopy } from '@/i18n/en'
import type { Locale } from '@/i18n/types'

/**
 * The agent-update sentences that named the runtime's publisher, rewritten without it (ruling S27.1): the person sees
 * "the agent" and "the update server", never the upstream's name. The rest of the agent-update catalogue is unchanged.
 */
type AgentUpdateWords = Pick<
  AgentUpdateCopy,
  | 'aboutFlagged'
  | 'aboutNewer'
  | 'aboutVerified'
  | 'confirmFetch'
  | 'latest'
  | 'offline'
  | 'searchDescription'
  | 'unavailable'
> & { aboutTitle: string; originMismatch: string }

const WORDS: Record<Locale, AgentUpdateWords> = {
  en: {
    aboutFlagged: version =>
      `Version ${version}, verified with this release and flagged since. Check for a newer agent.`,
    aboutNewer: version => `Version ${version}, newer than the version verified with this release.`,
    aboutTitle: 'The agent this app runs',
    aboutVerified: version => `Version ${version}, verified with this release.`,
    confirmFetch: 'The agent is downloaded from its publisher. This usually takes a few minutes.',
    latest: 'Latest release',
    offline: 'Could not reach the update server. Check the connection and try again.',
    originMismatch:
      'This agent does not come from its official source, so the checked version cannot be installed. Nothing was changed.',
    searchDescription: 'Check for the newest agent and update it, only when you click.',
    unavailable: 'The update server did not return a version. Try again later.'
  },
  ja: {
    aboutFlagged: version =>
      `バージョン ${version}。このリリースで確認済みですが、その後要注意となりました。新しいエージェントを確認してください。`,
    aboutNewer: version => `バージョン ${version}。このリリースで確認済みのバージョンより新しいものです。`,
    aboutTitle: 'このアプリが動かしているエージェント',
    aboutVerified: version => `バージョン ${version}。このリリースで確認済みです。`,
    confirmFetch: 'エージェントを配布元からダウンロードします。通常は数分かかります。',
    latest: '最新リリース',
    offline: '更新サーバーに接続できませんでした。接続を確認して、もう一度お試しください。',
    originMismatch:
      'このエージェントは公式の配布元から取得されていないため、確認したバージョンをインストールできません。何も変更されていません。',
    searchDescription: '最新のエージェントを確認し、クリックしたときだけ更新します。',
    unavailable: '更新サーバーからバージョンが返りませんでした。後でもう一度お試しください。'
  },
  'pt-PT': {
    aboutFlagged: version =>
      `Versão ${version}, verificada com esta versão da aplicação e entretanto sinalizada. Procure um agente mais recente.`,
    aboutNewer: version => `Versão ${version}, mais recente do que a versão verificada com esta versão da aplicação.`,
    aboutTitle: 'O agente que esta aplicação executa',
    aboutVerified: version => `Versão ${version}, verificada com esta versão da aplicação.`,
    confirmFetch: 'O agente é transferido a partir do seu editor. Normalmente demora alguns minutos.',
    latest: 'Versão mais recente',
    offline: 'Não foi possível contactar o servidor de atualizações. Verifique a ligação e tente novamente.',
    originMismatch:
      'Este agente não vem da sua origem oficial, por isso a versão verificada não pode ser instalada. Nada foi alterado.',
    searchDescription: 'Procurar o agente mais recente e atualizá-lo, apenas quando clicar.',
    unavailable: 'O servidor de atualizações não devolveu nenhuma versão. Tente novamente mais tarde.'
  },
  zh: {
    aboutFlagged: version => `版本 ${version}，已随此版本发布验证，随后被标记。请检查是否有更新的智能体。`,
    aboutNewer: version => `版本 ${version}，比此版本发布时验证过的版本更新。`,
    aboutTitle: '此应用运行的智能体',
    aboutVerified: version => `版本 ${version}，已随此版本发布验证。`,
    confirmFetch: '智能体将从发布方下载更新，通常需要几分钟。',
    latest: '最新发布',
    offline: '无法连接更新服务器。请检查网络连接后重试。',
    originMismatch: '此智能体并非来自官方来源，因此无法安装已检查的版本。未做任何更改。',
    searchDescription: '检查最新的智能体并更新，仅在你点击时进行。',
    unavailable: '更新服务器未返回版本。请稍后重试。'
  },
  'zh-hant': {
    aboutFlagged: version => `版本 ${version}，已隨此版本發布驗證，隨後被標記。請檢查是否有更新的智慧代理。`,
    aboutNewer: version => `版本 ${version}，比此版本發布時驗證過的版本更新。`,
    aboutTitle: '此應用程式執行的智慧代理',
    aboutVerified: version => `版本 ${version}，已隨此版本發布驗證。`,
    confirmFetch: '智慧代理將從發布方下載更新，通常需要幾分鐘。',
    latest: '最新發布',
    offline: '無法連線至更新伺服器。請檢查網路連線後重試。',
    originMismatch: '此智慧代理並非來自官方來源，因此無法安裝已檢查的版本。未做任何變更。',
    searchDescription: '檢查最新的智慧代理並更新，僅在你點擊時進行。',
    unavailable: '更新伺服器未傳回版本。請稍後重試。'
  },
  ar: {
    aboutFlagged: version =>
      `الإصدار ${version}، جرى التحقق منه مع هذا الإصدار من التطبيق ثم جرى التنبيه عليه. تحقّق من وجود وكيل أحدث.`,
    aboutNewer: version => `الإصدار ${version}، أحدث من الإصدار الذي جرى التحقق منه مع هذا الإصدار من التطبيق.`,
    aboutTitle: 'الوكيل الذي يشغّله هذا التطبيق',
    aboutVerified: version => `الإصدار ${version}، جرى التحقق منه مع هذا الإصدار من التطبيق.`,
    confirmFetch: 'يُنزَّل الوكيل من جهة نشره. يستغرق ذلك عادةً بضع دقائق.',
    latest: 'أحدث إصدار',
    offline: 'تعذّر الوصول إلى خادم التحديثات. تحقّق من الاتصال وحاول مرة أخرى.',
    originMismatch: 'هذا الوكيل لا يأتي من مصدره الرسمي، لذا لا يمكن تثبيت الإصدار الذي تم فحصه. لم يتغيّر شيء.',
    searchDescription: 'التحقق من أحدث وكيل وتحديثه، فقط عند النقر.',
    unavailable: 'لم يُرجع خادم التحديثات أي إصدار. حاول لاحقًا.'
  }
}

/** The agent-update catalogue of a locale with the publisher-free sentences laid over it. */
export function withAgentUpdateWords(copy: AgentUpdateCopy, locale: Locale): AgentUpdateCopy & { aboutTitle: string } {
  const { originMismatch, ...words } = WORDS[locale] ?? WORDS.en

  return { ...copy, ...words, applyErrors: { ...copy.applyErrors, 'origin-mismatch': originMismatch } }
}
