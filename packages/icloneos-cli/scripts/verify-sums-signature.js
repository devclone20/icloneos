#!/usr/bin/env node
// @ts-check
// node scripts/verify-sums-signature.js <SHA256SUMS.txt> <SHA256SUMS.txt.sig> [TEAMID]
// The exact check every launcher runs when requireSignedSums is on. `npm run release:mac -- --sign-sums` calls it
// on the freshly signed list, so a signature the launchers would reject is never uploaded. Not shipped (see "files").
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { Refusal } from '../src/contract.js';
import { verifySumsSignature } from '../src/sums-signature.js';
import { runSystemTool } from '../src/system.js';

const [sums, signature, teamId] = process.argv.slice(2);
if (sums === undefined || signature === undefined) {
  process.stderr.write('usage: verify-sums-signature.js <SHA256SUMS.txt> <SHA256SUMS.txt.sig> [TEAMID]\n');
  process.exit(64);
}
const workDir = await mkdtemp(join(tmpdir(), 'icloneos-verify-sums-'));
try {
  await verifySumsSignature(runSystemTool, {
    sumsPath: resolve(sums),
    signaturePath: resolve(signature),
    workDir,
    ...(teamId === undefined ? {} : { teamId }),
  });
  process.stdout.write(`OK: ${signature} is a valid Developer ID signature over ${sums}.\n`);
} catch (error) {
  process.stderr.write(`refused — ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = error instanceof Refusal ? 2 : 1;
} finally {
  await rm(workDir, { recursive: true, force: true });
}
