// @ts-check
// Runs the real packaging/install.sh under /bin/sh. Only the tools that touch the network, Apple's signing
// services or disk images are swapped for stubs (by rewriting their absolute paths in a temp copy); mv is
// wrapped so a test can deliver a real signal to the script right after its first move.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { RELEASE_CONTRACT } from '../src/contract.js';

const SCRIPT = fileURLToPath(new URL('../../../packaging/install.sh', import.meta.url));
const APP = RELEASE_CONTRACT.appBundleName;
const STUBBED = ['/usr/bin/curl', '/usr/bin/codesign', '/usr/sbin/spctl', '/usr/bin/hdiutil', '/usr/bin/ditto',
  '/usr/bin/pgrep', '/bin/mv', '/usr/bin/security', '/usr/bin/openssl'];
const darwin = process.platform === 'darwin';

/** @param {string} version */
const plist = (version) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${RELEASE_CONTRACT.bundleId}</string>
<key>CFBundleVersion</key><string>${version}</string>
</dict></plist>
`;

/**
 * @param {string} app
 * @param {string} version
 */
async function writeApp(app, version) {
  await mkdir(join(app, 'Contents', 'MacOS'), { recursive: true });
  await writeFile(join(app, 'Contents', 'Info.plist'), plist(version));
}

/** @param {string} app */
async function versionOf(app) {
  return /<key>CFBundleVersion<\/key><string>([^<]+)</.exec(await readFile(join(app, 'Contents', 'Info.plist'), 'utf8'))?.[1];
}

const STUBS = {
  curl: `#!/bin/sh
out=""; url=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; -w|--proto|--proto-redir|--max-filesize|--connect-timeout) shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac; done
/bin/cp "$FIXTURES/\${url##*/}" "$out" 2>/dev/null || exit 22
printf '%s' "$url"`,
  codesign: `#!/bin/sh
case "$1" in --verify) exit 0 ;; esac
printf 'Identifier=x\\nAuthority=Developer ID Application: Test (HJSLQL98D8)\\nTeamIdentifier=HJSLQL98D8\\n' >&2`,
  spctl: `#!/bin/sh
echo "source=Notarized Developer ID" >&2`,
  hdiutil: `#!/bin/sh
if [ "$1" = attach ]; then
  while [ $# -gt 0 ]; do [ "$1" = -mountpoint ] && mnt="$2"; shift; done
  /bin/mkdir -p "$mnt/${APP}/Contents/MacOS" && /bin/cp "$FIXTURES/Info.plist" "$mnt/${APP}/Contents/Info.plist"
else
  [ -d "$2" ] && /bin/rm -rf "$2"/* ; exit 0
fi`,
  ditto: `#!/bin/sh
/bin/cp -R "$1" "$2"`,
  pgrep: `#!/bin/sh
printf '%s\\n' "$2" >> "$FIXTURES/pgrep.log"; exit 1`,
  mv: `#!/bin/sh
/bin/mv "$@" || exit $?
case "$2" in */previous.app) [ -z "$SIGNAL_AFTER_FIRST_MV" ] || kill -"$SIGNAL_AFTER_FIRST_MV" "$PPID" ;; esac`,
  security: `#!/bin/sh
/bin/cat "$FIXTURES/roots.pem"`,
  openssl: `#!/bin/sh
case "$*" in
  *-fingerprint*) exec /usr/bin/openssl "$@" ;;
  smime*) [ -z "$SMIME_FAILS" ] || exit 4
    while [ $# -gt 0 ]; do [ "$1" = -signer ] && s="$2"; shift; done; /bin/cat "$FIXTURES/signer.pem" > "$s" ;;
  *) /bin/cat "$FIXTURES/signer-report.txt" ;;
