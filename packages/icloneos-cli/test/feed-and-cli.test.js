// @ts-check
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { main } from '../src/cli.js';
import { Refusal } from '../src/contract.js';
import { assertAllowedUrl, compareVersions, parseFeedVersion, parseSha256Sums } from '../src/feed.js';
import { parseCodesignDisplay } from '../src/verify.js';
import { makeFakeSystem } from './fake-system.js';

describe('feed parsing', () => {
  it('reads the version from a real latest-mac.yml', () => {
    const yml = "version: 0.0.2\nfiles:\n  - url: iclone-os-0.0.2-mac-arm64.zip\n    size: 248146632\npath: iclone-os-0.0.2-mac-arm64.zip\nreleaseDate: '2026-10-21T04:35:35.148Z'\n";
    assert.equal(parseFeedVersion(yml), '0.0.2');
  });

  it('refuses a feed version that could escape the URL', () => {
    assert.throws(() => parseFeedVersion('version: ../../evil\n'), Refusal);
    assert.throws(() => parseFeedVersion('files: []\n'), Refusal);
  });

  it('parses SHA256SUMS in text and binary mode', () => {
    const sums = parseSha256Sums(`${'0'.repeat(64)}  a.dmg\n${'1'.repeat(64)} *b.zip\n`);
    assert.equal(sums.get('a.dmg'), '0'.repeat(64));
    assert.equal(sums.get('b.zip'), '1'.repeat(64));
  });

  it('refuses malformed or contradictory checksum lists', () => {
    assert.throws(() => parseSha256Sums('nothex  a.dmg\n'), Refusal);
    assert.throws(() => parseSha256Sums(`${'0'.repeat(64)}  a.dmg\n${'1'.repeat(64)}  a.dmg\n`), Refusal);
    assert.throws(() => parseSha256Sums(`${'0'.repeat(64)}  ../a.dmg\n`), Refusal);
  });

  it('compares versions numerically', () => {
    assert.ok(compareVersions('0.0.10', '0.0.9') > 0);
    assert.equal(compareVersions('0.0.2', '0.0.2.0'), 0);
    assert.ok(compareVersions('0.0.1', '0.0.2') < 0);
  });

  it('accepts only HTTPS GitHub release hosts', () => {
    assertAllowedUrl('https://github.com/devclone20/icloneos/releases/latest/download/x');
    assertAllowedUrl('https://release-assets.githubusercontent.com/x');
    assert.throws(() => assertAllowedUrl('http://github.com/x'), Refusal);
    assert.throws(() => assertAllowedUrl('https://github.com.evil.example/x'), Refusal);
  });

  it('parses codesign --display output', () => {
    const report = 'Identifier=io.cloneframe.icloneos\nAuthority=Developer ID Application: A (HJSLQL98D8)\nAuthority=Apple Root CA\nTeamIdentifier=HJSLQL98D8\n';
    assert.deepEqual(parseCodesignDisplay(report), {
      identifier: 'io.cloneframe.icloneos',
      teamId: 'HJSLQL98D8',
      leafAuthority: 'Developer ID Application: A (HJSLQL98D8)',
    });
  });
});

describe('command line', () => {
  /** @param {string[]} argv */
  async function cli(argv) {
    const fake = await makeFakeSystem();
    /** @type {string[]} */
    const out = [];
    /** @type {string[]} */
    const err = [];
    const code = await main(argv, fake.sys, { out: (l) => out.push(l), err: (l) => err.push(l) });
    await fake.cleanup();
    return { code, out: out.join('\n'), err: err.join('\n') };
  }

  it('prints the package version', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    assert.deepEqual((await cli(['--version'])).out, manifest.version);
  });

  it('prints usage listing exactly the four verbs', async () => {
    const { code, out } = await cli(['--help']);
    assert.equal(code, 0);
    for (const verb of ['install', 'launch', 'update', 'uninstall']) assert.match(out, new RegExp(`icloneos ${verb}`));
  });

  it('rejects unknown verbs and flags with exit 64', async () => {
    assert.equal((await cli(['frobnicate'])).code, 64);
    assert.equal((await cli(['install', '--sudo'])).code, 64);
    assert.equal((await cli(['install', '--dest', '/x', '--system'])).code, 64);
    assert.equal((await cli(['launch', '--force'])).code, 64);
    assert.equal((await cli(['update', '--allow-downgrade'])).code, 64);
    assert.equal((await cli(['uninstall', '--allow-downgrade'])).code, 64);
  });

  it('accepts --force on uninstall and --allow-downgrade on install', async () => {
    assert.match((await cli(['uninstall', '--force'])).err, /not installed/);
    assert.equal((await cli(['install', '--allow-downgrade', '--system'])).code, 0);
  });

  it('turns a refusal into exit 2 with a one-line reason', async () => {
    const { code, err } = await cli(['launch']);
    assert.equal(code, 2);
    assert.match(err, /^icloneos: refused — iclone os is not installed/);
  });
});
