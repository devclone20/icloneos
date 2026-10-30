/**
 * Ruling 54.4 (V3-FX r5) — one env seal for every child the app spawns.
 *
 * Every known telemetry-off variable is set on main's own environment (so a child that inherits it is sealed), and
 * every child-process primitive Node gives this process — child_process spawn / spawnSync / exec / execSync / execFile
 * / execFileSync / fork, Electron's utilityProcess.fork, node-pty's spawn — is wrapped so that a child launched with an
 * EXPLICIT env gets the same variables merged on top. `installTelemetrySeal()` runs before any other module of main
 * (it is main.ts's first import), and `syncBuiltinESMExports()` makes every `import { spawn } from 'node:child_process'`
 * binding see the sealed function. hermes-spawn-paths.test.ts proves every launch site uses one of these primitives.
 *
 * Ruling 57.4 (V3-FX r6): the seal also STRIPS every variable that carries a destination (proxies, OTLP endpoints,
 * telemetry SDK hosts, the Relay plugins file) and pins NO_PROXY to '*', from main's own env and from every child's —
 * unless main itself hands a child its own captured value for a LISTED non-telemetry reason (`DESTINATION_REASONS`,
 * `allowDestinationEnv`). Options are found as the first plain object after the command, so `(file, null|undefined,
 * {env})` is sealed too (critic r5 n2).
 *
 * The lists mirror the runtime's (hermes_cli/iclone_sinks.py TELEMETRY_OFF_ENV, DESTINATION_ENV_KEYS,
 * DESTINATION_ENV_PATTERN, DESTINATION_PINNED_ENV); a test on each side keeps them equal.
 */
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'

export const TELEMETRY_OFF_ENV: Readonly<Record<string, string>> = Object.freeze({
  // cua-driver (computer use): PostHog product telemetry, default on (critic r4 M1).
  CUA_DRIVER_RS_TELEMETRY_ENABLED: '0',
  CUA_TELEMETRY_ENABLED: '0',
  // browser-use / Chroma / mem0-style anonymized telemetry.
  ANONYMIZED_TELEMETRY: 'false',
  // Photon CLI (messaging platform plugin) and the Vercel CLI (sandbox environment).
  PHOTON_TELEMETRY: '0',
  VERCEL_TELEMETRY_DISABLED: '1',
  // The common opt-outs other bundled or agent-installed tools read.
  DO_NOT_TRACK: '1',
  HF_HUB_DISABLE_TELEMETRY: '1',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  CLAUDE_CODE_ENABLE_TELEMETRY: '0',
  NEXT_TELEMETRY_DISABLED: '1',
  NUXT_TELEMETRY_DISABLED: '1',
  ASTRO_TELEMETRY_DISABLED: '1',
  GATSBY_TELEMETRY_DISABLED: '1',
  DOTNET_CLI_TELEMETRY_OPTOUT: '1',
  AZURE_CORE_COLLECT_TELEMETRY: '0',
  CHECKPOINT_DISABLE: '1',
  SCARF_ANALYTICS: 'false',
  GRADIO_ANALYTICS_ENABLED: 'False',
  LANGCHAIN_TRACING_V2: 'false',
  LANGSMITH_TRACING: 'false',
  MEM0_TELEMETRY: 'False',
  POSTHOG_DISABLED: '1',
  OTEL_SDK_DISABLED: 'true',
  // browser-harness (a core Hermes dependency) PostHog telemetry (r7)
  BH_TELEMETRY: '0',
  BROWSER_HARNESS_TELEMETRY: '0',
  // Ruling 63 (r7): third-party opt-outs, set OFF for every child — one closed table
  TURBO_TELEMETRY_DISABLED: '1',
  WRANGLER_SEND_METRICS: 'false',
  HOMEBREW_NO_ANALYTICS: '1',
  STRIPE_CLI_TELEMETRY_OPTOUT: '1',
  SAM_CLI_TELEMETRY: '0',
  YARN_ENABLE_TELEMETRY: '0',
  EXPO_NO_TELEMETRY: '1',
  STORYBOOK_DISABLE_TELEMETRY: '1',
  CLOUDSDK_CORE_DISABLE_USAGE_REPORTING: 'true',
  GOTELEMETRY: 'off',
  GH_TELEMETRY: 'false',
  HF_XET_TELEMETRY_ENABLED: '0',
  MISTRAL_SDK_TELEMETRY: 'false'
})

