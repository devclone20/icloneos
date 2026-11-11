/**
 * config.yaml or .env that is a link (the dotfiles habit), against the real generated runtime profile and the real
 * runtime. The link's target is never added to the profile's read rules (a compromised runtime could plant that link and
 * read anything), so main refuses at spawn with the way out, and the way out it prints is run here and has to work:
 * the owner's model and key are asserted through the confined runtime afterwards.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createRuntimeWorld, runtimeAvailable, type RuntimeWorld } from './runtime-live-harness'

const OWNER_KEY = 'sk-owner-linked'
const OWNER_MODEL = 'owner-model-X'

const READ_BACK = `
import json, os
from hermes_cli.config import load_config
from hermes_cli.env_loader import load_hermes_dotenv
load_hermes_dotenv()
model = load_config().get("model")
print("READ-BACK" + json.dumps({"key": os.environ.get("OPENAI_API_KEY"), "model": model}))
`

const readBack = (out: string): { key: null | string; model: unknown } => {
  const line = out.split('\n').find(item => item.startsWith('READ-BACK'))

  if (!line) {
    throw new Error(`no read-back line in: ${out.slice(-400)}`)
  }

  return JSON.parse(line.slice('READ-BACK'.length))
}

/** The way out is the end of the message: `...then try again: <command>`. */
const printedCommand = (message: string): string => message.slice(message.lastIndexOf('then try again: ') + 16)

