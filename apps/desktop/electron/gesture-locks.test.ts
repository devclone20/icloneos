/**
 * F1-S (v0.0.9) — the preload's owner-click locks come from ONE registry, and every lock it creates is observed by
 * construction. Before v0.0.9 the preload created eight trackers and its capture listener fed seven: REL-6's
 * `acpToolsConfirm` was never observed, so the ACP tools' Install / Repair refused every real click (`gesture:false`).
 * Every UI test faked `window.hermesDesktop` and every main test injected `gestureOk`, so nothing caught it.
 *
 * Three layers here:
 * 1. the registry itself (gesture-locks.ts): one `observe` feeds every lock;
 * 2. the REAL preload, imported with a fake electron and a fake DOM: for every lock, a trusted click on its marked
 *    control opens exactly the bridge calls that use it (`confirm: true`), a script's synthetic event never does, and a
 *    click on another lock's control does not open it — the test that fails on the old preload (acpTools);
 * 3. static: no `createConfirmTracker(` in preload.ts at all, one `createGestureLocks(`, and the listener feeds only
 *    the registry.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as GestureLocksModule from './gesture-locks'
import { createGestureLocks } from './gesture-locks'

const PRELOAD = readFileSync(path.join(import.meta.dirname, 'preload.ts'), 'utf8')

// ── 1. the registry ─────────────────────────────────────────────────────────

describe('createGestureLocks', () => {
  const marked = (attribute: string) => ({ closest: (selector: string) => (selector === `[${attribute}]` ? {} : null) })

  const isOn = (attribute: string) => (target: unknown) =>
    (target as ReturnType<typeof marked>).closest(`[${attribute}]`) !== null

  it('one observe feeds every lock it built — none can be left out', () => {
    let now = 1000

    const registry = createGestureLocks({
      a: { isConfirmTarget: isOn('data-a'), now: () => now },
      b: { isConfirmTarget: isOn('data-b'), now: () => now },
      c: { isConfirmTarget: isOn('data-c'), now: () => now }
    })

    expect(registry.names).toEqual(['a', 'b', 'c'])

    for (const name of registry.names) {
      registry.observe({ isTrusted: true, target: marked(`data-${name}`), type: 'click' })
      now += 10
      expect(registry.locks[name].take(), name).toBe(true)
    }
  })

  it('a lock opens only for a trusted event on its own control, once', () => {
    const registry = createGestureLocks({
      a: { isConfirmTarget: isOn('data-a') },
      b: { isConfirmTarget: isOn('data-b') }
    })

    registry.observe({ isTrusted: false, target: marked('data-a'), type: 'click' })
    expect(registry.locks.a.take()).toBe(false)

    registry.observe({ isTrusted: true, target: marked('data-a'), type: 'click' })
    expect(registry.locks.b.take()).toBe(false)
    expect(registry.locks.a.take()).toBe(true)
    expect(registry.locks.a.take()).toBe(false)
  })

  it('is frozen: no lock can be swapped in after the listener holds it', () => {
    const registry = createGestureLocks({ a: { isConfirmTarget: isOn('data-a') } })

    expect(Object.isFrozen(registry)).toBe(true)
    expect(Object.isFrozen(registry.locks)).toBe(true)
  })

  it('refuses a lock with no confirm target', () => {
    expect(() => createGestureLocks({ a: {} as never })).toThrow(/no confirm target/)
  })
})

// ── 2. the real preload ─────────────────────────────────────────────────────

const lab = vi.hoisted(() => ({
  api: null as null | Record<string, any>,
  invokes: [] as { channel: string; args: unknown[] }[],
  listeners: [] as { type: string; fn: (event: unknown) => void; options: unknown }[],
  registries: [] as { names: readonly string[] }[]
}))

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, api: Record<string, any>) => {
      lab.api = api
    }
  },
  ipcRenderer: {
    sendSync: () => null,
    invoke: (channel: string, ...args: unknown[]) => {
      lab.invokes.push({ channel, args })

      return Promise.resolve(null)
    },
    on: () => undefined,
    removeListener: () => undefined,
    send: () => undefined
  },
  webFrame: { setZoomFactor: () => undefined },
  webUtils: { getPathForFile: () => '' }
}))

vi.mock('./gesture-locks', async importOriginal => {
  const real = await importOriginal<typeof GestureLocksModule>()

  return {
    ...real,
    createGestureLocks: (specs: Parameters<typeof real.createGestureLocks>[0]) => {
      const registry = real.createGestureLocks(specs)

      lab.registries.push(registry)

      return registry
    }
  }
})

/** Stands in for a DOM element carrying the given data attributes (what `closest('[attr]')` finds). */
class FakeElement {
  constructor(private readonly attributes: string[]) {}

  closest(selector: string): FakeElement | null {
    const match = /^\[([a-z-]+)\]$/.exec(selector)

    return match && this.attributes.includes(match[1]) ? this : null
  }
}

const REGISTER_ARGV = ['agent', 'register-erc8004', '--agent-id', 'a1', '--chain-id', '8453', '--json']
const DELETE_ARGV = ['offering', 'delete', '--offering-id', 'off-1', '--force', '--json']

