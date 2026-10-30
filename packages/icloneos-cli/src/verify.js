// @ts-check
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

import { RELEASE_CONTRACT, Refusal } from './contract.js';

/**
 * @typedef {{ code: number, stdout: string, stderr: string }} RunResult
 * @typedef {(command: string, args: readonly string[]) => Promise<RunResult>} Runner
 */

/**
 * @param {string} path
 * @returns {Promise<string>}
 */
export async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * @param {string} path
 * @param {string} expected
 * @param {string} label
 * @returns {Promise<void>}
 */
export async function verifyDigest(path, expected, label) {
  const actual = await sha256File(path);
  if (actual !== expected) {
    throw new Refusal(
      `The sha256 of ${label} (${actual}) does not match the published SHA256SUMS (${expected}).`,
    );
  }
}

/**
 * `codesign --display` writes its report to stderr as `Key=Value` lines.
 * @param {string} report
 * @returns {{ identifier: string | undefined, teamId: string | undefined, leafAuthority: string | undefined }}
 */
export function parseCodesignDisplay(report) {
  /** @type {string | undefined} */
  let identifier;
  /** @type {string | undefined} */
  let teamId;
  /** @type {string | undefined} */
  let leafAuthority;
  for (const line of report.split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator === -1) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1).trim();
    if (key === 'Identifier') identifier = value;
    else if (key === 'TeamIdentifier') teamId = value;
    else if (key === 'Authority' && leafAuthority === undefined) leafAuthority = value;
  }
  return { identifier, teamId, leafAuthority };
}

/**
 * @param {Runner} run
 * @param {string} path
 * @param {string} label
 * @returns {Promise<{ identifier: string | undefined }>}
 */
export async function verifyDeveloperIdTeam(run, path, label) {
  const display = await run('codesign', ['--display', '--verbose=2', path]);
  if (display.code !== 0) throw new Refusal(`codesign could not read the signature of ${label}.`);
  const { identifier, teamId, leafAuthority } = parseCodesignDisplay(display.stderr + display.stdout);
  if (teamId !== RELEASE_CONTRACT.teamId) {
    throw new Refusal(
      `${label} is signed by team ${teamId ?? 'none'}, not the iclone os team ${RELEASE_CONTRACT.teamId}.`,
    );
  }
  if (leafAuthority === undefined || !leafAuthority.startsWith('Developer ID Application:')) {
    throw new Refusal(`${label} is not signed with a Developer ID Application certificate.`);
  }
  return { identifier };
}

/**
 * The disk image is checked before it is mounted so an untrusted image never reaches hdiutil's parser
 * beyond what the hash check already allowed.
 * @param {Runner} run
 * @param {string} dmgPath
 * @returns {Promise<void>}
 */
export async function verifyDiskImage(run, dmgPath) {
  const label = 'the disk image';
  const verify = await run('codesign', ['--verify', '--strict', '--verbose=2', dmgPath]);
  if (verify.code !== 0) throw new Refusal(`The code signature of ${label} is invalid.`);
  await verifyDeveloperIdTeam(run, dmgPath, label);
  const assess = await run('spctl', [
    '--assess',
    '--type',
    'open',
    '--context',
    'context:primary-signature',
    '--verbose=2',
    dmgPath,
  ]);
  if (assess.code !== 0 || !`${assess.stderr}${assess.stdout}`.includes('source=Notarized Developer ID')) {
    throw new Refusal(`Gatekeeper does not accept ${label} as notarised.`);
  }
}

/**
 * Signature, seal, team and bundle id: everything that can be proven offline in a second or two. `launch`
 * runs this before every open because launcher-installed apps carry no quarantine flag, so Gatekeeper does
 * not assess them on launch.
 * @param {Runner} run
 * @param {string} appPath
 * @returns {Promise<void>}
 */
export async function verifySignedApp(run, appPath) {
  const label = 'the app bundle';
  const verify = await run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  if (verify.code !== 0) throw new Refusal(`The code signature of ${label} is invalid or was modified.`);
  const { identifier } = await verifyDeveloperIdTeam(run, appPath, label);
  if (identifier !== RELEASE_CONTRACT.bundleId) {
    throw new Refusal(
      `${label} identifies as ${identifier ?? 'nothing'}, not ${RELEASE_CONTRACT.bundleId}.`,
    );
  }
}

/**
 * @param {Runner} run
 * @param {string} appPath
 * @returns {Promise<void>}
 */
export async function verifyAppBundle(run, appPath) {
  const label = 'the app bundle';
  await verifySignedApp(run, appPath);
  const assess = await run('spctl', ['--assess', '--type', 'execute', '--verbose=2', appPath]);
  if (assess.code !== 0 || !`${assess.stderr}${assess.stdout}`.includes('source=Notarized Developer ID')) {
    throw new Refusal(`Gatekeeper does not accept ${label} as notarised.`);
  }
}
