/**
 * V3-J J4-4 — the LABELS of the two owner sheets main builds for the `$` door (signing a mandate, widening a setting
 * or clearing the hard stop), in the window's language. Only labels live here: every VALUE (agent, amount, currency,
 * payee, date, network id, list entry, mandate id) is passed in already escaped by `sheetText` and printed verbatim,
 * exactly as before (fix JM3). The door's `once` and the audit are bound to the canonical request, never to these
 * words (main's `sheet-request.ts`). Main reads them here, where it can (like the Ignore confirm's
 * `permission-ignore-copy.ts`); the six locales match the app catalogues and ride the parity registry.
 *
 * No label may hold a line break, a control or a bidi / invisible mark: the sheet's own line breaks are the only ones
 * it shows (the parity test and the J4-4 label test in `payments-pane.test.tsx` check every label).
 */

export const SHEET_LOCALES = ['en', 'zh', 'zh-hant', 'ja', 'ar', 'pt-PT'] as const
type SheetLocale = (typeof SHEET_LOCALES)[number]

/** The settings axes a widening sheet can name (`limits.ts` AXES). */
type SheetAxis =
  | 'mainnetEnabled'
  | 'mandateStorage'
  | 'network'
  | 'origins'
  | 'payees'
  | 'perAgentDayMicros'
  | 'perDayMicros'
  | 'perTxMicros'
  | 'signer'
  | 'stop'
  | 'v1Servers'

export interface PaymentsSheetCopy {
  mandate: {
    signFor: (agent: string) => string
    budget: (budget: string) => string
    range: (min: string, max: string) => string
    payees: (count: number) => string
    window: (from: string, to: string) => string
    expires: (at: string) => string
    caps: (perTx: string, perDay: string, perAgentDay: string) => string
    network: (label: string, id: string) => string
    revoke: string
  }
  settings: {
    /** Each axis' name on the sheet (an axis not listed: its id, escaped). English names the ids, as before. */
    axes: Record<SheetAxis, string>
    change: (axis: string, from: string, to: string) => string
    listChange: (axis: string, from: number, to: number) => string
  }
  /** The `why` line of each owner sheet. */
  reasons: {
    mandate: (agent: string) => string
    settings: string
    stop: string
  }
}

