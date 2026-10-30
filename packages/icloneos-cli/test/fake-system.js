// @ts-check
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RELEASE_CONTRACT, Refusal } from '../src/contract.js';

/**
 * @typedef {{
 *   feedVersion?: string,
 *   dmgBytes?: Buffer,
 *   deliveredBytes?: Buffer,
 *   appVersion?: string,
 *   appBundleId?: string,
 *   appTeamId?: string,
 *   dmgTeamId?: string,
 *   appCodesignValid?: boolean,
 *   dmgCodesignValid?: boolean,
 *   appNotarised?: boolean,
 *   dmgNotarised?: boolean,
 *   running?: boolean,
 *   attachCode?: number,
 *   uid?: number,
 *   platform?: string,
 *   abortSignal?: AbortSignal,
 *   onCommand?: (command: string, args: readonly string[]) => void | Promise<void>,
 *   sumsSignature?: { opensslVerifies?: boolean, signerCount?: number, signerReport?: string, rootMissing?: boolean, missing?: boolean },
 * }} Scenario
 * @typedef {{ command: string, args: readonly string[] }} Call
 */

/**
 * Writes a minimal bundle whose Info.plist is JSON; the fake plutil reads it back.
 * @param {string} appPath
 * @param {{ bundleId: string, version: string }} info
 * @returns {Promise<void>}
 */
export async function writeFakeApp(appPath, info) {
  await mkdir(join(appPath, 'Contents', 'MacOS'), { recursive: true });
  await writeFile(
    join(appPath, 'Contents', 'Info.plist'),
    JSON.stringify({ CFBundleIdentifier: info.bundleId, CFBundleVersion: info.version }),
  );
  await writeFile(join(appPath, 'Contents', 'MacOS', 'iclone os'), '#!/bin/sh\n');
}

/**
 * @param {string} teamId
 * @param {string} identifier
 * @returns {string}
 */
function codesignReport(teamId, identifier) {
  return [
    `Executable=/fake`,
    `Identifier=${identifier}`,
    `Authority=Developer ID Application: Test (${teamId})`,
    'Authority=Developer ID Certification Authority',
    'Authority=Apple Root CA',
    `TeamIdentifier=${teamId}`,
  ].join('\n');
}

/** A well-formed PEM block that is not Apple's root: the fake root store lists it first, as the real one does. */
export const OTHER_ROOT_PEM = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----';
/** The real, public Apple Root CA (exported from SystemRootCertificates.keychain), so the pin itself is tested. */
export const APPLE_ROOT_CA_PEM = readFileSync(new URL('./fixtures/apple-root-ca.crt', import.meta.url), 'utf8').trim();

/**
 * @param {string} teamId
 * @param {{ issuerCn?: string, cn?: string, marker?: boolean }} [overrides]
 * @returns {string}
 */
export function developerIdSignerReport(teamId, overrides = {}) {
  return [
    'Certificate:',
    '    Data:',
    '        X509v3 extensions:',
    ...(overrides.marker === false ? [] : ['            1.2.840.113635.100.6.1.13: critical']),
    'subject= ',
    `    UID=${teamId}`,
    `    CN=${overrides.cn ?? `Developer ID Application: Test (${teamId})`}`,
    `    OU=${teamId}`,
    '    O=Test',
    '    C=PT',
    'issuer= ',
    `    CN=${overrides.issuerCn ?? 'Developer ID Certification Authority'}`,
    '    OU=Apple Certification Authority',
    '    O=Apple Inc.',
    '    C=US',
    '',
  ].join('\n');
}

/**
 * @param {Scenario} [scenario]
 */
