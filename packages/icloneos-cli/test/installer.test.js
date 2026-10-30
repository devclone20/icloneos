// @ts-check
import assert from 'node:assert/strict';
import { chmod, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { RELEASE_CONTRACT, Refusal } from '../src/contract.js';
import { install, launch, uninstall, update } from '../src/installer.js';
import { makeFakeSystem, writeFakeApp } from './fake-system.js';

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

/**
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function listing(dir) {
  try {
    return (await readdir(dir)).sort();
  } catch {
    return [];
  }
}

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

const appPathIn = (/** @type {string} */ dir) => join(dir, RELEASE_CONTRACT.appBundleName);

describe('install', () => {
  it('installs on the happy path, using the same tag for SHA256SUMS and the DMG', async () => {
    const fake = await fixture();
    const installed = await install(fake.sys, {}, quiet);

    assert.equal(installed, appPathIn(fake.dest));
    const plist = JSON.parse(await readFile(join(installed, 'Contents', 'Info.plist'), 'utf8'));
    assert.equal(plist.CFBundleIdentifier, RELEASE_CONTRACT.bundleId);
    assert.deepEqual(await listing(fake.dest), [RELEASE_CONTRACT.appBundleName], 'no staging left behind');
    assert.deepEqual(await listing(fake.tmpRoot), [], 'download work dir removed');
    assert.deepEqual(fake.fetched, [
      'https://github.com/devclone20/icloneos/releases/latest/download/latest-mac.yml',
      'https://github.com/devclone20/icloneos/releases/download/v0.0.3/SHA256SUMS.txt',
      'https://github.com/devclone20/icloneos/releases/download/v0.0.3/iclone-os-mac-arm64.dmg',
    ]);
    const order = fake.calls.map((call) => `${call.command} ${call.args[0]}`);
    assert.ok(order.indexOf('codesign --verify') < order.indexOf('hdiutil attach'), 'DMG verified before mount');
    const appVerify = fake.calls.findIndex((call) => call.command === 'codesign' && call.args.includes('--deep'));
    const copied = fake.calls.findIndex((call) => call.command === 'ditto');
    assert.ok(copied !== -1 && appVerify > copied, 'the staged copy is what gets verified');
  });

  it('K81: an attach that mounts but answers an error is still detached', async () => {
    const fake = await fixture({ attachCode: 1 });
    await assertRefused(install(fake.sys, {}, quiet), /could not mount/);
    const hdiutil = fake.calls.filter((call) => call.command === 'hdiutil').map((call) => call.args[0]);
    assert.deepEqual(hdiutil, ['attach', 'detach']);
    assert.deepEqual(await listing(fake.dest), [], 'no staging left behind');
    assert.deepEqual(await listing(fake.tmpRoot), [], 'work dir removed');
  });

  it('K81: a staging folder that cannot be created stops the install before anything is mounted', async () => {
    const fake = await fixture({
      onCommand: async (_command, args) => {
        // The last disk-image check: from here on the destination refuses new folders.
        if ((args[args.length - 1] ?? '').endsWith('.dmg')) await chmod(fake.dest, 0o500);
      },
    });
    try {
      await assert.rejects(install(fake.sys, {}, quiet));
    } finally {
      await chmod(fake.dest, 0o700);
    }
    assert.equal(fake.calls.some((call) => call.command === 'hdiutil'), false, 'never mounted');
    assert.deepEqual(await listing(fake.tmpRoot), [], 'work dir removed');
  });

  it('refuses a tampered disk image before mounting it, and leaves the destination empty', async () => {
    const fake = await fixture({ deliveredBytes: Buffer.from('tampered disk image') });
    await assertRefused(install(fake.sys, {}, quiet), /sha256 .* does not match the published SHA256SUMS/);
    assert.equal(fake.calls.some((call) => call.command === 'hdiutil'), false, 'never mounted');
    assert.deepEqual(await listing(fake.dest), []);
    assert.deepEqual(await listing(fake.tmpRoot), []);
  });

  it('refuses when the disk image signature is invalid', async () => {
    const fake = await fixture({ dmgCodesignValid: false });
    await assertRefused(install(fake.sys, {}, quiet), /code signature of the disk image is invalid/);
    assert.equal(fake.calls.some((call) => call.command === 'hdiutil'), false);
  });

  it('refuses when the disk image is not notarised', async () => {
    const fake = await fixture({ dmgNotarised: false });
    await assertRefused(install(fake.sys, {}, quiet), /Gatekeeper does not accept the disk image/);
  });

  it('refuses when codesign --verify --deep --strict fails on the app', async () => {
    const fake = await fixture({ appCodesignValid: false });
    await assertRefused(install(fake.sys, {}, quiet), /code signature of the app bundle is invalid/);
    assert.deepEqual(await listing(fake.dest), [], 'staging removed, nothing installed');
  });

  it('refuses when spctl does not report a notarised Developer ID app', async () => {
    const fake = await fixture({ appNotarised: false });
    await assertRefused(install(fake.sys, {}, quiet), /Gatekeeper does not accept the app bundle as notarised/);
    assert.deepEqual(await listing(fake.dest), []);
  });

  it('refuses an app signed by another team', async () => {
    const fake = await fixture({ appTeamId: 'ZZZZZZZZZZ' });
    await assertRefused(install(fake.sys, {}, quiet), /signed by team ZZZZZZZZZZ, not the iclone os team HJSLQL98D8/);
  });

  it('refuses a disk image signed by another team', async () => {
    const fake = await fixture({ dmgTeamId: 'ZZZZZZZZZZ' });
    await assertRefused(install(fake.sys, {}, quiet), /disk image is signed by team ZZZZZZZZZZ/);
  });

  it('refuses an app with a different bundle id', async () => {
    const fake = await fixture({ appBundleId: 'com.evil.app' });
    await assertRefused(install(fake.sys, {}, quiet), /identifies as com\.evil\.app/);
  });

  it('refuses when the app version disagrees with the feed', async () => {
    const fake = await fixture({ appVersion: '0.0.1' });
    await assertRefused(install(fake.sys, {}, quiet), /reports version 0\.0\.1 but the release feed says 0\.0\.3/);
  });

  it('refuses to run as root', async () => {
    const fake = await fixture({ uid: 0 });
    await assertRefused(install(fake.sys, {}, quiet), /Do not run icloneos as root or with sudo/);
    assert.deepEqual(fake.fetched, []);
  });

  it('refuses on a non-macOS host', async () => {
    const fake = await fixture({ platform: 'linux' });
    await assertRefused(install(fake.sys, {}, quiet), /macOS app/);
  });

  it('will not overwrite a foreign app that happens to share the name', async () => {
    const fake = await fixture();
    await writeFakeApp(appPathIn(fake.dest), { bundleId: 'com.someone.else', version: '9.9.9' });
    await assertRefused(install(fake.sys, { force: true }, quiet), /is not iclone os/);
  });

  it('honours --dest', async () => {
    const fake = await fixture();
    const custom = join(fake.home, 'custom', 'place');
    const installed = await install(fake.sys, { dest: custom }, quiet);
    assert.equal(installed, appPathIn(custom));
    assert.ok((await stat(installed)).isDirectory());
  });
});

