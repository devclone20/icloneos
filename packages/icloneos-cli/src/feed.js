// @ts-check
import { RELEASE_CONTRACT, Refusal } from './contract.js';

const VERSION_PATTERN = /^\d+(?:\.\d+){1,3}$/;
const SHA256_LINE = /^([0-9a-f]{64}) [ *]([^\s/][^/]*)$/;

/**
 * @param {string} file
 * @returns {string}
 */
export function latestAssetUrl(file) {
  return `https://github.com/${RELEASE_CONTRACT.repository}/releases/latest/download/${encodeURIComponent(file)}`;
}

/**
 * Both the checksum list and the DMG are fetched from the same tag so they cannot come from two
 * different releases if "latest" moves between requests.
 * @param {string} version
 * @param {string} file
 * @returns {string}
 */
export function taggedAssetUrl(version, file) {
  return `https://github.com/${RELEASE_CONTRACT.repository}/releases/download/v${version}/${encodeURIComponent(file)}`;
}

/**
 * Reads only the top-level `version:` key of electron-builder's latest-mac.yml; nothing else in the
 * file is trusted or needed.
 * @param {string} yamlText
 * @returns {string}
 */
export function parseFeedVersion(yamlText) {
  for (const line of yamlText.split(/\r?\n/)) {
    const match = /^version:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line);
    if (match?.[1] !== undefined) {
      if (!VERSION_PATTERN.test(match[1])) {
        throw new Refusal(`The release feed announces a malformed version "${match[1]}".`);
      }
      return match[1];
    }
  }
  throw new Refusal('The release feed does not announce a version.');
}

/**
 * @param {string} text
 * @returns {Map<string, string>}
 */
export function parseSha256Sums(text) {
  /** @type {Map<string, string>} */
  const sums = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line === '') continue;
    const match = SHA256_LINE.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) {
      throw new Refusal('The checksum list contains a line that is not "<sha256>  <file>".');
    }
    const previous = sums.get(match[2]);
    if (previous !== undefined && previous !== match[1]) {
      throw new Refusal(`The checksum list gives two different hashes for ${match[2]}.`);
    }
    sums.set(match[2], match[1]);
  }
  return sums;
}

/**
 * @param {Map<string, string>} sums
 * @param {string} file
 * @returns {string}
 */
export function expectedHashFor(sums, file) {
  const hash = sums.get(file);
  if (hash === undefined) throw new Refusal(`The checksum list has no entry for ${file}.`);
  return hash;
}

/**
 * Numeric, dot-separated comparison; missing components count as zero.
 * @param {string} a
 * @param {string} b
 * @returns {number} negative if a < b, zero if equal, positive if a > b
 */
export function compareVersions(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * @param {string} url
 * @returns {void}
 */
export function assertAllowedUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') {
    throw new Refusal(`Refusing a non-HTTPS download location (${parsed.protocol}).`);
  }
  if (!RELEASE_CONTRACT.allowedDownloadHosts.includes(parsed.hostname)) {
    throw new Refusal(`The download was redirected to an unexpected host (${parsed.hostname}).`);
  }
}

/**
 * The rollback floor. Someone who can write to the release repository could point "latest" at an older,
 * genuinely notarised build with a known flaw; Apple's signature cannot tell the two apart, the floor can.
 * @param {string} version
 * @returns {void}
 */
export function assertNotBelowFloor(version) {
  if (compareVersions(version, RELEASE_CONTRACT.minimumVersion) < 0) {
    throw new Refusal(
      `The release feed offers ${version}, below the minimum supported version ${RELEASE_CONTRACT.minimumVersion}; this looks like a rollback, so nothing was installed.`,
    );
  }
}
