/**
 * v0.0.9 r3 (lead order 5): a FIXTURE wallet for offline captures of every Collection and wallet state — a throwaway
 * profile signs in to a fixture address, its roster scan answers fixture iNFTs (or empty, or an error then the grid
 * on Retry, after an optional delay for the loading skeleton), and its balances answer fixture rows. No network, no
 * Privy window, no real session is read or written.
 *
 * DEV / TEST BUILDS ONLY. The switch is the code-path variable `HERMES_DESKTOP_FIXTURE_WALLET`, read through
 * `codePathEnv` (packaged-env.ts): a packaged build answers `undefined` for it, whatever the environment says, and seals
 * it out of every child's environment (it is in CODE_PATH_ENV). So the shipped app can never be told to fake a wallet.
 *
 *   HERMES_DESKTOP_FIXTURE_WALLET=builtin:grid     six iNFTs (the 2-column grid), balances on three chains
 *   HERMES_DESKTOP_FIXTURE_WALLET=builtin:empty    signed in, no iNFT (the empty state)
 *   HERMES_DESKTOP_FIXTURE_WALLET=builtin:error    every scan fails (the error state + Retry)
 *   HERMES_DESKTOP_FIXTURE_WALLET=builtin:retry    the first scan fails, Retry brings the grid
 *   HERMES_DESKTOP_FIXTURE_WALLET=builtin:slow     the grid after 8 s (the loading skeleton)
 *   HERMES_DESKTOP_FIXTURE_WALLET=builtin:partial  the grid, but Robinhood could not be read (missing-chains alert)
 *   HERMES_DESKTOP_FIXTURE_WALLET=builtin:balances-slow   the grid; balances after 8 s (popover loading)
 *   HERMES_DESKTOP_FIXTURE_WALLET=builtin:balances-error  the grid; every balances fetch fails (popover error)
 *   HERMES_DESKTOP_FIXTURE_WALLET=builtin:reopen   the grid; iCLONE Aurora carries a fixture 3D model and a fixture
 *                                                  soul, so every launch summons it (the stage, "Open in new window")
 *                                                  and connects its persona: the F2 reopen proof (eng r3 MR3-1)
 *   HERMES_DESKTOP_FIXTURE_WALLET=/abs/path.json   your own fixture (FixtureWalletFile below)
 *
 * Both scans are faked: the Home roster (`iclone:inft-scan`, the Collection) and the iNFT Book's pages
 * (`iclone:inft-book-scan`), each failing or answering per scenario, so the Book's error + Retry is reachable too.
 *
 * v0.0.9 r3b (MR3-1): the agent path is the real one. A fixture roster scan is noted like a real one (the session is
 * the fixture address), so `iclone:acp-run` admits the fixture iNFTs; a fixture iNFT with `soul` resolves its profile
 * here (no chain, no network) and one with `model` gets `FIXTURE_MODEL_URL`, whose bytes are a tiny built-in GLB
 * (`fixtureModelGlb`, served by iclone-model.ts only while a fixture is active). All of it is off when packaged.
 * Pure and Electron-free except for the file read; iclone-privy.ts, iclone-balances.ts and iclone-model.ts consult it.
 */
import fs from 'node:fs'
import path from 'node:path'

export const FIXTURE_WALLET_ENV = 'HERMES_DESKTOP_FIXTURE_WALLET'

export type FixtureScan = 'empty' | 'error' | 'error-then-grid' | 'grid'

export interface FixtureInft {
  readonly chain: string
  readonly contract: string
  readonly tokenId: string
  readonly name: string
  readonly image: string
  /** '' or FIXTURE_MODEL_URL (the built-in GLB): never a URL to fetch. */
  readonly model?: string
  /** True: the iNFT has a fixture soul (an agent_bootstrap block whose profile resolves offline). */
  readonly soul?: boolean
}

/**
 * The one model URL a fixture may name. `.invalid` never resolves (RFC 2606), so outside a fixture run (a packaged
 * build) the fetch simply fails; inside one, iclone-model.ts answers it with `fixtureModelGlb()` and never caches it.
 */
export const FIXTURE_MODEL_URL = 'https://fixture.invalid/iclone-fixture-stage.glb'

/** The bootstrap block a fixture soul carries: protocol `iclone-fixture`, nothing to fetch. */
export const FIXTURE_BOOTSTRAP = {
  version: 1,
  protocol: 'iclone-fixture',
  repo: '',
  genesis: '',
  soul_sha256: '',
  identity_sha256: '',
  manifest: '',
  byok: false
} as const

