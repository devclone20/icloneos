import type { DesktopUninstallMode } from '@/global'
import { type Locale, useI18n } from '@/i18n'

interface OptionCopy {
  title: string
  hint: string
  /** Completes "This removes …" in the confirm step, so people know exactly what disappears. */
  removes: string
}

// The uninstall rows' words in every locale (About › Remove iclone OS from this computer).
const en = {
  chooseTitle: 'Choose how much to remove from this computer',
  chooseHint: 'The app closes to finish the job; you can install it again at any time.',
  checking: 'Checking what is installed…',
  choose: 'Choose',
  confirmTitle: 'Remove it for good?',
  confirmHint: (removes: string) => `This removes ${removes}. It cannot be undone.`,
  remove: 'Yes, remove it',
  removing: 'Removing…',
  cancel: 'Cancel',
  startFailed: 'The removal could not start.',
  options: {
    gui: {
      title: 'Remove the app and keep the agent',
      hint: 'Your agent, its settings and your chats all stay.',
      removes: 'the app and its own data'
    },
    lite: {
      title: 'Remove the app and the agent, keep your data',
      hint: 'Settings, chats and secrets stay for a future install.',
      removes: 'the app and the agent (settings, chats and secrets are kept)'
    },
    full: {
      title: 'Remove the app, the agent and all your data',
      hint: 'The app, the agent and all your data: settings, chats, scheduled jobs, secrets and logs.',
      removes: 'everything: the app, the agent and all your settings, chats, secrets and logs'
    }
  } as Record<DesktopUninstallMode, OptionCopy>
}

type UninstallCopy = typeof en

const ar: UninstallCopy = {
  chooseTitle: 'اختر مقدار ما تريد إزالته من هذا الحاسوب',
  chooseHint: 'يُغلق التطبيق لإنهاء المهمة؛ ويمكنك تثبيته مجدداً في أي وقت.',
  checking: 'جارٍ التحقق مما هو مثبّت…',
  choose: 'اختر',
  confirmTitle: 'هل تريد إزالته نهائياً؟',
  confirmHint: removes => `سيؤدي هذا إلى إزالة ${removes}. لا يمكن التراجع عن ذلك.`,
  remove: 'نعم، أزله',
  removing: 'جارٍ الإزالة…',
  cancel: 'إلغاء',
  startFailed: 'تعذّر بدء الإزالة.',
  options: {
    gui: {
      title: 'أزل التطبيق واحتفظ بالوكيل',
      hint: 'يبقى وكيلك وإعداداته ومحادثاتك كما هي.',
      removes: 'التطبيق وبياناته الخاصة'
    },
    lite: {
      title: 'أزل التطبيق والوكيل واحتفظ ببياناتك',
      hint: 'تبقى الإعدادات والمحادثات والأسرار لتثبيت لاحق.',
      removes: 'التطبيق والوكيل (مع الاحتفاظ بالإعدادات والمحادثات والأسرار)'
    },
    full: {
      title: 'أزل التطبيق والوكيل وكل بياناتك',
      hint: 'التطبيق والوكيل وكل بياناتك: الإعدادات والمحادثات والمهام المجدولة والأسرار والسجلات.',
      removes: 'كل شيء: التطبيق والوكيل وكل إعداداتك ومحادثاتك وأسرارك وسجلاتك'
    }
  }
}

const ja: UninstallCopy = {
  chooseTitle: 'このコンピューターから何を削除するか選ぶ',
  chooseHint: '完了するためにアプリは終了します。いつでも再インストールできます。',
  checking: 'インストールされているものを確認しています…',
  choose: '選択',
  confirmTitle: '完全に削除しますか？',
  confirmHint: removes => `${removes}を削除します。元に戻すことはできません。`,
  remove: 'はい、削除します',
  removing: '削除しています…',
  cancel: 'キャンセル',
  startFailed: '削除を開始できませんでした。',
  options: {
    gui: {
      title: 'アプリを削除してエージェントは残す',
      hint: 'エージェント、その設定、チャットはすべて残ります。',
      removes: 'アプリとその専用データ'
    },
    lite: {
      title: 'アプリとエージェントを削除してデータは残す',
      hint: '設定、チャット、シークレットは次回のインストールのために残ります。',
      removes: 'アプリとエージェント（設定、チャット、シークレットは残ります）'
    },
    full: {
      title: 'アプリ、エージェント、すべてのデータを削除する',
      hint: 'アプリ、エージェント、そして設定・チャット・スケジュールされたジョブ・シークレット・ログを含むすべてのデータ。',
      removes: 'すべて：アプリ、エージェント、そして設定・チャット・シークレット・ログのすべて'
    }
  }
}

