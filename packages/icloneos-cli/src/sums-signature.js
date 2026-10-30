// @ts-check
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { RELEASE_CONTRACT, Refusal } from './contract.js';

/** @typedef {import('./verify.js').Runner} Runner */

export const SYSTEM_ROOTS_KEYCHAIN = '/System/Library/Keychains/SystemRootCertificates.keychain';
/** Apple's "Developer ID Application" certificate marker (critical extension on every such leaf). */
export const DEVELOPER_ID_APPLICATION_OID = '1.2.840.113635.100.6.1.13';

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----\r?\n[\s\S]*?-----END CERTIFICATE-----/g;

/**
 * @param {string} pemText
 * @returns {string[]}
 */
export function pemCertificates(pemText) {
  return pemText.match(PEM_BLOCK) ?? [];
}

/**
 * @param {string} pem
 * @returns {string} lowercase hex sha256 of the DER bytes
 */
export function pemFingerprint(pem) {
  const base64 = pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
  return createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex');
}

/**
 * Parses `openssl x509 -noout -text -subject -issuer -nameopt sep_multiline,utf8`: the text dump comes first,
 * then a `subject=` and an `issuer=` block of four-space-indented `KEY=value` lines.
 * @param {string} report
 * @returns {{ subject: Map<string, string>, issuer: Map<string, string>, developerIdMarker: boolean }}
 */
export function parseSignerReport(report) {
  /** @type {Map<string, string>} */
  const subject = new Map();
  /** @type {Map<string, string>} */
  const issuer = new Map();
  /** @type {Map<string, string> | undefined} */
  let section;
  for (const line of report.split(/\r?\n/)) {
    if (line.startsWith('subject=')) section = subject;
    else if (line.startsWith('issuer=')) section = issuer;
    else if (section !== undefined) {
      const match = /^ {4}([A-Za-z]+)=(.*)$/.exec(line);
      if (match?.[1] !== undefined && match[2] !== undefined && !section.has(match[1])) {
        section.set(match[1], match[2]);
      }
    }
  }
  return { subject, issuer, developerIdMarker: report.includes(`${DEVELOPER_ID_APPLICATION_OID}:`) };
}

/**
 * Verifies the detached CMS signature `SHA256SUMS.txt.sig` over the exact bytes of `SHA256SUMS.txt`:
 * the chain must end at Apple Root CA (pinned by sha256, read from the SIP-protected system root store),
 * there must be exactly one signer, and it must be a Developer ID Application certificate of our team
 * issued by Apple's Developer ID Certification Authority. `-ignore_critical` is required because LibreSSL
 * does not know Apple's critical extensions; the one that matters (the Developer ID marker) is checked here.
 * @param {Runner} run
 * @param {{ sumsPath: string, signaturePath: string, workDir: string, teamId?: string }} input
 * @returns {Promise<void>}
 */
export async function verifySumsSignature(run, { sumsPath, signaturePath, workDir, teamId = RELEASE_CONTRACT.teamId }) {
  const label = RELEASE_CONTRACT.sumsFile;
  const roots = await run('security', ['find-certificate', '-a', '-c', 'Apple Root CA', '-p', SYSTEM_ROOTS_KEYCHAIN]);
  const root = pemCertificates(roots.stdout).find((pem) => pemFingerprint(pem) === RELEASE_CONTRACT.appleRootCaSha256);
  if (roots.code !== 0 || root === undefined) {
    throw new Refusal("Apple's root certificate was not found in the system root store, so the checksum list cannot be checked.");
  }
  const rootPath = join(workDir, 'apple-root-ca.pem');
  const signerPath = join(workDir, 'sums-signer.pem');
  await writeFile(rootPath, `${root}\n`, { mode: 0o600, flag: 'wx' });

  const verify = await run('openssl', [
    'smime', '-verify', '-binary', '-inform', 'DER',
    '-in', signaturePath, '-content', sumsPath,
    '-CAfile', rootPath, '-purpose', 'any', '-ignore_critical',
    '-signer', signerPath, '-out', '/dev/null',
  ]);
  if (verify.code !== 0) {
    throw new Refusal(`The signature on ${label} is invalid or does not chain to Apple's root certificate.`);
  }
  const signers = pemCertificates(await readFile(signerPath, 'utf8').catch(() => ''));
  if (signers.length !== 1) throw new Refusal(`${label} must carry exactly one signer, not ${signers.length}.`);

  const report = await run('openssl', [
    'x509', '-in', signerPath, '-noout', '-text', '-subject', '-issuer', '-nameopt', 'sep_multiline,utf8',
  ]);
  if (report.code !== 0) throw new Refusal(`openssl could not read the signer of ${label}.`);
  const { subject, issuer, developerIdMarker } = parseSignerReport(report.stdout);
  if (issuer.get('CN') !== 'Developer ID Certification Authority' || issuer.get('O') !== 'Apple Inc.') {
    throw new Refusal(`${label} was not signed with a certificate from Apple's Developer ID authority.`);
  }
  if (!developerIdMarker || !(subject.get('CN') ?? '').startsWith('Developer ID Application:')) {
    throw new Refusal(`${label} was not signed with a Developer ID Application certificate.`);
  }
  if (subject.get('OU') !== teamId) {
    throw new Refusal(`${label} is signed by team ${subject.get('OU') ?? 'none'}, not the iclone os team ${teamId}.`);
  }
}