export interface FixtureWallet {
  readonly address: string
  readonly label: string
  readonly scan: FixtureScan
  /** How long each scan takes (the loading skeleton), 0–30 s. */
  readonly scanDelayMs: number
  readonly infts: readonly FixtureInft[]
  /** Chain key → decimal balance string; chains left out read 0. */
  readonly balances: Readonly<Record<string, string>>
  /** Chains the scan says it could not read to the end (the Collection's missing-chains alert); [] = none. */
  readonly incomplete: readonly string[]
  /** How long the balances take (the wallet popover's loading state), 0–30 s. */
  readonly balancesDelayMs: number
  /** Every balances fetch fails (the popover's error state). */
  readonly balancesFail: boolean
}

/** The JSON a custom fixture file holds (every field but `address` optional). */
export interface FixtureWalletFile {
  address: string
  label?: string
  scan?: FixtureScan
  scanDelayMs?: number
  infts?: FixtureInft[]
  balances?: Record<string, string>
  incomplete?: string[]
  balancesDelayMs?: number
  balancesFail?: boolean
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const DECIMAL = /^\d{1,12}(\.\d{1,18})?$/
const SCANS: readonly FixtureScan[] = ['empty', 'error', 'error-then-grid', 'grid']
const MAX_INFTS = 64
const MAX_FILE_BYTES = 256 * 1024

const BUILTIN_ADDRESS = '0x00000000000000000000000000000000f1c7a7e5'
const BUILTIN_CONTRACT = '0x000000000000000000000000000000000000c10e'

/**
 * Six fixture iNFTs. Their images start empty (the card's own placeholder head); a dev/test run gives them the art
 * tiles in apps/desktop/fixtures/inft-art (`withFixtureArt`, design r3 MAJOR 2), read from disk as data: URIs.
 */
const BUILTIN_INFTS: readonly FixtureInft[] = ['Aurora', 'Basalt', 'Cinder', 'Delta', 'Ember', 'Fjord'].map(
  (name, index) => ({
    chain: index % 3 === 2 ? 'Robinhood' : 'Base',
    contract: BUILTIN_CONTRACT,
    tokenId: String(101 + index),
    name: `iCLONE ${name}`,
    image: ''
  })
)

const BUILTIN_BALANCES = { base: '0.042817', ethereum: '0.0035', robinhood: '1.25' }

/** builtin:reopen — the first iNFT is the one every launch summons: a model and a soul. */
const REOPEN_INFTS: readonly FixtureInft[] = BUILTIN_INFTS.map((inft, index) =>
  index === 0 ? { ...inft, model: FIXTURE_MODEL_URL, soul: true } : inft
)

function builtin(name: string): FixtureWallet | null {
  const base = {
    address: BUILTIN_ADDRESS,
    label: 'Fixture wallet',
    scanDelayMs: 600,
    infts: BUILTIN_INFTS,
    balances: BUILTIN_BALANCES,
    incomplete: [] as string[],
    balancesDelayMs: 300,
    balancesFail: false
  }

  switch (name) {
    case 'grid':
      return { ...base, scan: 'grid' }

    case 'empty':
      return { ...base, scan: 'empty', infts: [] }

    case 'error':
      return { ...base, scan: 'error' }

    case 'retry':
      return { ...base, scan: 'error-then-grid' }

    case 'slow':
      return { ...base, scan: 'grid', scanDelayMs: 8_000 }

    case 'partial':
      return { ...base, scan: 'grid', incomplete: ['Robinhood'] }

    case 'balances-slow':
      return { ...base, scan: 'grid', balancesDelayMs: 8_000 }

    case 'balances-error':
      return { ...base, scan: 'grid', balancesFail: true }

    case 'reopen':
      return { ...base, scan: 'grid', infts: REOPEN_INFTS }

    default:
      return null
  }
}

const str = (value: unknown, max: number): null | string =>
  typeof value === 'string' && value.length <= max ? value : null

/** A fixture file's content, validated field by field; null when anything is malformed. */
export function parseFixtureWallet(raw: unknown): FixtureWallet | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }

  const file = raw as Partial<Record<keyof FixtureWalletFile, unknown>>
  const address = str(file.address, 42)

  if (!address || !ADDRESS.test(address)) {
    return null
  }

  const scan = file.scan === undefined ? 'grid' : SCANS.find(s => s === file.scan)
  const delay = file.scanDelayMs === undefined ? 600 : file.scanDelayMs

  if (!scan || typeof delay !== 'number' || !Number.isInteger(delay) || delay < 0 || delay > 30_000) {
    return null
  }

  const inftsRaw = file.infts === undefined ? BUILTIN_INFTS : file.infts

  if (!Array.isArray(inftsRaw) || inftsRaw.length > MAX_INFTS) {
    return null
  }

  const infts: FixtureInft[] = []

  for (const item of inftsRaw as unknown[]) {
    const it = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
    const chain = str(it.chain, 32)
    const contract = str(it.contract, 42)
    const tokenId = str(it.tokenId, 78)
    const name = str(it.name, 120)
    const image = it.image === undefined ? '' : str(it.image, 2048)
    const model = it.model === undefined ? '' : it.model
    const soul = it.soul === undefined ? false : it.soul

    if (!chain || !contract || !ADDRESS.test(contract) || !tokenId || !/^\d+$/.test(tokenId) || !name || image === null) {
      return null
    }

    // Offline by construction: an image is a data: URI or nothing, never a URL to fetch; a model is the built-in one.
    if (image && !image.startsWith('data:image/')) {
      return null
    }

    if ((model !== '' && model !== FIXTURE_MODEL_URL) || typeof soul !== 'boolean') {
      return null
    }

    infts.push({ chain, contract, tokenId, name, image, ...(model ? { model } : {}), ...(soul ? { soul } : {}) })
  }

  const balancesRaw = file.balances === undefined ? BUILTIN_BALANCES : file.balances

  if (!balancesRaw || typeof balancesRaw !== 'object' || Array.isArray(balancesRaw)) {
    return null
  }

  const balances: Record<string, string> = {}

  for (const [key, value] of Object.entries(balancesRaw as Record<string, unknown>)) {
    if (!/^[a-z]{2,16}$/.test(key) || typeof value !== 'string' || !DECIMAL.test(value)) {
      return null
    }

    balances[key] = value
  }

  const label = file.label === undefined ? 'Fixture wallet' : str(file.label, 64)
  const incomplete = file.incomplete === undefined ? [] : file.incomplete
  const balancesDelayMs = file.balancesDelayMs === undefined ? 300 : file.balancesDelayMs
  const balancesFail = file.balancesFail === undefined ? false : file.balancesFail

  if (
    !Array.isArray(incomplete) ||
    incomplete.length > 8 ||
    !incomplete.every(chain => typeof chain === 'string' && /^[A-Za-z][A-Za-z ]{0,31}$/.test(chain)) ||
    typeof balancesDelayMs !== 'number' ||
    !Number.isInteger(balancesDelayMs) ||
    balancesDelayMs < 0 ||
    balancesDelayMs > 30_000 ||
    typeof balancesFail !== 'boolean'
  ) {
    return null
  }

  return label === null
    ? null
    : {
        address,
        label,
        scan,
        scanDelayMs: delay,
        infts,
        balances,
        incomplete: incomplete as string[],
        balancesDelayMs,
        balancesFail
      }
}

