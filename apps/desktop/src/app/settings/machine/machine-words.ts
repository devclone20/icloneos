import { useI18n } from '@/i18n'
import type { Locale } from '@/i18n/types'
import type { CredentialAuditEntry } from '@/lib/credential-audit'

/**
 * Small five-locale words of the Machine panes that the backend or a preset would otherwise print in English (S27.1):
 * the default profile's name, the built-in theme names, and the About › key-change log.
 */
interface MachineWords {
  audit: {
    empty: string
    heading: string
    hint: string
    kinds: Record<CredentialAuditEntry['kind'], string>
    results: Record<CredentialAuditEntry['result'], string>
  }
  /** The default profile, as a person names it ("default" is its key, not its name). */
  defaultProfile: string
  /** The local connection's name; the backend's label is never printed. */
  thisDevice: string
  /** Built-in theme names by theme id; a user theme keeps its own name. */
  themes: Record<string, string>
}

export const MACHINE_WORDS: Record<Locale, MachineWords> = {
  en: {
    audit: {
      empty: 'No changes to your keys or sign-ins yet.',
      heading: 'Recent changes to your keys and sign-ins',
      hint: 'Only names are kept — never the values.',
      kinds: {
        api_key: 'API key',
        bot_token: 'Bot token',
        custom_endpoint: 'Custom endpoint',
        external: 'External account',
        gateway_session: 'Connection sign-in',
        memory_secret: 'Memory secret',
        oauth: 'Account'
      },
      results: {
        already_removed: 'Already removed',
        failed: 'Failed',
        removed: 'Removed',
        signed_out: 'Signed out',
        terminal_started: 'Command started'
      }
    },
    defaultProfile: 'Default profile',
    thisDevice: 'This device',
    themes: { 'iclone-dark': 'iclone dark', 'iclone-light': 'iclone light', 'iclone-natural': 'iclone natural' }
  },
  ja: {
    audit: {
      empty: 'キーやサインインの変更はまだありません。',
      heading: 'キーとサインインの最近の変更',
      hint: '記録されるのは名前だけで、値は残りません。',
      kinds: {
        api_key: 'API キー',
        bot_token: 'ボットのトークン',
        custom_endpoint: 'カスタムエンドポイント',
        external: '外部アカウント',
        gateway_session: '接続のサインイン',
        memory_secret: 'メモリーのシークレット',
        oauth: 'アカウント'
      },
      results: {
        already_removed: '削除済み',
        failed: '失敗',
        removed: '削除しました',
        signed_out: 'サインアウトしました',
        terminal_started: 'コマンドを開始しました'
      }
    },
    defaultProfile: '既定のプロファイル',
    thisDevice: 'このデバイス',
    themes: { 'iclone-dark': 'iclone ダーク', 'iclone-light': 'iclone ライト', 'iclone-natural': 'iclone ナチュラル' }
  },
  zh: {
    audit: {
      empty: '你的密钥和登录还没有任何变更。',
      heading: '密钥和登录的最近变更',
      hint: '只记录名称，从不记录值。',
      kinds: {
        api_key: 'API 密钥',
        bot_token: '机器人令牌',
        custom_endpoint: '自定义端点',
        external: '外部账号',
        gateway_session: '连接登录',
        memory_secret: '记忆密钥',
        oauth: '账号'
      },
      results: {
        already_removed: '已移除',
        failed: '失败',
        removed: '已移除',
        signed_out: '已退出登录',
        terminal_started: '命令已开始'
      }
    },
    defaultProfile: '默认配置文件',
    thisDevice: '此设备',
    themes: { 'iclone-dark': 'iclone 深色', 'iclone-light': 'iclone 浅色', 'iclone-natural': 'iclone 自然' }
  },
  'zh-hant': {
    audit: {
      empty: '你的金鑰和登入還沒有任何變更。',
      heading: '金鑰和登入的最近變更',
      hint: '只記錄名稱，從不記錄值。',
      kinds: {
        api_key: 'API 金鑰',
        bot_token: '機器人權杖',
        custom_endpoint: '自訂端點',
        external: '外部帳號',
        gateway_session: '連線登入',
        memory_secret: '記憶金鑰',
        oauth: '帳號'
      },
      results: {
        already_removed: '已移除',
        failed: '失敗',
        removed: '已移除',
        signed_out: '已登出',
        terminal_started: '指令已開始'
      }
    },
    defaultProfile: '預設設定檔',
    thisDevice: '此裝置',
    themes: { 'iclone-dark': 'iclone 深色', 'iclone-light': 'iclone 淺色', 'iclone-natural': 'iclone 自然' }
  },
  ar: {
    audit: {
      empty: 'لا توجد تغييرات على مفاتيحك أو تسجيلات دخولك بعد.',
      heading: 'التغييرات الأخيرة على مفاتيحك وتسجيلات دخولك',
      hint: 'تُحفظ الأسماء فقط — ولا تُحفظ القيم أبدًا.',
      kinds: {
        api_key: 'مفتاح API',
        bot_token: 'رمز البوت',
        custom_endpoint: 'نقطة نهاية مخصصة',
        external: 'حساب خارجي',
        gateway_session: 'تسجيل دخول الاتصال',
        memory_secret: 'سرّ الذاكرة',
        oauth: 'حساب'
      },
      results: {
        already_removed: 'أُزيل من قبل',
        failed: 'فشل',
        removed: 'أُزيل',
        signed_out: 'تم تسجيل الخروج',
        terminal_started: 'بدأ الأمر'
      }
    },
    defaultProfile: 'الملف الشخصي الافتراضي',
    thisDevice: 'هذا الجهاز',
    themes: { 'iclone-dark': 'iclone داكن', 'iclone-light': 'iclone فاتح', 'iclone-natural': 'iclone طبيعي' }
  },
  'pt-PT': {
    audit: {
      empty: 'Ainda não há alterações às suas chaves ou inícios de sessão.',
      heading: 'Alterações recentes às suas chaves e inícios de sessão',
      hint: 'Só são guardados os nomes — nunca os valores.',
      kinds: {
        api_key: 'Chave de API',
        bot_token: 'Token do bot',
        custom_endpoint: 'Endpoint personalizado',
        external: 'Conta externa',
        gateway_session: 'Início de sessão da ligação',
        memory_secret: 'Segredo da memória',
        oauth: 'Conta'
      },
      results: {
        already_removed: 'Já removido',
        failed: 'Falhou',
        removed: 'Removido',
        signed_out: 'Sessão terminada',
        terminal_started: 'Comando iniciado'
      }
    },
    defaultProfile: 'Perfil predefinido',
    thisDevice: 'Este dispositivo',
    themes: { 'iclone-dark': 'iclone escuro', 'iclone-light': 'iclone claro', 'iclone-natural': 'iclone natural' }
  }
}

export function useMachineWords(): MachineWords {
  const { locale } = useI18n()

  return MACHINE_WORDS[locale] ?? MACHINE_WORDS.en
}
