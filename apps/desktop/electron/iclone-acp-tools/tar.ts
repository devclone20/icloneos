/**
 * REL-6 — read an npm package tarball (gzip'd ustar/pax) the way npm's own extractor does for a package: regular
 * files and directories only (links, devices and FIFOs are skipped, as pacote skips them), the first path component
 * (`package/`) stripped, and every path refused that is absolute, climbs with `..` or carries a NUL. Pure buffers: the
 * caller writes the files, so nothing here touches the disk.
 */
import { gunzip } from 'node:zlib'

export interface TarFile {
  /** `/`-separated, relative to the package root (the tarball's first component stripped). */
  path: string
  /** 0o755 when the archive marks any execute bit, else 0o644 (npm's normalisation). */
  mode: number
  data: Buffer
}

export class TarError extends Error {}

const BLOCK = 512

function field(header: Buffer, at: number, length: number): string {
  const end = header.indexOf(0, at)

  return header.toString('utf8', at, end < 0 || end > at + length ? at + length : end)
}

function octal(header: Buffer, at: number, length: number): number {
  // GNU base-256 for sizes over 8 GiB: never in an npm tarball, so it is refused rather than read.
  if (header[at] !== undefined && (header[at] as number) & 0x80) {
    throw new TarError('tar: base-256 size field')
  }

  const text = field(header, at, length).trim()

  return text ? Number.parseInt(text, 8) : 0
}

/** pax `len key=value\n` records; only `path` matters for a package. */
function paxPath(data: Buffer): string | null {
  let found: string | null = null

  for (let at = 0; at < data.length;) {
    const space = data.indexOf(0x20, at)

    if (space < 0) {
      break
    }

    const length = Number.parseInt(data.toString('utf8', at, space), 10)

    if (!Number.isFinite(length) || length <= 0) {
      break
    }

    const record = data.toString('utf8', space + 1, at + length - 1)
    const eq = record.indexOf('=')

    if (eq > 0 && record.slice(0, eq) === 'path') {
      found = record.slice(eq + 1)
    }

    at += length
  }

  return found
}

/** The package-relative path, or null for the root itself; throws on anything that could leave the package. */
export function packagePath(raw: string): string | null {
  if (raw.includes('\0') || raw.includes('\\')) {
    throw new TarError(`tar: unsafe path ${JSON.stringify(raw.slice(0, 120))}`)
  }

  const parts = raw.split('/').filter(part => part !== '' && part !== '.')

  if (raw.startsWith('/') || parts.some(part => part === '..')) {
    throw new TarError(`tar: unsafe path ${JSON.stringify(raw.slice(0, 120))}`)
  }

  // npm strips the first component whatever its name (`package/`, or a repo name in older tarballs).
  const rest = parts.slice(1)

  return rest.length > 0 ? rest.join('/') : null
}

/** Every regular file of an uncompressed tar, in archive order. A later entry of the same path wins. */
export function readTar(tar: Buffer): TarFile[] {
  const files = new Map<string, TarFile>()
  let nextPath: string | null = null

  for (let at = 0; at + BLOCK <= tar.length;) {
    const header = tar.subarray(at, at + BLOCK)

    if (header.every(byte => byte === 0)) {
      break
    }

    const stored = octal(header, 148, 8)
    let sum = 0

    for (let i = 0; i < BLOCK; i++) {
      sum += i >= 148 && i < 156 ? 0x20 : (header[i] as number)
    }

    if (sum !== stored) {
      throw new TarError('tar: header checksum mismatch')
    }

    const size = octal(header, 124, 12)
    const type = String.fromCharCode(header[156] || 0x30)
    const dataStart = at + BLOCK
    const dataEnd = dataStart + size

    if (dataEnd > tar.length) {
      throw new TarError('tar: entry runs past the end of the archive')
    }

    const data = tar.subarray(dataStart, dataEnd)

    at = dataStart + Math.ceil(size / BLOCK) * BLOCK

    if (type === 'x') {
      nextPath = paxPath(data)

      continue
    }

    if (type === 'L') {
      nextPath = data.toString('utf8').replace(/\0+$/, '')

      continue
    }

    if (type === 'g') {
      continue
    }

    const prefix = field(header, 345, 155)
    const name = field(header, 0, 100)
    const raw = nextPath ?? (prefix ? `${prefix}/${name}` : name)

    nextPath = null

    const rel = packagePath(raw)

    if (rel === null || (type !== '0' && type !== '\0' && type !== '7')) {
      // The root, directories (implied by their files), links, devices, FIFOs: never written.
      continue
    }

    const mode = octal(header, 100, 8)

    files.set(rel, { path: rel, mode: mode & 0o111 ? 0o755 : 0o644, data: Buffer.from(data) })
  }

  return [...files.values()]
}

export function gunzipAsync(buffer: Buffer, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    gunzip(buffer, { maxOutputLength: maxBytes }, (error, out) =>
      error ? reject(new TarError(`tar: ${error.message}`)) : resolve(out)
    )
  })
}
