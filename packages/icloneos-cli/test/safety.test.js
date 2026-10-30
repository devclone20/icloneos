// @ts-check
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { Interrupted, RELEASE_CONTRACT, Refusal } from '../src/contract.js';
import { install, launch, resolveLatestRelease, uninstall, update } from '../src/installer.js';
import { parseSignerReport, pemFingerprint } from '../src/sums-signature.js';
import { APPLE_ROOT_CA_PEM, developerIdSignerReport, makeFakeSystem, writeFakeApp } from './fake-system.js';

const run = promisify(execFile);

/** @type {Array<() => Promise<void>>} */
const cleanups = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

/** @param {import('./fake-system.js').Scenario} [scenario] */
async function fixture(scenario) {
  const fake = await makeFakeSystem(scenario);
  cleanups.push(fake.cleanup);
  return fake;
}

const quiet = () => {};
const APP = RELEASE_CONTRACT.appBundleName;
const ours = { bundleId: RELEASE_CONTRACT.bundleId };

/** @param {string} dir */
const listing = async (dir) => (await readdir(dir).catch(() => [])).sort();

/** @param {string} app */
const versionOf = async (app) => JSON.parse(await readFile(join(app, 'Contents', 'Info.plist'), 'utf8')).CFBundleVersion;

/**
 * @param {Promise<unknown>} promise
 * @param {RegExp} reason
 */
async function assertRefused(promise, reason) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof Refusal, `expected a Refusal, got ${String(error)}`);
    assert.match(error.message, reason);
    return true;
  });
}

describe('rollback floor and downgrade protection', () => {
  it('pins the floor in the contract at a real version', () => {
    assert.match(RELEASE_CONTRACT.minimumVersion, /^\d+(\.\d+){1,3}$/);
  });

  it('refuses a feed below the minimum version before fetching anything else', async () => {
    const fake = await fixture({ feedVersion: '0.0.1' });
    await assertRefused(install(fake.sys, {}, quiet), /offers 0\.0\.1, below the minimum supported version 0\.0\.3/);
    assert.equal(fake.fetched.length, 1, 'only the feed was read');
    assert.deepEqual(await listing(fake.dest), []);
  });

  it('the floor holds even with --allow-downgrade and --force', async () => {
    const fake = await fixture({ feedVersion: '0.0.1' });
    await assertRefused(install(fake.sys, { allowDowngrade: true, force: true }, quiet), /below the minimum/);
  });

  it('refuses to install a version older than the installed app, keeping it', async () => {
    const fake = await fixture({ feedVersion: '0.0.3' });
    await writeFakeApp(join(fake.dest, APP), { ...ours, version: '0.0.4' });
    await assertRefused(install(fake.sys, {}, quiet), /0\.0\.4 is installed .* older 0\.0\.3; pass --allow-downgrade/);
    await assertRefused(install(fake.sys, { force: true }, quiet), /--allow-downgrade/);
    assert.equal(await versionOf(join(fake.dest, APP)), '0.0.4');
    assert.equal(fake.fetched.some((url) => url.endsWith('.dmg')), false, 'never downloaded');
  });

  it('downgrades only with --allow-downgrade', async () => {
    const fake = await fixture({ feedVersion: '0.0.3' });
    await writeFakeApp(join(fake.dest, APP), { ...ours, version: '0.0.4' });
    await install(fake.sys, { allowDowngrade: true }, quiet);
    assert.equal(await versionOf(join(fake.dest, APP)), '0.0.3');
  });

  it('update never downgrades', async () => {
    const fake = await fixture({ feedVersion: '0.0.3' });
    await writeFakeApp(join(fake.dest, APP), { ...ours, version: '0.0.4' });
    await update(fake.sys, {}, quiet);
    assert.equal(await versionOf(join(fake.dest, APP)), '0.0.4');
    assert.equal(fake.fetched.some((url) => url.endsWith('.dmg')), false);
  });
});

