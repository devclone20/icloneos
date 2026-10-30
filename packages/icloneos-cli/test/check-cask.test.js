// @ts-check
// Runs the real packaging/check-cask.sh under /bin/sh against a fixture cask; only /usr/bin/curl is stubbed (by
// rewriting its absolute path in a temp copy), so no test touches the network.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { RELEASE_CONTRACT } from '../src/contract.js';

const PACKAGING = fileURLToPath(new URL('../../../packaging/', import.meta.url));
const SERVED = Buffer.from('the notarised disk image that was uploaded');
const SERVED_SHA = createHash('sha256').update(SERVED).digest('hex');
const CURL_STUB = `#!/bin/sh
out=""; url=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; -w|--proto|--proto-redir|--max-filesize|--connect-timeout) shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac; done
printf '%s\\n' "$url" >> "$ROOT/curl.log"
[ "\${CURL_EXIT:-0}" = 0 ] || exit "$CURL_EXIT"
/bin/cp "$ROOT/served.dmg" "$out"
printf '%s' "\${CURL_ANSWER:-200 $url}"
`;

/** @type {string[]} */
const roots = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

/**
 * @param {{ version?: string, sha?: string, repo?: string }} cask
 */
async function fixture({ version = '0.0.3', sha = SERVED_SHA, repo = RELEASE_CONTRACT.repository } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'check-cask-'));
  roots.push(root);
  await mkdir(join(root, 'packaging', 'homebrew', 'Casks'), { recursive: true });
  await copyFile(join(PACKAGING, 'release-contract.json'), join(root, 'packaging', 'release-contract.json'));
  const real = await readFile(join(PACKAGING, 'homebrew', 'Casks', 'icloneos.rb'), 'utf8');
  const cask = real
    .replace(/^ {2}version "[^"]+"$/m, `  version "${version}"`)
    .replace(/^ {2}sha256 "[0-9a-f]{64}"$/m, `  sha256 "${sha}"`)
    .replaceAll(RELEASE_CONTRACT.repository, repo);
  await writeFile(join(root, 'packaging', 'homebrew', 'Casks', 'icloneos.rb'), cask);
  const script = (await readFile(join(PACKAGING, 'check-cask.sh'), 'utf8')).replaceAll('/usr/bin/curl', join(root, 'curl'));
  await writeFile(join(root, 'packaging', 'check-cask.sh'), script);
  await writeFile(join(root, 'curl'), CURL_STUB);
  await chmod(join(root, 'curl'), 0o755);
  await writeFile(join(root, 'served.dmg'), SERVED);
  await writeFile(join(root, 'curl.log'), '');
  return root;
}

/**
 * @param {string} root
 * @param {string[]} [args]
 * @param {Record<string, string>} [env]
 * @returns {Promise<{ code: number, stdout: string, stderr: string, fetched: string[] }>}
 */
function run(root, args = [], env = {}) {
  return new Promise((resolve) => {
    execFile('/bin/sh', [join(root, 'packaging', 'check-cask.sh'), ...args], {
      env: { PATH: '/usr/bin:/bin', TMPDIR: root, ROOT: root, ...env },
    }, async (error, stdout, stderr) => {
      const fetched = (await readFile(join(root, 'curl.log'), 'utf8')).split('\n').filter(Boolean);
      resolve({ code: error ? Number(error.code) : 0, stdout, stderr, fetched });
    });
  });
}

/** @param {string} version */
const tagged = (version) =>
  `https://github.com/${RELEASE_CONTRACT.repository}/releases/download/v${version}/${RELEASE_CONTRACT.dmgFile}`;

describe('check-cask.sh — the release-time gate of the Homebrew channel', { skip: process.platform !== 'darwin' }, () => {
  it('passes when the tagged DMG answers 200 and hashes to the cask sha256, and the uploaded DMG agrees', async () => {
    const root = await fixture();
    await writeFile(join(root, 'uploaded.dmg'), SERVED);
    const result = await run(root, ['--dmg', join(root, 'uploaded.dmg')]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /check-cask: OK — icloneos 0\.0\.3/);
    assert.deepEqual(result.fetched, [tagged('0.0.3')]);
  });

  it('refuses a cask below the rollback floor without fetching (no such DMG exists in the release repo)', async () => {
    const result = await run(await fixture({ version: '0.0.2' }));
    assert.equal(result.code, 2);
    assert.match(result.stderr, /below the rollback floor/);
    assert.deepEqual(result.fetched, []);
  });

  it('refuses a cask URL that is not the tagged DMG of the release repo, without fetching it', async () => {
    const result = await run(await fixture({ repo: ['devclone20/iclone-os', 'releases'].join('-') }));
    assert.equal(result.code, 2);
    assert.match(result.stderr, /the cask URL is .*, not https:\/\/github\.com\/devclone20\/icloneos\//);
    assert.deepEqual(result.fetched, []);
  });

  it('refuses when the URL does not answer 200 (curl -f fails on a 404)', async () => {
    const result = await run(await fixture(), [], { CURL_EXIT: '22' });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /did not answer 200/);
  });

  it('refuses a redirect that ends on a host other than GitHub', async () => {
    const result = await run(await fixture(), [], { CURL_ANSWER: '200 https://evil.example/x.dmg' });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /unexpected answer or host/);
  });

  it('refuses when the served bytes do not hash to the cask sha256', async () => {
    const result = await run(await fixture({ sha: 'a'.repeat(64) }));
    assert.equal(result.code, 2);
    assert.match(result.stderr, /hashes to [0-9a-f]{64}, not the cask's a{64}/);
  });

  it('refuses when the local uploaded DMG differs from the cask sha256', async () => {
    const root = await fixture();
    await writeFile(join(root, 'uploaded.dmg'), 'another build');
    const result = await run(root, ['--dmg', join(root, 'uploaded.dmg')]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /the uploaded DMG .* hashes to/);
  });
});