const zh: UninstallCopy = {
  chooseTitle: '选择要从这台电脑上移除多少内容',
  chooseHint: '应用会关闭以完成操作；你随时可以重新安装。',
  checking: '正在检查已安装的内容…',
  choose: '选择',
  confirmTitle: '要永久移除吗？',
  confirmHint: removes => `这将移除${removes}。此操作无法撤销。`,
  remove: '是的，移除',
  removing: '正在移除…',
  cancel: '取消',
  startFailed: '无法开始移除。',
  options: {
    gui: {
      title: '移除应用，保留智能体',
      hint: '你的智能体、它的设置和你的聊天都会保留。',
      removes: '应用及其自身的数据'
    },
    lite: {
      title: '移除应用和智能体，保留你的数据',
      hint: '设置、聊天和密钥会保留，供以后安装使用。',
      removes: '应用和智能体（保留设置、聊天和密钥）'
    },
    full: {
      title: '移除应用、智能体和你的所有数据',
      hint: '应用、智能体以及你的所有数据：设置、聊天、定时任务、密钥和日志。',
      removes: '所有内容：应用、智能体以及你的全部设置、聊天、密钥和日志'
    }
  }
}

const zhHant: UninstallCopy = {
  chooseTitle: '選擇要從這台電腦移除多少內容',
  chooseHint: '應用程式會關閉以完成操作；你隨時可以重新安裝。',
  checking: '正在檢查已安裝的內容…',
  choose: '選擇',
  confirmTitle: '要永久移除嗎？',
  confirmHint: removes => `這將移除${removes}。此操作無法復原。`,
  remove: '是的，移除',
  removing: '正在移除…',
  cancel: '取消',
  startFailed: '無法開始移除。',
  options: {
    gui: {
      title: '移除應用程式，保留智慧代理',
      hint: '你的智慧代理、它的設定和你的聊天都會保留。',
      removes: '應用程式及其自身的資料'
    },
    lite: {
      title: '移除應用程式和智慧代理，保留你的資料',
      hint: '設定、聊天和密鑰會保留，供日後安裝使用。',
      removes: '應用程式和智慧代理（保留設定、聊天和密鑰）'
    },
    full: {
      title: '移除應用程式、智慧代理和你的所有資料',
      hint: '應用程式、智慧代理以及你的所有資料：設定、聊天、排程工作、密鑰和記錄。',
      removes: '所有內容：應用程式、智慧代理以及你的全部設定、聊天、密鑰和記錄'
    }
  }
}

const ptPt: UninstallCopy = {
  chooseTitle: 'Escolha quanto quer remover deste computador',
  chooseHint: 'A aplicação fecha para concluir o processo; pode voltar a instalá-la a qualquer momento.',
  checking: 'A verificar o que está instalado…',
  choose: 'Escolher',
  confirmTitle: 'Remover definitivamente?',
  confirmHint: removes => `Isto remove ${removes}. Não pode ser anulado.`,
  remove: 'Sim, remover',
  removing: 'A remover…',
  cancel: 'Cancelar',
  startFailed: 'Não foi possível iniciar a remoção.',
  options: {
    gui: {
      title: 'Remover a aplicação e manter o agente',
      hint: 'O seu agente, as definições dele e as suas conversas ficam todos.',
      removes: 'a aplicação e os respetivos dados'
    },
    lite: {
      title: 'Remover a aplicação e o agente, manter os seus dados',
      hint: 'As definições, as conversas e os segredos ficam para uma instalação futura.',
      removes: 'a aplicação e o agente (as definições, as conversas e os segredos são mantidos)'
    },
    full: {
      title: 'Remover a aplicação, o agente e todos os seus dados',
      hint: 'A aplicação, o agente e todos os seus dados: definições, conversas, tarefas agendadas, segredos e registos.',
      removes: 'tudo: a aplicação, o agente e todas as suas definições, conversas, segredos e registos'
    }
  }
}

export const UNINSTALL_COPY: Record<Locale, UninstallCopy> = { ar, en, ja, 'pt-PT': ptPt, zh, 'zh-hant': zhHant }

export function useUninstallCopy(): UninstallCopy {
  return UNINSTALL_COPY[useI18n().locale] ?? en
}
