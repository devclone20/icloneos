import type { KeysCopy } from './keys-copy'

// Settings › Keys and Providers › API keys in Arabic; the shape and the rules live in keys-copy.tsx.
export const keysCopyAr: KeysCopy = {
  kinds: {
    anotherKey: ['استخدم مفتاحًا آخر لهذا المزوّد', 'مطلوب فقط إذا لم يكن المفتاح الأول هو الذي تستخدمه.'],
    cloudProfile: ['اختر ملف السحابة الذي يسجّل دخولك', ''],
    credentialsFile: ['حدّد ملف بيانات الاعتماد الخاص بك', ''],
    other: ['غيّر إعدادًا إضافيًا لهذا المزوّد', ''],
    region: ['اختر المنطقة التي تُعالَج فيها طلباتك', ''],
    serverAddress: ['استخدم عنوان خادم مختلفًا', 'اتركه فارغًا لاستخدام العنوان المعتاد للمزوّد.']
  },
  lessFields: 'إعدادات أقل',
  pasteKey: 'الصق مفتاحك هنا',
  apiKeyProviders: {
    anthropic: [
      'استخدم مفتاح Anthropic الخاص بك',
      'الصق مفتاحًا من Anthropic Console، دون الحاجة إلى تسجيل الدخول عبر المتصفح.'
    ]
  },
  providers: {
    'AWS Bedrock': 'نماذج في سحابة Amazon تُحتسب على حسابك في AWS.',
    'Actual Computer': 'نماذج تقدّمها Actual Computer.',
    'Alibaba Cloud (Coding Plan)': 'نماذج Qwen للبرمجة ضمن خطة البرمجة من Alibaba Cloud.',
    Anthropic: 'نماذج Claude مباشرةً من Anthropic.',
    'Arcee AI': 'نماذج صغيرة وفعّالة من Arcee AI.',
    'Azure Foundry': 'نماذج منشورة في حسابك على Microsoft Azure.',
    CommandCode: 'نماذج برمجة تقدّمها CommandCode.',
    'DashScope (Qwen)': 'نماذج Qwen من Alibaba Cloud.',
    DeepInfra: 'نماذج مفتوحة بأسعار منخفضة على DeepInfra.',
    DeepSeek: 'نماذج الدردشة والاستدلال من DeepSeek.',
    'Fireworks AI': 'نماذج مفتوحة سريعة تقدّمها Fireworks AI.',
    'GLM / Z.AI': 'نماذج GLM من Z.AI.',
    'GMI Cloud': 'نماذج مفتوحة على وحدات GPU من GMI Cloud.',
    Gemini: 'نماذج Gemini بمفتاح من Google AI Studio.',
    'GitHub Copilot': 'نماذج مضمّنة في خطة GitHub Copilot الخاصة بك.',
    'Google AI Studio': 'نماذج Gemini بمفتاح من Google AI Studio.',
    'Google Vertex AI': 'نماذج Gemini ونماذج الشركاء في مشروعك على Google Cloud.',
    'Hugging Face': 'نماذج مفتوحة عبر Hugging Face.',
    HuggingFace: 'نماذج مفتوحة عبر Hugging Face.',
    'Kilo Code': 'نماذج عبر حسابك في Kilo Code.',
    'Kimi (China)': 'نماذج Kimi المقدّمة في البر الرئيسي الصيني.',
    'Kimi / Kimi Coding Plan': 'نماذج Kimi من Moonshot AI، بما فيها خطة البرمجة.',
    'Kimi / Moonshot': 'نماذج Kimi من Moonshot AI.',
    'Kimi / Moonshot (China)': 'نماذج Kimi المقدّمة في البر الرئيسي الصيني.',
    'LM Studio': 'نماذج تعمل على حاسوبك باستخدام LM Studio.',
    'Meta Model API': 'نماذج Llama مباشرةً من Meta.',
    MiniMax: 'نماذج MiniMax ذات السياق الطويل.',
    'MiniMax (China)': 'نماذج MiniMax المقدّمة في البر الرئيسي الصيني.',
    'NVIDIA NIM': 'نماذج تستضيفها NVIDIA.',
    'Nous Portal': 'نماذج درّبتها Nous Research.',
    NovitaAI: 'نماذج مفتوحة بأسعار منخفضة على Novita AI.',
    'Ollama Cloud': 'نماذج مفتوحة في سحابة Ollama.',
    'OpenAI API': 'نماذج GPT مباشرةً من OpenAI.',
    'OpenCode Go': 'نماذج عبر خطة OpenCode Go الخاصة بك.',
    'OpenCode Zen': 'نماذج اختارتها OpenCode Zen واختبرتها.',
    OpenRouter: 'مئات النماذج بمفتاح واحد.',
    'Qwen Cloud': 'نماذج Qwen من Alibaba Cloud.',
    StepFun: 'نماذج Step من StepFun.',
    'StepFun Step Plan': 'نماذج Step من StepFun.',
    'Tencent TokenHub': 'نماذج تقدّمها Tencent TokenHub.',
    'Upstage Solar': 'نماذج Solar من Upstage.',
    'Vercel AI Gateway': 'مزوّدون كثيرون بمفتاح Vercel واحد.',
    'Xiaomi MiMo': 'نماذج MiMo من Xiaomi.',
    'Z.AI (GLM)': 'نماذج GLM من Z.AI.',
    xAI: 'نماذج Grok مباشرةً من xAI.'
  },
  vars: {
    AGENT_BROWSER_ENGINE: [
      'اختر المحرّك الذي يعمل عليه المتصفح المحلي',
      'الوضع التلقائي يستخدم Chrome. ‏Lightpanda أسرع لكنه لا يلتقط صورًا للشاشة.'
    ],
    BRAVE_SEARCH_API_KEY: ['ابحث في الويب باستخدام Brave', 'تغطي الخطة المجانية نحو 2,000 عملية بحث شهريًا.'],
    BROWSERBASE_API_KEY: ['تصفّح في السحابة باستخدام Browserbase', 'اختياري. يعمل المتصفح على هذا الحاسوب من دونه.'],
    BROWSERBASE_PROJECT_ID: [
      'حدّد لـ Browserbase المشروع الذي يستخدمه',
      'مطلوب فقط عند التصفح في السحابة باستخدام Browserbase.'
    ],
    BROWSER_USE_API_KEY: ['تصفّح في السحابة باستخدام Browser Use', 'اختياري. يعمل المتصفح على هذا الحاسوب من دونه.'],
    BRV_API_KEY: [
      'زامن الذاكرة مع السحابة باستخدام ByteRover',
      'اختياري. تبقى الذاكرة على هذا الحاسوب حتى تضيف مفتاحًا.'
    ],
    CAMOFOX_API_KEY: ['سجّل الدخول إلى متصفح Camofox البعيد', 'مطلوب فقط إذا طلب خادم Camofox مفتاحًا.'],
    CAMOFOX_URL: [
      'تصفّح باستخدام Camofox لتقلّ احتمالات حظر المواقع لك',
      'عنوان خادم Camofox، وعادةً يكون على هذا الحاسوب.'
    ],
    ELEVENLABS_API_KEY: ['انطق وانسخ الكلام باستخدام ElevenLabs', 'أصوات مميزة للنطق ونسخ دقيق للكلام.'],
    EXA_API_KEY: ['ابحث في الويب باستخدام Exa', 'بحث مصمم للوكلاء، ويتضمن محتوى الصفحات في النتائج.'],
    FAL_KEY: ['أنشئ صورًا ومقاطع فيديو باستخدام fal', ''],
    FIRECRAWL_API_KEY: ['ابحث في المواقع واقرأها باستخدام Firecrawl', 'يتيح لوكيلك البحث في الويب وقراءة صفحات كاملة.'],
    FIRECRAWL_API_URL: ['استخدم خادم Firecrawl الخاص بك', 'اختياري. فقط لنسخة Firecrawl تستضيفها بنفسك.'],
    FIRECRAWL_BROWSER_TTL: ['اختر مدة بقاء جلسة متصفح Firecrawl مفتوحة', 'بالثواني. خمس دقائق إذا تُرك فارغًا.'],
    FIRECRAWL_GATEWAY_URL: [
      'أرسل طلبات Firecrawl عبر عنوان مشترك مختلف',
      'لمشتركي Nous Portal فقط. اتركه فارغًا ما لم يطلب الدعم غير ذلك.'
    ],
    GATEWAY_ALLOW_ALL_USERS: [
      'اسمح لأي شخص بالتحدث إلى روبوتات المراسلة',
      'متوقف افتراضيًا، فلا يصل إليها إلا من تسمح لهم.'
    ],
    GATEWAY_PROXY_KEY: ['سجّل الدخول إلى الخادم الذي يجيب عن رسائلك', 'يجب أن يطابق المفتاح المضبوط على ذلك الخادم.'],
    GATEWAY_PROXY_URL: ['حوّل رسائلك إلى خادم وكيل آخر', 'عند ضبطه، يجيب ذلك الخادم عن رسائلك بدلًا من هذا الحاسوب.'],
    GITHUB_TOKEN: [
      'اربط GitHub للعثور على المهارات ونشرها',
      'يرفع الحدود التي يضعها GitHub عندما يتصفح وكيلك المهارات وينشرها.'
    ],
    HERMES_EPHEMERAL_SYSTEM_PROMPT: [
      'أضف تعليمات إلى كل طلب دون حفظها',
      'تُرسل مع كل طلب ولا تُحفظ أبدًا في محادثاتك.'
    ],
    HERMES_LANGFUSE_BASE_URL: ['استخدم خادم Langfuse الخاص بك', 'اتركه فارغًا لاستخدام Langfuse Cloud.'],
    HERMES_LANGFUSE_PUBLIC_KEY: ['تابع عمل وكيلك خطوة بخطوة في Langfuse', 'المفتاح العام لمشروعك في Langfuse.'],
    HERMES_LANGFUSE_SECRET_KEY: ['اسمح لوكيلك بتسجيل خطواته في Langfuse', 'المفتاح السري لمشروعك في Langfuse.'],
    HERMES_PREFILL_MESSAGES_FILE: ['اعرض على وكيلك رسائل أمثلة من ملف', 'تُرسل قبل كل محادثة ولا تُحفظ أبدًا.'],
    HINDSIGHT_API_KEY: ['امنح وكيلك ذاكرة دائمة باستخدام Hindsight', 'ذاكرة تتتبّع كيف ترتبط الأشياء ببعضها.'],
    HINDSIGHT_API_URL: ['استخدم خادم Hindsight مختلفًا', 'اتركه فارغًا لاستخدام خدمة Hindsight المستضافة.'],
    HONCHO_API_KEY: ['امنح وكيلك ذاكرة دائمة باستخدام Honcho', 'ذاكرة تتعرّف عليك مع مرور الوقت.'],
    HONCHO_BASE_URL: ['استخدم خادم Honcho الخاص بك', 'لا تحتاج نسخة Honcho التي تستضيفها بنفسك إلى مفتاح.'],
    KEENABLE_API_KEY: ['ابحث في الويب بسرعة باستخدام Keenable', 'اختياري. يعمل Keenable أيضًا من دون مفتاح.'],
    KREA_API_KEY: ['أنشئ صورًا باستخدام Krea', ''],
    MEM0_API_KEY: ['امنح وكيلك ذاكرة دائمة باستخدام Mem0', 'ذاكرة تجد الأشياء بحسب معناها.'],
    MISTRAL_API_KEY: ['انطق وانسخ الكلام باستخدام Mistral', ''],
    OPENVIKING_API_KEY: ['اتصل بذاكرة OpenViking الخاصة بك', 'اتركه فارغًا عندما يعمل OpenViking على هذا الحاسوب.'],
    OPENVIKING_ENDPOINT: ['استخدم خادم OpenViking مختلفًا', 'اتركه فارغًا لاستخدام الخادم الموجود على هذا الحاسوب.'],
    PARALLEL_API_KEY: ['ابحث في الويب واقرأه باستخدام Parallel', 'بحث مصمم للوكلاء يستخرج الأجزاء المفيدة من كل صفحة.'],
    PORCUPINE_ACCESS_KEY: ['أيقظ وكيلك بكلمة منطوقة', 'اختياري. يفعّل مفتاح Picovoice كلمة التنبيه في Porcupine.'],
    RAFT_PROFILE: ['انضم إلى مساحة عمل Raft بصفة هذا الوكيل', 'ملؤه يشغّل الاتصال بـ Raft.'],
    RETAINDB_API_KEY: ['امنح وكيلك ذاكرة دائمة باستخدام RetainDB', ''],
    RETAINDB_BASE_URL: ['استخدم خادم RetainDB الخاص بك', 'اتركه فارغًا لاستخدام خدمة RetainDB المستضافة.'],
    SEARXNG_URL: ['ابحث في الويب باستخدام SearXNG الخاص بك', 'بحث مجاني وخاص على خادم تديره بنفسك.'],
    SUDO_PASSWORD: ['اسمح لأوامر الطرفية بالعمل كمسؤول', 'يُحفظ على هذا الحاسوب. اتركه فارغًا ليُطلب منك في كل مرة.'],
    SUPERMEMORY_API_KEY: ['امنح وكيلك ذاكرة دائمة باستخدام Supermemory', 'ذاكرة محفوظة لكل محادثة.'],
    TAVILY_API_KEY: ['ابحث في الويب واقرأه باستخدام Tavily', 'اختياري. يعمل Tavily أيضًا من دون مفتاح.'],
    TOOL_GATEWAY_DOMAIN: [
      'وجّه أدوات المشتركين إلى نطاق مختلف',
      'لمشتركي Nous Portal فقط. اتركه فارغًا ما لم يطلب الدعم غير ذلك.'
    ],
    TOOL_GATEWAY_SCHEME: [
      'اختر طريقة اتصال أدوات المشتركين',
      'لمشتركي Nous Portal فقط. اتركه فارغًا ما لم يطلب الدعم غير ذلك.'
    ],
    TOOL_GATEWAY_USER_TOKEN: [
      'سجّل دخول أدوات المشتركين برمزك الخاص',
      'لمشتركي Nous Portal فقط. يُستخدم تسجيل دخولك الحالي إذا تُرك فارغًا.'
    ],
    VOICE_TOOLS_OPENAI_KEY: ['انطق وانسخ الكلام باستخدام OpenAI', 'يُستخدم لنسخ Whisper ولأصوات OpenAI.']
  }
}
