// The ONE marker list of scripts/artifact-hygiene.mjs. Build-only (scripts/ is never packed); the scan skips only a
// byte-identical copy of this file (its sha256), never a file that merely borrows the name. Nothing owner-identifying
// is stored here, not even as a digest (ruling 48): those markers are loaded at scan time (scripts/private-markers.mjs).

const SERVICE_ISSUER_RE = /privy|virtuals|agentcard|(?:^|[^a-z])acp(?:[^a-z]|$)/i

// Every table below is frozen, rows included: one module instance serves every importer of a process (the release
// scripts, make-distribution, their tests), so a row changed by one caller would silently change the others' scans.
// A write throws (modules are strict); compileMarkers() in artifact-hygiene.mjs copies what the scan needs.
const table = rows => Object.freeze(rows.map(row => (typeof row === 'object' ? Object.freeze(row) : row)))

/** True when a JWT's payload names Privy, Virtuals/ACP or AgentCard as issuer or audience. */
export function serviceJwt(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))

    return [payload.iss, payload.aud].flat().some(v => typeof v === 'string' && SERVICE_ISSUER_RE.test(v))
  } catch {
    return false
  }
}

/**
 * Regex shapes: key and token formats, user DIDs, lab paths and usage slugs. `check` (optional) confirms a match. A
 * placeholder such as `sk-ant-...` must not match. Every quantifier is bounded: V8 overflows its backtrack stack on one
 * multi-megabyte run, and a shape without `check` only needs its minimum length to be found.
 */
export const SHAPES = table([
  { id: 'key.anthropic', re: /sk-ant-[A-Za-z0-9_-]{20}/g },
  { id: 'key.openai', re: /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9]{32}/g },
  { id: 'key.github', re: /ghp_[A-Za-z0-9]{30}/g },
  { id: 'usage.inft-slug', re: /inft-4dfb27-[a-z0-9]/gi },
  { id: 'lab.run-nosync', re: /RESUME[\\/]run\.nosync/g },
  { id: 'lab.devdata', re: /(?<![A-Za-z0-9_-])devdata\d{0,16}(?=[\\/"'\s]|$)/g },
  { id: 'lab.release-keychain', re: /iclone-release\.keychain/g },
  // A Privy user DID names one person (the owner's included); the app's public Privy app id is a bare id, never a DID.
  { id: 'id.privy-did', re: /did:privy:[a-z0-9]{16}/gi },
  // Virtuals GAME API key, and a value assigned to a Virtuals/ACP or AgentCard key, token, secret or session name.
  // The value must carry two digits, so placeholders such as `your-api-key-here` stay quiet.
  { id: 'key.virtuals-game', re: /(?<![A-Za-z0-9])apt-[0-9a-f]{32}(?![0-9a-f])/gi },
  {
    id: 'key.virtuals-assigned',
    re: /(?:virtuals|game|acp)[_-]?[a-z0-9_-]{0,24}?(?:api[_-]?key|token|secret|session|private[_-]?key)["']?\s{0,64}[:=]\s{0,64}["'`]?(?=(?:[A-Za-z0-9._-]{0,4096}?\d){2})[A-Za-z0-9._-]{20}/gi
  },
  {
    id: 'key.agentcard-assigned',
    re: /agent[_-]?card[_-]?[a-z0-9_-]{0,24}?(?:api[_-]?key|token|secret|session)["']?\s{0,64}[:=]\s{0,64}["'`]?(?=(?:[A-Za-z0-9._-]{0,4096}?\d){2})[A-Za-z0-9._-]{20}/gi
  },
  // A session JWT issued by Privy, Virtuals/ACP or AgentCard (checked on the decoded payload's iss/aud).
  {
    id: 'token.service-jwt',
    // Header bounded to 1 KiB (a real JWT header is < 200 B): 8 MB of dense 'eyJ' scans in < 6 s instead of 75 s.
    re: /eyJ[A-Za-z0-9_-]{8,1024}\.eyJ[A-Za-z0-9_-]{8,65536}\.[A-Za-z0-9_-]{16}/g,
    check: serviceJwt
  }
])

// Owner-identity markers (his user name, alias, first name, wallets, agent ids) are NOT here (ruling 48): a digest of
// a short private value is that value once the repo is public. scripts/private-markers.mjs loads them when a scan
// runs, from a private file outside the repo and from the machine itself; a release scan fails closed without them.

export const BIP39_LENGTHS = table([12, 15, 18, 21, 24])

/**
 * Public example seed phrases (sha256 of the lowercase words joined by one space): test vectors and JSDoc examples of
 * third-party wallet libraries. They hit as secret.bip39-public-example, which ALLOW accepts inside node_modules
 * only: the same phrase in our own code is still a hit. Any other valid phrase is secret.bip39-phrase.
 */
export const PUBLIC_PHRASES = table([
  // ox Mnemonic / HdKey JSDoc examples (also vendored under viem, @alchemy and @virtuals-protocol)
  'f79cd64f9cea237897b8133e4b905b361c6f166faa5a1c64c32280938f5b707e',
  '2566fb00a345bd17480f047e54a68e9800dd87b261d86adbfe13654c6f6c3813',
  // @scure/bip39 README / JSDoc example
  'ecb0e7ba498c5920991f0b3483e91f7abafa9ecc6bd82a9a51494589592b1a8f'
])

/**
 * Reviewed hits that are not the owner's: { id, path } where path is a RegExp over the artifact-relative path.
 * Reviewed 2026-10-17 (front R11, its fifth round) on a real pack. The economyos skill's profile slug is the owner's own usage: it is
 * fixed at the source, never allowed here.
 */
export const ALLOW = table([
  // A third-party contributor who shares the first name: Chromium's bundled license list and axios' changelog.
  { id: 'owner.first-name', path: /(^|\/)LICENSES\.chromium\.html$/ },
  { id: 'owner.first-name', path: /(^|\/)runtime\/node_modules\/axios\/CHANGELOG\.md$/ },
  // ox, viem, @alchemy, @virtuals-protocol and @scure/bip39 document their APIs with public example phrases.
  { id: 'secret.bip39-public-example', path: /(^|\/)node_modules\// }
])

export const MARKERS_FILE = 'artifact-hygiene-markers.mjs'