/** Variables that carry a destination: never in a sealed env (ruling 57.4). */
export const DESTINATION_ENV_KEYS: readonly string[] = Object.freeze([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'FTP_PROXY',
  'GRPC_PROXY',
  'SOCKS_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'ftp_proxy',
  'grpc_proxy',
  'socks_proxy',
  'HERMES_NEMO_RELAY_PLUGINS_TOML',
  'SENTRY_DSN',
  'BH_POSTHOG_HOST',
  'MISTRAL_OTLP_TRACES_ENDPOINT',
  'SEGMENT_WRITE_KEY'
])

// prettier-ignore
export const DESTINATION_ENV_PATTERN = new RegExp(String.raw`^(?:OTEL_EXPORTER_\w+|ICLONE_\w*(?:ENDPOINT|BASE_URL)|(?:HERMES_)?LANGFUSE_\w+|(?:POSTHOG|SENTRY|DD|DATADOG|HONEYCOMB|SEGMENT|MIXPANEL|AMPLITUDE|LANGSMITH|LANGCHAIN|LOGFIRE|WANDB|AGENTOPS|PHOENIX|TRACELOOP|OPIK|BRAINTRUST|NEW_RELIC|ELASTIC_APM|BUGSNAG|ROLLBAR|NEMO_RELAY|HERMES_NEMO_RELAY)_\w*(?:HOST|URL|ENDPOINT|DSN|SITE|TOML|COLLECTOR)|(?![Nn][Oo]_[Pp][Rr][Oo][Xx][Yy]$)[A-Za-z0-9_]*_[Pp][Rr][Oo][Xx][Yy](?:_[Uu][Rr][Ll])?)$`)

/** NO_PROXY handling: pinned to '*' so a proxy that reaches a child anyway is bypassed. */
export const DESTINATION_PINNED_ENV: Readonly<Record<string, string>> = Object.freeze({ NO_PROXY: '*', no_proxy: '*' })

export const isDestinationKey = (key: string) => DESTINATION_ENV_KEYS.includes(key) || DESTINATION_ENV_PATTERN.test(key)

/**
 * The listed non-telemetry reasons main may hand a child its OWN destination values (captured from main's env before
 * the seal stripped it). Nothing else ever carries a proxy or an endpoint to a child.
 */
export const DESTINATION_REASONS = Object.freeze({
  'runtime-git-network-read':
    "`git ls-remote` of the runtime checkout's origin (update check) through the user's own proxy; no telemetry",
  'hermes-user-proxy':
    "Hermes reaches the user's model provider through the user's own proxy (main's env at app start, exactly as " +
    'captured; never a value from .env or config); telemetry stays off (OTEL_SDK_DISABLED, the venv exclusion)'
} as const)

/** The user's own proxy variables (lead correction r6; equal to hermes_cli/iclone_sinks.py USER_PROXY_ENV_KEYS). */
export const USER_PROXY_ENV_KEYS: readonly string[] = Object.freeze([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy'
])

export type DestinationReason = keyof typeof DESTINATION_REASONS

const listedEnvs = new WeakSet<object>()
let mainDestinations: Readonly<Record<string, string>> = Object.freeze({})

/** Main's own destination values, captured when the seal was installed (they are no longer in process.env). */
export function mainDestinationEnv(keys: readonly string[]): Record<string, string> {
  return Object.fromEntries(keys.filter(key => key in mainDestinations).map(key => [key, mainDestinations[key]!]))
}

/**
 * Main's captured user proxy, exactly as captured (its NO_PROXY included, nothing pinned over it) — or {} when the
 * user had no proxy at app start (the child then gets NO_PROXY='*' from the seal).
 */
