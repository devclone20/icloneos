import { describe, expect, it } from 'vitest'

import {
  clampToRouteLevels,
  effortDots,
  type EffortRoutesTable,
  effortWireState,
  routeDefaultEffort,
  routeEffortCatalog,
  routeEffortLevels,
  routeSentLevel
} from './reasoning-levels'

// served.py `effortRoutes` of the pinned runtime (rev 1ac3f97), verbatim:
// `python3 -B iclone/contract/served.py --runtime <pinned checkout> --out <spec>`, then its `effortRoutes`.
const TABLE: EffortRoutesTable = {
  ladder: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  sets: {
    ACTUAL_RELAY_EFFORTS: ['none', 'low', 'medium', 'high', 'max'],
    CODEX_ASTRA_EFFORTS: ['low', 'medium', 'high', 'xhigh', 'max'],
    CODEX_GPT56_EFFORTS: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    CODEX_LEGACY_EFFORTS: ['none', 'low', 'medium', 'high', 'xhigh'],
    DEEPSEEK_V4_EFFORTS: ['low', 'medium', 'high', 'max'],
    GLM52_EFFORTS: ['high', 'max'],
    GLM53_EFFORTS: ['low', 'medium', 'high', 'max'],
    KIMI_K2_EFFORTS: ['low', 'medium', 'high'],
    KIMI_K3_EFFORTS: ['low', 'high', 'max'],
    META_AI_EFFORTS: ['minimal', 'low', 'medium', 'high', 'xhigh'],
    NEBIUS_EFFORTS: ['low', 'medium', 'high'],
    OLLAMA_CLOUD_EFFORTS: ['none', 'low', 'medium', 'high', 'max'],
    OPENAI_COMPAT_WIRE_EFFORTS: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    OX_ALPHA_EFFORTS: ['low', 'high', 'max'],
    SOLAR_EFFORTS: ['low', 'medium', 'high'],
    TOKENHUB_EFFORTS: ['low', 'medium', 'high'],
    XAI_GROK46_EFFORTS: ['low', 'medium', 'high', 'xhigh'],
    XAI_LEGACY_EFFORTS: ['low', 'medium', 'high']
  },
  entry: {
    default: 'OPENAI_COMPAT_WIRE_EFFORTS',
    codex: {
      provider: 'openai-codex',
      ultraApiMode: 'codex_app_server',
      astraIds: ['gpt-6-astra', 'gpt-6-astra-900k'],
      noDisablePrefixes: ['gpt-6.1-sol'],
      gpt56Substrings: ['gpt-5.6'],
      gpt6Prefixes: ['gpt-6-sol', 'gpt-6-luna'],
      daybreakIds: ['gpt-daybreak-blue-latest', 'gpt-daybreak-blue-latest-900k'],
      astra: 'CODEX_ASTRA_EFFORTS',
      gpt56: 'CODEX_GPT56_EFFORTS',
      legacy: 'CODEX_LEGACY_EFFORTS'
    }
  },
  routes: [
    {
      providers: ['anthropic', 'claude', 'claude-oauth', 'claude-code'],
      source: 'agent/anthropic_adapter.py',
      cases: [
        {
          any: [
            'claude-3',
            'claude-opus-4-0',
            'claude-opus-4.0',
            'claude-opus-4-1',
            'claude-opus-4.1',
            'claude-sonnet-4-0',
            'claude-sonnet-4.0',
            'claude-opus-4-2025',
            'claude-sonnet-4-2025',
            'claude-opus-4-5',
            'claude-opus-4.5',
            'claude-sonnet-4-5',
            'claude-sonnet-4.5',
            'claude-haiku-4-5',
            'claude-haiku-4.5'
          ],
          levels: []
        },
        {
          without: ['claude'],
          levels: []
        },
        {
          any: ['claude-opus-4-6', 'claude-opus-4.6', 'claude-sonnet-4-6', 'claude-sonnet-4.6'],
          levels: ['low', 'medium', 'high', 'max'],
          overrides: {
            minimal: 'low',
            ultra: 'max',
            xhigh: 'max'
          }
        },
        {
          levels: ['low', 'medium', 'high', 'xhigh', 'max'],
          overrides: {
            minimal: 'low',
            ultra: 'max'
          }
        }
      ]
    },
    {
      providers: ['xai', 'xai-oauth', 'grok', 'x-ai', 'x.ai'],
      source: 'agent/transports/codex.py:_resolve_reasoning',
      cases: [
        {
          bare: true,
          exact: ['grok-4.6'],
          set: 'XAI_GROK46_EFFORTS',
          levels: ['low', 'medium', 'high', 'xhigh']
        },
        {
          bare: true,
          prefix: 'grok-4.6-',
          set: 'XAI_GROK46_EFFORTS',
          levels: ['low', 'medium', 'high', 'xhigh']
        },
        {
          set: 'XAI_LEGACY_EFFORTS',
          levels: ['low', 'medium', 'high']
        }
      ]
    },
    {
      providers: [],
      hosts: ['tokenhub.tencentmaas.com'],
      source: 'agent/transports/chat_completions.py:build_kwargs',
      cases: [
        {
          set: 'TOKENHUB_EFFORTS',
          levels: ['low', 'medium', 'high']
        }
      ]
    },
    {
      providers: ['custom', 'ollama', 'local', 'vllm', 'llamacpp', 'llama.cpp', 'llama-cpp'],
      hosts: ['api.groq.com'],
      source: 'plugins/model-providers/custom/__init__.py:CustomProfile.build_api_kwargs_extras',
      cases: [
        {
          levels: []
        }
      ]
    },
    {
      providers: ['deepseek', 'deepseek-chat', 'deep-seek'],
      source: 'plugins/model-providers/deepseek/__init__.py:DeepSeekProfile.build_api_kwargs_extras',
      cases: [
        {
          prefix: 'deepseek-v3',
          levels: []
        },
        {
          prefix: 'deepseek-v',
          set: 'DEEPSEEK_V4_EFFORTS',
          levels: ['low', 'medium', 'high', 'max'],
          overrides: {
            xhigh: 'max'
          }
        },
        {
          exact: ['deepseek-flash'],
          set: 'DEEPSEEK_V4_EFFORTS',
          levels: ['low', 'medium', 'high', 'max'],
          overrides: {
            xhigh: 'max'
          }
        },
        {
          levels: []
        }
      ]
    },
    {
      providers: ['opencode-zen', 'opencode', 'opencode_zen', 'zen'],
      source: 'plugins/model-providers/opencode-zen/__init__.py:OpenCodeZenProfile.build_api_kwargs_extras',
      cases: [
        {
          segment: true,
          exact: ['x-preview-f-free'],
          set: 'OX_ALPHA_EFFORTS',
          levels: ['low', 'high', 'max'],
          overrides: {
            xhigh: 'max'
          }
        },
        {
          levels: []
        }
      ]
    },
    {
      providers: ['opencode-go', 'opencode_go', 'go', 'opencode-go-sub'],
      source: 'plugins/model-providers/opencode-zen/__init__.py:OpenCodeGoProfile.build_api_kwargs_extras',
      cases: [
        {
          segment: true,
          any: ['glm-5-2', 'glm-5.2', 'glm-5p2'],
          set: 'GLM52_EFFORTS',
          levels: ['high', 'max'],
          overrides: {
            xhigh: 'max'
          }
        },
        {
          segment: true,
          prefix: 'kimi-k2',
          set: 'KIMI_K2_EFFORTS',
          levels: ['low', 'medium', 'high']
        },
        {
          segment: true,
          prefix: 'deepseek-v3',
          levels: []
        },
        {
          segment: true,
          prefix: 'deepseek-v',
          set: 'DEEPSEEK_V4_EFFORTS',
          levels: ['low', 'medium', 'high', 'max'],
          overrides: {
            xhigh: 'max'
          }
        },
        {
          segment: true,
          exact: ['deepseek-flash', 'deepseek-reasoner'],
          set: 'DEEPSEEK_V4_EFFORTS',
          levels: ['low', 'medium', 'high', 'max'],
          overrides: {
            xhigh: 'max'
          }
        },
        {
          levels: []
        }
      ]
    },
    {
      providers: ['openrouter', 'or'],
      source: 'plugins/model-providers/openrouter/__init__.py:OpenRouterProfile.build_api_kwargs_extras',
      cases: [
        {
          prefix: 'anthropic/',
          without: [
            'claude-3',
            'claude-opus-4-0',
            'claude-opus-4.0',
            'claude-opus-4-1',
            'claude-opus-4.1',
            'claude-sonnet-4-0',
            'claude-sonnet-4.0',
            'claude-opus-4-2025',
            'claude-sonnet-4-2025',
            'claude-opus-4-5',
            'claude-opus-4.5',
            'claude-sonnet-4-5',
            'claude-sonnet-4.5',
            'claude-haiku-4-5',
            'claude-haiku-4.5'
          ],
          levels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
        },
        {
          any: ['claude'],
          without: [
            'claude-3',
            'claude-opus-4-0',
            'claude-opus-4.0',
            'claude-opus-4-1',
            'claude-opus-4.1',
            'claude-sonnet-4-0',
            'claude-sonnet-4.0',
            'claude-opus-4-2025',
            'claude-sonnet-4-2025',
            'claude-opus-4-5',
            'claude-opus-4.5',
            'claude-sonnet-4-5',
            'claude-sonnet-4.5',
            'claude-haiku-4-5',
            'claude-haiku-4.5'
          ],
          levels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
        },
        {
          catalog: 'openrouter',
          levels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
        }
      ]
    },
    {
      providers: ['claude-code-cli'],
      source: 'iclone/hermes-plugins/claude-code',
      sha256: 'c16fc3cd5f3c705ab13efa2098d676b7eb0965e8ef71dffde33cc31ea03fbec6',
      cases: [
        {
          levels: []
        }
      ]
    },
    {
      providers: ['gemini', 'google', 'google-gemini', 'google-ai-studio'],
      source: 'agent/transports/chat_completions.py:_build_gemini_thinking_config',
      cases: [
        {
          strip: 'google/',
          prefix: 'gemini-3',
          any: ['flash'],
          levels: ['low', 'medium', 'high']
        },
        {
          strip: 'google/',
          prefix: 'gemini-3',
          any: ['pro'],
          levels: ['low', 'high']
        },
        {
          levels: []
        }
      ]
    },
    {
      providers: ['actual', 'actual-computer', 'actualcomputer', 'aci'],
      source: 'plugins/model-providers/actual/__init__.py',
      sha256: 'cc3005f778f0c5f3f0a7e2940371d812f370ce9422fc635a2d5eb19cf98c8528',
      cases: [
        {
          set: 'ACTUAL_RELAY_EFFORTS',
          levels: ['none', 'low', 'medium', 'high', 'max']
        }
      ]
    },
    {
      providers: ['custom', 'ollama', 'local', 'vllm', 'llamacpp', 'llama.cpp', 'llama-cpp'],
      source: 'plugins/model-providers/custom/__init__.py',
      sha256: 'e0bebb5675726793c87be3ba12d2cce088742106c852f142bcdf74f1d0156d98',
      cases: [
        {
          set: 'OPENAI_COMPAT_WIRE_EFFORTS',
          levels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
        }
      ]
    },
    {
      providers: ['deepinfra', 'deep-infra', 'deepinfra-ai'],
      source: 'plugins/model-providers/deepinfra/__init__.py',
      sha256: '7819591882c289cc83ad110d3b71467d3e826ecef38abab6c79a83a39bd74a79',
      cases: [
        {
          set: 'OPENAI_COMPAT_WIRE_EFFORTS',
          levels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
        }
      ]
    },
    {
      providers: ['kimi-coding', 'kimi', 'moonshot', 'kimi-for-coding', 'kimi-coding-cn', 'kimi-cn', 'moonshot-cn'],
      source: 'plugins/model-providers/kimi-coding/__init__.py',
      sha256: '2e46a8a248787ab6f253cdbe7a4d0208f196a728a947efdac81843bf2e0abea5',
      cases: [
        {
          set: 'KIMI_K3_EFFORTS',
          levels: ['low', 'high', 'max'],
          overrides: {
            medium: 'high',
            xhigh: 'max'
          }
        }
      ]
    },
    {
      providers: ['meta-ai', 'meta', 'muse', 'muse-spark', 'model-api', 'msl'],
      source: 'plugins/model-providers/meta-ai/__init__.py',
      sha256: '1b78fcabb23420cea419ce6563191b7cc5cd69a255fca3fbe5885a6b04c37608',
      cases: [
        {
          set: 'META_AI_EFFORTS',
          levels: ['minimal', 'low', 'medium', 'high', 'xhigh']
        }
      ]
    },
    {
      providers: [
        'nebius-token-factory',
        'nebius',
        'nebius-tokenfactory',
        'nebius-tf',
        'token-factory',
        'tokenfactory'
      ],
      source: 'plugins/model-providers/nebius-token-factory/__init__.py',
      sha256: '2ac113698c549bf1224527252c50dda966a63f372fa6f98e604ab7cc4a6bfa2d',
      cases: [
        {
          set: 'NEBIUS_EFFORTS',
          levels: ['low', 'medium', 'high']
        }
      ]
    },
    {
      providers: ['ollama-cloud', 'ollama_cloud'],
      source: 'plugins/model-providers/ollama-cloud/__init__.py',
      sha256: '16bc259bd3737d34a706c49a604bbb2737128b94db62b1fe89fc750452e00ab8',
      cases: [
        {
          set: 'OLLAMA_CLOUD_EFFORTS',
          levels: ['none', 'low', 'medium', 'high', 'max'],
          overrides: {
            xhigh: 'max'
          }
        }
      ]
    },
    {
      providers: ['router', 'ramp-router', 'ramp', 'router.com'],
      source: 'plugins/model-providers/router/__init__.py',
      sha256: '01260416864eda6e79d9a72d9b8ffd65b8114794a2af9e180aebe267c48c9823',
      cases: [
        {
          set: 'OPENAI_COMPAT_WIRE_EFFORTS',
          levels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
          catalog: 'router'
        }
      ]
    },
    {
      providers: ['upstage', 'solar'],
      source: 'plugins/model-providers/upstage/__init__.py',
      sha256: '34bc6eca4c810714bf6a5e763e8d2afccffa5602620bd8a2958b67e4fddf8ecd',
      cases: [
        {
          set: 'SOLAR_EFFORTS',
          levels: ['low', 'medium', 'high']
        }
      ]
    },
    {
      providers: ['zai', 'glm', 'z-ai', 'z.ai', 'zhipu'],
      source: 'plugins/model-providers/zai/__init__.py',
      sha256: 'bee1c33949e4dc2f92f8c90515ac927bb88336ac1ddd11cc9bba4e5244181bbd',
      cases: [
        {
          any: ['glm-5.3', 'glm-5-3', 'glm-5p3'],
          set: 'GLM53_EFFORTS',
          levels: ['low', 'medium', 'high', 'max'],
          overrides: {
            xhigh: 'max'
          }
        },
        {
          set: 'GLM52_EFFORTS',
          levels: ['high', 'max'],
          overrides: {
            xhigh: 'max'
          }
        }
      ]
    },
    {
      providers: ['tencent-tokenhub', 'tencent', 'tokenhub', 'tencent-cloud', 'tencentmaas'],
      registryHosts: ['tokenhub.tencentmaas.com'],
      source: 'hermes_cli/auth.py:_REGISTRY_ROWS',
      cases: [
        {
          set: 'TOKENHUB_EFFORTS',
          levels: ['low', 'medium', 'high']
        }
      ]
    }
  ],
  pins: {
    'agent/anthropic_adapter.py:_is_claude_model': '1d56c99584665456c5595da209617f16f01903f18e3a3f23b8afe05d0f86a511',
    'agent/anthropic_adapter.py:_supports_adaptive_thinking':
      'a9cbb930477a04b48cd5016447184500f2280edb75e703376e67e1cafedcead7',
    'agent/anthropic_adapter.py:_supports_xhigh_effort':
      'e0074ef9cb63a0c47d1bea5dea179da352e2665c7500871a735099b760d1f3bd',
    'agent/anthropic_adapter.py:_thinking_kwargs': 'f25db438339b13cb6654d36ac9dfdf76d5e68ca87ad31ac4ca92649e4f55b17f',
    'agent/codex_responses_adapter.py:classify_responses_route':
      '2bd15ea106ace7d2e6a43ea33d8f6c40381b1fcdc7a3def080e5b9dc46fd3da6',
    'agent/model_metadata.py:is_grok_46_family': 'f9b73a6cc94ad44551c79444d42b25fffdf6f8a4063db795034d53e9a048d742',
    'agent/reasoning_effort.py:clamp_effort': 'c9dfa140167ca5826b0a907577eb6dee1a9237fa8c5998d29d0215e73fec8df2',
    'agent/reasoning_effort.py:codex_supported_efforts':
      '83829abe7643ff6e5b1d1fa9b056f66a3c87d5880096cb6157e80a31a4c0cd49',
    'agent/reasoning_effort.py:ox_alpha_reasoning_extras':
      '986eb5270968cee9444fd85fa00a72f06de420ae2e07ffe27cef83b328bb22ee',
    'agent/reasoning_effort.py:route_supported_efforts':
      'e9fd6172cff4cd8779d41764fdb1626e3e814d39c582afe6fa46fbf9adf1acab',
    'agent/transports/chat_completions.py:_build_gemini_thinking_config':
      '447cf73da57b22e05c6a5a494a493073b7224b0b71cdfde07c1554e6ed9b061e',
    'agent/transports/chat_completions.py:build_kwargs':
      '091d10cfc12ef0255cfded256cccfeedd24e840157dd6c04ea82fd7c9935d2a3',
    'agent/transports/codex.py:_resolve_reasoning': '7f6a787e93e9adf52971388096517b564a3f1a7919a737919ed83daf2a518847',
    'hermes_cli/auth.py:_REGISTRY_ROWS': '2d195b3c0b344fc7a25335d947114c9fb9841a298d19ecf5a130563e5eebb5fe',
    'plugins/model-providers/custom/__init__.py:CustomProfile.build_api_kwargs_extras':
      '01a37d1a856cdaac161082fc25bebfc879bcdfba7293923c53305c3ea98249d0',
    'plugins/model-providers/deepseek/__init__.py:DeepSeekProfile.build_api_kwargs_extras':
      '976459b158c9448a82320d34cfeebd1dca80e0b55da3bf8cf6392d9bdc892eea',
    'plugins/model-providers/opencode-zen/__init__.py:OpenCodeGoProfile.build_api_kwargs_extras':
      '93fd603ecf69c5ce2bee226f2a8f889951bf7533f5eb5c8c7dcd5eb7b7aa736f',
    'plugins/model-providers/opencode-zen/__init__.py:OpenCodeZenProfile.build_api_kwargs_extras':
      '22c9371ae6e070b7dee25736bc1a626fac8a5eed837d53a1d35b1a652b43afa6',
    'plugins/model-providers/opencode-zen/__init__.py:_flat_model_name':
      '20e4e80bcad1e6b00b77975ef3ad0ccd6511dbce87bd098ef78225d32c850c8f',
    'plugins/model-providers/opencode-zen/__init__.py:_is_deepseek_thinking_model':
      'cd881842f890c16028fbabd130517a7485e89aa3e016af3cb62b5a422418ee95',
    'plugins/model-providers/opencode-zen/__init__.py:_is_glm_5_2_model':
      '0fbc3da64f52cc0adcb580a454a5bb8debb2c62bdb02487bbaa925c2859e92c1',
    'plugins/model-providers/openrouter/__init__.py:OpenRouterProfile._clamp_reasoning_to_catalog':
      '877860da3b6c0225702223d56319d8a988d9bfbbdb6e5f221c3fd0a039e34979',
    'plugins/model-providers/openrouter/__init__.py:OpenRouterProfile.build_api_kwargs_extras':
      'c257ee31bfa4d38ee6ac507fe96914aa12da060970585ec3b1b940217280b7bf',
    'plugins/model-providers/openrouter/__init__.py:_anthropic_reasoning_is_mandatory':
      '8ad47a7729ccee8c9cc462aa2c8e2b8fdae68bb10705b2f729709b4a03d6059b',
    'plugins/model-providers/router/__init__.py:RouterProfile.supported_reasoning_efforts':
      'bcc659c89a3dd29f2287482efd732f4df57fd2000112ffecd50b914e305d6bc6'
  }
}

