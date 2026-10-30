import { describe, expect, it } from 'vitest'

import { diagnoseInstallFailure } from './install-diagnosis'

describe('every install failure class has a diagnosis and one fix (RTB-6)', () => {
  const cases: [string, Parameters<typeof diagnoseInstallFailure>[0], string, string][] = [
    [
      'no network / DNS',
      {
        stage: 'python-deps',
        error: 'exit code 1',
        log: ['  → Installing', 'error: Could not resolve host: files.pythonhosted.org']
      },
      'network',
      'retry'
    ],
    [
      'registry unreachable',
      {
        stage: 'python-deps',
        log: [
          'error: Request failed after 3 retries',
          'Caused by: error sending request for url (https://pypi.org/simple/)'
        ]
      },
      'network',
      'retry'
    ],
    [
      'GitHub unreachable (getaddrinfo)',
      { stage: 'repository', error: 'getaddrinfo ENOTFOUND github.com' },
      'network',
      'retry'
    ],
    [
      'download hash mismatch',
      { stage: 'repository', error: 'sha256 mismatch for runtime tarball: expected 1ca5, got 9f00' },
      'integrity',
      'repair'
    ],
    [
      'disk full',
      { stage: 'python-deps', log: ['OSError: [Errno 28] No space left on device: needs 1.2 GiB'] },
      'disk',
      'open-storage-settings'
    ],
    [
      'userData not writable',
      { stage: 'venv', error: "EACCES: permission denied, mkdir '/x/hermes-runtime'" },
      'permission',
      'reveal-folder'
    ],
    [
      'read-only volume',
      { stage: 'venv', log: ['OSError: [Errno 30] Read-only file system'] },
      'permission',
      'reveal-folder'
    ],
    [
      'resolver cannot build',
      { stage: 'python-deps', log: ['  × Failed to build `pyaudio==0.2.14`', "  ╰─▶ error: command 'clang' failed"] },
      'resolver',
      'repair'
    ],
    ['interpreter missing', { stage: 'venv', log: ['bash: python3.14: command not found'] }, 'interpreter', 'repair'],
    [
      'killed by the OS',
      { stage: 'python-deps', error: 'install.sh --stage python-deps produced no JSON result frame (exit=137)' },
      'killed',
      'retry'
    ],
    [
      'stalled (watchdog)',
      { stage: 'python-deps', error: '[iclone-install-watchdog] no progress (output, CPU or bytes written) for 120 s' },
      'stalled',
      'retry'
    ],
    [
      'over the first-launch budget: slow, not stuck (r2)',
      { stage: 'python-deps', error: '[iclone-install-watchdog] ceiling 900 s reached' },
      'slow',
      'retry'
    ],
    ['cancelled', { stage: 'python-deps', error: 'cancelled by user' }, 'cancelled', 'retry'],
    ['unknown', { stage: 'config', error: 'exit code 3', log: ['something odd'] }, 'unknown', 'repair']
  ]

  it.each(cases)('%s', (_name, input, cls, fix) => {
    const diagnosis = diagnoseInstallFailure(input)

    expect(diagnosis.class).toBe(cls)
    expect(diagnosis.fix).toBe(fix)
    expect(diagnosis.stage).toBe(input.stage)
    expect(diagnosis.evidence).toBeTruthy()
  })

  it('reads the amount a full disk needs', () => {
    expect(diagnoseInstallFailure({ log: ['No space left on device: needs 1.5 GiB'] }).neededBytes).toBe(
      Math.round(1.5 * 2 ** 30)
    )
  })

  it('names the package that failed inside the dependency stage', () => {
    const diagnosis = diagnoseInstallFailure({
      log: ['✗ cua-driver: download failed: Connection reset by peer', '⚠ optional cua-driver was not installed'],
      stage: 'python-deps'
    })

    expect(diagnosis).toMatchObject({ class: 'network', packageName: 'cua-driver' })
  })

  it('a hash mismatch seen during a download is integrity, not network', () => {
    expect(diagnoseInstallFailure({ log: ['Failed to download x', 'Hash mismatch for x.whl'] }).class).toBe('integrity')
  })

  it('the LAST telling line wins (critic minor 1): an early network blip, then a full disk → disk', () => {
    expect(
      diagnoseInstallFailure({
        log: ['Connection reset by peer, retrying', 'ok', 'OSError: [Errno 28] No space left on device']
      }).class
    ).toBe('disk')
    expect(
      diagnoseInstallFailure({
        log: ['OSError: [Errno 28] No space left on device', 'then: Could not resolve host: pypi.org']
      }).class
    ).toBe('network')
  })

  it('proxy and SSL only match their failure shapes, not package names that contain them', () => {
    for (const line of ['Installed pyOpenSSL 24.2.1', 'Downloading proxy-tools (12KiB)', 'ssl_context created']) {
      expect(diagnoseInstallFailure({ log: [line] }).class, line).toBe('unknown')
    }

    expect(
      diagnoseInstallFailure({ log: ["requests.exceptions.ProxyError: HTTPSConnectionPool(host='pypi.org')"] }).class
    ).toBe('network')
    expect(diagnoseInstallFailure({ log: ['ssl.SSLError: [SSL: CERTIFICATE_VERIFY_FAILED]'] }).class).toBe('network')
  })
})