/** Every lock: its marker, and the bridge calls that take it (channel + where the gesture sits in the payload). */
const LOCKS: { lock: string; marker: string; calls: { channel: string; call: (api: any) => unknown }[] }[] = [
  {
    lock: 'agentUpdate',
    marker: 'data-agent-update-confirm',
    calls: [{ channel: 'hermes:agent-update:gesture', call: api => api.agentUpdate.gesture() }]
  },
  {
    lock: 'permMode',
    marker: 'data-perm-mode-confirm',
    calls: [
      { channel: 'iclone:permissions:set-mode', call: api => api.icloneConsent.permissions.setMode({}) },
      { channel: 'iclone:permissions:revoke', call: api => api.icloneConsent.permissions.revoke('g1') }
    ]
  },
  {
    lock: 'doorAnswer',
    marker: 'data-consent-door-answer',
    calls: [{ channel: 'iclone:consent:door-answer', call: api => api.icloneConsent.doorAnswer({}) }]
  },
  {
    lock: 'acpWork',
    marker: 'data-acp-work-confirm',
    calls: [{ channel: 'iclone:acp-work:online', call: api => api.icloneAcpWork.online('slug-1') }]
  },
  {
    // The REL-6 bug: on the old preload this lock was never observed, so these stayed `confirm: false`.
    lock: 'acpTools',
    marker: 'data-acp-tools-confirm',
    calls: [
      { channel: 'iclone:acp-tools:install', call: api => api.icloneAcpTools.install() },
      { channel: 'iclone:acp-install', call: api => api.icloneAcp.install() }
    ]
  },
  {
    lock: 'confinement',
    marker: 'data-confinement-confirm',
    calls: [{ channel: 'iclone:confinement:set-isolation', call: api => api.icloneConfinement.setIsolation(true) }]
  },
  {
    lock: 'payments',
    marker: 'data-payments-confirm',
    calls: [{ channel: 'iclone:payments:revoke', call: api => api.payments.revoke('a'.repeat(32)) }]
  },
  {
    lock: 'acpRegister',
    marker: 'data-acp-register-confirm',
    calls: [{ channel: 'iclone:acp-owner-confirm', call: api => api.icloneAcp.ownerConfirm('inft-1', REGISTER_ARGV) }]
  },
  {
    lock: 'acpMarket',
    marker: 'data-acp-market-confirm',
    calls: [{ channel: 'iclone:acp-owner-confirm', call: api => api.icloneAcp.ownerConfirm('inft-1', DELETE_ARGV) }]
  },
  {
    lock: 'billingCharge',
    marker: 'data-billing-charge-confirm',
    calls: [
      { channel: 'iclone:billing:authorize-charge', call: api => api.billingCharge.authorize('25', 'key-0000-0001') },
      // v0.0.9 Q (lead decision 1): Upgrade / Change plan / Resume / auto-reload on take the same lock.
      {
        channel: 'iclone:billing:authorize-action',
        call: api => api.billingCharge.authorizeAction('subscription-upgrade', 'tier_pro', 'key-0000-0001')
      }
    ]
  },
  {
    // v0.0.9 F3 (R-f3-1, integration): Repair install on the boot card, and the kit's Repair / Undo in Diagnostics.
    lock: 'repairKit',
    marker: 'data-repair-kit-confirm',
    calls: [
      { channel: 'hermes:bootstrap:repair', call: api => api.repairBootstrap() },
      // v0.0.9 Q (F3 rerun): Install again reinstalls the runtime, on the same lock.
      { channel: 'hermes:agent-runtime:install-again', call: api => api.agentRuntime.installAgain() },
      // v0.0.9 critic m6: "Install the agent locally" starts the network install, on the same lock.
      { channel: 'hermes:bootstrap:continue-local', call: api => api.continueBootstrapLocal() },
      {
        channel: 'iclone:repair-kit:apply',
        call: api => api.icloneRepairKit.apply({ classId: 'stale-install-record', dryRun: false })
      },
      { channel: 'iclone:repair-kit:undo', call: api => api.icloneRepairKit.undo('20261117-stale-install-record') }
    ]
  },
  {
    // v0.0.9 W1b: the voice extra installs app-side, only on the owner's own click (red on the old preload: no lock).
    lock: 'voiceExtra',
    marker: 'data-voice-extra-confirm',
    calls: [{ channel: 'iclone:voice-extra:install', call: api => api.icloneVoiceExtra.install() }]
  },
  {
    // v0.0.9 Q (lead decision 2): "Quit Anyway" / "Restart now" in the window. Red on the old preload: the answer sent
    // only `activation`, so no lock, no confirm, and a script holding activation could answer it.
    lock: 'nativeDecision',
    marker: 'data-native-decision-confirm',
    calls: [{ channel: 'iclone:native-decision:answer', call: api => api.nativeDecisions.answer('nd-1', 1) }]
  }
]