/**
 * The fixture this run uses, from the code-path variable's value (already `undefined` in a packaged build). `isPackaged`
 * is checked again here: two locks, so a refactor of one never ships a fake wallet.
 */
export function resolveFixtureWallet(value: string | undefined, isPackaged: boolean): FixtureWallet | null {
  if (isPackaged || !value) {
    return null
  }

  if (value.startsWith('builtin:')) {
    return builtin(value.slice('builtin:'.length))
  }

  if (!path.isAbsolute(value)) {
    return null
  }

  try {
    const stat = fs.statSync(value)

    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
      return null
    }

    return parseFixtureWallet(JSON.parse(fs.readFileSync(value, 'utf8')))
  } catch {
    return null
  }
}

/** v0.0.9 r4: the art tiles are a dev/test asset folder, never in the packed app (package.json build.files). */
export const FIXTURE_ART_DIR = path.join('fixtures', 'inft-art')
const MAX_ART_BYTES = 16 * 1024
const ART_FILE = /^(\d{1,6})-[a-z0-9-]{1,40}\.svg$/

/**
 * v0.0.9 r4 (design r3 MAJOR 2): real-looking art for the BUILT-IN fixture iNFTs, so the Home Collection and the Book
 * render populated. Each `<tokenId>-<name>.svg` in `artDir` becomes that iNFT's `data:image/svg+xml` image — read from
 * disk, never fetched, never cached. Three locks: a packaged build gets the fixture back untouched (it is null there
 * anyway), the folder is not packed (package.json build.files), and only built-in iNFTs (the fixture contract) with no
 * image of their own are touched. A missing folder, an odd name or an oversize file is skipped, never an error.
 */