const COPY: Readonly<Record<SheetLocale, PaymentsSheetCopy>> = {
  en: {
    mandate: {
      signFor: agent => `sign an open payment mandate for agent ${agent}`,
      budget: budget => `budget ${budget} USDC in total`,
      range: (min, max) => `each payment between ${min} and ${max} USDC`,
      payees: count => `only to these ${count} payee${count === 1 ? '' : 's'}:`,
      window: (from, to) => `payments allowed from ${from} to ${to}`,
      expires: at => `the mandate expires ${at}`,
      caps: (perTx, perDay, perAgentDay) =>
        `your caps still apply: ${perTx} USDC per payment, ${perDay} USDC per day, ${perAgentDay} USDC per agent per day`,
      network: (label, id) => `network ${label} (${id})`,
      revoke: 'revoking it later is immediate (Settings › Economy › Payments)'
    },
    settings: {
      // English has always named each axis by its setting id on this sheet; kept byte for byte.
      axes: {
        signer: 'signer',
        network: 'network',
        mainnetEnabled: 'mainnetEnabled',
        perTxMicros: 'perTxMicros',
        perDayMicros: 'perDayMicros',
        perAgentDayMicros: 'perAgentDayMicros',
        payees: 'payees',
        origins: 'origins',
        mandateStorage: 'mandateStorage',
        v1Servers: 'v1Servers',
        stop: 'stop'
      },
      change: (axis, from, to) => `${axis}: ${from} → ${to}`,
      listChange: (axis, from, to) => `${axis}: ${from} → ${to} ${to === 1 ? 'entry' : 'entries'}`
    },
    reasons: {
      mandate: agent => `Sign a payment mandate for ${agent} (Settings › Economy › Payments)`,
      settings: 'Widen what agents may spend (Settings › Economy › Payments)',
      stop: 'Clear the hard stop'
    }
  },
  zh: {
    mandate: {
      signFor: agent => `为智能体 ${agent} 签署开放支付授权书`,
      budget: budget => `总预算 ${budget} USDC`,
      range: (min, max) => `每笔支付介于 ${min} 和 ${max} USDC 之间`,
      payees: count => `仅限以下 ${count} 个收款方：`,
      window: (from, to) => `允许支付的时间：${from} 至 ${to}`,
      expires: at => `授权书到期时间：${at}`,
      caps: (perTx, perDay, perAgentDay) =>
        `你的上限仍然有效：每笔 ${perTx} USDC，每天 ${perDay} USDC，每个智能体每天 ${perAgentDay} USDC`,
      network: (label, id) => `网络 ${label}（${id}）`,
      revoke: '之后撤销会立即生效（设置 › 经济 › 支付）'
    },
    settings: {
      axes: {
        signer: '签名方',
        network: '网络',
        mainnetEnabled: '主网',
        perTxMicros: '每笔支付上限',
        perDayMicros: '每天上限',
        perAgentDayMicros: '每个智能体每天上限',
        payees: '收款方',
        origins: '网站',
        mandateStorage: '授权书存储',
        v1Servers: 'x402 v1 服务器',
        stop: '紧急停止'
      },
      change: (axis, from, to) => `${axis}：${from} → ${to}`,
      listChange: (axis, from, to) => `${axis}：${from} → ${to} 项`
    },
    reasons: {
      mandate: agent => `为 ${agent} 签署支付授权书（设置 › 经济 › 支付）`,
      settings: '放宽智能体可支出的范围（设置 › 经济 › 支付）',
      stop: '解除紧急停止'
    }
  },
  'zh-hant': {
    mandate: {
      signFor: agent => `為智慧代理 ${agent} 簽署開放付款授權書`,
      budget: budget => `總預算 ${budget} USDC`,
      range: (min, max) => `每筆付款介於 ${min} 和 ${max} USDC 之間`,
      payees: count => `僅限以下 ${count} 個收款方：`,
      window: (from, to) => `允許付款的時間：${from} 至 ${to}`,
      expires: at => `授權書到期時間：${at}`,
      caps: (perTx, perDay, perAgentDay) =>
        `你的上限仍然有效：每筆 ${perTx} USDC，每天 ${perDay} USDC，每個智慧代理每天 ${perAgentDay} USDC`,
      network: (label, id) => `網路 ${label}（${id}）`,
      revoke: '之後撤銷會立即生效（設定 › 經濟 › 付款）'
    },
    settings: {
      axes: {
        signer: '簽署方',
        network: '網路',
        mainnetEnabled: '主網',
        perTxMicros: '每筆付款上限',
        perDayMicros: '每天上限',
        perAgentDayMicros: '每個智慧代理每天上限',
        payees: '收款方',
        origins: '網站',
        mandateStorage: '授權書儲存',
        v1Servers: 'x402 v1 伺服器',
        stop: '緊急停止'
      },
      change: (axis, from, to) => `${axis}：${from} → ${to}`,
      listChange: (axis, from, to) => `${axis}：${from} → ${to} 項`
    },
    reasons: {
      mandate: agent => `為 ${agent} 簽署付款授權書（設定 › 經濟 › 付款）`,
      settings: '放寬智慧代理可支出的範圍（設定 › 經濟 › 付款）',
      stop: '解除緊急停止'
    }
  },
  ja: {
    mandate: {
      signFor: agent => `エージェント ${agent} のオープン支払いマンデートに署名`,
      budget: budget => `予算は合計 ${budget} USDC`,
      range: (min, max) => `1 回の支払いは ${min}〜${max} USDC`,
      payees: count => `次の ${count} 件の支払先のみ:`,
      window: (from, to) => `支払いを許可する期間: ${from} 〜 ${to}`,
      expires: at => `マンデートの有効期限: ${at}`,
      caps: (perTx, perDay, perAgentDay) =>
        `上限は引き続き適用されます: 1 回 ${perTx} USDC、1 日 ${perDay} USDC、エージェントごとに 1 日 ${perAgentDay} USDC`,
      network: (label, id) => `ネットワーク ${label} (${id})`,
      revoke: 'あとで取り消すと即座に反映されます (設定 › エコノミー › 支払い)'
    },
    settings: {
      axes: {
        signer: '署名者',
        network: 'ネットワーク',
        mainnetEnabled: 'メインネット',
        perTxMicros: '1 回の支払いの上限',
        perDayMicros: '1 日の上限',
        perAgentDayMicros: 'エージェントごとの 1 日の上限',
        payees: '支払先',
        origins: 'サイト',
        mandateStorage: 'マンデートの保存先',
        v1Servers: 'x402 v1 サーバー',
        stop: '緊急停止'
      },
      change: (axis, from, to) => `${axis}: ${from} → ${to}`,
      listChange: (axis, from, to) => `${axis}: ${from} → ${to} 件`
    },
    reasons: {
      mandate: agent => `${agent} の支払いマンデートに署名 (設定 › エコノミー › 支払い)`,
      settings: 'エージェントが支出できる範囲を広げる (設定 › エコノミー › 支払い)',
      stop: '緊急停止を解除'
    }
  },
  ar: {
    mandate: {
      signFor: agent => `توقيع تفويض دفع مفتوح للوكيل ${agent}`,
      budget: budget => `الميزانية ${budget} USDC إجمالًا`,
      range: (min, max) => `كل دفعة بين ${min} و${max} USDC`,
      payees: count => `فقط إلى هؤلاء المستفيدين (${count}):`,
      window: (from, to) => `الدفعات مسموحة من ${from} إلى ${to}`,
      expires: at => `ينتهي التفويض في ${at}`,
      caps: (perTx, perDay, perAgentDay) =>
        `حدودك ما زالت سارية: ${perTx} USDC لكل دفعة، ${perDay} USDC في اليوم، ${perAgentDay} USDC لكل وكيل في اليوم`,
      network: (label, id) => `الشبكة ${label} (${id})`,
      revoke: 'إلغاؤه لاحقًا فوري (الإعدادات › الاقتصاد › المدفوعات)'
    },
    settings: {
      axes: {
        signer: 'الموقِّع',
        network: 'الشبكة',
        mainnetEnabled: 'الشبكة الرئيسية',
        perTxMicros: 'الحد لكل دفعة',
        perDayMicros: 'الحد في اليوم',
        perAgentDayMicros: 'الحد لكل وكيل في اليوم',
        payees: 'المستفيدون',
        origins: 'المواقع',
        mandateStorage: 'حفظ التفويضات',
        v1Servers: 'خوادم x402 v1',
        stop: 'الإيقاف الكامل'
      },
      // Read right to left (the sheet inherits dir=rtl): the arrow points from the old value to the new one, as in
      // V3-T3's `functions.change` (with `→` the bidi algorithm shows "2 → 1" for a widening from 1 to 2).
      change: (axis, from, to) => `${axis}: ${from} ← ${to}`,
      listChange: (axis, from, to) => `${axis}: ${from} ← ${to} ${to === 1 ? 'إدخال' : 'إدخالات'}`
    },
    reasons: {
      mandate: agent => `توقيع تفويض دفع للوكيل ${agent} (الإعدادات › الاقتصاد › المدفوعات)`,
      settings: 'توسيع ما يمكن للوكلاء إنفاقه (الإعدادات › الاقتصاد › المدفوعات)',
      stop: 'رفع الإيقاف الكامل'
    }
  },
  'pt-PT': {
    mandate: {
      signFor: agent => `assinar um mandato de pagamento aberto para o agente ${agent}`,
      budget: budget => `orçamento de ${budget} USDC no total`,
      range: (min, max) => `cada pagamento entre ${min} e ${max} USDC`,
      payees: count => `apenas para ${count === 1 ? 'este destinatário' : `estes ${count} destinatários`}:`,
      window: (from, to) => `pagamentos permitidos de ${from} a ${to}`,
      expires: at => `o mandato expira a ${at}`,
      caps: (perTx, perDay, perAgentDay) =>
        `os seus limites continuam a aplicar-se: ${perTx} USDC por pagamento, ${perDay} USDC por dia, ${perAgentDay} USDC por agente por dia`,
      network: (label, id) => `rede ${label} (${id})`,
      revoke: 'revogá-lo mais tarde tem efeito imediato (Definições › Economia › Pagamentos)'
    },
    settings: {
      axes: {
        signer: 'Signatário',
        network: 'Rede',
        mainnetEnabled: 'Mainnet',
        perTxMicros: 'Limite por pagamento',
        perDayMicros: 'Limite por dia',
        perAgentDayMicros: 'Limite por agente, por dia',
        payees: 'Destinatários',
        origins: 'Sites de origem',
        mandateStorage: 'Armazenamento dos mandatos',
        v1Servers: 'Servidores x402 v1',
        stop: 'Paragem total'
      },
      change: (axis, from, to) => `${axis}: ${from} → ${to}`,
      listChange: (axis, from, to) => `${axis}: ${from} → ${to} ${to === 1 ? 'entrada' : 'entradas'}`
    },
    reasons: {
      mandate: agent => `Assinar um mandato de pagamento para ${agent} (Definições › Economia › Pagamentos)`,
      settings: 'Alargar o que os agentes podem gastar (Definições › Economia › Pagamentos)',
      stop: 'Levantar a paragem total'
    }
  }
}

/** One of the six locales, from whatever the window sent (its `<html lang>`); anything else is English. */
function sheetLocale(value: unknown): SheetLocale {
  return (SHEET_LOCALES as readonly unknown[]).includes(value) ? (value as SheetLocale) : 'en'
}

/** The sheet labels for `locale` (anything unknown: English). */
export function paymentsSheetCopy(locale: unknown): PaymentsSheetCopy {
  return COPY[sheetLocale(locale)]
}
