/**
 * v0.0.9 — the one surface the BUILD scripts load from the ACP tools (scripts/stage-acp-bundle.mjs,
 * scripts/sign-acp-bundle.mjs, scripts/acp-pack-bundled.mjs), bundled for Node by esbuild (scripts/lib/import-ts.mjs):
 * the build materialises, reseals and checks the tree with the very code the app verifies it with. No Electron here.
 */
export { ACP_CLI_NAME, parsePin, signerFor, targetName } from '../../src/iclone-shared/acp-pin'
export { BUNDLE_DIR, BUNDLE_ORIGIN, parseBundleManifest, readBundleManifest } from './bundle'
export { MANIFEST_FILE, sha256Hex, treeDigest, verifyTree } from './manifest'
export { loadPin, materialiseBundle, NOTICES_FILE, resealBundle, RUNTIME_DIR, signerPath } from './materialise'
export { addonsDigest } from './native'
export { createRegistryFetch } from './net-core'
