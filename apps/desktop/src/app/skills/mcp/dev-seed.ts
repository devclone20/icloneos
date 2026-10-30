/**
 * Dev-only seed for the MCP tab's two data-bearing states.
 *
 * The front's target asks for the server list, its row actions and the
 * inspector to be proven on a real lab window, and a fresh user has no MCP
 * server configured: the rows, the add row and the config pane render on zero
 * nodes, so a probe can only ever reach the catalog. Nothing outside the app
 * can change that — `contextBridge` exposes `window.hermesDesktop` as a
 * NON-CONFIGURABLE, deep-frozen property (measured on lab 2 by E3d2), so the
 * config query cannot be stubbed from outside. Same shape and the same
 * reasoning as `../dev-fault.ts`.
 *
 * One optional window field, read only under `import.meta.env.DEV`: a
 * production build drops the branch with the constant, and an app where nobody
 * sets the field behaves exactly as before. The seed is READ-ONLY by
 * construction — `McpTab` refuses to persist while it is armed, because a stub
 * fleet is not a real one and saving it would write stub servers into the
 * user's config.
 */
import { type McpCatalogEntry } from '@/hermes'
import { type McpServers } from '@/lib/mcp-servers'

const FIELD = '__icloneMcpSeed'

/** The only accepted value; anything else clears the seed. */
type McpSeedArm = 'fleet'

export interface McpSeed {
  /** Prepended to the live catalog, so the real entries still render. */
  catalog: McpCatalogEntry[]
  servers: McpServers
}

// How many filler rows the fleet carries beyond the two named ones. The server
// list is its own scroller (clientHeight 640 on lab 2) and a row sitting at its
// bottom edge is the case the hover hint has to survive, so the seeded fleet has
// to be taller than the scroller: 20 rows of h-11 are 880 px.
const FILLER_ROWS = 18

// EVERY seeded server is switched off, and that is a safety property, not a
// style: `use-mcp-probes` auto-probes enabled servers as the config arrives,
// which would have the backend spawn each of these commands. Disabled rows
// paint `.icsk__srv-name--off` + the status line + both row actions and call
// nothing; the enabled name rung paints on the catalog entries beside them.
const fleet = (): McpServers => {
  const servers: McpServers = {
    'seed-files': {
      args: ['-y', 'iclone-seed-mcp', '/seed'],
      command: 'npx',
      enabled: false,
      env: { SEED_TOKEN: 'seed' }
    },
    'seed-off': { args: ['-y', 'iclone-seed-mcp'], command: 'npx', enabled: false }
  }

  for (let i = 1; i <= FILLER_ROWS; i++) {
    servers[`seed-${String(i).padStart(2, '0')}`] = {
      args: ['-y', 'iclone-seed-mcp'],
      command: 'npx',
      enabled: false
    }
  }

  return servers
}

const SEED: McpSeed = {
  catalog: [
    {
      args: [],
      auth_type: 'api_key',
      bootstrap: [],
      command: 'iclone-seed-mcp',
      default_enabled: null,
      description: 'Seeded catalog entry. Dev-only, never installed: it exists so the credential prompt can be driven.',
      enabled: false,
      install_ref: null,
      install_url: null,
      installed: false,
      name: 'seed-catalog',
      needs_install: false,
      post_install: '',
      // `required: true` with no draft value keeps `install()` on its first
      // branch — it reveals the prompt and returns, never calling the backend.
      required_env: [{ name: 'SEED_TOKEN', prompt: 'Seed token', required: true }],
      source: 'seed',
      transport: 'stdio',
      url: null
    }
  ],
  servers: fleet()
}

let armed: McpSeedArm | null = null

const normalize = (value: unknown): McpSeedArm | null => (value === 'fleet' ? 'fleet' : null)

const seedFor = (arm: McpSeedArm | null): McpSeed | null => (arm === null ? null : SEED)

/** The stub fleet a dev (or a CDP probe) armed, or null. */
export function mcpSeed(): McpSeed | null {
  if (!import.meta.env.DEV || typeof window === 'undefined') {
    return null
  }

  // Read through the FIELD, not the backing store: a probe may arm the seed
  // before the page mounts and installs the accessor.
  return seedFor(normalize((window as unknown as Record<string, unknown>)[FIELD]))
}

/**
 * Install the seam, once, from the page.
 *
 * An ACCESSOR, not a plain data property, because arming the seed has to repaint
 * the list as well (`../dev-fault.ts` carries the same reasoning for the two
 * capability lists). The getter answers the ARM TOKEN, so a page that mounts
 * after the seam is installed still normalizes the same value.
 */
export function installMcpSeedSeam(onArm: (seed: McpSeed | null) => void): void {
  if (!import.meta.env.DEV || typeof window === 'undefined') {
    return
  }

  const host = window as unknown as Record<string, unknown>
  const existing = Object.getOwnPropertyDescriptor(host, FIELD)

  if (existing?.get) {
    return
  }

  // A probe that armed the seed before this ran left a plain data property.
  armed = normalize(host[FIELD])

  Object.defineProperty(host, FIELD, {
    // Non-configurable so `delete` cannot drop the accessor and leave a stale
    // `armed` behind: clearing the seed is `window.__icloneMcpSeed = null`.
    configurable: false,
    get: () => armed,
    set: (value: unknown) => {
      armed = normalize(value)
      onArm(seedFor(armed))
    }
  })
}