describe('an interrupted run never loses the installed app', () => {
  for (const [step, nth] of /** @type {const} */ ([['ditto', 1], ['pgrep', 2]])) {
    it(`stops cleanly when a signal arrives during ${step}`, async () => {
      let seen = 0;
      /** @type {Awaited<ReturnType<typeof makeFakeSystem>> | undefined} */
      let fake;
      fake = await fixture({
        feedVersion: '0.0.4',
        onCommand: (command) => {
          if (command === step && (seen += 1) === nth) fake?.abort('SIGINT');
        },
      });
      await writeFakeApp(join(fake.dest, APP), { ...ours, version: '0.0.3' });
      await assert.rejects(update(fake.sys, {}, quiet), Interrupted);
      assert.equal(await versionOf(join(fake.dest, APP)), '0.0.3', 'old app intact');
      assert.deepEqual(await listing(fake.dest), [APP], 'no staging left');
      assert.deepEqual(await listing(fake.tmpRoot), [], 'no work dir left');
    });
  }

  for (const [signal, exitCode] of /** @type {const} */ ([['SIGINT', 130], ['SIGTERM', 143]])) {
    it(`a real ${signal} right before the swap exits ${exitCode} and keeps the old app`, async () => {
      const child = fileURLToPath(new URL('./fixtures/interrupt-child.js', import.meta.url));
      const { stdout, stderr } = await run(process.execPath, [child, signal]);
      const result = JSON.parse(stdout);
      cleanups.push(() => rm(result.root, { recursive: true, force: true }));
      assert.equal(result.code, exitCode);
      assert.match(stderr, /interrupted — nothing half-installed/);
      assert.equal(await versionOf(join(result.dest, APP)), '0.0.3');
      assert.deepEqual(await listing(result.dest), [APP]);
      assert.deepEqual(await listing(result.tmpRoot), []);
    });
  }

  it('restores an app stranded in staging by a killed run (target missing)', async () => {
    const fake = await fixture();
    const staging = join(fake.dest, '.icloneos-staging-AbC123');
    await writeFakeApp(join(staging, 'previous.app'), { ...ours, version: '0.0.3' });
    /** @type {string[]} */
    const lines = [];
    await launch(fake.sys, {}, (line) => lines.push(line));
    assert.deepEqual(await listing(fake.dest), [APP]);
    assert.equal(await versionOf(join(fake.dest, APP)), '0.0.3');
    assert.match(lines.join('\n'), /Restored iclone os/);
  });

  it('only removes leftovers when the swap had already completed', async () => {
    const fake = await fixture();
    await writeFakeApp(join(fake.dest, APP), { ...ours, version: '0.0.4' });
    await writeFakeApp(join(fake.dest, '.icloneos-staging-x', 'previous.app'), { ...ours, version: '0.0.3' });
    await install(fake.sys, {}, quiet).catch(() => {});
    assert.deepEqual(await listing(fake.dest), [APP]);
    assert.equal(await versionOf(join(fake.dest, APP)), '0.0.4');
  });
});

describe('a symlinked iclone os.app is never followed, replaced or removed (every verb)', () => {
  for (const verb of /** @type {const} */ (['install', 'update', 'launch', 'uninstall'])) {
    it(verb, async () => {
      const fake = await fixture({ feedVersion: '0.0.4' });
      const real = join(fake.home, 'elsewhere', APP);
      await writeFakeApp(real, { ...ours, version: '0.0.3' });
      await mkdir(fake.dest, { recursive: true });
      await symlink(real, join(fake.dest, APP));
      const verbs = { install, update, launch, uninstall };
      await assertRefused(verbs[verb](fake.sys, { force: true }, quiet), /is a symbolic link; icloneos will not follow, replace or remove it/);
      assert.equal(await versionOf(real), '0.0.3', 'link target intact');
      assert.deepEqual(await listing(fake.dest), [APP], 'link still there');
    });
  }
});