describe('update', () => {
  it('replaces an older install', async () => {
    const fake = await fixture({ feedVersion: '0.0.3' });
    await writeFakeApp(appPathIn(fake.dest), { bundleId: RELEASE_CONTRACT.bundleId, version: '0.0.2' });
    await update(fake.sys, {}, quiet);
    const plist = JSON.parse(await readFile(join(appPathIn(fake.dest), 'Contents', 'Info.plist'), 'utf8'));
    assert.equal(plist.CFBundleVersion, '0.0.3');
    assert.deepEqual(await listing(fake.dest), [RELEASE_CONTRACT.appBundleName]);
  });

  it('does nothing when already current', async () => {
    const fake = await fixture();
    await writeFakeApp(appPathIn(fake.dest), { bundleId: RELEASE_CONTRACT.bundleId, version: '0.0.3' });
    await update(fake.sys, {}, quiet);
    assert.equal(fake.fetched.some((url) => url.endsWith('.dmg')), false);
  });

  it('refuses while the app is running', async () => {
    const fake = await fixture({ feedVersion: '0.0.3', running: true });
    await writeFakeApp(appPathIn(fake.dest), { bundleId: RELEASE_CONTRACT.bundleId, version: '0.0.2' });
    await assertRefused(update(fake.sys, {}, quiet), /running; quit it/);
  });

  it('keeps the old app when the new one fails verification', async () => {
    const fake = await fixture({ feedVersion: '0.0.3', appNotarised: false });
    await writeFakeApp(appPathIn(fake.dest), { bundleId: RELEASE_CONTRACT.bundleId, version: '0.0.2' });
    await assertRefused(update(fake.sys, {}, quiet), /notarised/);
    const plist = JSON.parse(await readFile(join(appPathIn(fake.dest), 'Contents', 'Info.plist'), 'utf8'));
    assert.equal(plist.CFBundleVersion, '0.0.2');
    assert.deepEqual(await listing(fake.dest), [RELEASE_CONTRACT.appBundleName]);
  });

  it('refuses when nothing is installed', async () => {
    const fake = await fixture();
    await assertRefused(update(fake.sys, {}, quiet), /not installed/);
  });
});

describe('launch and uninstall', () => {
  it('launches through open(1)', async () => {
    const fake = await fixture();
    await writeFakeApp(appPathIn(fake.dest), { bundleId: RELEASE_CONTRACT.bundleId, version: '0.0.2' });
    await launch(fake.sys, {}, quiet);
    assert.deepEqual(fake.calls.at(-1), { command: 'open', args: [appPathIn(fake.dest)] });
  });

  it('uninstalls only the bundle', async () => {
    const fake = await fixture();
    await writeFakeApp(appPathIn(fake.dest), { bundleId: RELEASE_CONTRACT.bundleId, version: '0.0.2' });
    await uninstall(fake.sys, {}, quiet);
    assert.deepEqual(await listing(fake.dest), []);
  });

  it('refuses to uninstall a foreign bundle', async () => {
    const fake = await fixture();
    await writeFakeApp(appPathIn(fake.dest), { bundleId: 'com.someone.else', version: '1.0' });
    await assertRefused(uninstall(fake.sys, {}, quiet), /is not iclone os/);
    assert.deepEqual(await listing(fake.dest), [RELEASE_CONTRACT.appBundleName]);
  });
});
