// Child process of the `crypto.ops` row: the real key loading, signing and audit-chain code of the permission authority and the payments.
// Prints one JSON line. Electron is replaced by an inert stub (nothing on the timed path imports it).
import '../lib/ts-hook.mjs'

import { sign as signRaw } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { writeResult } from '../lib/child_result.mjs'

const args = JSON.parse(process.argv[2] ?? '{}')
const E = new URL('../../apps/desktop/electron/', import.meta.url)
const { loadOwnerMandateKey } = await import(new URL('iclone-x402/keys.ts', E).href)
const { createPocketSigner } = await import(new URL('iclone-x402/signer.ts', E).href)
const { loadPermissionKeys } = await import(new URL('iclone-permissions/keys.ts', E).href)
const { createAuditLog } = await import(new URL('iclone-permissions/audit.ts', E).href)

// The OS seal (Electron safeStorage -> Keychain) only exists inside Electron: an in-memory double stands in, as in the
// repo's own tests (iclone-permissions/keys.ts:23). Its cost is NOT part of these numbers. `delayMs` = the control.
const spin = ms => {
  const end = performance.now() + ms
  while (performance.now() < end);
}
const sealer = {
  seal: plain => Buffer.from(plain, 'utf8').toString('base64'),
  unseal: sealed => {
    if (args.delayMs) spin(args.delayMs)
    return Buffer.from(sealed, 'base64').toString('utf8')
  }
}
const dir = args.scratch
const keysDir = path.join(dir, 'keys')
fs.mkdirSync(keysDir, { recursive: true, mode: 0o700 })
const hr = () => performance.now()
const time = fn => {
  const t0 = hr()
  fn()
  return hr() - t0
}
const timeAsync = async fn => {
  const t0 = hr()
  await fn()
  return hr() - t0
}
const n = Number(args.n ?? 200)
const ops = {}
const run = async (name, fn, isAsync = false) => {
  ops[name] = []
  for (let i = 0; i < n; i += 1) ops[name].push(isAsync ? await timeAsync(() => fn(i)) : time(() => fn(i)))
}

// 1. Sealed key load: first call mints + seals (cold), the rest unseal + parse the PEM (keys.ts:38-98).
const first = time(() => loadOwnerMandateKey(keysDir, sealer))
await run('key.load_p256', () => {
  if (!loadOwnerMandateKey(keysDir, sealer).privateKey) throw new Error('key did not load')
})
ops['key.load_p256'].unshift(first)

// 2. ES256 compact JWS: the body of mandates.ts signJws (lines 116-121, not exported), same primitive and options.
const owner = loadOwnerMandateKey(keysDir, sealer)
const b64u = text => Buffer.from(text).toString('base64url')
await run('mandate.es256_sign', i => {
  const input = `${b64u(JSON.stringify({ alg: 'ES256', typ: 'dc+sd-jwt' }))}.${b64u(JSON.stringify({ iat: i, cap: '1000000' }))}`
  signRaw('sha256', Buffer.from(input), { key: owner.privateKey, dsaEncoding: 'ieee-p1363' })
})

// 3. x402 pocket signer: EIP-712 TransferWithAuthorization through viem (signer.ts:86-113).
const pocket = createPocketSigner(keysDir, sealer)
if (!pocket.address) throw new Error(`pocket signer unavailable: ${pocket.reason}`)
const domain = {
  name: 'USD Coin',
  version: '2',
  chainId: 8453,
  verifyingContract: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
}
await run(
  'pocket.eip712_sign',
  i =>
    pocket.signAuthorization(
      {
        from: pocket.address,
        to: '0x00000000000000000000000000000000000000bb',
        value: '10000',
        validAfter: '0',
        validBefore: String(2e9 + i),
        nonce: `0x${i.toString(16).padStart(64, '0')}`
      },
      domain
    ),
  true
)

// 4. Permission authority: one Hermes spawn key, HMAC(master, nonce) (permissions/keys.ts:45-50).
const perm = loadPermissionKeys(path.join(dir, 'perm'), sealer)
await run('perm.spawn_key', () => perm.spawnKey(perm.newSpawnNonce()))

// 5. Audit chain: one HMAC-chained, fsync'd record (permissions/audit.ts createAuditLog().append).
const audit = createAuditLog({ dir: path.join(dir, 'audit'), key: perm.auditKey, kid: perm.kid })
await run('audit.append_fsync', i => audit.append({ src: 'main', kind: 'gap', reason: `bench record ${i}` }))
audit.close?.()
// 6. The same append through the repo's own test seam `durable: false` (audit.ts:391): separates the fsync from the HMAC.
const quick = createAuditLog({
  dir: path.join(dir, 'audit-nofsync'),
  key: perm.auditKey,
  kid: perm.kid,
  durable: false
})
await run('audit.append_nofsync', i => quick.append({ src: 'main', kind: 'gap', reason: `bench record ${i}` }))
quick.close?.()

writeResult(args.result, { ops })
process.exit(0)