esac`,
};

/** @type {string[]} */
const roots = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

/**
 * @param {{ feed?: string, sums?: string, installed?: string, args?: string[], env?: Record<string, string>,
 *   requireSignedSums?: boolean, destName?: string, prepare?: (dest: string) => Promise<void> }} [options]
 */
async function runInstaller(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'icloneos-sh-'));
  roots.push(root);
  const stubs = join(root, 'stubs');
  const fixtures = join(root, 'fixtures');
  const tmp = join(root, 'tmp');
  const dest = join(root, options.destName ?? 'Applications');
  await Promise.all([mkdir(stubs), mkdir(fixtures), mkdir(tmp), mkdir(dest, { recursive: true })]);
  for (const [name, body] of Object.entries(STUBS)) {
    await writeFile(join(stubs, name), `${body}\n`);
    await chmod(join(stubs, name), 0o755);
  }
  const feed = options.feed ?? '0.0.3';
  const dmg = Buffer.from(`fake dmg ${feed}`);
  const sha = createHash('sha256').update(dmg).digest('hex');
  await writeFile(join(fixtures, RELEASE_CONTRACT.dmgFile), dmg);
  await writeFile(join(fixtures, 'latest-mac.yml'), `version: ${feed}\nfiles: []\n`);
  await writeFile(join(fixtures, 'SHA256SUMS.txt'), options.sums ?? `${sha}  ${RELEASE_CONTRACT.dmgFile}\n`);
  await writeFile(join(fixtures, 'SHA256SUMS.txt.sig'), 'cms');
  await writeFile(join(fixtures, 'Info.plist'), plist(feed));
  const appleRoot = await readFile(fileURLToPath(new URL('./fixtures/apple-root-ca.crt', import.meta.url)), 'utf8');
  await writeFile(join(fixtures, 'roots.pem'), appleRoot);
  await writeFile(join(fixtures, 'signer.pem'), '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n');
  await writeFile(join(fixtures, 'signer-report.txt'), [
    '        X509v3 extensions:', '            1.2.840.113635.100.6.1.13: critical',
    'subject= ', '    CN=Developer ID Application: Test (HJSLQL98D8)', '    OU=HJSLQL98D8',
    'issuer= ', '    CN=Developer ID Certification Authority', '    O=Apple Inc.', '',
  ].join('\n'));
  if (options.installed !== undefined) await writeApp(join(dest, APP), options.installed);
  await options.prepare?.(dest);

  let script = await readFile(SCRIPT, 'utf8');
  for (const tool of STUBBED) script = script.replaceAll(tool, join(stubs, tool.split('/').pop() ?? ''));
  if (options.requireSignedSums) script = script.replace('REQUIRE_SIGNED_SUMS=0', 'REQUIRE_SIGNED_SUMS=1');
  const copy = join(root, 'install.sh');
  await writeFile(copy, script);

  const result = await new Promise((resolve) => {
    execFile('/bin/sh', [copy, '--dest', dest, ...(options.args ?? [])], {
      env: { PATH: '/usr/bin:/bin', HOME: root, TMPDIR: tmp, FIXTURES: fixtures, ...options.env },
    }, (error, stdout, stderr) => resolve({ code: error === null ? 0 : (typeof error.code === 'number' ? error.code : 1), stdout, stderr }));
  });
  const { code, stderr } = /** @type {{ code: number, stderr: string }} */ (result);
  return { code, stderr, dest, tmp, fixtures, app: join(dest, APP), listing: (await readdir(dest)).sort(), work: await readdir(tmp) };
}

describe('install.sh (real /bin/sh, stubbed network and signing tools)', { skip: !darwin }, () => {
  it('upgrades an installed app on the happy path and leaves nothing behind', async () => {
    const r = await runInstaller({ installed: '0.0.2' });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(await versionOf(r.app), '0.0.3');
    assert.deepEqual(r.listing, [APP]);
    assert.deepEqual(r.work, []);
  });

  for (const [signal, exitCode] of /** @type {const} */ ([['INT', 130], ['TERM', 143]])) {
    it(`SIG${signal} between the two moves exits ${exitCode} and puts the old app back`, async () => {
      const r = await runInstaller({ installed: '0.0.2', env: { SIGNAL_AFTER_FIRST_MV: signal } });
      assert.equal(r.code, exitCode, r.stderr);
      assert.equal(await versionOf(r.app), '0.0.2', 'old app intact');
      assert.deepEqual(r.listing, [APP], 'no staging left');
      assert.deepEqual(r.work, [], 'no work dir left');
    });
  }

  it('restores an app stranded by a killed run, then upgrades it', async () => {
    const r = await runInstaller({
      prepare: (dest) => writeApp(join(dest, '.icloneos-staging-AbC123', 'previous.app'), '0.0.2'),
    });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /Restored iclone os/);
    assert.equal(await versionOf(r.app), '0.0.3');
    assert.deepEqual(r.listing, [APP]);
  });

  it('refuses a feed below the minimum version', async () => {
    const r = await runInstaller({ feed: '0.0.1', args: ['--allow-downgrade'] });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /offers 0\.0\.1, below the minimum supported version 0\.0\.3/);
    assert.deepEqual(r.listing, []);
  });

  it('refuses a downgrade unless --allow-downgrade', async () => {
    const refused = await runInstaller({ installed: '0.0.4' });
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /0\.0\.4 is installed .* older 0\.0\.3; pass --allow-downgrade/);
    assert.equal(await versionOf(refused.app), '0.0.4');
    const allowed = await runInstaller({ installed: '0.0.4', args: ['--allow-downgrade'] });
    assert.equal(allowed.code, 0, allowed.stderr);
    assert.equal(await versionOf(allowed.app), '0.0.3');
  });

  it('refuses two different hashes for the DMG', async () => {
    const r = await runInstaller({ sums: `${'a'.repeat(64)}  ${RELEASE_CONTRACT.dmgFile}\n${'b'.repeat(64)}  ${RELEASE_CONTRACT.dmgFile}\n` });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /two different hashes/);
  });

  it('K85: refuses a SHA256SUMS line that is not "<sha256>  <file>", as the other launchers do', async () => {
    const good = `${'a'.repeat(64)}  ${RELEASE_CONTRACT.dmgFile}\n`;
    for (const bad of [`${'b'.repeat(63)}  other.zip\n`, 'not a checksum line\n', `${'c'.repeat(64)}  dir/other.zip\n`]) {
      const r = await runInstaller({ sums: good + bad });
      assert.equal(r.code, 2, bad);
      assert.match(r.stderr, /contains a line that is not/);
    }
  });

  it('K85: every download is capped at 2 GiB with a bounded connect', async () => {
    const script = await readFile(SCRIPT, 'utf8');
    assert.match(script, /--max-filesize 2147483648 --connect-timeout 15/);
  });

  it('refuses a symlinked iclone os.app and leaves the link and its target alone', async () => {
    /** @type {string} */
    let real = '';
    const r = await runInstaller({
      prepare: async (dest) => {
        real = join(dest, '..', 'elsewhere', APP);
        await writeApp(real, '0.0.2');
        await symlink(real, join(dest, APP));
      },
    });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /is a symbolic link; icloneos will not follow, replace or remove it/);
    assert.equal(await versionOf(real), '0.0.2');
  });

  it('regex-escapes the destination for the running-app check', async () => {
    const r = await runInstaller({ installed: '0.0.2', destName: 'Apps (x)+[y]' });
    assert.equal(r.code, 0, r.stderr);
    const pattern = (await readFile(join(r.fixtures, 'pgrep.log'), 'utf8')).trim();
    assert.ok(pattern.includes('Apps \\(x\\)\\+\\[y\\]/iclone os\\.app/Contents/MacOS/'), pattern);
  });

  it('with signed sums on, accepts a Developer ID signer of our team and refuses a bad signature', async () => {
    const good = await runInstaller({ requireSignedSums: true });
    assert.equal(good.code, 0, good.stderr);
    const bad = await runInstaller({ requireSignedSums: true, env: { SMIME_FAILS: '1' } });
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /signature on SHA256SUMS\.txt is invalid/);
    assert.deepEqual(bad.listing, []);
  });
});