export async function makeFakeSystem(scenario = {}) {
  const root = await mkdtemp(join(tmpdir(), 'icloneos-test-'));
  const home = join(root, 'home');
  const tmpRoot = join(root, 'tmp');
  await mkdir(home, { recursive: true });
  await mkdir(tmpRoot, { recursive: true });

  const feedVersion = scenario.feedVersion ?? '0.0.3';
  const dmgBytes = scenario.dmgBytes ?? Buffer.from('genuine iclone os disk image');
  const published = createHash('sha256').update(dmgBytes).digest('hex');

  /** @type {Call[]} */
  const calls = [];
  /** @type {string[]} */
  const fetched = [];

  const controller = new AbortController();
  const abortSignal = scenario.abortSignal ?? controller.signal;
  const signature = scenario.sumsSignature ?? {};

  /** @type {import('../src/verify.js').Runner} */
  const run = async (command, args) => {
    calls.push({ command, args });
    await scenario.onCommand?.(command, args);
    const last = args[args.length - 1] ?? '';
    const isDmg = last.endsWith('.dmg');
    switch (command) {
      case 'codesign': {
        if (args[0] === '--verify') {
          const valid = isDmg ? scenario.dmgCodesignValid !== false : scenario.appCodesignValid !== false;
          return { code: valid ? 0 : 1, stdout: '', stderr: valid ? 'valid on disk' : 'a sealed resource is missing or invalid' };
        }
        const team = isDmg ? (scenario.dmgTeamId ?? RELEASE_CONTRACT.teamId) : (scenario.appTeamId ?? RELEASE_CONTRACT.teamId);
        const identifier = isDmg ? 'iclone-os-mac-arm64' : (scenario.appBundleId ?? RELEASE_CONTRACT.bundleId);
        return { code: 0, stdout: '', stderr: codesignReport(team, identifier) };
      }
      case 'spctl': {
        const notarised = isDmg ? scenario.dmgNotarised !== false : scenario.appNotarised !== false;
        return notarised
          ? { code: 0, stdout: '', stderr: `${last}: accepted\nsource=Notarized Developer ID\n` }
          : { code: 3, stdout: '', stderr: `${last}: rejected\nsource=Unnotarized Developer ID\n` };
      }
      case 'hdiutil': {
        if (args[0] === 'attach') {
          const mountPoint = args[args.indexOf('-mountpoint') + 1] ?? '';
          await writeFakeApp(join(mountPoint, RELEASE_CONTRACT.appBundleName), {
            bundleId: scenario.appBundleId ?? RELEASE_CONTRACT.bundleId,
            version: scenario.appVersion ?? feedVersion,
          });
          // attachCode: hdiutil mounted the image but still answered with an error.
          return { code: scenario.attachCode ?? 0, stdout: '', stderr: '' };
        }
        const mountPoint = args[1] ?? '';
        for (const entry of await readdir(mountPoint)) await rm(join(mountPoint, entry), { recursive: true });
        return { code: 0, stdout: '', stderr: '' };
      }
      case 'ditto': {
        await cp(args[0] ?? '', args[1] ?? '', { recursive: true, errorOnExist: true });
        return { code: 0, stdout: '', stderr: '' };
      }
      case 'plutil': {
        try {
          const plist = JSON.parse(await readFile(last, 'utf8'));
          const value = plist[args[1] ?? ''];
          return typeof value === 'string' ? { code: 0, stdout: `${value}\n`, stderr: '' } : { code: 1, stdout: '', stderr: 'no key' };
        } catch {
          return { code: 1, stdout: '', stderr: 'unreadable' };
        }
      }
      case 'pgrep':
        return { code: scenario.running ? 0 : 1, stdout: '', stderr: '' };
      case 'open':
        return { code: 0, stdout: '', stderr: '' };
      case 'security':
        return signature.rootMissing
          ? { code: 0, stdout: `${OTHER_ROOT_PEM}\n`, stderr: '' }
          : { code: 0, stdout: `${OTHER_ROOT_PEM}\n${APPLE_ROOT_CA_PEM}\n`, stderr: '' };
      case 'openssl': {
        if (args[0] === 'smime') {
          if (signature.opensslVerifies === false) return { code: 4, stdout: '', stderr: 'Verification failure' };
          const signerPath = args[args.indexOf('-signer') + 1] ?? '';
          await writeFile(signerPath, `${OTHER_ROOT_PEM}\n`.repeat(signature.signerCount ?? 1));
          return { code: 0, stdout: '', stderr: 'Verification successful' };
        }
        return { code: 0, stdout: signature.signerReport ?? developerIdSignerReport(RELEASE_CONTRACT.teamId), stderr: '' };
      }
      default:
        throw new Error(`unexpected command ${command}`);
    }
  };

  /** @type {import('../src/system.js').System} */
  const sys = {
    run,
    async fetchText(url) {
      fetched.push(url);
      if (url.endsWith(`/${RELEASE_CONTRACT.feedFile}`)) {
        return `version: ${feedVersion}\nfiles:\n  - url: x.zip\nreleaseDate: '2026-10-21'\n`;
      }
      if (url.endsWith(`/${RELEASE_CONTRACT.sumsFile}`)) {
        return `${published}  ${RELEASE_CONTRACT.dmgFile}\n${'a'.repeat(64)}  other.zip\n`;
      }
      throw new Error(`unexpected fetch ${url}`);
    },
    async download(url, destination) {
      fetched.push(url);
      // sumsSignature.missing: the release has no .sig — what system.js fetchVerified throws for an HTTP 404.
      if (signature.missing && url.endsWith(`/${RELEASE_CONTRACT.sumsSignatureFile}`)) {
        throw new Refusal(`The release server answered HTTP 404 for ${url}.`);
      }
      const body = url.endsWith(`/${RELEASE_CONTRACT.sumsSignatureFile}`) ? Buffer.from('cms') : (scenario.deliveredBytes ?? dmgBytes);
      await writeFile(destination, body, { flag: 'wx' });
    },
    abortSignal,
    home,
    systemAppsDir: join(root, 'Applications'),
    tmpRoot,
    platform: scenario.platform ?? 'darwin',
    arch: 'arm64',
    uid: scenario.uid ?? 501,
  };

  return {
    sys,
    calls,
    fetched,
    home,
    tmpRoot,
    dest: join(home, 'Applications'),
    abort: (/** @type {string} */ reason) => controller.abort(reason),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