describe('launch and uninstall check the signature', () => {
  it('launch refuses a bundle whose seal is broken and never opens it', async () => {
    const fake = await fixture({ appCodesignValid: false });
    await writeFakeApp(join(fake.dest, APP), { ...ours, version: '0.0.3' });
    await assertRefused(launch(fake.sys, {}, quiet), /code signature of the app bundle is invalid/);
    assert.equal(fake.calls.some((call) => call.command === 'open'), false);
  });

  it('launch refuses a bundle signed by another team', async () => {
    const fake = await fixture({ appTeamId: 'ZZZZZZZZZZ' });
    await writeFakeApp(join(fake.dest, APP), { ...ours, version: '0.0.3' });
    await assertRefused(launch(fake.sys, {}, quiet), /signed by team ZZZZZZZZZZ/);
  });

  it('uninstall refuses a plist-forged bundle unless --force', async () => {
    const fake = await fixture({ appTeamId: 'ZZZZZZZZZZ' });
    await writeFakeApp(join(fake.dest, APP), { ...ours, version: '0.0.3' });
    await assertRefused(uninstall(fake.sys, {}, quiet), /does not carry a valid iclone os signature .*pass --force/);
    assert.deepEqual(await listing(fake.dest), [APP]);
    await uninstall(fake.sys, { force: true }, quiet);
    assert.deepEqual(await listing(fake.dest), []);
  });
});

describe('signed SHA256SUMS (feature flag)', () => {
  it('is off until the owner signs the first list', () => {
    assert.equal(RELEASE_CONTRACT.requireSignedSums, false);
  });

  it('pins the real Apple Root CA', () => {
    assert.equal(pemFingerprint(APPLE_ROOT_CA_PEM), RELEASE_CONTRACT.appleRootCaSha256);
  });

  it('when on, fetches the .sig from the same tag and accepts a Developer ID signer of our team', async () => {
    const fake = await fixture();
    const release = await resolveLatestRelease(fake.sys, true);
    assert.equal(release.version, '0.0.3');
    assert.ok(fake.fetched.includes(`https://github.com/${RELEASE_CONTRACT.repository}/releases/download/v0.0.3/SHA256SUMS.txt.sig`));
    const smime = fake.calls.find((call) => call.command === 'openssl' && call.args[0] === 'smime');
    assert.ok(smime?.args.includes('-ignore_critical') && smime.args.includes('-CAfile'));
    assert.deepEqual(await listing(fake.tmpRoot), [], 'signature work dir removed');
  });

  const hostile = /** @type {const} */ ([
    // K86 / K33 I1: signing is on and the release carries no signature: refused (exit 2), never a silent pass.
    ['the release has no signature file (HTTP 404)', { missing: true }, /HTTP 404 for .*SHA256SUMS\.txt\.sig/],
    ['the CMS signature does not verify', { opensslVerifies: false }, /signature on SHA256SUMS\.txt is invalid/],
    ["Apple's root is missing from the store", { rootMissing: true }, /root certificate was not found/],
    ['there are two signers', { signerCount: 2 }, /exactly one signer, not 2/],
    ['the signer belongs to another team', { signerReport: developerIdSignerReport('ZZZZZZZZZZ') }, /signed by team ZZZZZZZZZZ/],
    ['the issuer is not the Developer ID CA', { signerReport: developerIdSignerReport(RELEASE_CONTRACT.teamId, { issuerCn: 'Apple Worldwide Developer Relations Certification Authority' }) }, /Developer ID authority/],
    ['the leaf lacks the Developer ID marker', { signerReport: developerIdSignerReport(RELEASE_CONTRACT.teamId, { marker: false }) }, /not signed with a Developer ID Application/],
    ['the leaf is not a Developer ID Application', { signerReport: developerIdSignerReport(RELEASE_CONTRACT.teamId, { cn: `Apple Development: X (${RELEASE_CONTRACT.teamId})` }) }, /not signed with a Developer ID Application/],
  ]);
  for (const [why, sumsSignature, reason] of hostile) {
    it(`when on, refuses when ${why}`, async () => {
      const fake = await fixture({ sumsSignature });
      await assertRefused(resolveLatestRelease(fake.sys, true), reason);
      assert.deepEqual(await listing(fake.tmpRoot), []);
    });
  }

  it('parses a real LibreSSL signer report', () => {
    const report = developerIdSignerReport('HJSLQL98D8');
    const parsed = parseSignerReport(`    Subject: CN=decoy, OU=ZZZZZZZZZZ\n${report}`);
    assert.equal(parsed.subject.get('OU'), 'HJSLQL98D8');
    assert.equal(parsed.issuer.get('CN'), 'Developer ID Certification Authority');
    assert.equal(parsed.developerIdMarker, true);
  });
});