export function withFixtureArt(fixture: FixtureWallet | null, isPackaged: boolean, artDir: string): FixtureWallet | null {
  if (!fixture || isPackaged) {
    return fixture
  }

  const art = new Map<string, string>()

  try {
    for (const name of fs.readdirSync(artDir)) {
      const match = ART_FILE.exec(name)
      const file = path.join(artDir, name)

      if (!match || art.has(match[1])) {
        continue
      }

      const stat = fs.statSync(file)

      if (stat.isFile() && stat.size > 0 && stat.size <= MAX_ART_BYTES) {
        const svg = fs.readFileSync(file)

        if (/^\s*<svg[\s>]/.test(svg.toString('utf8', 0, 64))) {
          art.set(match[1], `data:image/svg+xml;base64,${svg.toString('base64')}`)
        }
      }
    }
  } catch {
    return fixture
  }

  if (art.size === 0) {
    return fixture
  }

  return {
    ...fixture,
    infts: fixture.infts.map(inft =>
      inft.contract === BUILTIN_CONTRACT && !inft.image && art.has(inft.tokenId)
        ? { ...inft, image: art.get(inft.tokenId)! }
        : inft
    )
  }
}

/** The scan answer of the `attempt`-th scan (0-based) for this fixture, in iclone-privy's InftScanResult shape. */
export function fixtureScanResult(fixture: FixtureWallet, attempt: number) {
  const fails = fixture.scan === 'error' || (fixture.scan === 'error-then-grid' && attempt === 0)

  if (fails) {
    return { ok: false, source: 'none' as const, agents: [], complete: false, error: 'fixture: the scan failed' }
  }

  const agents =
    fixture.scan === 'empty'
      ? []
      : fixture.infts.map(({ soul, ...inft }) => ({
          ...inft,
          model: inft.model ?? '',
          isAgentNft: true,
          backdrop: '',
          bootstrap: soul ? { ...FIXTURE_BOOTSTRAP } : null
        }))

  // A partial scan (some chains unread) keeps what it read and names the rest: the Collection's missing-chains alert.
  return fixture.incomplete.length > 0
    ? { ok: true, source: 'indexer' as const, agents, complete: false, incomplete: [...fixture.incomplete] }
    : { ok: true, source: 'indexer' as const, agents, complete: true }
}

/**
 * The iNFT Book's page answer (`iclone:inft-book-scan`, one page per scan) for the `attempt`-th Book scan: it fails
 * as the roster scan does (the Book's error + Retry), and a partial fixture answers what it read then a failed page.
 */
export function fixtureBookPage(fixture: FixtureWallet, attempt: number, cursor: unknown) {
  const roster = fixtureScanResult(fixture, attempt)

  if (!roster.ok) {
    return { ok: false, items: [], cursor: null, done: false, error: 'fixture: the page failed' }
  }

  // The second page of a partial fixture: the unread chain.
  if (cursor !== null && cursor !== undefined) {
    return { ok: false, items: [], cursor, done: false, error: 'fixture: an unread chain' }
  }

  const partial = fixture.incomplete.length > 0

  return {
    ok: true,
    items: roster.agents,
    cursor: partial ? { chain: fixture.incomplete[0], params: null } : null,
    done: !partial
  }
}

/** The soul a fixture iNFT speaks with (its profile, resolved offline). */
export function fixtureSoul(name: string): string {
  return [
    `# ${name}`,
    '',
    `You are ${name}, a fixture iNFT of the iCLONE OS development build. You exist so the app can prove, offline,`,
    'that an iNFT on the home reconnects by itself after every reopen. Answer briefly and plainly.',
    ''
  ].join('\n')
}

/**
 * The profile of a fixture iNFT with a soul (iclone-profile's ResolvedInftProfile), or null when the item is not one of
 * this fixture's soul iNFTs (the caller then resolves it the real way).
 */
export function fixtureProfile(fixture: FixtureWallet, item: { contract?: unknown; tokenId?: unknown }, slug: string) {
  const contract = typeof item.contract === 'string' ? item.contract.toLowerCase() : ''

  const inft = fixture.infts.find(
    candidate => candidate.soul && candidate.contract.toLowerCase() === contract && candidate.tokenId === item.tokenId
  )

  return inft
    ? {
        slug,
        name: inft.name,
        soulMd: fixtureSoul(inft.name),
        identity: null,
        source: 'genesis' as const,
        identityVerified: false,
        soulVerified: false
      }
    : null
}

/**
 * The fixture's 3D model: a small, valid glTF 2.0 binary (one lit box mesh, about 1.4 KB), built in code so the repo
 * carries no binary and the stage needs no network. A plain mesh: the stage frames its visible bounds.
 */