describe.skipIf(!runtimeAvailable())('a linked config.yaml or .env under the runtime profile (live)', { timeout: 180_000 }, () => {
  let world: RuntimeWorld | null = null

  afterEach(() => {
    world?.dispose()
    world = null
  })

  const setUp = () => {
    world = createRuntimeWorld()
    const hermesHome = world.paths.hermesHome
    const homeDir = world.facts.homeDir

    if (!homeDir) {
      throw new Error('the runtime world has no home folder')
    }

    const dotfiles = path.join(homeDir, 'dotfiles')

    mkdirSync(dotfiles, { recursive: true })
    writeFileSync(path.join(hermesHome, 'config.yaml'), `model:\n  default: ${OWNER_MODEL}\n`)
    writeFileSync(path.join(hermesHome, '.env'), `OPENAI_API_KEY=${OWNER_KEY}\n`)

    return { dotfiles, hermesHome, run: world.run, readyDir: world.readyDir }
  }

  const linkOut = (hermesHome: string, dotfiles: string, name: string, body: string) => {
    const target = path.join(dotfiles, name)

    writeFileSync(target, body)
    rmSync(path.join(hermesHome, name))
    symlinkSync(target, path.join(hermesHome, name))
  }

  const serve = async (run: RuntimeWorld['run'], readyDir: string) => {
    const ready = path.join(readyDir, 'r.json')

    const result = await run(true, ['-m', 'hermes_cli.main', 'serve', '--host', '127.0.0.1', '--port', '0'], {
      env: { HERMES_DESKTOP_READY_FILE: ready },
      timeoutMs: 90_000,
      until: () => existsSync(ready)
    })

    return { ...result, ready: existsSync(ready) }
  }

  it('config.yaml linked outside: the runtime never calls the denial a formatting error', async () => {
    const { dotfiles, hermesHome, run, readyDir } = setUp()

    linkOut(hermesHome, dotfiles, 'config.yaml', `model:\n  default: ${OWNER_MODEL}\n`)
    const result = await serve(run, readyDir)
    const said = result.err + result.out

    expect(result.ready).toBe(false)
    expect(said).not.toMatch(/formatting error/i)
    expect(said).toMatch(/config\.yaml\) is a link/)
    expect(said).toContain('cp -L')
  })

  it('config.yaml linked outside: load_config answers with the reason, never a PermissionError (critic link.mts)', async () => {
    const { dotfiles, hermesHome, run } = setUp()

    linkOut(hermesHome, dotfiles, 'config.yaml', `model:\n  default: ${OWNER_MODEL}\n`)
    const direct = await run(true, ['-c', READ_BACK], { timeoutMs: 60_000 })

    expect(direct.err).not.toContain('Traceback')
    expect(direct.err).not.toMatch(/formatting error/i)
    expect(direct.err).toMatch(/config\.yaml\) is a link/)
    expect(readBack(direct.out).key).toBe(OWNER_KEY)
  })

  it('.env linked outside: the runtime says so, and never treats it as absent', async () => {
    const { dotfiles, hermesHome, run, readyDir } = setUp()

    linkOut(hermesHome, dotfiles, '.env', `OPENAI_API_KEY=${OWNER_KEY}\n`)
    const result = await serve(run, readyDir)

    expect(result.err + result.out).toMatch(/\.env\) is a link/)

    const direct = await run(true, ['-c', READ_BACK], { timeoutMs: 60_000 })

    expect(direct.err).toMatch(/\.env\) is a link/)
    expect(readBack(direct.out).key).toBeNull()
  })

  it.each(['config.yaml', '.env'])('%s linked outside: main refuses, and the command it prints brings the owner back', async name => {
    const { homeSettingsRefusal } = await import('../home-settings-files')
    const { dotfiles, hermesHome, run } = setUp()
    const body = name === '.env' ? `OPENAI_API_KEY=${OWNER_KEY}\n` : `model:\n  default: ${OWNER_MODEL}\n`

    linkOut(hermesHome, dotfiles, name, body)

    const refusal = homeSettingsRefusal(hermesHome, { doing: 'start', linksOutsideRefused: true, root: hermesHome })

    expect(refusal).toContain(`Your ${name} is a link`)

    execFileSync('/bin/sh', ['-c', printedCommand(refusal ?? '')])
    expect(homeSettingsRefusal(hermesHome, { doing: 'start', linksOutsideRefused: true, root: hermesHome })).toBeNull()

    const after = await run(true, ['-c', READ_BACK], { timeoutMs: 60_000 })

    expect(readBack(after.out)).toEqual({ key: OWNER_KEY, model: expect.objectContaining({ default: OWNER_MODEL }) })
  })

  it.each(['config.yaml', '.env'])('%s linked inside the home keeps working: no refusal, ready, values read', async name => {
    const { homeSettingsRefusal } = await import('../home-settings-files')
    const { hermesHome, run, readyDir } = setUp()
    const target = path.join(hermesHome, `real-${name.replace('.', '')}`)
    const body = name === '.env' ? `OPENAI_API_KEY=${OWNER_KEY}\n` : `model:\n  default: ${OWNER_MODEL}\n`

    writeFileSync(target, body)
    rmSync(path.join(hermesHome, name))
    symlinkSync(target, path.join(hermesHome, name))

    expect(homeSettingsRefusal(hermesHome, { doing: 'start', linksOutsideRefused: true, root: hermesHome })).toBeNull()
    expect((await serve(run, readyDir)).ready).toBe(true)

    const after = await run(true, ['-c', READ_BACK], { timeoutMs: 60_000 })

    expect(readBack(after.out)).toEqual({ key: OWNER_KEY, model: expect.objectContaining({ default: OWNER_MODEL }) })
  })

  it.each(['config.yaml', '.env'])('%s linked outside: the app\'s Replace with a copy brings the owner back through the real profile', async name => {
    const { homeSettingsRefusalView, replaceLinkWithCopy } = await import('../home-settings-files')
    const { dotfiles, hermesHome, run } = setUp()
    const body = name === '.env' ? `OPENAI_API_KEY=${OWNER_KEY}\n` : `model:\n  default: ${OWNER_MODEL}\n`
    const check = { doing: 'start', linksOutsideRefused: true, root: hermesHome } as const

    linkOut(hermesHome, dotfiles, name, body)

    const finding = homeSettingsRefusalView(hermesHome, check)?.findings[0]

    expect(finding?.kind).toBe('link-outside')
    expect(replaceLinkWithCopy(hermesHome, name as 'config.yaml' | '.env', String(finding?.target), check)).toEqual({ ok: true, refusal: null })

    const after = await run(true, ['-c', READ_BACK], { timeoutMs: 60_000 })

    expect(readBack(after.out)).toEqual({ key: OWNER_KEY, model: expect.objectContaining({ default: OWNER_MODEL }) })
  })

  it('.op.env linked outside: main refuses it, the runtime is never silent about it, and the copy restores the token', async () => {
    const { homeSettingsRefusalView, replaceLinkWithCopy } = await import('../home-settings-files')
    const { dotfiles, hermesHome, run } = setUp()
    const check = { doing: 'start', linksOutsideRefused: true, root: hermesHome } as const

    const token = `
import os
from hermes_cli.env_loader import load_hermes_dotenv
load_hermes_dotenv()
print("TOKEN=" + str(os.environ.get("OP_SERVICE_ACCOUNT_TOKEN")))
`

    const target = path.join(dotfiles, 'op')

    writeFileSync(target, 'OP_SERVICE_ACCOUNT_TOKEN=op-owner\n')
    symlinkSync(target, path.join(hermesHome, '.op.env'))

    const finding = homeSettingsRefusalView(hermesHome, check)?.findings[0]

    expect(finding).toMatchObject({ file: '.op.env', kind: 'link-outside' })

    const denied = await run(true, ['-c', token], { timeoutMs: 60_000 })

    expect(denied.out).toContain('TOKEN=None')
    expect(denied.err).not.toContain('Traceback')
    expect(denied.err).toMatch(/\.op\.env\) is a link/)

    expect(replaceLinkWithCopy(hermesHome, '.op.env', String(finding?.target), check)).toEqual({ ok: true, refusal: null })
    expect((await run(true, ['-c', token], { timeoutMs: 60_000 })).out).toContain('TOKEN=op-owner')
  })

  it('unconfined: a dangling .env does not stop the runtime, and it says so', async () => {
    const { homeSettingsRefusal } = await import('../home-settings-files')
    const { dotfiles, hermesHome, run } = setUp()

    rmSync(path.join(hermesHome, '.env'))
    symlinkSync(path.join(dotfiles, 'gone'), path.join(hermesHome, '.env'))

    expect(homeSettingsRefusal(hermesHome, { doing: 'start', linksOutsideRefused: false, root: hermesHome })).toBeNull()

    const direct = await run(false, ['-c', READ_BACK], { timeoutMs: 60_000 })

    expect(readBack(direct.out).model).toEqual(expect.objectContaining({ default: OWNER_MODEL }))
    expect(direct.err).toMatch(/\.env\) is a link to a file that does not exist/)
  })

  it('the control: plain files are ready with the owner values', async () => {
    const { run, readyDir } = setUp()

    expect((await serve(run, readyDir)).ready).toBe(true)
    const after = await run(true, ['-c', READ_BACK], { timeoutMs: 60_000 })

    expect(readBack(after.out)).toEqual({ key: OWNER_KEY, model: expect.objectContaining({ default: OWNER_MODEL }) })
  })
})
