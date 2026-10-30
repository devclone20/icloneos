import { useI18n } from '@/i18n'
import { enCustomEndpoints } from '@/i18n/en'
import { getRuntimeI18nLocale } from '@/i18n/runtime'
import type { Locale } from '@/i18n/types'

// Settings › Providers › Model servers of your own: the pane's side words in all five locales.
// English is the catalogue in src/i18n/en; the other four mirror its shape key by key.
type CustomEndpointsCopy = typeof enCustomEndpoints

const PLACEHOLDER_EXAMPLES = {
  baseUrl: enCustomEndpoints.placeholders.baseUrl,
  model: enCustomEndpoints.placeholders.model,
  providerId: enCustomEndpoints.placeholders.providerId
}

const ja: CustomEndpointsCopy = {
  activationFailed: '切り替えられませんでした',
  active: '使用中',
  addEndpoint: 'サーバーを追加',
  apiKey: 'API キー',
  apiKeySet: 'API キー設定済み',
  context: 'コンテキスト',
  defaultModel: '既定のモデル',
  deleteEndpoint: 'このサーバーを削除',
  discoverModels: 'モデルを探す',
  editEndpoint: 'サーバーを編集',
  emptyDescription: '下で OpenAI 互換のサーバーを追加してください。',
  emptyTitle: '自分のモデルサーバーはまだありません',
  endpointUrl: 'サーバーのアドレス',
  heading: '自分のモデルサーバー',
  loadFailed: '自分のモデルサーバーを読み込めませんでした',
  name: '名前',
  newEndpoint: '新しいサーバー',
  placeholders: {
    ...PLACEHOLDER_EXAMPLES,
    context: '自動',
    keepKey: '空欄なら今のキーのまま',
    name: '社内プロキシ',
    optional: '任意'
  },
  providerId: 'サーバーの ID',
  reachable: (models: number) =>
    models ? `サーバーに接続できました。${models} 個のモデルが見つかりました。` : 'サーバーに接続できました。',
  save: '保存',
  saveFailed: '保存できませんでした',
  saved: 'サーバーを保存しました。',
  test: 'テスト',
  use: '使う',
  useForNewChats: '新しいチャットで使う',
  validationFailed: 'テストに失敗しました',
  validationFailedMessage: 'サーバーが応答しませんでした。'
}

const zh: CustomEndpointsCopy = {
  activationFailed: '无法切换',
  active: '使用中',
  addEndpoint: '添加服务器',
  apiKey: 'API 密钥',
  apiKeySet: '已设置 API 密钥',
  context: '上下文',
  defaultModel: '默认模型',
  deleteEndpoint: '删除此服务器',
  discoverModels: '查找模型',
  editEndpoint: '编辑服务器',
  emptyDescription: '在下方添加一个兼容 OpenAI 的服务器。',
  emptyTitle: '还没有你自己的模型服务器',
  endpointUrl: '服务器地址',
  heading: '你自己的模型服务器',
  loadFailed: '无法加载你自己的模型服务器',
  name: '名称',
  newEndpoint: '新服务器',
  placeholders: {
    ...PLACEHOLDER_EXAMPLES,
    context: '自动',
    keepKey: '留空则保留当前密钥',
    name: '公司代理',
    optional: '可选'
  },
  providerId: '服务器 ID',
  reachable: (models: number) => (models ? `服务器可以连接。找到 ${models} 个模型。` : '服务器可以连接。'),
  save: '保存',
  saveFailed: '无法保存',
  saved: '服务器已保存。',
  test: '测试',
  use: '使用',
  useForNewChats: '用于新对话',
  validationFailed: '测试失败',
  validationFailedMessage: '服务器没有响应。'
}

const zhHant: CustomEndpointsCopy = {
  activationFailed: '無法切換',
  active: '使用中',
  addEndpoint: '新增伺服器',
  apiKey: 'API 金鑰',
  apiKeySet: '已設定 API 金鑰',
  context: '上下文',
  defaultModel: '預設模型',
  deleteEndpoint: '刪除此伺服器',
  discoverModels: '尋找模型',
  editEndpoint: '編輯伺服器',
  emptyDescription: '在下方新增一個相容 OpenAI 的伺服器。',
  emptyTitle: '還沒有您自己的模型伺服器',
  endpointUrl: '伺服器位址',
  heading: '您自己的模型伺服器',
  loadFailed: '無法載入您自己的模型伺服器',
  name: '名稱',
  newEndpoint: '新伺服器',
  placeholders: {
    ...PLACEHOLDER_EXAMPLES,
    context: '自動',
    keepKey: '留空則保留目前的金鑰',
    name: '公司代理',
    optional: '選填'
  },
  providerId: '伺服器 ID',
  reachable: (models: number) => (models ? `伺服器可以連線。找到 ${models} 個模型。` : '伺服器可以連線。'),
  save: '儲存',
  saveFailed: '無法儲存',
  saved: '伺服器已儲存。',
  test: '測試',
  use: '使用',
  useForNewChats: '用於新對話',
  validationFailed: '測試失敗',
  validationFailedMessage: '伺服器沒有回應。'
}