export function fixtureModelGlb(): Buffer {
  // A box 0.6 × 1.8 × 0.4 (a standing figure's proportions), 6 faces × 4 vertices with flat normals.
  const [hx, hy, hz] = [0.3, 0.9, 0.2]

  const faces: Array<{ n: [number, number, number]; v: Array<[number, number, number]> }> = [
    { n: [1, 0, 0], v: [[hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz], [hx, -hy, hz]] },
    { n: [-1, 0, 0], v: [[-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz], [-hx, -hy, -hz]] },
    { n: [0, 1, 0], v: [[-hx, hy, -hz], [-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz]] },
    { n: [0, -1, 0], v: [[-hx, -hy, hz], [-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz]] },
    { n: [0, 0, 1], v: [[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]] },
    { n: [0, 0, -1], v: [[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]] }
  ]

  const positions = new Float32Array(faces.flatMap(face => face.v.flat()))
  const normals = new Float32Array(faces.flatMap(face => face.v.flatMap(() => face.n)))
  const indices = new Uint16Array(faces.flatMap((_, f) => [0, 1, 2, 0, 2, 3].map(i => f * 4 + i)))

  const bin = Buffer.concat([
    Buffer.from(positions.buffer),
    Buffer.from(normals.buffer),
    Buffer.from(indices.buffer),
    Buffer.alloc((4 - (indices.byteLength % 4)) % 4)
  ])

  const json = {
    asset: { version: '2.0', generator: 'iclone-fixture-wallet' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'fixture-agent' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
    materials: [
      {
        name: 'fixture-metal',
        pbrMetallicRoughness: { baseColorFactor: [0.62, 0.66, 0.72, 1], metallicFactor: 0.8, roughnessFactor: 0.35 }
      }
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 24, type: 'VEC3', min: [-hx, -hy, -hz], max: [hx, hy, hz] },
      { bufferView: 1, componentType: 5126, count: 24, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: 36, type: 'SCALAR' }
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength, target: 34962 },
      { buffer: 0, byteOffset: positions.byteLength, byteLength: normals.byteLength, target: 34962 },
      { buffer: 0, byteOffset: positions.byteLength + normals.byteLength, byteLength: indices.byteLength, target: 34963 }
    ],
    buffers: [{ byteLength: bin.length }]
  }

  const text = Buffer.from(JSON.stringify(json), 'utf8')
  const jsonChunk = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)])
  const header = Buffer.alloc(12)
  const total = 12 + 8 + jsonChunk.length + 8 + bin.length

  header.writeUInt32LE(0x46546c67, 0) // "glTF"
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(total, 8)

  const chunk = (type: number, body: Buffer) => {
    const head = Buffer.alloc(8)

    head.writeUInt32LE(body.length, 0)
    head.writeUInt32LE(type, 4)

    return Buffer.concat([head, body])
  }

  return Buffer.concat([header, chunk(0x4e4f534a, jsonChunk), chunk(0x004e4942, bin)])
}

/**
 * The dev reopen loop's marker (the harness greps desktop.log for it). The renderer logs `[inft-switch] <slug> done …`
 * at info level, which desktop.log never keeps; while a fixture is active main copies exactly those lines in, as
 * `[fixture] inft connected <slug> (<ms> ms<, scope>)`. Null for every other line, and always null without a fixture.
 */
export function fixtureSwitchLogLine(fixture: FixtureWallet | null, message: unknown): null | string {
  if (!fixture || typeof message !== 'string') {
    return null
  }

  const done = /^\[inft-switch\] (inft-[a-z0-9-]{1,80}) done (\d{1,9})(?: ([a-z-]{1,40}))?$/.exec(message)

  return done ? `[fixture] inft connected ${done[1]} (${done[2]} ms${done[3] ? `, ${done[3]}` : ''})` : null
}

/** The session payload a fixture run reports (iclone-privy's IclonePrivySessionPayload). */
export function fixtureSession(fixture: FixtureWallet, signedIn: boolean) {
  return signedIn
    ? { status: 'in' as const, address: fixture.address, userId: 'fixture-user', label: fixture.label }
    : { status: 'out' as const, address: null, userId: null, label: null }
}

let active: FixtureWallet | null = null

/** Set once by iclone-privy.ts at init (from `codePathEnv`, so never in a packaged build). */
export function setActiveFixtureWallet(fixture: FixtureWallet | null): void {
  active = fixture
}

/** The fixture this run uses, or null (always null in a packaged build). */
export function activeFixtureWallet(): FixtureWallet | null {
  return active
}