// The runtime's OWN functions (route_supported_efforts + clamp_effort + each
// transport: anthropic adapter, kimi, zai plugin, gemini thinkingConfig), run
// with python3 -I -B on the pinned checkout: the verbatim levels per route.
const RUNTIME_LEVELS: [provider: string, model: string, apiMode: string, levels: string[]][] = [
  ['anthropic', 'claude-sonnet-4-6', '', ['low', 'medium', 'high', 'max']],
  ['anthropic', 'claude-opus-4-7', '', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['anthropic', 'claude-sonnet-4-5', '', []],
  ['openai-codex', 'gpt-5.5', '', ['low', 'medium', 'high', 'xhigh']],
  ['openai-codex', 'gpt-5.6', '', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['openai-codex', 'gpt-5.6', 'codex_app_server', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']],
  ['openai-codex', 'gpt-6-astra', '', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['openrouter', 'anthropic/claude-sonnet-4-6', '', ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']],
  ['kimi-coding', 'kimi-k3', '', ['low', 'high', 'max']],
  ['zai', 'glm-5.2', '', ['high', 'max']],
  ['zai', 'glm-5.3', '', ['low', 'medium', 'high', 'max']],
  ['gemini', 'gemini-3-pro', '', ['low', 'high']],
  ['gemini', 'gemini-3-flash', '', ['low', 'medium', 'high']],
  ['gemini', 'gemini-2.5-pro', '', []],
  ['xai', 'grok-4.6', '', ['low', 'medium', 'high', 'xhigh']],
  ['xai', 'grok-4.6-fast', '', ['low', 'medium', 'high', 'xhigh']],
  ['grok', 'x-ai/grok_4.6', '', ['low', 'medium', 'high', 'xhigh']],
  ['xai', 'grok-4.60', '', ['low', 'medium', 'high']],
  ['xai', 'grok-4', '', ['low', 'medium', 'high']],
  ['xai-oauth', 'grok-4', '', ['low', 'medium', 'high']],
  // Provider-plugin routes, one per ProviderProfile, gated per model like its build_api_kwargs_extras.
  ['deepseek', 'deepseek-v4', '', ['low', 'medium', 'high', 'max']],
  ['deepseek', 'deepseek-v4-pro', '', ['low', 'medium', 'high', 'max']],
  ['deepseek', 'deepseek-v3', '', []],
  ['deepseek', 'deepseek-flash', '', ['low', 'medium', 'high', 'max']],
  ['deepseek', 'deepseek/deepseek-v4', '', []],
  ['opencode-zen', 'x-preview-f-free', '', ['low', 'high', 'max']],
  ['opencode-zen', 'opencode/x-preview-f-free', '', ['low', 'high', 'max']],
  ['opencode-zen', 'glm-5.2', '', []],
  ['zen', 'kimi-k2.5', '', []],
  ['opencode-go', 'glm-5.2', '', ['high', 'max']],
  ['opencode-go', 'glm-5p2', '', ['high', 'max']],
  ['opencode-go', 'kimi-k2.5', '', ['low', 'medium', 'high']],
  ['opencode-go', 'deepseek-v4', '', ['low', 'medium', 'high', 'max']],
  ['opencode-go', 'deepseek-v3', '', []],
  ['opencode-go', 'deepseek-reasoner', '', ['low', 'medium', 'high', 'max']],
  ['opencode-go', 'mimo-v2.5-pro', '', []],
  ['go', 'zai/glm-5-2', '', ['high', 'max']]
]

// The same runtime run: what each plugin route really sends for every requested level.
const RUNTIME_SENT: [provider: string, model: string, sent: Record<string, string>][] = [
  [
    'deepseek',
    'deepseek-v4',
    { minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'max', max: 'max', ultra: 'max' }
  ],
  [
    'deepseek',
    'deepseek-v4-pro',
    { minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'max', max: 'max', ultra: 'max' }
  ],
  [
    'deepseek',
    'deepseek-flash',
    { minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'max', max: 'max', ultra: 'max' }
  ],
  [
    'opencode-zen',
    'x-preview-f-free',
    { minimal: 'low', low: 'low', medium: 'low', high: 'high', xhigh: 'max', max: 'max', ultra: 'max' }
  ],
  [
    'opencode-zen',
    'opencode/x-preview-f-free',
    { minimal: 'low', low: 'low', medium: 'low', high: 'high', xhigh: 'max', max: 'max', ultra: 'max' }
  ],
  [
    'opencode-go',
    'glm-5.2',
    { minimal: 'high', low: 'high', medium: 'high', high: 'high', xhigh: 'max', max: 'max', ultra: 'max' }
  ],
  [
    'opencode-go',
    'glm-5p2',
    { minimal: 'high', low: 'high', medium: 'high', high: 'high', xhigh: 'max', max: 'max', ultra: 'max' }
  ],
  [
    'opencode-go',
    'kimi-k2.5',
    { minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high', ultra: 'high' }
  ],
  [
    'opencode-go',
    'deepseek-v4',
    { minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'max', max: 'max', ultra: 'max' }
  ],
  [
    'opencode-go',
    'deepseek-reasoner',
    { minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'max', max: 'max', ultra: 'max' }
  ],
  [
    'go',
    'zai/glm-5-2',
    { minimal: 'high', low: 'high', medium: 'high', high: 'high', xhigh: 'max', max: 'max', ultra: 'max' }
  ]
]

const LADDER = TABLE.ladder

describe('routeEffortLevels', () => {
  it.each(RUNTIME_LEVELS)(
    '%s %s %s lists exactly what the runtime sends verbatim',
    (provider, model, apiMode, levels) => {
      expect(routeEffortLevels(provider, model, { apiMode: apiMode || undefined, table: TABLE })).toEqual(levels)
    }
  )

  it('resolves provider aliases and user-defined custom:<key> identities', () => {
    expect(routeEffortLevels('kimi', 'kimi-k3', { table: TABLE })).toEqual(['low', 'high', 'max'])
    expect(routeEffortLevels('Google', 'google/gemini-3-pro', { table: TABLE })).toEqual(['low', 'high'])
    expect(routeEffortLevels('claude', 'claude-opus-4-7', { table: TABLE })).toContain('xhigh')
    expect(routeEffortLevels('custom:lab', 'qwen3', { table: TABLE })).toEqual([
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max'
    ])
  })

  it('never lists none, and nothing when the runtime says the model has no reasoning', () => {
    expect(routeEffortLevels('openrouter', 'x/y', { table: TABLE })).not.toContain('none')
    expect(routeEffortLevels('openrouter', 'x/y', { caps: { reasoning: false }, table: TABLE })).toEqual([])
    expect(routeEffortLevels('openrouter', 'x/y', { caps: { reasoning: true }, table: TABLE })).toHaveLength(6)
  })

  it('lists nothing without a table, a provider or a model', () => {
    expect(routeEffortLevels('anthropic', 'claude-opus-4-7', { table: null })).toEqual([])
    expect(routeEffortLevels('', 'claude-opus-4-7', { table: TABLE })).toEqual([])
    expect(routeEffortLevels('anthropic', '  ', { table: TABLE })).toEqual([])
  })

  it('treats a non-Claude model on the Anthropic route as budget-only (no levels)', () => {
    expect(routeEffortLevels('anthropic', 'minimax-m2', { table: TABLE })).toEqual([])
  })
})

describe('clampToRouteLevels', () => {
  const sonnet46 = ['low', 'medium', 'high', 'max']

  it('keeps a listed level, else takes the nearest weaker one, else the weakest', () => {
    expect(clampToRouteLevels('high', sonnet46, LADDER)).toBe('high')
    expect(clampToRouteLevels('xhigh', sonnet46, LADDER)).toBe('high')
    expect(clampToRouteLevels('ultra', sonnet46, LADDER)).toBe('max')
    expect(clampToRouteLevels('minimal', sonnet46, LADDER)).toBe('low')
    expect(clampToRouteLevels('medium', ['high', 'max'], LADDER)).toBe('high')
    expect(clampToRouteLevels('high', [], LADDER)).toBe('')
  })

  it('defaults a model without a preset to medium, or the nearest level the route has', () => {
    expect(routeDefaultEffort(sonnet46, LADDER)).toBe('medium')
    expect(routeDefaultEffort(['low', 'high', 'max'], LADDER)).toBe('low')
    expect(routeDefaultEffort(['high', 'max'], LADDER)).toBe('high')
    expect(routeDefaultEffort([], LADDER)).toBe('')
  })
})

describe('effortDots', () => {
  it('ranks by the ladder, 1 to 5, the same on every model', () => {
    expect(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(l => effortDots(l, LADDER))).toEqual([
      1, 1, 2, 3, 4, 5, 5
    ])
    expect(effortDots('bespoke', LADDER)).toBe(0)
  })
})

describe('effortWireState', () => {
  it('reads the runtime echo, and says unknown rather than guessing', () => {
    expect(effortWireState('high', 'high')).toBe('verbatim')
    expect(effortWireState('xhigh', 'max')).toBe('clamped')
    expect(effortWireState('high', '')).toBe('unknown')
    expect(effortWireState('none', '')).toBe('unknown')
    expect(effortWireState('', 'high')).toBe('unknown')
  })
})

describe('routeSentLevel', () => {
  const sent = (provider: string, model: string, level: string, baseUrl?: string) =>
    routeSentLevel(provider, model, level, { baseUrl, table: TABLE })

  it('is the requested level when the route lists it', () => {
    expect(sent('anthropic', 'claude-opus-4-7', 'xhigh')).toBe('xhigh')
    expect(sent('kimi-coding', 'kimi-k3', 'max')).toBe('max')
  })

  it('follows the adapter and vendor maps the wire echo cannot show', () => {
    expect(sent('anthropic', 'claude-sonnet-4-6', 'xhigh')).toBe('max')
    expect(sent('anthropic', 'claude-sonnet-4-6', 'ultra')).toBe('max')
    expect(sent('anthropic', 'claude-opus-4-7', 'minimal')).toBe('low')
    expect(sent('kimi-coding', 'kimi-k3', 'medium')).toBe('high')
    expect(sent('kimi-coding', 'kimi-k3', 'xhigh')).toBe('max')
    expect(sent('zai', 'glm-5.2', 'xhigh')).toBe('max')
  })

  it('else clamps to the nearest weaker level the route lists', () => {
    expect(sent('xai', 'grok-4.6', 'max')).toBe('xhigh')
    expect(sent('xai', 'grok-4', 'max')).toBe('high')
    expect(sent('xai', 'grok-4', 'minimal')).toBe('low')
    expect(sent('gemini', 'gemini-3-pro', 'medium')).toBe('low')
  })

  it.each(RUNTIME_SENT)('%s %s sends what the runtime plugin sends for each level', (provider, model, levels) => {
    for (const [level, want] of Object.entries(levels)) {
      expect([level, sent(provider, model, level)]).toEqual([level, want])
    }
  })

  it('is empty where the route has no effort knob', () => {
    expect(sent('anthropic', 'claude-sonnet-4-5', 'high')).toBe('')
    expect(sent('anthropic', 'claude-opus-4-7', 'none')).toBe('')
    expect(routeSentLevel('anthropic', 'claude-opus-4-7', 'high', { table: null })).toBe('')
  })
})

describe('our own provider plugins (served.py reads iclone/hermes-plugins)', () => {
  it('offers no level on claude-code-cli: the claude CLI argv carries no effort', () => {
    expect(routeEffortLevels('claude-code-cli', 'claude-sonnet-5-5', { table: TABLE })).toEqual([])
    expect(routeSentLevel('claude-code-cli', 'claude-sonnet-5-5', 'high', { table: TABLE })).toBe('')
    expect(routeEffortCatalog('claude-code-cli', 'claude-sonnet-5-5', { table: TABLE })).toBe('')
  })
})

describe('host-chosen routes', () => {
  it('applies TokenHub only when the base URL is its host or a subdomain', () => {
    const levels = (baseUrl?: string) => routeEffortLevels('custom:tokenhub', 'hunyuan-t1', { baseUrl, table: TABLE })

    expect(levels('https://tokenhub.tencentmaas.com/v1')).toEqual(['low', 'medium', 'high'])
    expect(levels('eu.tokenhub.tencentmaas.com')).toEqual(['low', 'medium', 'high'])
    expect(levels('https://tokenhub.tencentmaas.com.evil.example/v1')).toEqual(levels())
    expect(levels()).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(routeSentLevel('custom', 'hunyuan-t1', 'max', { baseUrl: 'tokenhub.tencentmaas.com', table: TABLE })).toBe(
      'high'
    )
  })

  it('applies TokenHub to the built-in tencent-tokenhub rows and aliases, which carry no base URL', () => {
    for (const provider of ['tencent-tokenhub', 'tokenhub', 'tencent', 'tencent-cloud', 'tencentmaas']) {
      expect(routeEffortLevels(provider, 'hunyuan-t1', { table: TABLE })).toEqual(['low', 'medium', 'high'])
      expect(routeSentLevel(provider, 'hunyuan-t1', 'max', { table: TABLE })).toBe('high')
      expect(routeSentLevel(provider, 'hunyuan-t1', 'xhigh', { table: TABLE })).toBe('high')
    }

    // A row naming the registry host keeps the route; one naming another host (an env override) is off it.
    expect(
      routeEffortLevels('tencent-tokenhub', 'hunyuan-t1', {
        baseUrl: 'https://tokenhub.tencentmaas.com/v1',
        table: TABLE
      })
    ).toEqual(['low', 'medium', 'high'])
    expect(
      routeEffortLevels('tencent-tokenhub', 'hunyuan-t1', { baseUrl: 'https://proxy.example.com/v1', table: TABLE })
    ).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  })

  it("applies the custom profile's Groq branch (no graded level is sent) only to that profile's providers", () => {
    const GROQ = 'https://api.groq.com/openai/v1'
    const WIDE = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

    const levels = (provider: string, baseUrl?: string) =>
      routeEffortLevels(provider, 'gpt-oss-120b', { baseUrl, table: TABLE })

    expect(levels('custom', GROQ)).toEqual([])
    expect(levels('custom:groq', GROQ)).toEqual([])
    expect(levels('ollama', 'api.groq.com')).toEqual([])
    expect(routeSentLevel('custom:groq', 'gpt-oss-120b', 'high', { baseUrl: GROQ, table: TABLE })).toBe('')
    expect(levels('custom')).toEqual(WIDE)
    expect(levels('custom', 'https://api.groq.com.evil.example/v1')).toEqual(WIDE)
    expect(levels('nous', GROQ)).toEqual(levels('nous'))
  })
})

describe('catalog-lowered routes (OpenRouter supported_efforts)', () => {
  const WIDE = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  const CATALOG = { reasoning: true, supported_efforts: ['low', 'medium', 'high', 'xhigh'] }

  it('without the catalog list, offers the entry levels as an upper bound and says the catalog may lower them', () => {
    expect(routeEffortLevels('openrouter', 'openai/gpt-5.5', { table: TABLE })).toEqual(WIDE)
    expect(routeEffortCatalog('openrouter', 'openai/gpt-5.5', { table: TABLE })).toBe('openrouter')
    expect(routeEffortCatalog('or', 'openai/gpt-5.5', { table: TABLE })).toBe('openrouter')
  })

  it("with the catalog's list, lists exactly it and clamps like the runtime", () => {
    const opts = { caps: CATALOG, table: TABLE }

    expect(routeEffortLevels('openrouter', 'openai/gpt-5.5', opts)).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(routeEffortCatalog('openrouter', 'openai/gpt-5.5', opts)).toBe('')
    expect(routeSentLevel('openrouter', 'openai/gpt-5.5', 'max', opts)).toBe('xhigh')
    expect(routeSentLevel('openrouter', 'openai/gpt-5.5', 'minimal', opts)).toBe('low')
  })

  it('never applies the catalog to Claude models that take the effort as-is, nor to other providers', () => {
    expect(routeEffortCatalog('openrouter', 'anthropic/claude-sonnet-4-6', { caps: null, table: TABLE })).toBe('')
    expect(routeEffortLevels('openrouter', 'anthropic/claude-sonnet-4-6', { caps: CATALOG, table: TABLE })).toEqual(
      WIDE
    )
    expect(routeEffortCatalog('openrouter', 'anthropic/claude-opus-4-5', { table: TABLE })).toBe('openrouter')
    expect(routeEffortCatalog('anthropic', 'claude-opus-4-7', { table: TABLE })).toBe('')
    expect(routeEffortCatalog('openrouter', 'openai/gpt-5.5', { table: null })).toBe('')
  })

  it('flags Ramp Router (a cache-backed supported_reasoning_efforts) and narrows to its listed levels', () => {
    const route = { apiMode: 'codex_responses', table: TABLE }

    for (const provider of ['router', 'ramp-router', 'ramp', 'router.com']) {
      expect(routeEffortCatalog(provider, 'gpt-5.5', route)).toBe('router')
      expect(routeEffortLevels(provider, 'gpt-5.5', route)).toEqual(WIDE)
    }

    expect(routeEffortLevels('router', 'gpt-5.5', { ...route, caps: CATALOG })).toEqual([
      'low',
      'medium',
      'high',
      'xhigh'
    ])
    expect(routeEffortCatalog('router', 'gpt-5.5', { ...route, caps: CATALOG })).toBe('')
    expect(routeEffortCatalog('actual', 'kimi-k2.5', { table: TABLE })).toBe('')
    expect(routeEffortCatalog('custom', 'glm-5.2', { table: TABLE })).toBe('')
  })
})