const ar: CustomEndpointsCopy = {
  activationFailed: 'تعذّر التبديل',
  active: 'قيد الاستخدام',
  addEndpoint: 'إضافة خادم',
  apiKey: 'مفتاح API',
  apiKeySet: 'تم تعيين مفتاح API',
  context: 'السياق',
  defaultModel: 'النموذج الافتراضي',
  deleteEndpoint: 'حذف هذا الخادم',
  discoverModels: 'البحث عن النماذج',
  editEndpoint: 'تعديل الخادم',
  emptyDescription: 'أضف أدناه خادمًا متوافقًا مع OpenAI.',
  emptyTitle: 'لا توجد خوادم نماذج خاصة بك بعد',
  endpointUrl: 'عنوان الخادم',
  heading: 'خوادم النماذج الخاصة بك',
  loadFailed: 'تعذّر تحميل خوادم النماذج الخاصة بك',
  name: 'الاسم',
  newEndpoint: 'خادم جديد',
  placeholders: {
    ...PLACEHOLDER_EXAMPLES,
    context: 'تلقائي',
    keepKey: 'اتركه فارغًا للإبقاء على المفتاح الحالي',
    name: 'وكيل الشركة',
    optional: 'اختياري'
  },
  providerId: 'معرّف الخادم',
  reachable: (models: number) =>
    models ? `يمكن الوصول إلى الخادم. تم العثور على ${models} من النماذج.` : 'يمكن الوصول إلى الخادم.',
  save: 'حفظ',
  saveFailed: 'تعذّر الحفظ',
  saved: 'تم حفظ الخادم.',
  test: 'اختبار',
  use: 'استخدام',
  useForNewChats: 'استخدامه للمحادثات الجديدة',
  validationFailed: 'فشل الاختبار',
  validationFailedMessage: 'لم يستجب الخادم.'
}

const ptPt: CustomEndpointsCopy = {
  activationFailed: 'Não foi possível ativar',
  active: 'Ativo',
  addEndpoint: 'Adicionar endpoint',
  apiKey: 'Chave de API',
  apiKeySet: 'Chave de API definida',
  context: 'Contexto',
  defaultModel: 'Modelo predefinido',
  deleteEndpoint: 'Eliminar endpoint',
  discoverModels: 'Descobrir modelos',
  editEndpoint: 'Editar endpoint',
  emptyDescription: 'Adicione abaixo um endpoint compatível com OpenAI.',
  emptyTitle: 'Sem endpoints personalizados',
  endpointUrl: 'URL do endpoint',
  heading: 'Endpoints personalizados',
  loadFailed: 'Não foi possível carregar os endpoints personalizados',
  name: 'Nome',
  newEndpoint: 'Novo endpoint',
  placeholders: {
    ...PLACEHOLDER_EXAMPLES,
    context: 'Automático',
    keepKey: 'Deixe vazio para manter a chave atual',
    name: 'Proxy da empresa',
    optional: 'Opcional'
  },
  providerId: 'ID do fornecedor',
  reachable: (models: number) =>
    models ? `O endpoint está acessível. Foram encontrados ${models} modelos.` : 'O endpoint está acessível.',
  save: 'Guardar',
  saveFailed: 'Não foi possível guardar',
  saved: 'Endpoint personalizado guardado.',
  test: 'Testar',
  use: 'Usar',
  useForNewChats: 'Usar em novas conversas',
  validationFailed: 'A validação falhou',
  validationFailedMessage: 'A validação do endpoint falhou.'
}

const COPY: Record<Locale, CustomEndpointsCopy> = {
  ar,
  en: enCustomEndpoints,
  ja,
  'pt-PT': ptPt,
  zh,
  'zh-hant': zhHant
}

export function useCustomEndpointsCopy(): CustomEndpointsCopy {
  const { locale } = useI18n()

  return COPY[locale] ?? enCustomEndpoints
}

/** For a callback that outlives the render it was made in (a load started on mount): the locale now. */
export const customEndpointsCopyNow = (): CustomEndpointsCopy => COPY[getRuntimeI18nLocale()] ?? enCustomEndpoints
