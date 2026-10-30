/**
 * V3-S r3 (m-b, m-f): the Python isolation and the env seal every gated Hermes runs with. Pure functions.
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  HERMES_APP_ENV,
  interpreterEnvAllows,
  isolatePythonEnv,
  PYTHON_ISOLATION_FLAGS,
  RUNTIME_LANGUAGE,
  runtimePythonPath,
  sealHermesSpawnEnv,
  SESSION_ENV_ALLOW
} from './iclone-spawn-env'

const SITE = '/rt/venv/lib/python3.11/site-packages'

describe('isolatePythonEnv', () => {
  it('drops every inherited PYTHON* setting that runs or redirects code; keeps encoding and buffering', () => {
    const env = isolatePythonEnv(
      {
        HOME: '/h',
        PATH: '/usr/bin',
        PYTHONBREAKPOINT: 'evil.hook',
        PYTHONEXECUTABLE: '/evil/python',
        PYTHONHOME: '/evil',
        PYTHONINSPECT: '1',
        PYTHONIOENCODING: 'utf-8',
        PYTHONOPTIMIZE: '2',
        PYTHONPLATLIBDIR: 'evil',
        PYTHONPYCACHEPREFIX: '/shared/cache',
        PYTHONSTARTUP: '/evil/startup.py',
        PYTHONUNBUFFERED: '1',
        PYTHONUSERBASE: '/evil/user',
        PYTHONUTF8: '1',
        PYTHONWARNINGS: 'error::evil.Category',
        PYTHON_GIL: '0',
        UNSET: undefined
      },
      '/rt'
    )

    expect(env).toEqual({
      HOME: '/h',
      PATH: '/usr/bin',
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1',
      PYTHONUTF8: '1'
    })
  })

  it('PYTHONPATH keeps only the runtime root and what is inside it (a sibling with the same prefix is outside)', () => {
    const value = ['/rt', SITE, '/evil/site', '/rt-evil', 'relative', '', '/rt'].join(path.delimiter)

    expect(isolatePythonEnv({ PYTHONPATH: value }, '/rt')).toEqual({ PYTHONPATH: ['/rt', SITE].join(path.delimiter) })
    expect(runtimePythonPath('/evil', '/rt')).toBeUndefined()
    expect(isolatePythonEnv({ PYTHONPATH: '/evil' }, '/rt')).toEqual({})
  })

  it('a key is matched whatever its case (Windows env keys are case-insensitive)', () => {
    expect(isolatePythonEnv({ PythonPath: `/rt${path.delimiter}/evil`, PythonStartup: '/evil/s.py' }, '/rt')).toEqual({
      PYTHONPATH: '/rt'
    })
  })

  it('m-b′: __PYVENV_LAUNCHER__, _PYTHON_*, DYLD_* and LD_* are never inherited, whatever their case', () => {
    const env = isolatePythonEnv(
      {
        DYLD_INSERT_LIBRARIES: '/evil/x.dylib',
        DYLD_LIBRARY_PATH: '/evil/lib',
        HOME: '/h',
        LD_LIBRARY_PATH: '/evil/lib',
        LD_PRELOAD: '/evil/x.so',
        PYVENV_LAUNCHER: '/evil/venv/bin/python',
        __PYVENV_LAUNCHER__: '/evil/venv/bin/python',
        __pyvenv_launcher__: '/evil/venv/bin/python',
        _PYTHON_HOST_PLATFORM: 'evil',
        _PYTHON_SYSCONFIGDATA_NAME: 'evil_sysconfigdata'
      },
      '/rt'
    )

    expect(env).toEqual({ HOME: '/h' })
  })

  it('m-b′: HERMES_* is an allowlist — only what the app sets passes; HERMES_BUNDLED_PLUGINS never does', () => {
    const app = Object.fromEntries([...HERMES_APP_ENV].map(key => [key, `app:${key}`]))

    const env = isolatePythonEnv(
      {
        ...app,
        HERMES_BUNDLED_PLUGINS: '/evil/plugins',
        HERMES_ENABLE_PROJECT_PLUGINS: '1',
        HERMES_SAFE_MODE: '1',
        Hermes_Bundled_Plugins: '/evil/plugins',
        OPENROUTER_API_KEY: 'k'
      },
      '/rt'
    )

    // r5 (m-b″): a provider key from the GUI environment is not kept either (Hermes reads HERMES_HOME/.env).
    expect(env).toEqual(app)
    expect([...HERMES_APP_ENV].sort()).toEqual([
      'HERMES_DASHBOARD_SESSION_TOKEN',
      'HERMES_DESKTOP',
      'HERMES_DESKTOP_READY_FILE',
      'HERMES_HOME',
      'HERMES_PARENT_NONCE',
      'HERMES_PARENT_PID',
      'HERMES_PARENT_START_MARKER',
      'HERMES_SPAWN',
      'HERMES_WEB_DIST'
    ])
  })

  it('m-b″: a strict ALLOWLIST — OPENSSL_*, GCONV_PATH, NODE_OPTIONS and anything unlisted never reach a gated Python', () => {
    const env = isolatePythonEnv(
      {
        GCONV_PATH: '/evil/gconv',
        HOME: '/h',
        LANG: 'pt_PT.UTF-8',
        LC_ALL: 'pt_PT.UTF-8',
        LC_CTYPE: 'UTF-8',
        NODE_OPTIONS: '--require /evil/x.js',
        OPENSSL_CONF: '/evil/openssl.cnf',
        OPENSSL_ENGINES: '/evil/engines',
        OPENSSL_MODULES: '/evil/ossl-modules',
        PATH: '/rt/venv/bin:/usr/bin',
        PERL5OPT: '-Mevil',
        RUBYOPT: '-revil',
        SSH_AUTH_SOCK: '/tmp/agent',
        SSL_CERT_FILE: '/evil/ca.pem',
        SystemRoot: 'C:\\Windows',
        TERM: 'xterm-256color',
        TERMINAL_CWD: '/work',
        TMPDIR: '/tmp/x',
        TZ: 'Europe/Lisbon',
        USER: 'u'
      },
      '/rt',
      path,
      'darwin'
    )

    expect(env).toEqual({
      HOME: '/h',
      LANG: 'pt_PT.UTF-8',
      LC_ALL: 'pt_PT.UTF-8',
      LC_CTYPE: 'UTF-8',
      PATH: '/rt/venv/bin:/usr/bin',
      TERM: 'xterm-256color',
      SSH_AUTH_SOCK: '/tmp/agent',
      TERMINAL_CWD: '/work',
      TMPDIR: '/tmp/x',
      TZ: 'Europe/Lisbon',
      USER: 'u'
    })
  })

  it('m-b″: the Windows start-up variables are kept on Windows only; the app’s consent and pay keys always', () => {
    expect(interpreterEnvAllows('SystemRoot', 'win32')).toBe(true)
    expect(interpreterEnvAllows('SystemRoot', 'darwin')).toBe(false)
    expect(interpreterEnvAllows('ICLONE_CONSENT_CAMERA', 'darwin')).toBe(true)
    expect(interpreterEnvAllows('ICLONE_PAY_SOCKET', 'darwin')).toBe(true)
    expect(interpreterEnvAllows('ICLONE_POLICY_LOCK', 'darwin')).toBe(false)
    expect(interpreterEnvAllows('OPENSSL_CONF', 'win32')).toBe(false)
  })

  it('lead ruling (r5b): identity/session variables pass — exactly these eleven, each unable to load code', () => {
    expect([...SESSION_ENV_ALLOW].sort()).toEqual([
      'COLORTERM',
      'LOGNAME',
      'SHELL',
      'SSH_AUTH_SOCK',
      'TERM_PROGRAM',
      'TZ',
      'USER',
      'XDG_CACHE_HOME',
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
      'XDG_RUNTIME_DIR'
    ])

    for (const key of SESSION_ENV_ALLOW) {
      expect(interpreterEnvAllows(key, 'darwin')).toBe(true)
    }
  })

  it.runIf(process.platform !== 'win32')(
    'r5b: a gated agent’s shell sees the user’s SSH_AUTH_SOCK, and never OPENSSL_CONF',
    () => {
      const sealed = sealHermesSpawnEnv(
        {
          HOME: '/h',
          OPENSSL_CONF: '/evil/openssl.cnf',
          PATH: '/usr/bin:/bin',
          SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
          USER: 'u'
        },
        { gateEnv: { ICLONE_POLICY_LOCK: '1' }, role: 'primary', runtimeRoot: '/rt' }
      )

      // What the agent's terminal tool runs: a shell that inherits the backend's (sealed) env.
      const shell = spawnSync('/bin/sh', ['-c', 'echo "ssh=${SSH_AUTH_SOCK:-none} ssl=${OPENSSL_CONF:-none}"'], {
        encoding: 'utf8',
        env: sealed
      })

      expect(shell.stdout.trim()).toBe('ssh=/tmp/ssh-agent.sock ssl=none')
    }
  )

  it('the interpreter flags: no user site, no cwd or script dir on sys.path', () => {
    expect(PYTHON_ISOLATION_FLAGS).toEqual(['-s', '-P'])
  })
})

describe('sealHermesSpawnEnv', () => {
  const gateEnv = {
    ICLONE_POLICY_FILE: '/ud/p.json',
    ICLONE_POLICY_KEY_FD: '3',
    ICLONE_POLICY_LOCK: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONPYCACHEPREFIX: '/ud/hermes-pycache/spawn-1-a',
    TERMINAL_ENV: 'iclone_seatbelt'
  }

  const composed = {
    HERMES_HOME: '/hh',
    ICLONE_CONFINEMENT_SPEC: '/evil/spec',
    ICLONE_CONSENT_CAMERA: 'ask',
    ICLONE_PAY_SOCKET: '/ud/pay.sock',
    ICLONE_PAY_TOKEN_FILE: '/ud/pay/t',
    // V3-J r5 (m-r4-1): the folder the pay token is bound to rides with it.
    ICLONE_PAY_HOME: '16777220:4242',
    ICLONE_POLICY_FILE: '/evil/p.json',
    ICLONE_POLICY_LOCK: '0',
    PYTHONDONTWRITEBYTECODE: '0',
    PYTHONPATH: `/rt${path.delimiter}/evil`,
    PYTHONPYCACHEPREFIX: '/shared',
    // Not ICLONE_-prefixed: only applying the gate env last keeps the confined shell.
    TERMINAL_ENV: 'local'
  }

  it('the gate’s env is applied LAST: a lock key or the bytecode prefix from anywhere else never survives', () => {
    const env = sealHermesSpawnEnv(composed, { gateEnv, role: 'primary', runtimeRoot: '/rt' })

    expect(env).toMatchObject(gateEnv)
    expect(env).toMatchObject({ HERMES_HOME: '/hh', ICLONE_CONSENT_CAMERA: 'ask', PYTHONPATH: '/rt' })
    expect(env).not.toHaveProperty('ICLONE_CONFINEMENT_SPEC')
  })

  it('m-b′: an inherited loader, venv launcher or plugin-folder variable never survives; the gate’s own does', () => {
    const env = sealHermesSpawnEnv(
      {
        ...composed,
        DYLD_INSERT_LIBRARIES: '/evil/x.dylib',
        HERMES_BUNDLED_PLUGINS: '/evil/plugins',
        __PYVENV_LAUNCHER__: '/evil/venv/bin/python'
      },
      { gateEnv: { ...gateEnv, HERMES_BUNDLED_PLUGINS: '/ud/dev-plugins/plugins' }, role: 'pool', runtimeRoot: '/rt' }
    )

    expect(env).not.toHaveProperty('DYLD_INSERT_LIBRARIES')
    expect(env).not.toHaveProperty('__PYVENV_LAUNCHER__')
    expect(env.HERMES_BUNDLED_PLUGINS).toBe('/ud/dev-plugins/plugins')
    expect(
      sealHermesSpawnEnv({ HERMES_BUNDLED_PLUGINS: '/evil/plugins' }, { gateEnv, role: 'primary', runtimeRoot: '/rt' })
    ).not.toHaveProperty('HERMES_BUNDLED_PLUGINS')
  })

  it('r5: the gate’s env wins even over a key the allowlist keeps (the order is the rule, not the disjoint names)', () => {
    for (const role of ['primary', 'pool'] as const) {
      const env = sealHermesSpawnEnv(
        { LANG: 'user', PATH: '/user/bin' },
        { gateEnv: { ...gateEnv, LANG: 'C.UTF-8', PATH: '/gate/bin' }, role, runtimeRoot: '/rt' }
      )

      expect(env).toMatchObject({ LANG: 'C.UTF-8', PATH: '/gate/bin' })
    }
  })

  // Ruling 69: earlier builds saved display.language 'pt-PT' in config.yaml, and Hermes reads HERMES_LANGUAGE first.
  it('ruling 69: every gated runtime is told English, whatever language the parent env or backend.env names', () => {
    for (const role of ['primary', 'pool'] as const) {
      const env = sealHermesSpawnEnv(
        { ...composed, HERMES_LANGUAGE: 'pt-PT', hermes_language: 'ja', LANG: 'pt_PT.UTF-8' },
        { gateEnv, role, runtimeRoot: '/rt' }
      )

      expect(env.HERMES_LANGUAGE, role).toBe('en')
      expect(env).not.toHaveProperty('hermes_language')
      expect(env.LANG, role).toBe('pt_PT.UTF-8')
    }

    expect(RUNTIME_LANGUAGE).toBe('en')
    expect(sealHermesSpawnEnv({ HOME: '/h' }, { gateEnv, role: 'pool', runtimeRoot: '/rt' }).HERMES_LANGUAGE).toBe('en')
  })

  it('primary keeps its payment socket; a pool backend keeps none', () => {
    const primary = sealHermesSpawnEnv(composed, { gateEnv, role: 'primary', runtimeRoot: '/rt' })
    const pool = sealHermesSpawnEnv(composed, { gateEnv, role: 'pool', runtimeRoot: '/rt' })

    expect(primary).toMatchObject({
      ICLONE_PAY_HOME: '16777220:4242',
      ICLONE_PAY_SOCKET: '/ud/pay.sock',
      ICLONE_PAY_TOKEN_FILE: '/ud/pay/t'
    })
    expect(Object.keys(pool).filter(key => key.startsWith('ICLONE_PAY_'))).toEqual([])
    expect(pool).toMatchObject(gateEnv)
  })
})