function fire(target: unknown, isTrusted: boolean) {
  for (const listener of lab.listeners) {
    // The gesture listener is the `{ capture: true }` one; the link router's (`true`) never sees these targets.
    if (listener.type === 'click' && typeof listener.options === 'object') {
      listener.fn({ isTrusted, target, type: 'click' })
    }
  }
}

/** The `confirm` flag main would receive from the last invoke on `channel`. */
function confirmSent(channel: string): unknown {
  const last = lab.invokes.filter(entry => entry.channel === channel).at(-1)
  const payload = last?.args[0] as Record<string, any> | undefined

  return channel === 'hermes:agent-update:gesture' ? payload?.confirm : payload?.gesture?.confirm
}

describe('the real preload: every lock is observed (F1-S)', () => {
  beforeAll(async () => {
    vi.stubGlobal('Element', FakeElement)
    vi.stubGlobal('KeyboardEvent', class {})
    vi.stubGlobal('navigator', { userActivation: { isActive: true } })
    vi.stubGlobal('document', { hasFocus: () => true, documentElement: { lang: 'en' } })
    vi.stubGlobal('window', {
      addEventListener: (type: string, fn: (event: unknown) => void, options: unknown) =>
        lab.listeners.push({ type, fn, options }),
      location: { href: 'app://iclone/index.html', search: '' }
    })

    // Only the preload's own registry counts (the registry tests above built theirs through the same mock).
    lab.registries.length = 0
    await import('./preload')
  })

  afterAll(() => {
    vi.unstubAllGlobals()
  })

  beforeEach(() => {
    lab.invokes.length = 0
  })

  it('builds exactly one registry, holding every lock this test knows (and the folder lock)', () => {
    expect(lab.api).not.toBeNull()
    expect(lab.registries).toHaveLength(1)
    expect([...lab.registries[0].names].sort()).toEqual([...LOCKS.map(entry => entry.lock), 'folder'].sort())
  })

  for (const { lock, marker, calls } of LOCKS) {
    for (const { channel, call } of calls) {
      it(`${lock}: a trusted click on [${marker}] opens ${channel}`, () => {
        fire(new FakeElement([marker]), true)
        call(lab.api)

        expect(confirmSent(channel)).toBe(true)
      })

      it(`${lock}: a script's synthetic click (el.click(), dispatchEvent) never opens ${channel}`, () => {
        fire(new FakeElement([marker]), false)
        call(lab.api)

        expect(confirmSent(channel)).toBe(false)
      })

      it(`${lock}: a real click on another lock's control does not open ${channel}`, () => {
        const other = LOCKS.find(entry => entry.marker !== marker && entry.calls[0].channel !== channel)!

        fire(new FakeElement([other.marker]), true)
        call(lab.api)

        expect(confirmSent(channel)).toBe(false)
      })
    }
  }

  it('an owner-locked ACP argv takes ITS lock: a market click never opens the ERC-8004 registration', () => {
    fire(new FakeElement(['data-acp-market-confirm']), true)
    lab.api!.icloneAcp.ownerConfirm('inft-1', REGISTER_ARGV)

    const payload = lab.invokes.at(-1)?.args[0] as Record<string, any>

    expect(payload.lock).toBe('acp-register')
    expect(payload.gesture.confirm).toBe(false)
  })

  it('an argv that is not owner-locked takes no confirm and reaches no channel', async () => {
    fire(new FakeElement(['data-acp-market-confirm']), true)

    expect(await lab.api!.icloneAcp.ownerConfirm('inft-1', ['offering', 'list', '--json'])).toMatchObject({ ok: false })
    expect(lab.invokes).toHaveLength(0)
  })
})

// ── 3. static ───────────────────────────────────────────────────────────────

describe('preload.ts: no lock outside the registry (static)', () => {
  const code = PRELOAD.replace(/\/\/.*$/gm, '').replace(/\/\*[^]*?\*\//g, '')

  it('never calls createConfirmTracker( — and does not even import it', () => {
    expect(code).not.toMatch(/createConfirmTracker\s*\(/)
    expect(code).not.toMatch(/import[^;]*\bcreateConfirmTracker\b/)
  })

  it('builds the registry once, and the capture listener feeds only the registry', () => {
    expect(code.match(/createGestureLocks\s*\(/g)).toHaveLength(1)
    expect(code.match(/\.observe\(observed\)/g)).toEqual(['.observe(observed)'])
    expect(code).toContain('gestureLocks.observe(observed)')
  })

  it('every tracker the bridge takes a confirm from comes out of the registry', () => {
    const taken = [...code.matchAll(/userGesture\(([^)]+)\)|(\w+)\.take\(\)/g)].map(match => match[1] ?? match[2])

    const fromRegistry = new Set(
      [...code.matchAll(/const (\w+) = gestureLocks\.locks\.\w+/g)].map(match => match[1]).concat('acpOwnerLocks[lock]')
    )

    expect(taken.length).toBeGreaterThan(20)
    expect(taken.filter(name => !fromRegistry.has(name) && name !== 'tracker')).toEqual([])
  })
})
