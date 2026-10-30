// The one Chrome DevTools Protocol client for every desktop script: the perf
// harness, the dev helpers (eval, reload, probe-*, click-session) and the
// short-session hang repro. Each used to ship its own copy-pasted socket loop
// and `/json` vs `/json/list` discovery; this is the single place to fix a
// protocol bug.

import { setTimeout as sleep } from 'node:timers/promises'

const DEFAULT_PORT = 9222

// The same rules as electron/dev-cdp.ts, so a script looks for the port the dev app actually opened.
const MIN_PORT = 1024
const MAX_PORT = 65535
const OPT_OUT = new Set(['0', 'off', 'false', 'no'])

const DEV_PORT_HINT =
  'Dev-server runs (`npm run dev` / `hgui`) open one automatically — check the app is running, ' +
  'and that HERMES_DESKTOP_CDP_PORT is not set to "off" or another port.'

/**
 * The renderer debugging port the dev app opened: unset → 9222, else `HERMES_DESKTOP_CDP_PORT`. Throws when
 * that value opts out ("off" / "0" / "false" / "no") or is not a port, because the app then opened none.
 */
export function envPort(env = process.env) {
  const requested = (env.HERMES_DESKTOP_CDP_PORT ?? '').trim()

  if (!requested) {
    return DEFAULT_PORT
  }

  if (OPT_OUT.has(requested.toLowerCase())) {
    throw new Error(
      `HERMES_DESKTOP_CDP_PORT=${requested} turns renderer debugging off, so there is no port to connect to`
    )
  }

  const port = Number(requested)

  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new Error(
      `HERMES_DESKTOP_CDP_PORT is not a valid port (expected an integer ${MIN_PORT}-${MAX_PORT}, or "off"); ` +
        'renderer debugging is disabled'
    )
  }

  return port
}

// Stable DOM hooks the renderer exposes. Centralised so a component refactor
// updates one constant instead of a dozen scattered querySelector strings.
export const SELECTORS = {
  composer: '[data-slot="composer-rich-input"]',
  threadViewport: '[data-slot="aui_thread-viewport"]',
  threadContent: '[data-slot="aui_thread-content"]',
  assistantMessage: '[data-slot="aui_assistant-message-root"]',
  turnPair: '[data-slot="aui_turn-pair"]',
  profileRail: '[data-slot="profile-rail"]',
  rowButton: '[data-slot="row-button"]'
}

/**
 * Poll the CDP HTTP endpoint until a page target is available.
 * @param {object} [opts]
 * @param {number} [opts.port] remote-debugging-port (default 9222).
 * @param {string} [opts.match] substring the target URL must contain (e.g. a dev-server port).
 * @param {string} [opts.prefer] substring to pick first, falling back to the default choice.
 * @param {number} [opts.timeoutMs] how long to wait for a target (0 = one attempt).
 */
export async function discoverTarget({ port = DEFAULT_PORT, match, prefer, timeoutMs = 30000 } = {}) {
  const deadline = Date.now() + timeoutMs

  for (;;) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const pages = list.filter(t => t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string')
      const target = match
        ? pages.find(t => String(t.url).includes(match))
        : ((prefer ? pages.find(t => String(t.url).includes(prefer)) : undefined) ??
          pages.find(t => String(t.url).startsWith('http')) ??
          pages[0])

      if (target) {
        return target
      }
    } catch {
      // debug port not up yet — keep polling until the deadline.
    }

    if (Date.now() >= deadline) {
      throw new Error(`no CDP page target on :${port}${match ? ` matching "${match}"` : ''} within ${timeoutMs}ms`)
    }

    await sleep(250)
  }
}

/**
 * The dev helpers' entry: one attempt at a page target on the port the dev app opened (`envPort`). On failure it
 * prints one line explaining why — never a stack trace — and exits 1.
 * @param {{ match?: string, prefer?: string }} [opts] as for `discoverTarget`.
 */
export async function devTargetOrExit(
  opts = {},
  { env = process.env, exit = code => process.exit(code), log = console.error } = {}
) {
  let port

  try {
    port = envPort(env)
  } catch (error) {
    log(`${error.message}.`)

    return exit(1)
  }

  try {
    return await discoverTarget({ ...opts, port, timeoutMs: 0 })
  } catch (error) {
    log(`${error.message}. ${DEV_PORT_HINT}`)

    return exit(1)
  }
}

export class CDP {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.listeners = new Map()
  }

  /** Open a socket to a target object from `discoverTarget` or its `webSocketDebuggerUrl`. */
  static async open(target) {
    const ws = new WebSocket(typeof target === 'string' ? target : target.webSocketDebuggerUrl)

    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', reject, { once: true })
    })

    return CDP.attach(ws)
  }

  /** Route an open socket's replies to pending calls and its events to `on()` listeners. */
  static attach(ws) {
    const cdp = new CDP(ws)

    ws.addEventListener('message', ev => {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString('utf8'))

      if (m.id != null && cdp.pending.has(m.id)) {
        const { resolve, reject } = cdp.pending.get(m.id)
        cdp.pending.delete(m.id)

        if (m.error) {
          reject(new Error(m.error.message))
        } else {
          resolve(m.result)
        }
      } else if (m.method) {
        for (const handler of cdp.listeners.get(m.method) ?? []) {
          handler(m.params)
        }
      }
    })

    ws.addEventListener('close', () => {
      for (const { reject } of cdp.pending.values()) {
        reject(new Error('CDP socket closed'))
      }

      cdp.pending.clear()
    })

    return cdp
  }

  /** Connect straight to a discovered target. */
  static async connect(opts) {
    const target = await discoverTarget(opts)

    return CDP.open(target)
  }

  send(method, params = {}) {
    const id = ++this.id

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  on(method, handler) {
    if (!this.listeners.has(method)) {
      this.listeners.set(method, [])
    }

    this.listeners.get(method).push(handler)
  }

  /** Evaluate an expression in the page and return its value (awaits promises). */
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })

    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'eval failed')
    }

    return r.result.value
  }

  close() {
    this.ws.close()
  }
}

/** Assert the renderer has the dev-only `__PERF_DRIVE__` harness attached. */
export async function requireDriver(cdp) {
  const ok = await cdp.eval('!!(window.__PERF_DRIVE__ && window.__PERF_DRIVE__.stream)')

  if (!ok) {
    throw new Error(
      '__PERF_DRIVE__ not on window. The perf harness needs a DEV renderer ' +
        '(perf-probe.tsx is excluded from production builds). Launch with `npm run perf:serve`.'
    )
  }
}

/** Type real key events into the composer, one char at a time, at `cps` chars/sec. */
export async function typeIntoComposer(cdp, text, { cps = 15 } = {}) {
  await cdp.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(SELECTORS.composer)})
    if (!el) return false
    el.focus()
    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
    return true
  })()`)

  const intervalMs = Math.max(1, Math.round(1000 / cps))

  for (const ch of text) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: ch, unmodifiedText: ch })
    await sleep(intervalMs)
  }
}

/**
 * Run `body()` while a V8 CPU profile is recording. Returns
 * `{ result, profile }`; the caller decides whether to write the .cpuprofile.
 */
export async function withCpuProfile(cdp, body, { samplingIntervalUs = 100 } = {}) {
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: samplingIntervalUs })
  await cdp.send('Profiler.start')

  let result
  let stopped

  try {
    result = await body()
  } finally {
    // Always stop so a scenario error can't leave the profiler running.
    stopped = await cdp.send('Profiler.stop')
  }

  return { result, profile: stopped.profile }
}

export { sleep }
