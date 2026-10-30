// @ts-check
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { RELEASE_CONTRACT } from '../src/contract.js';
import { compareVersions } from '../src/feed.js';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const packagingRoot = join(packageRoot, '..', '..', 'packaging');

/** @param {string} path */
const text = (path) => readFile(path, 'utf8');

/**
 * The cask names a published DMG (its sha256 comes from the uploaded file), so it can only move to a release after
 * that release is built. When a release raises the floor to itself, the tagged tree still carries the previous
 * cask: it may then sit exactly one patch below the floor, and nothing lower.
 * @param {string} cask
 * @param {string} floor
 */
export function caskFollowsFloor(cask, floor) {
  if (compareVersions(cask, floor) >= 0) return true;
  const [fMajor = 0, fMinor = 0, fPatch = 0] = floor.split('.').map(Number);
  const [cMajor = 0, cMinor = 0, cPatch = 0] = cask.split('.').map(Number);
  return fPatch > 0 && cMajor === fMajor && cMinor === fMinor && cPatch === fPatch - 1;
}

/**
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function filesUnder(dir) {
  /** @type {string[]} */
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(path)));
    else out.push(path);
  }
  return out;
}

describe('every channel speaks the same release contract', () => {
  it('matches packaging/release-contract.json', async () => {
    const contract = JSON.parse(await text(join(packagingRoot, 'release-contract.json')));
    assert.deepEqual(contract, { ...RELEASE_CONTRACT, allowedDownloadHosts: [...RELEASE_CONTRACT.allowedDownloadHosts] });
  });

  it('is embedded identically in the Python shim, install.sh and the cask', async () => {
    const python = await text(join(packagingRoot, 'python', 'src', 'icloneos', 'cli.py'));
    const shell = await text(join(packagingRoot, 'install.sh'));
    const cask = await text(join(packagingRoot, 'homebrew', 'Casks', 'icloneos.rb'));
    const c = RELEASE_CONTRACT;
    for (const [key, value] of Object.entries({
      REPOSITORY: c.repository, DMG_FILE: c.dmgFile, APP_BUNDLE_NAME: c.appBundleName, BUNDLE_ID: c.bundleId, TEAM_ID: c.teamId,
    })) assert.match(python, new RegExp(`^${key} = "${value.replace(/\./g, '\\.')}"$`, 'm'), `python ${key}`);
    for (const host of c.allowedDownloadHosts) {
      assert.ok(python.includes(`"${host}"`), `python host ${host}`);
      assert.ok(shell.includes(`https://${host}/*`), `install.sh host ${host}`);
    }
    for (const [key, value] of Object.entries({
      REPO: c.repository, DMG: c.dmgFile, APP: c.appBundleName, BUNDLE_ID: c.bundleId, TEAM_ID: c.teamId,
    })) assert.ok(shell.includes(`${key}="${value}"`), `install.sh ${key}`);
    for (const [key, value] of Object.entries({
      MINIMUM_VERSION: c.minimumVersion, SUMS_SIGNATURE_FILE: c.sumsSignatureFile, APPLE_ROOT_CA_SHA256: c.appleRootCaSha256,
    })) assert.match(python, new RegExp(`^${key} = "${value.replace(/\./g, '\\.')}"$`, 'm'), `python ${key}`);
    assert.match(python, new RegExp(`^REQUIRE_SIGNED_SUMS = ${c.requireSignedSums ? 'True' : 'False'}$`, 'm'));
    for (const [key, value] of Object.entries({
      MIN_VERSION: c.minimumVersion, SUMS_SIG: c.sumsSignatureFile, APPLE_ROOT_CA_SHA256: c.appleRootCaSha256,
    })) assert.ok(shell.includes(`${key}="${value}"`), `install.sh ${key}`);
    assert.ok(shell.includes(`REQUIRE_SIGNED_SUMS=${c.requireSignedSums ? 1 : 0}`));
    assert.ok(cask.includes(`github.com/${c.repository}/releases/download/v#{version}/${c.dmgFile}`));
    const caskVersion = /^ {2}version "([^"]+)"$/m.exec(cask)?.[1] ?? '0';
    assert.ok(caskFollowsFloor(caskVersion, c.minimumVersion), `cask ${caskVersion} is below the floor ${c.minimumVersion}`);
    assert.ok(cask.includes(`app "${c.appBundleName}"`));
    assert.match(cask, /^ {2}sha256 "[0-9a-f]{64}"$/m);
  });
});

describe('the cask may trail a floor raised by the release in flight by one patch, never more', () => {
  it('accepts the cask at or above the floor, and exactly one patch below it', () => {
    assert.equal(caskFollowsFloor('0.0.3', '0.0.3'), true);
    assert.equal(caskFollowsFloor('0.0.4', '0.0.3'), true);
    assert.equal(caskFollowsFloor('0.0.2', '0.0.3'), true);
  });

  it('refuses a cask two patches below the floor, or across a minor/major boundary', () => {
    assert.equal(caskFollowsFloor('0.0.1', '0.0.3'), false);
    assert.equal(caskFollowsFloor('0.0.9', '0.1.0'), false);
    assert.equal(caskFollowsFloor('0.9.9', '1.0.0'), false);
  });
});