export function userProxyEnv(): Record<string, string> {
  const captured = mainDestinationEnv(USER_PROXY_ENV_KEYS)
  const hasProxy = Object.keys(captured).some(key => !(key in DESTINATION_PINNED_ENV))

  return hasProxy ? captured : {}
}

/** Marks `env` as carrying main's own destination values for a listed reason; the seal then keeps them. */
export function allowDestinationEnv<T extends object>(reason: DestinationReason, env: T): T {
  if (!Object.prototype.hasOwnProperty.call(DESTINATION_REASONS, reason)) {
    throw new Error(`not a listed destination reason: ${String(reason)}`)
  }

  for (const [key, value] of Object.entries(env)) {
    if ((isDestinationKey(key) || key in DESTINATION_PINNED_ENV) && mainDestinations[key] !== value) {
      throw new Error(`${key} is not main's own value`)
    }
  }

  listedEnvs.add(env)

  return env
}

/**
 * `env` sealed: every telemetry-off variable set on top (the seal always wins over an inherited or explicit value),
 * every destination variable removed and NO_PROXY pinned — unless main listed this env object for a reason.
 */
export function sealTelemetryEnv<T extends Record<string, string | undefined>>(env: T): T & Record<string, string> {
  if (listedEnvs.has(env)) {
    return { ...env, ...TELEMETRY_OFF_ENV }
  }

  const kept = Object.fromEntries(Object.entries(env).filter(([key]) => !isDestinationKey(key)))

  return { ...kept, ...TELEMETRY_OFF_ENV, ...DESTINATION_PINNED_ENV } as T & Record<string, string>
}

type AnyFn = (...args: unknown[]) => unknown

const isPlainOptions = (value: unknown): value is { env?: Record<string, string | undefined> } =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** Seals the options argument (the first plain object after the command, when it carries an env) and calls through. */
function sealAt(fn: AnyFn): AnyFn {
  const sealed = function (this: unknown, ...args: unknown[]) {
    const index = args.findIndex((arg, i) => i > 0 && isPlainOptions(arg))
    const options = index > 0 ? args[index] : undefined

    if (isPlainOptions(options) && options.env) {
      args[index] = { ...options, env: sealTelemetryEnv(options.env) }
    }

    return fn.apply(this, args)
  }

  Object.defineProperty(sealed, '__icloneTelemetrySealed', { value: true })

  return sealed
}

export const SEALED_CHILD_PROCESS = [
  'spawn',
  'spawnSync',
  'execFile',
  'execFileSync',
  'fork',
  'exec',
  'execSync'
] as const

let installed = false

export function installTelemetrySeal(extra: { utilityProcess?: { fork: AnyFn } } = {}): void {
  const captured: Record<string, string> = { ...mainDestinations }

  for (const key of Object.keys(process.env)) {
    if (isDestinationKey(key) || key in DESTINATION_PINNED_ENV) {
      if (!installed && process.env[key] !== undefined) {
        captured[key] = process.env[key]!
      }

      if (isDestinationKey(key)) {
        delete process.env[key]
      }
    }
  }

  mainDestinations = Object.freeze(captured)
  Object.assign(process.env, TELEMETRY_OFF_ENV, DESTINATION_PINNED_ENV)

  const utility = extra.utilityProcess

  if (
    utility &&
    typeof utility.fork === 'function' &&
    !(utility.fork as { __icloneTelemetrySealed?: boolean }).__icloneTelemetrySealed
  ) {
    utility.fork = sealAt(utility.fork)
  }

  if (installed) {
    return
  }

  installed = true

  const module = childProcess as unknown as Record<string, AnyFn>

  for (const name of SEALED_CHILD_PROCESS) {
    const original = module[name]

    if (
      typeof original === 'function' &&
      !(original as { __icloneTelemetrySealed?: boolean }).__icloneTelemetrySealed
    ) {
      module[name] = sealAt(original)
    }
  }

  syncBuiltinESMExports()
}

/** For tests: whether the seal is on. */
export const telemetrySealInstalled = () => installed