describe('the Homebrew cask (K80)', () => {
  it('marks the github.com download as verified for a cloneframe.io homepage, and says the app updates itself', async () => {
    const cask = await text(join(packagingRoot, 'homebrew', 'Casks', 'icloneos.rb'));
    const c = RELEASE_CONTRACT;
    // `brew audit --cask` wants `verified:` whenever the url host is not the homepage host.
    assert.match(cask, /^ {2}homepage "https:\/\/cloneframe\.io\/"$/m);
    assert.match(cask, new RegExp(`^ {2}url "https://github\\.com/[^"]+",\\n {6}verified: "github\\.com/${c.repository.replace('/', '\\/')}/"$`, 'm'));
    // electron-updater replaces the bundle itself; without this, `brew upgrade` would fight it.
    assert.match(cask, /^ {2}auto_updates true$/m);
  });
});

describe('the publish workflow (K82)', () => {
  it('never splices the tag, or any ${{ }} expression, into code a step runs', async () => {
    const workflow = await text(join(packagingRoot, 'github-workflows', 'publish.yml'));
    /** @type {string[]} */
    const runBodies = [];
    const lines = workflow.split('\n');
    lines.forEach((line, index) => {
      const run = /^(\s*)(?:- )?run: (\|)?(.*)$/.exec(line);
      if (!run) return;
      if (!run[2]) { runBodies.push(run[3] ?? ''); return; }
      const indent = (run[1] ?? '').length;
      for (let next = index + 1; next < lines.length; next += 1) {
        const body = lines[next] ?? '';
        if (body.trim() && body.search(/\S/) <= indent) break;
        runBodies.push(body);
      }
    });
    assert.ok(runBodies.length >= 6, 'the run bodies were read');
    for (const body of runBodies) {
      assert.doesNotMatch(body, /\$\{\{/, `expression inside a run body: ${body.trim()}`);
      // The tag (or anything derived from it) is never inside the source text node or python is given.
      assert.doesNotMatch(body, /(node|python3?) -(e|c) .*\$(tag|\{tag\}|GITHUB_REF)/, `tag spliced into code: ${body.trim()}`);
    }
    assert.match(workflow, /process\.env\.TAG_VERSION/);
    assert.match(workflow, /grep -Eqx '\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+'/);
  });
});

describe('no channel escalates privileges', () => {
  it('never invokes sudo, osascript admin prompts or privileged helpers', async () => {
    const shipped = [
      ...(await filesUnder(join(packageRoot, 'src'))),
      ...(await filesUnder(join(packageRoot, 'bin'))),
      ...(await filesUnder(join(packagingRoot, 'python', 'src'))),
      ...(await filesUnder(join(packagingRoot, 'npm-defensive', 'bin'))),
      join(packagingRoot, 'install.sh'),
      join(packagingRoot, 'homebrew', 'Casks', 'icloneos.rb'),
    ];
    const invocation = /(^|[;&|`(]\s*|\$\(\s*|['"])sudo(['"\s]|$)|administrator privileges|AuthorizationExecuteWithPrivileges|SMJobBless/m;
    for (const bad of ['sudo mv a b', "run('sudo', [])", 'x=$(sudo id)', 'true && sudo rm', 'with administrator privileges']) {
      assert.match(bad, invocation, `detector must catch: ${bad}`);
    }
    assert.doesNotMatch('icloneos never uses sudo.', invocation);
    for (const file of shipped) {
      const lines = (await text(file)).split('\n');
      lines.forEach((line, index) => {
        assert.doesNotMatch(line, invocation, `${file}:${index + 1}`);
      });
    }
    assert.ok(shipped.length >= 9);
  });
});

describe('every channel reads devclone20/icloneos only (the earlier releases repo is archived)', () => {
  it('pins the release repository, and no shipped launcher, cask, metadata or doc names the archived repo', async () => {
    assert.equal(RELEASE_CONTRACT.repository, 'devclone20/icloneos');
    // Spelled in two halves so this file is not itself a hit.
    const archived = ['iclone-os', 'releases'].join('-');
    const shipped = [
      ...(await filesUnder(join(packageRoot, 'src'))),
      ...(await filesUnder(join(packageRoot, 'bin'))),
      ...(await filesUnder(join(packageRoot, 'scripts'))),
      join(packageRoot, 'README.md'),
      join(packageRoot, 'package.json'),
      ...(await filesUnder(packagingRoot)),
    ];
    const hits = [];
    for (const file of shipped) if ((await text(file)).includes(archived)) hits.push(file);
    assert.deepEqual(hits, []);
    assert.ok(shipped.length >= 15);
  });
});
