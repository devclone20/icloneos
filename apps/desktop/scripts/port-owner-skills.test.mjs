// V3-B — the port tool: scrub rules (prose vs code, identity), the secret and private-marker refusals (negative
// controls, B6), third-party attribution (F1), exclusions (F2), text-derived touches (F3), the manifest, versions and
// --check (B7, attribution, notices).
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, test } from 'vitest'

import {
  compileMarkers,
  decodeEscapes,
  foldSplits,
  layoutNameRegex,
  machineLayoutChildren,
  machineLayoutNames,
  machineLayoutShapes,
  scanTree
} from './artifact-hygiene.mjs'

import {
  aliasLayoutNames,
  checkAttribution,
  checkDrift,
  copyrightLinesOf,
  countMachinePaths,
  coveredByRoots,
  declaredPaths,
  DEFAULT_BUNDLE,
  derivedTouches,
  dropUnusedHomedirImport,
  findPrivateMarker,
  findSecret,
  foldDesktopRoots,
  homeRootsOf,
  identityTokens,
  inferLanguage,
  LAYOUT_ALIAS,
  layoutAlias,
  LICENSE_FILE,
  LICENSE_NAMES,
  listSkillFiles,
  main,
  MANIFEST_FILE,
  NOTICES_FILE,
  PORT_NAMES,
  PORT_SET,
  place,
  buildPlace,
  portHygiene,
  resolvePlaces,
  portSkill,
  readManifest,
  renderThirdPartyNotices,
  rewriteHomePaths,
  rewriteMachinePaths,
  privateTokenIds,
  PORT_PRIVATE_TOKENS,
  rewritePlaces,
  scrubResidue,
  scrubText,
  scrubVoiceProfile,
  thirdPartyOf,
  treeSha256,
  undeclaredRoots,
  upstreamVersionOf
} from './port-owner-skills.mjs'
import { dropDeliveryRecords, neutraliseOwnerSeries, SERIES_ALIAS } from './port-owner-skills.mjs'

// Ruling 48: a test never reads the owner's private markers file, whatever the shell exports.
delete process.env.ICLONE_PRIVATE_MARKERS
// r5f (X2): the port never runs without the owner identity setting; the tests use a synthetic one.
process.env.PORT_IDENTITY = 'Corvina Example'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'v3b-port-'))

const MIT = `MIT License\n\nCopyright (c) 2026 Rodrigo Lopes\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software…\n`

/** A fake owner library holding one skill of the set with the owner's Claude Code frontmatter. */
function library(root, name = 'hm-qa', extra = {}) {
  const dir = path.join(root, name)
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    extra.skill ??
      `---\nname: ${name}\ndescription: "Original trigger text with \\"quotes\\"."\nargument-hint: "[x]"\n---\n\n# Title\n\nRun \`bash ~/.claude/skills/${name}/tools/go.sh\` then read ~/.claude/skills/parrallello/references/lessons.md and /Users/someone/Desktop/x.\nMail patricia@example.org or noreply@anthropic.com; wallet 0x${'ab'.repeat(20)}; memory in ~/.claude/notes.md\n`
  )
  fs.writeFileSync(path.join(dir, 'tools', 'go.sh'), '#!/bin/sh\necho go\n', { mode: 0o755 })
  for (const [rel, text] of Object.entries(extra.files ?? {})) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
  }
  return dir
}

/** A fake third-party package inside the library (the highermind-code-skills shape): a LICENSE, a README with the
 *  repo URL, the skill folder inside it and a symlink at the library root pointing in. */
function thirdPartyLibrary(root, name = 'hm-qa', { license = MIT, symlink = true } = {}) {
  const pkg = path.join(root, 'highermind-code-skills')
  fs.mkdirSync(path.join(pkg, name), { recursive: true })
  if (license !== null) fs.writeFileSync(path.join(pkg, 'LICENSE'), license)
  fs.writeFileSync(
    path.join(pkg, 'README.md'),
    'See https://github.com/other/unrelated and git clone https://github.com/rodrigohighermind/highermind-code-skills.git\n'
  )
  fs.writeFileSync(path.join(pkg, name, 'SKILL.md'), `# /${name} — Title\n\nBody.\n`)
  if (symlink) fs.symlinkSync(path.join(pkg, name), path.join(root, name))
  return pkg
}

/** The ridervoice files its redactions read, with a stand-in identity (PORT_IDENTITY = "Pat Example") and made-up
 *  numbers: the name rows (F2b), two signed values labelled as his (m5), a pointer into the excluded record (m6). */
const RIDER_FILES = {
  'references/pronunciation.md':
    '| palavra | escrever | notas |\n|---|---|---|\n| Pat Example | `Pat Example` | r3: saiu "It\'s Exampel" |\n| owl | `owl` | ok |\n',
  'references/LEARNED.md':
    '- O crítico r3 encontrou "Pat Example" → "It\'s Exampel" e "owl" → "all" em amostras.\n' +
    '- vírgula → ≤ +4,5 st (as dele ficam em +2,7); premiada por o alvo dele ser +0,81.\n',
  'references/pipeline.md':
    'Formato "pretrained": chaves `step` (ver `training-record.md`;\no slim de inferência NÃO serve para o trainer).\n',
  // K140 r4: the batch's table of video titles (made-up titles) and the two place lines the batch carries.
  'tools/revoice.sh':
    '#!/bin/zsh\nKEYS=(a1 b2)\nE="$HOME/Desktop/VAULT/Agent Lark Voice/engine"; [ -d "$E" ] || E="$HOME/Desktop/Agent Lark Voice/engine"   # engine moved into HOME\n' +
    'DESK="$HOME/Desktop"; [ -d "$HOME/Desktop/VAULT" ] || DESK="$HOME/Library/Mobile Documents/com~apple~CloudDocs/Desktop"; SRT="$DESK/VAULT/ARCHIVE/12_CLIP_LAB_APP/take_7/subtitles"\n' +
    'typeset -A NAME; NAME[a1]="1 - a demo intro"; NAME[b2]="2.1 - the second demo"\nNAME[c3]="3 - the third"\n'
}

/**
 * Synthetic named places, already built (K140 r5: the real ones come from the porting machine's PORT_PLACE_<ENV>
 * values, kept in the owner's control plane; the repo holds neither their paths nor digests of them).
 */
const SYNTH_PLACES = {
  ridervoice: [
    buildPlace('RIDERVOICE_DIR', 'the Rider Voice folder: engine, docs and samples', [
      'Desktop/VAULT/Agent Lark Voice',
      'Desktop/Agent Lark Voice'
    ]),
    buildPlace('RIDERVOICE_SUBTITLES_DIR', 'the subtitles of the videos to re-voice', [
      'Desktop/VAULT/ARCHIVE/12_CLIP_LAB_APP/take_7/subtitles',
      'Library/Mobile Documents/com~apple~CloudDocs/Desktop/VAULT/ARCHIVE/12_CLIP_LAB_APP/take_7/subtitles'
    ]),
    buildPlace('RIDERVOICE_PIPELINE_DIR', 'the raw-video pipeline', ['Desktop/VAULT/ARCHIVE/20_NOTES/take_9_pipeline'])
  ],
  'higgsfield-blender': [buildPlace('VIDEO_ENGINE_DIR', 'the video engine folder', ['Desktop/clip Forge'])]
}
/** A port of one rule, independent of this machine's private and coined names (K140 r5 reads those at port time). */
const isolated = { privateNames: null, coinedNames: new Set() }
const synthSpec = name => ({ ...PORT_SET[name], places: SYNTH_PLACES[name] })
/** A skill's rules with every file of a fixture listed as shippable (a test of a rule other than the ship list). */
const shipAll = (name, from, spec = PORT_SET[name]) => ({ ...spec, ship: listSkillFiles(path.join(from, name)) })

/** The ridervoice SKILL.md lines its redactions read (m5: the pause flag labelled as his; m6: two record pointers). */
const RIDER_SKILL_BODY = [
  'Predefinições aprovadas: `--speed 1.12` (= o ritmo real dele, 4,22 palavras/s), `--pause 0.4` (a pausa dele entre',
  'frases, 0,58 s), `--seed 23`.',
  '',
  'Crítico escolhe o checkpoint → aprovação.',
  'Números de referência do treino aprovado em `references/training-record.md`. Sobre-ajuste aparece depois de ~2000',
  'updates.',
  '',
  '## 6. Referências',
  '',
  '- `references/pipeline.md` — o motor passo a passo',
  '- `references/training-record.md` — o treino aprovado: dados, curva',
  '- `references/LEARNED.md` — a memória viva da skill',
  ''
].join('\n')

const silently = fn => {
  const log = console.log
  console.log = () => {}
  try {
    return fn()
  } finally {
    console.log = log
  }
}

describe('scrubText', () => {
  test('rewrites home paths, library self/sibling/other references, e-mails, addresses, the machine user and identity', () => {
    const { text, counts } = scrubText(
      [
        '/Users/patowner/Desktop/x and /Users/patowner/Movies',
        '~/.claude/skills/hm-qa/tools/go.sh ~/.claude/skills/parrallello/install.sh $HOME/.claude/skills/other/x',
        '~/.claude/cloneframe_context.md',
        'a@b.co noreply@anthropic.com 0x' + 'ab'.repeat(20) + ' patowner',
        'Speak in Pat Example\'s voice; "author": "Patricia (Example Labs)"; Patrician stays'
      ].join('\n'),
      {
        self: 'hm-qa',
        user: 'patowner',
        identity: identityTokens({ env: { PORT_IDENTITY: 'Pat Example, Patricia (Example Labs),Pat' } }),
        roots: ['~/Desktop']
      }
    )

    assert.equal(
      text,
      [
        '~/Desktop/x and ~/Movies',
        '{skill_dir}/tools/go.sh {skills_root}/parrallello/install.sh {skills_root}/other/x',
        '{agent_home}/cloneframe_context.md',
        '<email> noreply@anthropic.com 0x<address> <user>',
        'Speak in the owner\'s voice; "author": "the owner"; Patrician stays'
      ].join('\n')
    )
    assert.deepEqual(counts, {
      homePaths: 2,
      codePaths: 0,
      claudeRefs: 4,
      emails: 1,
      addresses: 1,
      users: 1,
      identity: 2,
      machinePaths: 0,
      voiceProfile: 0
    })
  })

  test('leaves a clean text untouched', () => {
    const { text, counts } = scrubText('ffmpeg -i in.mp4 ~/Movies/out.mp4 0xabc 1234', { self: 'x' })

    assert.equal(text, 'ffmpeg -i in.mp4 ~/Movies/out.mp4 0xabc 1234')
    assert.deepEqual(counts, {
      homePaths: 0,
      codePaths: 0,
      claudeRefs: 0,
      emails: 0,
      addresses: 0,
      users: 0,
      identity: 0,
      machinePaths: 0,
      voiceProfile: 0
    })
  })

  test('identity tokens come only from PORT_IDENTITY and --identity, longest first; a guessed name never', () => {
    assert.deepEqual(identityTokens({ env: { PORT_IDENTITY: 'Pat, Pat Example ,' }, extra: ['Patricia'] }), [
      'Pat Example',
      'Patricia',
      'Pat'
    ])
    assert.deepEqual(identityTokens({ env: {} }), [])
  })
})

describe('home paths: prose vs code (F5)', () => {
  test('a Python or Lua literal gets the form the language resolves; shell gets $HOME; prose keeps ~', () => {
    const text = [
      'See /Users/u/Desktop/notes and "/Users/u/quoted prose".',
      "`import sys; sys.path.insert(0, '/Users/u/Desktop/clip Forge'); from engine import shot`",
      "Write `dofile('/Users/u/Movies/Bridge.lua')` + Return.",
      '`cp "/Users/u/a b/c" .` and `ffmpeg -i /Users/u/in.mp4 out.mp4`',
      '`~/Desktop/just a path`',
      '```python',
      "root = '/Users/u/engine'",
      "already = '~/Desktop/x'",
      "ok = os.path.expanduser('~/Desktop/y')",
      '```',
      '```',
      'cd /Users/u/project && make',
      '```',
      '```json',
      '{ "path": "/Users/u/data" }',
      '```'
    ].join('\n')
    const users = []
    let code = 0
    // ~/Desktop declared: this test is about the home forms; machine-layout paths have their own (m3).
    const out = rewriteHomePaths(text, { onUser: u => users.push(u), onCode: () => code++, roots: ['~/Desktop'] })

    assert.equal(
      out,
      [
        'See ~/Desktop/notes and "~/quoted prose".',
        "`import sys; sys.path.insert(0, os.path.expanduser('~/Desktop/clip Forge')); from engine import shot`",
        "Write `dofile(os.getenv('HOME') .. '/Movies/Bridge.lua')` + Return.",
        '`cp "$HOME/a b/c" .` and `ffmpeg -i $HOME/in.mp4 out.mp4`',
        '`~/Desktop/just a path`',
        '```python',
        "root = os.path.expanduser('~/engine')",
        "already = os.path.expanduser('~/Desktop/x')",
        "ok = os.path.expanduser('~/Desktop/y')",
        '```',
        '```',
        'cd $HOME/project && make',
        '```',
        '```json',
        '{ "path": "~/data" }',
        '```'
      ].join('\n')
    )
    assert.equal(users.length, 9)
    assert.equal(code, 7)
  })

  test('a whole .py / .sh file is code; a re-scan of the result counts no code residue', () => {
    const py = scrubText("import sys\nsys.path.insert(0, '/Users/u/engine')\n", { self: 'x', rel: 'tools/run.py' })
    assert.equal(py.text, "import sys\nsys.path.insert(0, os.path.expanduser('~/engine'))\n")
    assert.deepEqual(scrubText(py.text, { self: 'x', rel: 'tools/run.py' }).counts.codePaths, 0)

    const sh = scrubText('E="/Users/u/engine"; cd /Users/u/w\n', { self: 'x', rel: 'tools/go.sh' })
    assert.equal(sh.text, 'E="$HOME/engine"; cd $HOME/w\n')
  })

  test('inferLanguage reads a span by its words', () => {
    assert.equal(inferLanguage("sys.path.insert(0, '/x')"), 'python')
    assert.equal(inferLanguage("dofile('/x.lua')"), 'lua')
    assert.equal(inferLanguage('ffmpeg -i a b'), 'shell')
    assert.equal(inferLanguage('~/Desktop/clip Forge/'), 'inline')
  })
})

describe('findSecret / findPrivateMarker', () => {
  test('matches key-shaped values', () => {
    assert.ok(findSecret('OPENAI_API_KEY=sk-' + 'a1'.repeat(20)))
    assert.ok(findSecret('ghp_' + 'A'.repeat(36)))
    assert.ok(findSecret('token: ' + 'x'.repeat(30)))
    assert.ok(findSecret(['-----BEGIN RSA', 'PRIVATE KEY-----'].join(' ')))
    assert.ok(findSecret('xoxb-1234567890-abcdef'))
    assert.ok(findSecret('AKIA' + 'B'.repeat(16)))
  })

  test('never matches the pattern NAMES of a security checklist (hm-security, hm-qa)', () => {
    const checklist = [
      'ghp_             (GitHub PAT)',
      'AKIA[0-9A-Z]{16} (AWS Access Key)',
      'xoxb-            (Slack Bot Token)',
      '-----BEGIN.*PRIVATE KEY-----',
      'Bearer [A-Za-z0-9\\-._~+/]+=*',
      'grep -rn "sk-ant-\\|sk_live_\\|AKIA" .',
      'password= in git log'
    ].join('\n')

    assert.equal(findSecret(checklist), null)
  })

  test('private workflow markers: ssh keys, server inventory, mailbox, "private until"; a plain word is not one', () => {
    assert.ok(findPrivateMarker('keys in ~/.ssh/id_ed25519'))
    assert.ok(findPrivateMarker('~/.clone-frame-hub/servers.json (token DO)'))
    assert.ok(findPrivateMarker('PRIVADO até o lançamento'))
    assert.ok(findPrivateMarker('kept private until the drop'))
    assert.ok(findPrivateMarker('the Gmail OAuth saga; 64 unread in the inbox'))
    assert.equal(findPrivateMarker('um repo privado por default; Tokens de sessao / JWT'), null)
  })
})

describe('derivedTouches (F3)', () => {
  test('$ needs a spending verb with a money object; N is publishing, git push, posting or sending a message', () => {
    assert.deepEqual(derivedTouches("`fnf_*` tools **spend the owner's Higgsfield credits** — say what it costs."), {
      $: 1
    })
    assert.deepEqual(derivedTouches('Not a single credit is spent before the shot is locked.'), { $: 1 })
    assert.deepEqual(derivedTouches('a 120 Hz display gives one slot of credit; a rule já foi paga com dor.'), {})
    assert.deepEqual(derivedTouches('1. Compra o iNFT (OpenSea).'), {})
    assert.deepEqual(derivedTouches('then `git push` and publish the page; send the report email'), { N: 3 })
    assert.deepEqual(derivedTouches('the last frame re-sent every 0.5 s; post-present passes; enviar screenshots'), {})
    assert.deepEqual(derivedTouches('post it on X when the render lands'), { N: 1 })
  })
})

describe('thirdPartyOf (F1)', () => {
  test("the owner's own folder is not third-party; a symlink into a licensed package is, with author, licence and URL", () => {
    const from = tmp()
    library(from, 'parrallello')
    thirdPartyLibrary(from, 'hm-qa')

    assert.equal(thirdPartyOf(from, 'parrallello', {}), null)

    const third = thirdPartyOf(from, 'hm-qa', {})
    assert.equal(third.author, 'Rodrigo Lopes')
    assert.equal(third.license, 'MIT')
    assert.equal(third.licenseText, MIT)
    assert.deepEqual(third.upstream, {
      name: 'highermind-code-skills',
      url: 'https://github.com/rodrigohighermind/highermind-code-skills',
      license_file: LICENSE_FILE
    })
  })

  test('a LICENSE beside a real (non-symlink) folder and a foreign frontmatter author both count; the author wins', () => {
    const from = tmp()
    const dir = library(from, 'hm-init')
    fs.writeFileSync(path.join(dir, 'LICENSE'), 'Apache License\nVersion 2.0\n\nCopyright 2025 Someone Else\n')

    const byLicense = thirdPartyOf(from, 'hm-init', {})
    assert.equal(byLicense.author, 'Someone Else')
    assert.equal(byLicense.license, 'Apache-2.0')
    assert.equal(byLicense.upstream.name, 'hm-init')

    assert.equal(thirdPartyOf(from, 'hm-init', { author: 'Jane Doe' }).author, 'Jane Doe')
  })

  test('a third-party source without any licence text is refused (it cannot ship)', () => {
    const from = tmp()
    thirdPartyLibrary(from, 'hm-qa', { license: null })

    assert.throws(() => thirdPartyOf(from, 'hm-qa', {}), /without a licence text cannot ship/)
    assert.throws(() => portSkill('hm-qa', { from, to: tmp() }), /without a licence text/)
  })
})

describe('portSkill', () => {
  test('ports a skill: bundle frontmatter, port note, scrubbed body, executable bit kept, manifest facts', () => {
    const from = tmp()
    library(from)
    const result = portSkill('hm-qa', {
      from,
      to: tmp(),
      now: () => new Date('2026-10-21T10:00:00Z'),
      user: 'someone',
      spec: shipAll('hm-qa', from)
    })
    const skill = result.outputs.find(file => file.rel === 'SKILL.md').text

    assert.match(
      skill,
      /^---\nname: hm-qa\ndescription: "Use when testing everything and finding the gaps\. Original trigger text with \\"quotes\\"\."\nversion: 1\.0\.0\nported: 1\.0\.0\nauthor: "the owner \(ported from his Claude Code skills library\)"\nlicense: MIT\n/
    )
    assert.ok(skill.includes('    tags: [owner-library, highermind, QA, testing]'))
    assert.ok(skill.includes("> Ported from the owner's skills library (port 1.0.0;"))
    // The porting DAY is the owner's working day. manifest.json keeps the timestamp the product reads; the text
    // a stranger gets does not date his week. This assertion used to pin the date, i.e. to protect the leak.
    assert.ok(!/skills library on \d{4}-\d{2}-\d{2}/.test(skill))
    assert.ok(skill.includes('`bash {skill_dir}/tools/go.sh`'))
    assert.ok(skill.includes('{skills_root}/parrallello/references/lessons.md'))
    // m3: the machine folder no root declares reads as a placeholder (the source said /Users/someone/Desktop/x).
    assert.ok(skill.includes('<your project folder>/x'))
    assert.ok(skill.includes("> In this copy a folder of the owner's machine is written `<your project folder>`"))
    assert.ok(skill.includes('<email> or noreply@anthropic.com'))
    assert.ok(skill.includes('0x<address>'))
    assert.ok(skill.includes('{agent_home}/notes.md'))
    assert.ok(!skill.includes('argument-hint'))
    assert.ok(!skill.includes('Third-party'))
    assert.ok(!/\/Users\/|~\/\.claude|patricia@|someone/.test(skill))
    assert.equal(result.outputs.find(file => file.rel === 'tools/go.sh').mode, 0o755)
    assert.equal(
      result.outputs.find(file => file.rel === LICENSE_FILE),
      undefined
    )
    assert.equal(result.thirdParty, null)
    assert.deepEqual(result.manifest, {
      schema: 1,
      name: 'hm-qa',
      version: '1.0.0',
      author: 'the owner (ported from his Claude Code skills library)',
      license: 'MIT',
      source: {
        library: 'claude-code-skills',
        path: 'hm-qa',
        version: null,
        sha256: result.sourceSha256,
        ported_at: '2026-10-21' // the day, never the minute: the manifest carries no hour of the author's
      },
      excluded: [],
      requires: PORT_SET['hm-qa'].requires,
      touches: PORT_SET['hm-qa'].touches,
      touches_from_text: {},
      scrubbed: true,
      scrub: {
        homePaths: 1,
        codePaths: 0,
        claudeRefs: 3,
        emails: 1,
        addresses: 1,
        users: 0,
        identity: 0,
        machinePaths: 1,
        voiceProfile: 0,
        places: 0,
        redacted: 0,
        layoutNames: 0,
        ownerPaths: 0,
        privateNames: 0
      }
    })
  })

  test('a skill without frontmatter (the hm-* files) gets one, body intact', () => {
    const from = tmp()
    library(from, 'hm-init', { skill: '# /hm-init — start\n\nBody line.\n' })
    const skill = portSkill('hm-init', { from, to: tmp() }).outputs[0].text

    assert.match(skill, /^---\nname: hm-init\ndescription: "Use when starting a project with the right stack\."\n/)
    assert.ok(skill.endsWith('\n# /hm-init — start\n\nBody line.\n'))
  })

  test('F1: a third-party source ships its LICENSE verbatim, its true author in frontmatter and manifest, and an upstream', () => {
    const from = tmp()
    thirdPartyLibrary(from, 'hm-qa')
    const result = portSkill('hm-qa', { from, to: tmp() })
    const skill = result.outputs.find(file => file.rel === 'SKILL.md').text

    assert.match(skill, /\nauthor: Rodrigo Lopes\nlicense: MIT\n/)
    assert.ok(!skill.includes('author: "the owner'))
    assert.ok(
      skill.includes(
        '> Third-party work by Rodrigo Lopes (highermind-code-skills, https://github.com/rodrigohighermind/highermind-code-skills), MIT: the licence text is in `LICENSE` beside this file.'
      )
    )
    assert.equal(result.outputs.find(file => file.rel === LICENSE_FILE).text, MIT)
    assert.equal(result.manifest.author, 'Rodrigo Lopes')
    assert.equal(result.manifest.license, 'MIT')
    // m4: the upstream copyright line travels verbatim with the attribution.
    assert.deepEqual(result.manifest.upstream, {
      name: 'highermind-code-skills',
      url: 'https://github.com/rodrigohighermind/highermind-code-skills',
      license_file: LICENSE_FILE,
      copyright: ['Copyright (c) 2026 Rodrigo Lopes']
    })
  })

  test('K140 r5: only the files of the ship list ship (default deny); the rest is named in the manifest and the note', () => {
    const from = tmp()
    library(from, 'fable-orchestrator', {
      files: { 'references/clone-frame-map.md': 'diary\n', 'references/new.md': 'a file the list does not name\n' }
    })
    const result = portSkill('fable-orchestrator', { from, to: tmp() })

    assert.deepEqual(result.outputs.map(file => file.rel).sort(), ['SKILL.md'])
    assert.deepEqual(result.manifest.excluded, ['references/clone-frame-map.md', 'references/new.md', 'tools/go.sh'])
    assert.ok(
      result.outputs
        .find(file => file.rel === 'SKILL.md')
        .text.includes(
          "Not ported (the owner's own records — notes, logs, examples, project data — never ship): `references/clone-frame-map.md`, `references/new.md`, `tools/go.sh`."
        )
    )
    // A file named after a private name is listed by its number in the source listing only.
    const named = tmp()
    library(named, 'fable-orchestrator', { files: { 'notes/ready_9.md': 'x\n' } })
    assert.deepEqual(
      portSkill('fable-orchestrator', {
        from: named,
        to: tmp(),
        privateNames: new Map([['ready 9', 'any']])
      }).manifest.excluded,
      ['#1', 'tools/go.sh']
    )
    // Every skill of the set has a ship list; nothing ships by default.
    assert.ok(Object.values(PORT_SET).every(spec => Array.isArray(spec.ship) && spec.ship.includes('SKILL.md')))
    assert.throws(
      () =>
        portSkill('fable-orchestrator', {
          from: named,
          to: tmp(),
          spec: { ...PORT_SET['fable-orchestrator'], ship: undefined }
        }),
      /lists no shippable file/
    )
  })

  test('F2 negative control: a private workflow marker in a source file refuses the whole port', () => {
    const from = tmp()
    const to = tmp()
    library(from, 'hm-qa', { files: { 'references/map.md': 'keys live in ~/.ssh/id_ed25519 and servers.json\n' } })

    assert.throws(
      () => portSkill('hm-qa', { from, to, spec: shipAll('hm-qa', from) }),
      /hm-qa\/references\/map\.md: a private workflow marker/
    )
    // Through the CLI (the real ship list): the marker in the shipped SKILL.md refuses the whole run.
    const cli = tmp()
    library(cli, 'hm-qa', { skill: '# QA\n\nkeys live in ~/.ssh/id_ed25519\n' })
    assert.throws(() => silently(() => main(['--from', cli, '--to', to, '--only', 'hm-qa'])), /private workflow marker/)
    assert.equal(fs.existsSync(path.join(to, 'hm-qa')), false)
  })

  test('F3: the classes the text implies join the hand-written ones; both are recorded', () => {
    const from = tmp()
    library(from, 'hm-qa', {
      skill: "# QA\n\nThis step **spends the owner's credits** and then publishes the report.\n"
    })
    const { manifest } = portSkill('hm-qa', { from, to: tmp() })

    assert.deepEqual(manifest.touches, ['X', 'N', '$'])
    assert.deepEqual(manifest.touches_from_text, { $: 1, N: 1 })
  })

  test('I4: the upstream version stays the frontmatter version; the port version is `ported`', () => {
    const from = tmp()
    library(from, 'ridervoice', {
      skill: `---\nname: ridervoice\nversion: 1.5\ndescription: "Voice."\n---\n# Voice\n\n${RIDER_SKILL_BODY}`,
      files: RIDER_FILES
    })
    const result = portSkill('ridervoice', {
      from,
      to: tmp(),
      identity: ['Pat Example'],
      spec: synthSpec('ridervoice')
    })

    const skill = result.outputs.find(file => file.rel === 'SKILL.md').text

    assert.match(skill, /\nversion: "1\.5"\nported: 1\.0\.0\n/)
    assert.equal(result.manifest.version, '1.0.0')
    assert.equal(result.manifest.source.version, '1.5')
    assert.ok(skill.includes('(port 1.0.0, upstream version 1.5;'))

    assert.equal(upstreamVersionOf({ metadata: { version: '1.0 (2026-10-15)' } }), '1.0 (2026-10-15)')
    assert.equal(upstreamVersionOf({}), null)
  })

  test('every cue of the set obeys the catalog rule (Use when …, ≤ 57 chars) and names only V3-F classes', () => {
    for (const name of PORT_NAMES) {
      const spec = PORT_SET[name]
      assert.ok(spec.cue.startsWith('Use when '), name)
      assert.ok(spec.cue.length <= 57, `${name}: ${spec.cue.length}`)
      assert.ok(spec.cue.endsWith('.'), name)
      for (const cls of spec.touches)
        assert.ok(['R', 'Wp', 'Wo', 'X', 'N', '$', 'M', 'S', 'I', 'D'].includes(cls), name)
      for (const key of ['os', 'bins', 'mcp', 'paths']) assert.ok(Array.isArray(spec.requires[key]), name)
    }
    assert.equal(PORT_NAMES.length, 15)
    assert.ok(PORT_SET['higgsfield-blender'].touches.includes('$'))
    assert.deepEqual(PORT_SET['fable-orchestrator'].ship, ['SKILL.md'])
  })

  test('B6 negative control: a planted key in one source skill refuses the port and writes nothing', () => {
    const from = tmp()
    const to = tmp()
    library(from, 'hm-qa', { files: { 'references/notes.md': 'ANTHROPIC_API_KEY=sk-ant-' + 'k9'.repeat(24) + '\n' } })

    assert.throws(
      () => portSkill('hm-qa', { from, to, spec: shipAll('hm-qa', from) }),
      /hm-qa\/references\/notes\.md: a secret-looking value/
    )
    const cli = tmp()
    library(cli, 'hm-qa', { skill: '# QA\n\nANTHROPIC_API_KEY=sk-ant-' + 'k9'.repeat(24) + '\n' })
    assert.throws(() => silently(() => main(['--from', cli, '--to', to, '--only', 'hm-qa'])), /secret-looking/)
    assert.equal(fs.existsSync(path.join(to, 'hm-qa')), false)
  })

  test('refuses a bundle folder that is a symlink (a port is a copy)', () => {
    const from = tmp()
    const to = tmp()
    library(from)
    fs.symlinkSync(path.join(from, 'hm-qa'), path.join(to, 'hm-qa'))

    assert.throws(() => portSkill('hm-qa', { from, to }), /symlink/)
  })

  test('refuses a name outside the set', () => {
    assert.throws(() => portSkill('wayfinder', { from: tmp(), to: tmp() }), /not in the port set/)
  })
})

describe('main: port, re-port, --check (B7)', () => {
  test('a re-port of an unchanged source keeps version and ported_at; one changed byte bumps the patch by 1', () => {
    const from = tmp()
    const to = tmp()
    library(from)

    assert.equal(
      silently(() => main(['--from', from, '--to', to, '--only', 'hm-qa'])),
      0
    )
    const first = readManifest(path.join(to, 'hm-qa'))
    assert.equal(first.version, '1.0.0')

    assert.equal(
      silently(() => main(['--from', from, '--to', to, '--only', 'hm-qa'])),
      0
    )
    assert.deepEqual(readManifest(path.join(to, 'hm-qa')), first)

    fs.appendFileSync(path.join(from, 'hm-qa', 'SKILL.md'), 'one more line\n')
    assert.equal(
      silently(() => main(['--from', from, '--to', to, '--only', 'hm-qa'])),
      0
    )
    const bumped = readManifest(path.join(to, 'hm-qa'))
    assert.equal(bumped.version, '1.0.1')
    assert.notEqual(bumped.source.sha256, first.source.sha256)
    assert.ok(fs.readFileSync(path.join(to, 'hm-qa', 'SKILL.md'), 'utf8').includes('one more line'))
  })

  test('--check names the drifted skill and exits 1; a re-port clears it', () => {
    const from = tmp()
    const to = tmp()
    library(from)
    silently(() => main(['--from', from, '--to', to, '--only', 'hm-qa']))

    assert.equal(
      silently(() => main(['--check', '--from', from, '--to', to, '--only', 'hm-qa'])),
      0
    )
    assert.deepEqual(
      checkDrift(['hm-qa'], { from, to }).map(r => r.state),
      ['ok']
    )

    fs.writeFileSync(path.join(from, 'hm-qa', 'tools', 'go.sh'), '#!/bin/sh\necho changed\n')
    assert.equal(
      silently(() => main(['--check', '--from', from, '--to', to, '--only', 'hm-qa'])),
      1
    )
    const drift = checkDrift(['hm-qa'], { from, to })
    assert.equal(drift[0].state, 'drift')
    assert.equal(drift[0].name, 'hm-qa')

    silently(() => main(['--from', from, '--to', to, '--only', 'hm-qa']))
    assert.equal(
      silently(() => main(['--check', '--from', from, '--to', to, '--only', 'hm-qa'])),
      0
    )
  })

  test('--check reports an unported or source-missing skill as not ok', () => {
    const from = tmp()
    const to = tmp()
    assert.deepEqual(checkDrift(['hm-qa'], { from, to }), [{ name: 'hm-qa', state: 'unported' }])

    library(from)
    silently(() => main(['--from', from, '--to', to, '--only', 'hm-qa']))
    fs.rmSync(path.join(from, 'hm-qa'), { recursive: true })
    assert.equal(checkDrift(['hm-qa'], { from, to })[0].state, 'missing')
    assert.equal(
      silently(() => main(['--check', '--from', from, '--to', to, '--only', 'hm-qa'])),
      1
    )
  })

  test('--check fails on scrub residue planted in a ported folder after the port — in a dot file too', () => {
    const from = tmp()
    const to = tmp()
    library(from)
    silently(() => main(['--from', from, '--to', to, '--only', 'hm-qa']))
    fs.writeFileSync(path.join(to, 'hm-qa', 'late.md'), 'see /Users/someone/x\n')
    fs.writeFileSync(path.join(to, 'hm-qa', '.env.example'), 'KEYS=~/.ssh/id_rsa\n')

    assert.deepEqual(
      scrubResidue(path.join(to, 'hm-qa')).map(h => [h.file, h.privateMarker]),
      [
        ['.env.example', true],
        ['late.md', false]
      ]
    )
    assert.equal(
      silently(() => main(['--check', '--from', from, '--to', to, '--only', 'hm-qa'])),
      1
    )
  })

  test('F1: --check fails when a third-party LICENSE is missing or edited, or the author is the owner; notices too', () => {
    const from = tmp()
    const to = tmp()
    thirdPartyLibrary(from, 'hm-qa')
    silently(() => main(['--from', from, '--to', to, '--only', 'hm-qa']))

    assert.deepEqual(checkAttribution(['hm-qa'], { from, to }), [])
    assert.equal(fs.readFileSync(path.join(to, 'hm-qa', LICENSE_FILE), 'utf8'), MIT)
    const notices = fs.readFileSync(path.join(to, NOTICES_FILE), 'utf8')
    assert.ok(
      notices.includes(
        '| hm-qa | Rodrigo Lopes | highermind-code-skills (https://github.com/rodrigohighermind/highermind-code-skills) | MIT | Copyright (c) 2026 Rodrigo Lopes | hm-qa/LICENSE |'
      )
    )
    assert.equal(notices, renderThirdPartyNotices(to))
    assert.equal(
      silently(() => main(['--check', '--from', from, '--to', to, '--only', 'hm-qa'])),
      0
    )

    fs.appendFileSync(path.join(to, 'hm-qa', LICENSE_FILE), 'edited\n')
    assert.deepEqual(checkAttribution(['hm-qa'], { from, to }), [
      { name: 'hm-qa', problem: 'LICENSE differs from the upstream text' }
    ])
    assert.equal(
      silently(() => main(['--check', '--from', from, '--to', to, '--only', 'hm-qa'])),
      1
    )

    fs.rmSync(path.join(to, 'hm-qa', LICENSE_FILE))
    assert.deepEqual(checkAttribution(['hm-qa'], { from, to }), [
      { name: 'hm-qa', problem: 'LICENSE missing beside SKILL.md' }
    ])

    silently(() => main(['--from', from, '--to', to, '--only', 'hm-qa']))
    const manifest = readManifest(path.join(to, 'hm-qa'))
    fs.writeFileSync(
      path.join(to, 'hm-qa', MANIFEST_FILE),
      JSON.stringify({ ...manifest, author: 'the owner (ported from his library)' })
    )
    assert.ok(checkAttribution(['hm-qa'], { from, to }).some(p => p.problem === 'manifest author is the owner'))

    fs.writeFileSync(path.join(to, NOTICES_FILE), '# stale\n')
    assert.equal(
      silently(() => main(['--check', '--from', from, '--to', to, '--only', 'hm-qa'])),
      1
    )
  })

  test("F1: --check fails when the owner's own skill claims an upstream", () => {
    const from = tmp()
    const to = tmp()
    library(from)
    silently(() => main(['--from', from, '--to', to, '--only', 'hm-qa']))
    const manifest = readManifest(path.join(to, 'hm-qa'))
    fs.writeFileSync(path.join(to, 'hm-qa', MANIFEST_FILE), JSON.stringify({ ...manifest, upstream: { name: 'x' } }))

    assert.deepEqual(checkAttribution(['hm-qa'], { from, to }), [
      { name: 'hm-qa', problem: "manifest names an upstream for the owner's own skill" }
    ])
  })

  test('treeSha256 covers names and bytes; listSkillFiles skips dot files, node_modules and the manifest unless asked', () => {
    const root = tmp()
    fs.mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true })
    fs.writeFileSync(path.join(root, 'node_modules', 'x', 'i.js'), '1')
    fs.writeFileSync(path.join(root, '.DS_Store'), '1')
    fs.writeFileSync(path.join(root, MANIFEST_FILE), '{}')
    fs.writeFileSync(path.join(root, 'b.md'), 'b')
    fs.writeFileSync(path.join(root, 'a.md'), 'a')

    assert.deepEqual(listSkillFiles(root), ['a.md', 'b.md'])
    assert.deepEqual(listSkillFiles(root, '', { dot: true }), ['.DS_Store', 'a.md', 'b.md'])
    assert.deepEqual(listSkillFiles(root, '', { skip: new Set(['a.md']) }), ['b.md'])
    const before = treeSha256(root)
    fs.renameSync(path.join(root, 'b.md'), path.join(root, 'c.md'))
    assert.notEqual(treeSha256(root), before)
  })
})

describe('F2b: the voice profile, the name that sounds like the owner, the training record', () => {
  test('profile numbers become <n>; a signed delta, a ratio, a page pause and a tool default stay', () => {
    const { text, count } = scrubVoiceProfile(
      [
        'Perfil dele: f0 97 Hz, spread 3,41 st, 4,07 palavras/s, pausa entre frases 0,58 s.',
        '`--speed 1.12` (= o ritmo real dele, 4,22 palavras/s), `--pause 0.4` (a pausa dele entre',
        'frases, 0,58 s) · ritmo 0,85–1,25× · pausa mediana 0,31–0,62 s · altura ±2,5 st',
        'sim 0,902, altura +0,02 st, spread 3,29 st (dele 3,41). Nas frases dá 3,41 st; spread > 1,3× o dele.',
        'ritmo 3.05–4.11 p/s; g05 4,41 p/s; 5 words per second',
        'Page → Pause 1.5 s; Restart | a 120 Hz display gives 60 fps'
      ].join('\n')
    )

    assert.equal(
      text,
      [
        'Perfil dele: f0 <n> Hz, spread <n> st, <n> palavras/s, pausa entre frases <n> s.',
        '`--speed 1.12` (= o ritmo real dele, <n> palavras/s), `--pause 0.4` (a pausa dele entre',
        'frases, <n> s) · ritmo 0,85–1,25× · pausa mediana <n> s · altura ±2,5 st',
        'sim 0,902, altura +0,02 st, spread <n> st (dele <n>). Nas frases dá <n> st; spread > 1,3× o dele.',
        'ritmo <n> p/s; g05 <n> p/s; <n> words per second',
        'Page → Pause 1.5 s; Restart | a 120 Hz display gives 60 fps'
      ].join('\n')
    )
    assert.equal(count, 13)
    // A tool script's thresholds are code: scrubText leaves them, the control-plane gate scans them for the shape.
    const sh = '# his voice: f0 97 Hz\nPAUSE=0.4\n'
    assert.equal(scrubText(sh, { self: 'x', rel: 'tools/say.sh' }).text, sh)
    assert.equal(scrubText('f0 97 Hz', { self: 'x', rel: 'references/x.md' }).counts.voiceProfile, 1)
  })

  test('ridervoice: the training record is left out, the name rows go, numbers are <n>, the waiver is recorded', () => {
    const from = tmp()
    library(from, 'ridervoice', {
      skill:
        '---\nname: ridervoice\ndescription: "Rider Voice."\n---\n# Rider Voice\n\nO ritmo dele: 4,22 palavras/s.\n\n' +
        RIDER_SKILL_BODY,
      files: { ...RIDER_FILES, 'references/training-record.md': 'Perfil real dele: f0 97 Hz.\n' }
    })
    const result = portSkill('ridervoice', {
      from,
      to: tmp(),
      identity: ['Pat Example'],
      spec: synthSpec('ridervoice')
    })
    const file = rel => result.outputs.find(out => out.rel === rel)?.text
    const skill = file('SKILL.md')

    // K140 r5: the owner's records do not ship at all: the training record, his pronunciation notes (how his name
    // sounds), his lessons (values labelled as his), the batch over his own series.
    for (const rel of [
      'references/training-record.md',
      'references/pronunciation.md',
      'references/LEARNED.md',
      'tools/revoice.sh'
    ]) {
      assert.equal(file(rel), undefined, rel)
      assert.ok(result.manifest.excluded.includes(rel), rel)
    }
    assert.ok(skill.includes('`references/training-record.md`'))
    assert.ok(!/Exampel|Pat Example/.test(result.outputs.map(out => out.text).join('\n')))
    assert.ok(skill.includes('O ritmo dele: <n> palavras/s.'))
    assert.ok(
      skill.includes('> Kept by the owner\'s decision: "Rider Voice" (the owner\'s product name and public persona')
    )
    assert.ok(skill.includes('measured voice-profile numbers of a real person are written `<n>`'))
    assert.deepEqual(result.manifest.waivers, PORT_SET.ridervoice.waivers)
    assert.equal(result.manifest.scrub.redacted, 4)
    assert.equal(result.manifest.scrub.voiceProfile, 3)
  })

  test('m5/m6: no value labelled as his own prosody, no pointer to the record that does not ship', () => {
    const from = tmp()
    library(from, 'ridervoice', {
      skill: `---\nname: ridervoice\ndescription: "Rider Voice."\n---\n# Rider Voice\n\n${RIDER_SKILL_BODY}`,
      files: { ...RIDER_FILES, 'references/training-record.md': 'Perfil real dele: f0 97 Hz.\n' }
    })
    const result = portSkill('ridervoice', {
      from,
      to: tmp(),
      identity: ['Pat Example'],
      spec: synthSpec('ridervoice')
    })
    const file = rel => result.outputs.find(out => out.rel === rel)?.text
    const skill = file('SKILL.md')
    const body = skill.slice(skill.indexOf('# Rider Voice'))

    // m5: the pause flag keeps its value and loses the claim that it is his pause; the two signed values are <n>.
    assert.ok(
      body.includes(
        'Predefinições aprovadas: `--speed 1.12` (= o ritmo real dele, <n> palavras/s), `--pause 0.4` (pausa entre frases), `--seed 23`.'
      )
    )
    assert.ok(!/pausa dele entre/.test(skill))
    assert.equal(file('references/LEARNED.md'), undefined)
    // m6: the sentence and the list entry pointing at the record go; the pipeline pointer goes; the port note names it.
    assert.ok(
      body.includes('Crítico escolhe o checkpoint → aprovação.\nSobre-ajuste aparece depois de ~2000\nupdates.')
    )
    assert.ok(body.includes('- `references/pipeline.md` — o motor passo a passo\n- `references/LEARNED.md` —'))
    assert.equal(
      file('references/pipeline.md'),
      'Formato "pretrained": chaves `step` (o slim de inferência NÃO serve para o trainer).\n'
    )
    assert.deepEqual(
      result.outputs.flatMap(out =>
        out.text
          .split('\n')
          .filter(line => line.includes('training-record') && !line.includes('Not ported'))
          .map(() => out.rel)
      ),
      []
    )
    // The port note says what was done, class by class, and no more.
    assert.ok(skill.includes("a value labelled as the owner's own prosody is written `<n>` or left out"))
    assert.ok(skill.includes('pointers to a file that is not ported are left out'))
    assert.deepEqual(
      PORT_SET.ridervoice.redact.map(rule => rule.file),
      ['SKILL.md', 'SKILL.md', 'SKILL.md', 'references/pipeline.md']
    )
  })

  test('a skill without redact rules writes no "left out" line in its port note', () => {
    const from = tmp()
    library(from, 'hm-qa')
    const skill = portSkill('hm-qa', { from, to: tmp() }).outputs.find(out => out.rel === 'SKILL.md').text

    assert.ok(!skill.includes('left out'))
  })

  test("R2-1: hm-qa's report label is written Segredos (no secret-scanner hit); an optional rule may match nothing", () => {
    const from = tmp()
    // The label is assembled so this test file itself is no secret-scanner hit.
    const label = ['Sec', 'rets'].join('')
    const body = `# QA\n\n\`\`\`\nSECURITY AUDIT\n${label}: limpo/EXPOSED (detalhes)\nGate: PASSED / BLOCKED\n\`\`\`\n`
    library(from, 'hm-qa', { skill: `---\nname: hm-qa\ndescription: "QA."\n---\n\n${body}` })
    const result = portSkill('hm-qa', { from, to: tmp() })
    const skill = result.outputs.find(out => out.rel === 'SKILL.md').text

    assert.match(skill, /^Segredos: limpo\/EXPOSED \(detalhes\)$/m)
    assert.doesNotMatch(skill, /^Secrets: /m)
    assert.match(skill, /^> In this copy the report label `Secrets:` is written `Segredos:`/m)
    assert.equal(result.manifest.scrub.redacted, 1)

    // The same skill without the line: the optional rule refuses nothing and writes no note.
    const plain = tmp()
    library(plain, 'hm-qa')
    const again = portSkill('hm-qa', { from: plain, to: tmp() })
    assert.equal(again.manifest.scrub.redacted, 0)
    assert.ok(!again.outputs.find(out => out.rel === 'SKILL.md').text.includes('Segredos'))
  })

  test('a redaction that matches nothing refuses the port (the source moved under it)', () => {
    const from = tmp()
    library(from, 'ridervoice', {
      skill: `---\nname: ridervoice\ndescription: "Voice."\n---\n# Voice\n\n${RIDER_SKILL_BODY}`,
      files: { ...RIDER_FILES, 'references/pipeline.md': '- nothing points at the record here\n' }
    })

    assert.throws(
      () => portSkill('ridervoice', { from, to: tmp(), identity: ['Pat Example'], spec: synthSpec('ridervoice') }),
      /ridervoice\/references\/pipeline\.md: the redaction .* matched nothing/
    )
  })

  test('--check fails on a voice profile planted in a ported folder after the port', () => {
    const from = tmp()
    const to = tmp()
    library(from)
    silently(() => main(['--from', from, '--to', to, '--only', 'hm-qa']))
    fs.writeFileSync(path.join(to, 'hm-qa', 'notes.md'), 'Perfil: f0 97 Hz, 4,07 palavras/s\n')

    assert.deepEqual(
      scrubResidue(path.join(to, 'hm-qa')).map(hit => [hit.file, hit.voiceProfile]),
      [['notes.md', 2]]
    )
    assert.equal(
      silently(() => main(['--check', '--from', from, '--to', to, '--only', 'hm-qa'])),
      1
    )
  })
})

describe('m1: third-party detection by file links, licence names, unreadable licences', () => {
  test('A4: a real folder whose FILES are symlinks into a licensed package is third-party, never the owner', () => {
    const from = tmp()
    const pkg = thirdPartyLibrary(from, 'hm-qa', { symlink: false })
    fs.mkdirSync(path.join(pkg, 'hm-qa', 'refs'))
    fs.writeFileSync(path.join(pkg, 'hm-qa', 'refs', 'a.md'), 'a\n')
    fs.mkdirSync(path.join(from, 'hm-qa'))
    fs.symlinkSync(path.join(pkg, 'hm-qa', 'SKILL.md'), path.join(from, 'hm-qa', 'SKILL.md'))
    fs.symlinkSync(path.join(pkg, 'hm-qa', 'refs'), path.join(from, 'hm-qa', 'refs'))

    const third = thirdPartyOf(from, 'hm-qa', {})
    assert.equal(third.author, 'Rodrigo Lopes')
    assert.equal(third.upstream.name, 'highermind-code-skills')

    const result = portSkill('hm-qa', { from, to: tmp() })
    assert.equal(result.manifest.author, 'Rodrigo Lopes')
    assert.equal(result.outputs.find(file => file.rel === LICENSE_FILE).text, MIT)
  })

  test('a link between two files of the folder is not provenance; a dangling link refuses', () => {
    const from = tmp()
    const dir = library(from, 'parrallello')
    fs.symlinkSync(path.join(dir, 'SKILL.md'), path.join(dir, 'ALIAS.md'))
    assert.equal(thirdPartyOf(from, 'parrallello', {}), null)

    fs.symlinkSync(path.join(dir, 'gone.md'), path.join(dir, 'dangling.md'))
    assert.throws(() => thirdPartyOf(from, 'parrallello', {}), /dangling\.md is a dangling symlink — refusing/)
  })

  test('a link out of the library, or into two licences, refuses — it is never stamped as the owner', () => {
    const outside = tmp()
    fs.writeFileSync(path.join(outside, 'x.md'), 'x\n')
    const from = tmp()
    const dir = library(from, 'parrallello')
    fs.symlinkSync(path.join(outside, 'x.md'), path.join(dir, 'x.md'))
    assert.throws(() => thirdPartyOf(from, 'parrallello', {}), /x\.md links to a third-party source without a licence/)

    const two = tmp()
    thirdPartyLibrary(two, 'hm-qa', { symlink: false })
    const other = path.join(two, 'other-pkg')
    fs.mkdirSync(other)
    fs.writeFileSync(path.join(other, 'LICENSE'), 'Apache License\n')
    fs.writeFileSync(path.join(other, 'b.md'), 'b\n')
    fs.mkdirSync(path.join(two, 'hm-qa'))
    fs.symlinkSync(path.join(two, 'highermind-code-skills', 'hm-qa', 'SKILL.md'), path.join(two, 'hm-qa', 'SKILL.md'))
    fs.symlinkSync(path.join(other, 'b.md'), path.join(two, 'hm-qa', 'b.md'))
    assert.throws(() => thirdPartyOf(two, 'hm-qa', {}), /2 different licences/)
  })

  test('licence names: LICENSE*, LICENCE*, COPYING*, license.txt, .rst variants count; LICENSES/ does not', () => {
    for (const name of [
      'LICENSE',
      'LICENCE',
      'LICENSE-MIT',
      'LICENSE.rst',
      'LICENCE.md',
      'license.txt',
      'COPYING',
      'COPYING.LESSER',
      'COPYRIGHT',
      'License-Apache.txt'
    ])
      assert.ok(LICENSE_NAMES.test(name), name)
    for (const name of ['LICENSES', 'LICENSE_', 'MYLICENSE', 'COPYING-', 'NOTICE'])
      assert.ok(!LICENSE_NAMES.test(name), name)

    for (const name of ['LICENSE-MIT', 'LICENSE.rst', 'COPYING.LESSER', 'license.txt']) {
      const from = tmp()
      thirdPartyLibrary(from, 'hm-qa', { license: null })
      fs.writeFileSync(path.join(from, 'highermind-code-skills', name), MIT)
      const third = thirdPartyOf(from, 'hm-qa', {})
      assert.equal(third.licenseFile, name)
      assert.equal(third.author, 'Rodrigo Lopes', name)
    }

    // LICENSE is trusted before its variants and COPYRIGHT.
    const from = tmp()
    thirdPartyLibrary(from, 'hm-qa')
    fs.writeFileSync(path.join(from, 'highermind-code-skills', 'COPYRIGHT'), 'Copyright 2020 Other\n')
    assert.equal(thirdPartyOf(from, 'hm-qa', {}).licenseFile, 'LICENSE')
  })

  test('a licence that cannot be read (a folder, empty, no permission) refuses; never the owner', () => {
    const asDir = tmp()
    thirdPartyLibrary(asDir, 'hm-qa', { license: null })
    fs.mkdirSync(path.join(asDir, 'highermind-code-skills', 'LICENSE'))
    assert.throws(() => thirdPartyOf(asDir, 'hm-qa', {}), /the licence LICENSE cannot be read \(EISDIR\)/)

    const empty = tmp()
    thirdPartyLibrary(empty, 'hm-qa', { license: '\n' })
    assert.throws(() => thirdPartyOf(empty, 'hm-qa', {}), /the licence LICENSE is empty/)

    if (process.getuid?.() !== 0) {
      const locked = tmp()
      const pkg = thirdPartyLibrary(locked, 'hm-qa')
      fs.chmodSync(path.join(pkg, 'LICENSE'), 0o000)
      try {
        assert.throws(() => thirdPartyOf(locked, 'hm-qa', {}), /cannot be read \(EACCES\)/)
        assert.throws(() => portSkill('hm-qa', { from: locked, to: tmp() }), /never stamped as the owner's/)
      } finally {
        fs.chmodSync(path.join(pkg, 'LICENSE'), 0o644)
      }
    }
  })
})

describe('m2: the places a tool script reaches for, $VAR expanded, fallbacks included', () => {
  const revoice = [
    '#!/bin/zsh',
    '# engine moved into ~/Desktop/VAULT on 2024-03-05',
    'E="$HOME/Desktop/VAULT/Engine X/engine"; [ -d "$E" ] || E="$HOME/Desktop/Engine X/engine"; PY=~/.venvs/synth/bin/python; W=~/Movies/work/revoice',
    'DESK="$HOME/Desktop"; [ -d "$HOME/Desktop/VAULT" ] || DESK="$HOME/Library/Mobile Documents/com~apple~CloudDocs/Desktop"; SRT="$DESK/VAULT/MEDIA/subs"',
    '$PY $E/run.py "$SRT/$n.srt" > $W/logs/$k.log',
    'python3 -c "import sys; sys.path.insert(0, os.path.expanduser(\'~/Tools/lib\'))"'
  ].join('\n')

  test('homeRootsOf expands $VAR/… through every assignment (fallbacks too); comments are prose', () => {
    assert.deepEqual(homeRootsOf(revoice, 'tools/revoice.sh'), [
      '~/.venvs/synth/bin/python',
      '~/Desktop',
      '~/Desktop/Engine X/engine',
      '~/Desktop/VAULT',
      '~/Desktop/VAULT/Engine X/engine',
      '~/Desktop/VAULT/MEDIA/subs',
      '~/Library/Mobile Documents/com~apple~CloudDocs/Desktop',
      '~/Library/Mobile Documents/com~apple~CloudDocs/Desktop/VAULT/MEDIA/subs',
      '~/Movies/work/revoice',
      '~/Movies/work/revoice/logs',
      '~/Tools/lib'
    ])
    assert.deepEqual(homeRootsOf("dofile(os.getenv('HOME') .. '/Movies/B/b.lua') -- ~/Secret/x", 'x.lua'), [
      '~/Movies/B'
    ])
    assert.deepEqual(homeRootsOf('const a = join(homedir(), "Movies", "out") // ~/Secret', 'x.mjs'), ['~/Movies/out'])
  })

  test('undeclaredRoots: a root, inside one or a folder above one is declared; anything else is not', () => {
    const declared = ['~/Desktop/VAULT/Engine X/engine', '~/Movies']
    assert.deepEqual(
      undeclaredRoots(['~/Desktop', '~/Desktop/VAULT/Engine X/engine/sub', '~/Movies2', '~/Movies/x'], declared),
      ['~/Movies2']
    )
    assert.deepEqual(declaredPaths(['~/a', ['~/b', '~/c'], '/Applications/X.app']), ['~/a', '~/b', '~/c'])
  })

  test('a composite or fallback root not in requires.paths refuses the port; the real set declares them', () => {
    const from = tmp()
    library(from, 'ridervoice', { files: { ...RIDER_FILES, 'tools/say.sh': revoice } })

    assert.throws(
      () => portSkill('ridervoice', { from, to: tmp(), identity: ['Pat Example'], spec: synthSpec('ridervoice') }),
      /ridervoice\/tools\/say\.sh: reaches for .*~\/\.venvs\/synth\/bin\/python.*~\/Tools\/lib.* not in requires\.paths/
    )

    // K140 r2: the real set names every folder of the owner's machine it needs by variable, never by its layout.
    for (const { env } of PORT_SET.ridervoice.places) {
      assert.ok(PORT_SET.ridervoice.requires.paths.includes(`$${env}`), env)
    }
    // Hygiene 2026-10-27: the model folder and the python environment used to be declared by their literal place
    // in the author's home. They are variables now like every other place, so the only literal this skill still
    // names is ~/Movies - a folder macOS gives everyone, not a fact about one machine.
    assert.deepEqual(declaredPaths(PORT_SET.ridervoice.requires.paths), ['~/Movies'])
  })
})

describe('m3: machine-layout paths', () => {
  test('prose gets the placeholder; code a valid env form per language; a declared root and its parents stay', () => {
    const roots = ['~/Desktop/VAULT/Engine X/engine']
    const count = { n: 0 }
    const on = () => count.n++

    assert.equal(
      rewriteMachinePaths('Root: `~/Desktop/Studio/001 - QUARTZ` and ~/Developer/x.', null, roots, on),
      'Root: `<your project folder>/Studio/001 - QUARTZ` and <your project folder>/x.'
    )
    assert.equal(
      rewriteMachinePaths(
        'find ~/Desktop -maxdepth 6 && cd "$HOME/Desktop/a b" && ls ${HOME}/Developer/x',
        'shell',
        [],
        on
      ),
      'find ${PROJECT_DIR:?} -maxdepth 6 && cd "${PROJECT_DIR:?}/a b" && ls ${PROJECT_DIR:?}/x'
    )
    assert.equal(
      rewriteMachinePaths(
        "sys.path.insert(0, os.path.expanduser('~/Desktop/clip Forge')); r = os.path.expanduser('~/Desktop')",
        'python',
        [],
        on
      ),
      "sys.path.insert(0, os.path.join(os.environ['PROJECT_DIR'], 'clip Forge')); r = os.environ['PROJECT_DIR']"
    )
    assert.equal(
      rewriteMachinePaths("dofile(os.getenv('HOME') .. '/Desktop/b.lua')", 'lua', [], on),
      "dofile(os.getenv('PROJECT_DIR') .. '/b.lua')"
    )
    assert.equal(
      rewriteMachinePaths('const o = join(homedir(), "Desktop", "VIDEOS " + d)', null, [], on),
      'const o = join(process.env.PROJECT_DIR ?? process.cwd(), "VIDEOS " + d)'
    )
    assert.equal(count.n, 9)

    // I1: ${HOME:?}/…, ${HOME:-x}/…, $(echo ~)/… and Python's join(expanduser("~"), "Desktop", …) are the machine too.
    assert.equal(
      rewriteMachinePaths(
        'P="${HOME:?}/Desktop/a"; Q=${HOME:-/tmp}/Developer/b; cd $(echo ~)/Desktop/c',
        'shell',
        [],
        on
      ),
      'P="${PROJECT_DIR:?}/a"; Q=${PROJECT_DIR:?}/b; cd ${PROJECT_DIR:?}/c'
    )
    assert.equal(
      rewriteMachinePaths('o = os.path.join(os.path.expanduser("~"), "Desktop", "VIDEOS", n)', 'python', [], on),
      'o = os.path.join(os.environ[\'PROJECT_DIR\'], "VIDEOS", n)'
    )
    assert.equal(count.n, 13)
    const declaredI1 =
      'k = os.path.join(os.path.expanduser("~"), "Desktop", "VAULT", "Engine X", "engine")\nE="${HOME:?}/Desktop/VAULT"'
    assert.equal(rewriteMachinePaths(declaredI1, 'python', roots, on), declaredI1)
    assert.equal(count.n, 13)
    assert.equal(countMachinePaths('a ${HOME:?}/Desktop/x b $(echo ~)/Developer/y', []), 2)

    // Declared: the root, a file inside it, a shell-escaped space, and the folders above it (prose and code) stay.
    const kept = [
      '`~/Desktop/VAULT/Engine X/engine/run.py`',
      'E="$HOME/Desktop/VAULT/Engine X/engine"; [ -d "$HOME/Desktop/VAULT" ] || DESK="$HOME/Desktop"',
      'cd ~/Desktop/VAULT/Engine\\ X/engine',
      'moved into ~/Desktop/VAULT on 2024-03-05 (iCloud ↔ ~/Desktop).'
    ].join('\n')
    assert.equal(rewriteMachinePaths(kept, 'shell', roots, on), kept)
    assert.equal(count.n, 13)
    assert.equal(
      coveredByRoots(
        '/Desktop/VAULT/Engine Xtra',
        roots.map(r => r)
      ),
      false
    )
    assert.equal(countMachinePaths('a ~/Desktop/x b `~/Developer/y`', []), 2)
  })

  test('I2: the machine-path rewrite drops a homedir import it left unused; a module that still calls it keeps it', () => {
    assert.equal(
      dropUnusedHomedirImport('import { homedir, loadavg } from "node:os";\nconst l = loadavg()\n'),
      'import { loadavg } from "node:os";\nconst l = loadavg()\n'
    )
    assert.equal(dropUnusedHomedirImport("import { homedir } from 'os'\nrun()\n"), 'run()\n')
    const used = 'import { homedir } from "node:os";\nconst h = homedir()\n'
    assert.equal(dropUnusedHomedirImport(used), used)
    assert.equal(dropUnusedHomedirImport('import { cpus } from "node:os";\n'), 'import { cpus } from "node:os";\n')

    const { text } = scrubText(
      'import { join } from "node:path";\nimport { homedir, loadavg } from "node:os";\nconst OUT = join(homedir(), "Desktop", "V")\n',
      { self: 'camera-and-action', rel: 'templates/record-series.mjs' }
    )
    assert.equal(
      text,
      'import { join } from "node:path";\nimport { loadavg } from "node:os";\nconst OUT = join(process.env.PROJECT_DIR ?? process.cwd(), "V")\n'
    )
  })

  test('--check fails on a machine path planted in a ported folder; a named place is not residue', () => {
    const from = tmp()
    const to = tmp()
    library(from, 'videoediting', { files: { 'references/vignettes.md': '  vignette_640x360_25.mov  # demo\n' } })
    silently(() => main(['--from', from, '--to', to, '--only', 'videoediting']))
    assert.deepEqual(scrubResidue(path.join(to, 'videoediting')), [])

    fs.writeFileSync(
      path.join(to, 'videoediting', 'ok.md'),
      'Runs in `$VIDEOEDITING_PIPELINE_DIR/x.py` with `$F5TTS_VENV/bin/python`.\n'
    )
    assert.deepEqual(scrubResidue(path.join(to, 'videoediting')), [])

    fs.writeFileSync(path.join(to, 'videoediting', 'late.md'), 'Saved to `~/Desktop/SESSION_FULL_<date>.md`.\n')
    assert.deepEqual(
      scrubResidue(path.join(to, 'videoediting')).map(hit => [hit.file, hit.machinePaths]),
      [['late.md', 1]]
    )
    assert.equal(
      silently(() => main(['--check', '--from', from, '--to', to, '--only', 'videoediting'])),
      1
    )
  })
})

describe('m4: the upstream copyright line, verbatim', () => {
  test('copyrightLinesOf keeps every real line as written and drops a template line', () => {
    assert.deepEqual(copyrightLinesOf(MIT), ['Copyright (c) 2026 Rodrigo Lopes'])
    assert.deepEqual(
      copyrightLinesOf(
        '  Copyright © 2019-2024 A <a@x.org>\nCopyright 2025 B\nCopyright [yyyy] [name of copyright owner]\ncopyright notice\n'
      ),
      ['Copyright © 2019-2024 A <a@x.org>', 'Copyright 2025 B']
    )
  })

  test('--check fails when the manifest copyright differs from the licence text', () => {
    const from = tmp()
    const to = tmp()
    thirdPartyLibrary(from, 'hm-qa')
    silently(() => main(['--from', from, '--to', to, '--only', 'hm-qa']))
    const manifest = readManifest(path.join(to, 'hm-qa'))

    assert.deepEqual(manifest.upstream.copyright, ['Copyright (c) 2026 Rodrigo Lopes'])
    fs.writeFileSync(
      path.join(to, 'hm-qa', MANIFEST_FILE),
      JSON.stringify({ ...manifest, upstream: { ...manifest.upstream, copyright: ['Copyright (c) 2026 the owner'] } })
    )
    assert.deepEqual(checkAttribution(['hm-qa'], { from, to }), [
      { name: 'hm-qa', problem: 'manifest copyright differs from the upstream licence text' }
    ])
  })
})

describe('the real bundle', () => {
  test('every skill of the set is ported with a manifest and carries no residue (B5/B6 on the committed tree)', () => {
    for (const name of PORT_NAMES) {
      const dir = path.join(DEFAULT_BUNDLE, name)
      assert.ok(fs.existsSync(path.join(dir, MANIFEST_FILE)), `${name}: manifest`)
      assert.ok(fs.existsSync(path.join(dir, 'SKILL.md')), `${name}: SKILL.md`)
      assert.deepEqual(scrubResidue(dir), [], name)
      assert.ok(!fs.lstatSync(dir).isSymbolicLink(), `${name}: not a symlink`)
    }
    // K140 r4: the residue scan reads this machine's layout (once) and the product's tracked names.
  }, 60_000)

  test('F1/F2: the six highermind skills ship their licence and author; the private map is not in the bundle', () => {
    for (const name of ['hm-deploy', 'hm-designer', 'hm-engineer', 'hm-init', 'hm-qa', 'hm-security']) {
      const manifest = readManifest(path.join(DEFAULT_BUNDLE, name))
      assert.equal(manifest.author, 'Rodrigo Lopes', name)
      assert.equal(manifest.license, 'MIT', name)
      assert.equal(manifest.upstream.name, 'highermind-code-skills', name)
      assert.ok(
        fs
          .readFileSync(path.join(DEFAULT_BUNDLE, name, LICENSE_FILE), 'utf8')
          .includes('Copyright (c) 2026 Rodrigo Lopes'),
        name
      )
    }

    assert.equal(
      fs.existsSync(path.join(DEFAULT_BUNDLE, 'fable-orchestrator', 'references', 'clone-frame-map.md')),
      false
    )
    assert.deepEqual(readManifest(path.join(DEFAULT_BUNDLE, 'fable-orchestrator')).excluded, [
      'references/clone-frame-map.md'
    ])
    assert.equal(
      fs.readFileSync(path.join(DEFAULT_BUNDLE, NOTICES_FILE), 'utf8'),
      renderThirdPartyNotices(DEFAULT_BUNDLE)
    )
  })

  test('F2b/m2/m3/m4 on the committed tree: no training record, every tool root declared, 0 machine paths, copyright rows', () => {
    const rider = path.join(DEFAULT_BUNDLE, 'ridervoice')
    assert.equal(fs.existsSync(path.join(rider, 'references', 'training-record.md')), false)
    assert.ok(readManifest(rider).excluded.includes('references/training-record.md'))
    const riderText = listSkillFiles(rider)
      .map(rel => fs.readFileSync(path.join(rider, rel), 'utf8'))
      .join('\n')
    // K140 r5: no digest of how the owner's name sounds is kept here; the identity tokens come from the porting machine.
    for (const token of identityTokens()) {
      assert.ok(!riderText.toLowerCase().includes(token.toLowerCase()), 'an identity token ships')
    }
    // m5 / m6 on the committed tree: no value labelled as his own prosody; the record is named only as not ported.
    assert.ok(!/pausa dele entre|(?:as|o alvo) dele (?:ficam em|ser) [+−-]?\d/.test(riderText))
    assert.deepEqual(
      riderText.split('\n').filter(line => line.includes('training-record') && !line.includes('Not ported')),
      []
    )
    // I2: the recorder template no longer imports homedir after its machine paths were rewritten.
    assert.ok(
      !/import \{[^}]*\bhomedir\b/.test(
        fs.readFileSync(path.join(DEFAULT_BUNDLE, 'camera-and-action', 'templates', 'record-series.mjs'), 'utf8')
      )
    )

    const notices = fs.readFileSync(path.join(DEFAULT_BUNDLE, NOTICES_FILE), 'utf8')
    assert.ok(notices.includes("Owner's product names kept by his decision"))

    for (const name of PORT_NAMES) {
      const dir = path.join(DEFAULT_BUNDLE, name)
      const manifest = readManifest(dir)
      const roots = declaredPaths(manifest.requires.paths)

      for (const rel of listSkillFiles(dir, '', { dot: true })) {
        const text = fs.readFileSync(path.join(dir, rel), 'utf8')
        assert.equal(countMachinePaths(text, roots), 0, `${name}/${rel}: machine path`)
        if (/\.(?:sh|zsh|bash|py|lua|mjs|js|cjs|command)$/.test(rel))
          assert.deepEqual(undeclaredRoots(homeRootsOf(text, rel), roots), [], `${name}/${rel}: undeclared root`)
      }

      if (manifest.upstream) {
        const lines = copyrightLinesOf(fs.readFileSync(path.join(dir, LICENSE_FILE), 'utf8'))
        assert.ok(lines.length > 0, name)
        assert.deepEqual(manifest.upstream.copyright, lines, name)
        assert.ok(
          notices.split('\n').some(row => row.startsWith(`| ${name} |`) && lines.every(line => row.includes(line))),
          name
        )
      }
    }
  })
})

describe('K140: the port refuses what the release hygiene scan refuses', () => {
  // Built from parts so this test file never carries the marker itself (scripts/ is never packed, but stay clean).
  const LAB = ['RESUME', 'run.nosync'].join('/')

  test('a lab path the scan rejects refuses the port of a skill without a rule for it, and writes nothing', () => {
    const from = tmp()
    const to = tmp()
    library(from, 'hm-qa', { files: { 'tools/q.sh': `#!/bin/sh\nLOGS="$ROOT/${LAB}/logs"\n` } })

    assert.throws(
      () => portSkill('hm-qa', { from, to, spec: shipAll('hm-qa', from), ...isolated }),
      /hm-qa: would fail the release hygiene scan — tools\/q\.sh \(lab\.run-nosync\)/
    )
    // Through the CLI (the real ship list) the lab path in the shipped SKILL.md refuses the run, which writes nothing.
    const cli = tmp()
    library(cli, 'hm-qa', { skill: `# QA\n\nLogs in \`$ROOT/${LAB}/logs\`.\n` })
    assert.throws(() => silently(() => main(['--from', cli, '--to', to, '--only', 'hm-qa'])), /hygiene/)
    assert.equal(fs.existsSync(path.join(to, 'hm-qa')), false)
  })

  test('parrallello: one neutral name for the local run folder in prose and code alike; the port note says so', () => {
    const from = tmp()
    library(from, 'parrallello', {
      skill: `---\nname: parrallello\ndescription: x\n---\n\n# P\n\n  run.nosync/   local\nO crítico guarda em \`${LAB}/gates/\`.\n`,
      files: {
        'install.sh': `#!/usr/bin/env bash\nNOS="$ROOT/${LAB}"\necho "ok ${LAB} is ignored"\n`,
        'tools/gates.py': 'GATES = ROOT / "RESUME" / "run.nosync" / "gates"\n',
        // K140 r5: the owner's records (a worked example, scenarios from his projects, tools written for one of them)
        // are not on the ship list: they stay behind whatever they say.
        'tools/gpu_lock.py': '# a tool written for one of the owner projects\n',
        'references/scenarios.md': '## 2. Cena 3D (ex.: one of his projects)\n',
        'examples/run.md': '# A corrida\n\n- **Raiz:** `<x>/projects/run`.\n',
        'templates/workflows/block.js': `const s = \`Scratch: \${R}/${LAB}/scratch/\`\n`
      }
    })
    // The real ship list, plus the fixture's own tool that writes the control-plane path in pathlib form.
    const result = portSkill('parrallello', {
      from,
      to: tmp(),
      spec: { ...PORT_SET.parrallello, ship: [...PORT_SET.parrallello.ship, 'tools/gates.py'] }
    })
    const text = Object.fromEntries(result.outputs.map(out => [out.rel, out.text]))

    for (const [rel, body] of Object.entries(text)) {
      assert.ok(!/\brun\.nosync\b/.test(body), `${rel} still names the lab folder`)
    }
    // K140 r2: the control-plane folder gets one neutral name too, in every spelling the source uses.
    assert.match(text['install.sh'], /NOS="\$ROOT\/CONTROL\/local\.nosync"/)
    assert.match(text['tools/gates.py'], /"CONTROL" \/ "local\.nosync" \/ "gates"/)
    assert.match(text['templates/workflows/block.js'], /CONTROL\/local\.nosync\/scratch/)
    assert.match(text['SKILL.md'], /the control plane is `CONTROL\/` and its local half `CONTROL\/local\.nosync\/`/)
    for (const [rel, body] of Object.entries(text)) {
      assert.deepEqual(privateTokenIds(body), [], `${rel} still carries a control-plane token`)
    }
    assert.ok(result.counts.redacted >= 3)
    for (const rel of ['tools/gpu_lock.py', 'references/scenarios.md', 'examples/run.md']) {
      assert.equal(text[rel], undefined, rel)
      assert.ok(result.manifest.excluded.includes(rel), rel)
    }
  })

  test('--check fails on a lab path planted in a ported folder after the port', () => {
    const from = tmp()
    const to = tmp()
    library(from)
    silently(() => main(['--from', from, '--to', to, '--only', 'hm-qa']))
    fs.writeFileSync(path.join(to, 'hm-qa', 'late.md'), `logs in ${LAB}/logs\n`)

    // K140 r5: the residue scan reads this machine's private names too; the lab ids are the ones this test pins.
    const residue = scrubResidue(path.join(to, 'hm-qa'))
    assert.deepEqual(
      residue.map(h => h.file),
      ['late.md']
    )
    for (const id of ['lab.run-nosync', 'port.control-plane', 'port.run-nosync']) {
      assert.ok(residue[0].hygiene.includes(id), id)
    }
    assert.equal(
      silently(() => main(['--check', '--from', from, '--to', to, '--only', 'hm-qa'])),
      1
    )
  })

  test('the committed skills tree (Resources/hermes-skill) passes the release hygiene scan: 0 hits', () => {
    assert.deepEqual(scanTree(DEFAULT_BUNDLE, { log: () => {} }), [])
  })

  // K140 r2 (m2): the refusal matches the tokens, not one spelling of the path.
  test('a control-plane path in any spelling refuses the port: path joins, pathlib, backslashes, prose', () => {
    const CP = 'RES' + 'UME' // built from parts, as LAB above
    const NOS = 'run' + '.nosync'
    for (const [rel, body, ids] of [
      ['tools/a.py', `P = os.path.join(ROOT, "${CP}", "${NOS}")\n`, ['port.control-plane', 'port.run-nosync']],
      ['tools/b.py', `P = ROOT / "${CP}" / "${NOS}" / "gates"\n`, ['port.control-plane', 'port.run-nosync']],
      ['tools/c.sh', `P="$ROOT\\${CP}\\${NOS}"\n`, ['port.control-plane', 'port.run-nosync']],
      ['tools/d.sh', `cd "$ROOT"/${CP} && ls\n`, ['port.control-plane']],
      ['notes.md', `Logs live under the ${NOS} folder.\n`, ['port.run-nosync']],
      ['tools/e.py', `D = "/tmp/x/${NOS.toUpperCase()}/slots"\n`, ['port.run-nosync']],
      ['notes2.md', `O plano vive em ${CP} e mede.\n`, ['port.control-plane']]
    ]) {
      const from = tmp()
      library(from, 'hm-qa', { files: { [rel]: body } })
      assert.throws(
        () => portSkill('hm-qa', { from, to: tmp(), spec: shipAll('hm-qa', from), ...isolated }),
        new RegExp(`would fail the release hygiene scan — .*${rel.replace('.', '\\.')} \\(${ids[0]}\\)`),
        rel
      )
      assert.deepEqual(privateTokenIds(body), ids, rel)
    }
  })

  test('the tokens are whole words: other words and identifiers pass', () => {
    for (const text of [
      'HERMES_TUI_RESUME=1',
      'RESUMED and RESUMES',
      'resume the session',
      'my-run.nosyncs',
      'prerun.nosync'
    ]) {
      assert.deepEqual(privateTokenIds(text), [], text)
    }
    assert.deepEqual(
      PORT_PRIVATE_TOKENS.map(token => token.id),
      ['port.control-plane', 'port.run-nosync']
    )
  })

  // K140 r3: the reference table and the batch template's defaults, in the shape the source writes them.
  const CAMERA_TABLE =
    "## 10. Reference implementations\n\n| | files (under the owner's Desktop — locate first) |\n|---|---|\n| A: a page | `projects/a/web/record.js` |\n| B: another | `…/b/page/record.js` |\n\n## 11. How to run\n"
  const RECORD_SERIES =
    'const FROM = opt.from || [join(process.env.PROJECT_DIR ?? process.cwd(), "A", "B C", "pages"), join(dirname(HERE), "pagekit", "out")].find(existsSync);\n' +
    'const OUT = opt.out || join(process.env.PROJECT_DIR ?? process.cwd(), "SERIES videos " + new Date().toISOString().slice(0, 10));\n'

  test('camera-and-action: the reference table and the batch defaults name no folder of the owner (K140 r3)', () => {
    const from = tmp()
    library(from, 'camera-and-action', {
      skill: `---\nname: camera-and-action\ndescription: x\n---\n\n# C\n\nRounds in \`${'RES' + 'UME'}/CAMERA_RONDAS.md\`.\n\n${CAMERA_TABLE}`,
      files: { 'templates/record-series.mjs': RECORD_SERIES }
    })
    const result = portSkill('camera-and-action', { from, to: tmp(), ...isolated })
    const text = Object.fromEntries(result.outputs.map(out => [out.rel, out.text]))

    assert.ok(
      text['SKILL.md'].includes(
        "## 10. Reference implementations\n\nThe reference implementations are the owner's own projects and do not ship with this copy: §2–§8 carry what they teach, and `templates/` holds the tested pieces.\n\n## 11. How to run\n"
      ),
      text['SKILL.md']
    )
    assert.equal(
      text['templates/record-series.mjs'],
      'const FROM = opt.from || [process.env.PROJECT_DIR ?? process.cwd()].find(existsSync);\n' +
        'const OUT = opt.out || join(process.env.PROJECT_DIR ?? process.cwd(), "videos " + new Date().toISOString().slice(0, 10));\n'
    )
    assert.match(text['SKILL.md'], /the reference implementations are the owner's own projects and are not listed/)
    assert.match(text['SKILL.md'], /the batch template reads its pages from `--from` or `PROJECT_DIR`/)
  })

  test('camera-and-action: the rounds log is named without the control-plane folder', () => {
    const from = tmp()
    const CP = 'RES' + 'UME'
    library(from, 'camera-and-action', {
      skill: `---\nname: camera-and-action\ndescription: x\n---\n\n# C\n\nEvery verdict logged in \`${CP}/CAMERA_RONDAS.md\` (or the project's rounds log) · rounds \`pagekit/${CP}/CAMERA_RONDAS.md\`.\n\n${CAMERA_TABLE}`,
      files: { 'templates/record-series.mjs': RECORD_SERIES }
    })
    const result = portSkill('camera-and-action', { from, to: tmp(), ...isolated })
    const skill = result.outputs.find(out => out.rel === 'SKILL.md').text

    assert.ok(skill.includes('logged in `CAMERA_RONDAS.md` (or the project'), skill)
    assert.ok(skill.includes('rounds `pagekit/CAMERA_RONDAS.md`'))
    assert.deepEqual(privateTokenIds(skill), [])
  })

  test('portSkill scans the manifest it writes: a marker only the manifest carries refuses the port (m5)', () => {
    const from = tmp()
    library(from)
    // A fixture marker that matches the manifest's own source block and nothing in any ported file.
    const markers = compileMarkers({ shapes: [{ id: 'fixture.manifest-only', re: /claude-code-skills/g }], layout: [] })

    assert.throws(
      () => portSkill('hm-qa', { from, to: tmp(), markers }),
      new RegExp(`would fail the release hygiene scan — ${MANIFEST_FILE} \\(fixture\\.manifest-only\\);`)
    )
    assert.doesNotThrow(() => portSkill('hm-qa', { from, to: tmp(), markers: compileMarkers({ layout: [] }) }))
  })
})

describe("K140 r2: the owner's folder layout ships as named places, and the port scans the manifest too", () => {
  // K140 r4: a place is named by the digest of its path; the paths are found in the text it is resolved against.
  const synthetic = [...SYNTH_PLACES.ridervoice, ...SYNTH_PLACES['higgsfield-blender']]
  const placesFor = () => resolvePlaces(synthetic)

  test('every way a place is written becomes its variable: shell code, shell comment, prose, Python, /Users form', () => {
    const shell = [
      'E="$HOME/Desktop/VAULT/Agent Lark Voice/engine"; X=1   # engine: ~/Desktop/VAULT/Agent Lark Voice/engine',
      'cd ${HOME}/Desktop/clip\\ Forge && ls',
      'SRT="$HOME/Library/Mobile Documents/com~apple~CloudDocs/Desktop/VAULT/ARCHIVE/12_CLIP_LAB_APP/take_7/subtitles"'
    ].join('\n')

    assert.equal(
      rewritePlaces(shell, 'tools/x.sh', placesFor(shell)),
      [
        'E="${RIDERVOICE_DIR:?}/engine"; X=1   # engine: $RIDERVOICE_DIR/engine',
        'cd ${VIDEO_ENGINE_DIR:?} && ls',
        'SRT="${RIDERVOICE_SUBTITLES_DIR:?}"'
      ].join('\n')
    )
    const prose =
      "Root `~/Desktop/Agent Lark Voice/` · `sys.path.insert(0, os.path.expanduser('~/Desktop/clip Forge/lib'))` · /Users/pat/Desktop/VAULT/ARCHIVE/20_NOTES/take_9_pipeline"

    assert.equal(
      rewritePlaces(prose, 'SKILL.md', placesFor(prose)),
      "Root `$RIDERVOICE_DIR/` · `sys.path.insert(0, os.path.join(os.environ['VIDEO_ENGINE_DIR'], 'lib'))` · $RIDERVOICE_PIPELINE_DIR"
    )
    // A longer name that only starts like a place, or a place inside another word, is left alone.
    assert.equal(
      rewritePlaces('~/Desktop/clip Forges and ~/Desktop/VAULT/x', 'SKILL.md', placesFor(shell, prose)),
      '~/Desktop/clip Forges and ~/Desktop/VAULT/x'
    )
    // K140 r5: the rules hold an env name and a description only; the paths come from the porting machine.
    assert.ok(
      Object.values(PORT_SET).every(spec =>
        (spec.places ?? []).every(p => JSON.stringify(Object.keys(p)) === '["env","what"]')
      )
    )
    assert.deepEqual(
      resolvePlaces([place('X_DIR', 'x')], {}).map(p => p.roots),
      [[]]
    )
    assert.deepEqual(
      resolvePlaces([place('X_DIR', 'x')], { PORT_PLACE_X_DIR: '~/A b/c:/Users/u/D e: /elsewhere ' }, '/Users/u').map(
        p => p.roots
      ),
      [['~/A b/c', '~/D e']]
    )
  })

  test('a place root covers itself and what is inside it, never a folder above it', () => {
    const roots = [{ inside: '~/Desktop/VAULT/Engine' }]

    assert.equal(coveredByRoots('/Desktop/VAULT/Engine/x', roots), true)
    assert.equal(coveredByRoots('/Desktop/VAULT/Engine', roots), true)
    assert.equal(coveredByRoots('/Desktop/VAULT', roots), false)
    assert.equal(coveredByRoots('/Desktop', roots), false)
    assert.equal(
      coveredByRoots('/Desktop', ['~/Desktop/VAULT/Engine']),
      true,
      'a declared root still covers its folders'
    )
  })

  test('a place line must match in a file it names when the source has that file; an absent file asks nothing', () => {
    const from = tmp()
    // Without the batch (which carries the place lines): say.sh alone names the rule and does not have its line.
    const noBatch = Object.fromEntries(Object.entries(RIDER_FILES).filter(([rel]) => rel !== 'tools/revoice.sh'))
    library(from, 'ridervoice', {
      files: { ...noBatch, 'tools/say.sh': '#!/bin/zsh\nM=$RIDERVOICE_HOME\n' }
    })

    assert.throws(
      () => portSkill('ridervoice', { from, to: tmp(), identity: ['Pat Example'], spec: synthSpec('ridervoice') }),
      /ridervoice\/tools\/say\.sh, tools\/check\.sh, tools\/revoice\.sh: the place line .* matched nothing/
    )

    const plain = tmp()
    library(plain, 'ridervoice', {
      skill: `---\nname: ridervoice\ndescription: "Voice."\n---\n# Voice\n\n${RIDER_SKILL_BODY}`,
      files: RIDER_FILES
    })
    assert.doesNotThrow(() =>
      portSkill('ridervoice', { from: plain, to: tmp(), identity: ['Pat Example'], spec: synthSpec('ridervoice') })
    )
  })

  test('the port note names each variable and what it stands for; requires.paths names the variable', () => {
    const from = tmp()
    library(from, 'higgsfield-blender', {
      skill:
        '---\nname: higgsfield-blender\ndescription: x\n---\n\n# H\n\nEngine: `~/Desktop/clip Forge/` · `cd ~/Desktop/clip\\ Forge`\n' +
        'Launch with `~/Desktop/clip Forge/Run (Kit).command`.\n'
    })
    const result = portSkill('higgsfield-blender', { from, to: tmp(), spec: synthSpec('higgsfield-blender') })
    const skill = result.outputs.find(out => out.rel === 'SKILL.md').text

    assert.ok(skill.includes('Engine: `$VIDEO_ENGINE_DIR/` · `cd $VIDEO_ENGINE_DIR`'))
    assert.ok(skill.includes('Launch with `$VIDEO_ENGINE_DIR/<launcher>.command`.'))
    assert.ok(skill.includes('environment variables the host sets: `VIDEO_ENGINE_DIR` (the video engine folder)'))
    assert.ok(skill.includes('`$VIDEO_ENGINE_DIR`.'), 'the Needs list')
    assert.deepEqual(result.manifest.requires.paths, ['/Applications/Blender.app', '$VIDEO_ENGINE_DIR'])
    assert.equal(result.manifest.scrub.places, 3)
    assert.ok(!/Desktop\/clip/.test(result.outputs.map(out => out.text).join('\n') + JSON.stringify(result.manifest)))
  })

  test('portHygiene scans the manifest as well as every file (a marker only the manifest carries is refused)', () => {
    const clean = [{ rel: 'SKILL.md', text: '# ok\n' }]

    assert.deepEqual(portHygiene(clean, { requires: { paths: [] } }), [])
    assert.deepEqual(portHygiene(clean, { requires: { paths: ['~/RESUME/run.nosync/x'] } }), [
      `${MANIFEST_FILE} (lab.run-nosync)`,
      `${MANIFEST_FILE} (port.control-plane)`,
      `${MANIFEST_FILE} (port.run-nosync)`
    ])

    // The owner's layout (read from the scanning machine; here a fake home) is refused in a file and in the manifest.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'k140-home-'))
    fs.mkdirSync(path.join(home, 'Desktop', 'STUDIO'), { recursive: true })
    const markers = compileMarkers({ layout: machineLayoutShapes({ home }) })

    assert.deepEqual(
      portHygiene(
        [{ rel: 'tools/a.sh', text: 'E="$HOME/Desktop/STUDIO/engine"\n' }],
        { requires: { paths: ['~/Desktop/STUDIO'] } },
        markers
      ),
      ['tools/a.sh (owner.layout)', `${MANIFEST_FILE} (owner.layout)`]
    )
  })

  test('the committed tree carries no control-plane, lab or 3D-project token in any file of any ported skill', () => {
    for (const name of PORT_NAMES) {
      const dir = path.join(DEFAULT_BUNDLE, name)

      for (const rel of listSkillFiles(dir)) {
        assert.deepEqual(privateTokenIds(fs.readFileSync(path.join(dir, rel), 'utf8')), [], `${name}/${rel}`)
      }
    }
  })

  test('the committed tree names no folder of the owner layout in any shipped skill (ridervoice, videoediting, higgsfield-blender)', () => {
    for (const name of ['ridervoice', 'videoediting', 'higgsfield-blender', 'app-atualisation']) {
      const dir = path.join(DEFAULT_BUNDLE, name)
      const text = listSkillFiles(dir)
        .map(rel => fs.readFileSync(path.join(dir, rel), 'utf8'))
        .join('\n')

      assert.ok(!/(?:~|\$HOME|\$\{HOME\})\/(?:Desktop|Developer)\/[A-Za-z]/.test(text), name)
      assert.ok(!/Mobile Documents/.test(text), name)
    }
  })
})

describe("K140 r3: the owner's layout names, at any depth and in any spelling, never ship", () => {
  // Fixture layout names (never the owner's): an ordinal project folder, a delivery folder, a two-word folder.
  const NAMES = ['001 - QUARTZ HARBOR', 'ready_9', 'Lab Notes']
  const re = layoutNameRegex(NAMES)

  test('the port tokens are refused in every spelling the critic tried (m4): URL-encoded, any case, zero-width, concatenated', () => {
    const NOS = 'run' + '.nosync'
    for (const [text, ids] of [
      ['url = "file:///x/run%2Enosync/a"', ['port.run-nosync']],
      [`p = join(root, "x", "${NOS.toUpperCase()}")`, ['port.run-nosync']],
      ['see the run\u200b.nosync folder', ['port.run-nosync']],
      ['(Run.Nosync)', ['port.run-nosync']],
      ['RES\u200bUME/x', ['port.control-plane']],
      ['RES\u00adUME/engine', ['port.control-plane']],
      ['p = "RES" + "UME/x"', ['port.control-plane']],
      ['p = "run" +\n  ".nosync"', ['port.run-nosync']]
    ]) {
      assert.deepEqual(privateTokenIds(text), ids, text)
    }
  })

  test('layoutAlias keeps the case, the joiner and the ordinal of what it replaces', () => {
    assert.deepEqual(LAYOUT_ALIAS, ['sample', 'project'])
    for (const [match, alias] of [
      ['001 - QUARTZ HARBOR', '001 - SAMPLE PROJECT'],
      ['QUARTZ HARBOR', 'SAMPLE PROJECT'],
      ['Quartz Harbor', 'Sample Project'],
      ['quartz-harbor', 'sample-project'],
      ['QuartzHarbor', 'SampleProject'],
      ['ready_9', 'sample_project'],
      ['READY_9', 'SAMPLE_PROJECT'],
      ['lab.notes', 'sample.project']
    ]) {
      assert.equal(layoutAlias(match), alias, match)
    }
  })

  test('aliasLayoutNames replaces every spelling, bare segments and join() arguments; other words stay', () => {
    let hits = 0
    const text = [
      'root: x/y/001 - QUARTZ HARBOR/ENGINES/quartz-harbor/web',
      'Proven on Quartz Harbor (2026); tokens for QuartzHarbor_{scene}',
      'join(PROJECT_DIR, "VAULT", "Lab Notes", "x"), ~/Movies/ready_9_work/voice',
      'not: ready_90, xready_9, ready9, Lab Notesy, harbor'
    ].join('\n')

    assert.equal(
      aliasLayoutNames(text, re, () => hits++),
      [
        'root: x/y/001 - SAMPLE PROJECT/ENGINES/sample-project/web',
        'Proven on Sample Project (2026); tokens for SampleProject_{scene}',
        'join(PROJECT_DIR, "VAULT", "Sample Project", "x"), ~/Movies/sample_project_work/voice',
        'not: ready_90, xready_9, ready9, Lab Notesy, harbor'
      ].join('\n')
    )
    assert.equal(hits, 6)
    assert.equal(aliasLayoutNames(text, null), text)
  })

  test('foldDesktopRoots folds a Desktop folder that opens a path into the placeholder, nowhere else', () => {
    let hits = 0
    const out = foldDesktopRoots(
      '→ `<your project folder>/HOME/` · pipeline `HOME/MEDIA/x` · ("HOME/a") · $HOME/x · MY_HOME/x · HOMEX/y',
      ['HOME'],
      () => hits++
    )

    assert.equal(
      out,
      '→ `<your project folder>/` · pipeline `<your project folder>/MEDIA/x` · ("<your project folder>/a") · $HOME/x · MY_HOME/x · HOMEX/y'
    )
    assert.equal(hits, 3)
    assert.equal(foldDesktopRoots('`HOME/x`', []), '`HOME/x`')
  })

  test('a port renames a file named after a layout folder, aliases its text, counts it and says so in the port note', () => {
    const from = tmp()
    library(from, 'hm-qa', {
      files: {
        'examples/quartz-harbor.md': '# Quartz Harbor\n\nRoot: `<x>/001 - QUARTZ HARBOR`; pages in `HOME/ready_9/`.\n'
      }
    })
    const options = { to: tmp(), layoutNames: NAMES, desktopFolders: ['VAULT', 'ready_9'], privateNames: null }
    const result = portSkill('hm-qa', { from, ...options, spec: shipAll('hm-qa', from) })
    const text = Object.fromEntries(result.outputs.map(out => [out.rel, out.text]))

    assert.ok(!('examples/quartz-harbor.md' in text))
    // K140 r4: the numbered folder in a path is the owner's folder (R4-1): the path becomes the placeholder.
    assert.equal(
      text['examples/sample-project.md'],
      '# Sample Project\n\nRoot: `<x>/001 - SAMPLE PROJECT`; pages in `<your project folder>/`.\n'
    )
    assert.equal(result.counts.layoutNames, 3)
    assert.equal(result.counts.ownerPaths, 1)

    // A name split across a string concatenation is still the name: the port cannot rewrite it in place, and the
    // release's skill-text policy (folded) refuses it, so the port refuses the skill (it used to leave it for the scan).
    const split = tmp()
    library(split, 'hm-qa', {
      files: { 'tools/rec.mjs': 'const FROM = join(process.env.PROJECT_DIR, "Lab" + " Notes", "pages")\n' }
    })
    assert.throws(
      () => portSkill('hm-qa', { from: split, ...options, spec: shipAll('hm-qa', split) }),
      /tools\/rec\.mjs \(skill\.path\)/
    )
    assert.match(
      text['SKILL.md'],
      /the owner's own folder and project names are written `sample project` \(in the case and joiner they had\)/
    )
  })

  test('r5e X1: a series of the owner becomes a neutral example name in its own case and joiner; a delivery folder goes', () => {
    const sha = text => createHash('sha256').update(text).digest('hex')
    // Synthetic names (never the owner's).
    const owner = { series: new Set([sha('lark harbor'), sha('kilnhouse')]), delivery: new Set([sha('drop')]) }

    assert.deepEqual(SERIES_ALIAS, { one: ['showcase'], more: ['example', 'series'] })
    for (const [text, out] of [
      ['the Lark Harbor recorder', 'the Example Series recorder'],
      ['LARK HARBOR', 'EXAMPLE SERIES'],
      ['the lark harbor series', 'the example series'],
      ['the Lark Harbor series pages', 'the Example series pages'],
      ['const KEY = "lark-harbor.camera.v1"', 'const KEY = "example-series.camera.v1"'],
      ['db lark_harbor_rec', 'db example_series_rec'],
      ['LarkHarbor', 'ExampleSeries'],
      ['(Kilnhouse, 2026-01-02) in the Kilnhouse', '(Showcase, 2026-01-02) in the Showcase'],
      ['work on a / drop_4-10 / b deliverables', 'work on a / b deliverables'],
      ['drop_3 / a', 'a'],
      ['copied into drop_3 first', 'copied into a delivery folder first'],
      // r5f m6: two identical neighbours left once the delivery item between them goes become one.
      ['on a / drop_4 / a / b deliverables', 'on a / b deliverables'],
      // r5f: a slash or an ampersand between the words reads as a space.
      ['no LARK/HARBOR pages', 'no EXAMPLE SERIES pages']
    ]) {
      assert.equal(neutraliseOwnerSeries(text, owner), out, text)
    }
    assert.equal(neutraliseOwnerSeries('Lark Harbor drop_3', null), 'Lark Harbor drop_3')
    // r5f m2: in shell code a delivery folder becomes a placeholder variable (the command stays valid); in other code
    // a plain path segment.
    assert.equal(
      neutraliseOwnerSeries('cd drop_3 && ls\n', owner, () => {}, 'tools/go.sh'),
      'cd "${DELIVERY_DIR}" && ls\n'
    )
    assert.equal(
      neutraliseOwnerSeries('open("drop_3/out")', owner, () => {}, 'tools/go.py'),
      'open("delivery-folder/out")'
    )
    // An identity name is left to the scrub (and refused by the gate if it survived), never rewritten here.
    const withIdentity = { ...owner, identity: new Set([sha('corvina example')]) }

    assert.equal(neutraliseOwnerSeries('by Corvina Example', withIdentity), 'by Corvina Example')
  })

  test('r5e X1: a delivery record leaves its clause; the sentence stays', () => {
    let hits = 0
    const drop = text => dropDeliveryRecords(text, () => hits++)

    assert.equal(
      drop('compare bytes — 9 of 9 identical for the set), and keep backups'),
      'compare bytes), and keep backups'
    )
    assert.equal(drop('distilled from A, B and its 4 videos.'), 'distilled from A, B.')
    assert.equal(
      drop('(the tested tool, 2026-01-02: 5 videos, 12 min of film, 1.5 GB,\n59 fps kept). Tools: x'),
      '(the tested tool). Tools: x'
    )
    assert.equal(
      drop('"12 of 12 · 1920 × 1080 · 60 fps exact · 33 min · 6.4 GB · in <folder>"'),
      '"N of N · 1920 × 1080 · 60 fps exact · <minutes> · <size> · in <folder>"'
    )
    assert.equal(hits, 5)
    assert.equal(drop('one of the identical frames; its videos'), 'one of the identical frames; its videos')
  })

  test('r5e X1: a port with the owner names ships none of them and no delivery record', () => {
    const sha = text => createHash('sha256').update(text).digest('hex')
    const owner = { series: new Set([sha('lark harbor')]), delivery: new Set([sha('drop')]) }
    const from = tmp()

    library(from, 'hm-qa', {
      skill:
        '---\nname: hm-qa\ndescription: x\n---\n\n# Q\n\nTested on the Lark Harbor (9 of 9 identical, then kept).\nWork on a / drop_2 / b.\nThe tool and its 4 videos.\n'
    })
    const result = portSkill('hm-qa', { from, to: tmp(), ...isolated, ownerNames: owner, spec: shipAll('hm-qa', from) })
    const text = result.outputs.find(out => out.rel === 'SKILL.md').text

    assert.ok(text.includes('Tested on the Example Series (then kept).'), text)
    assert.ok(text.includes('Work on a / b.'))
    assert.ok(text.includes('The tool.'))
    assert.ok(!/lark|drop_2|identical|4 videos/i.test(text))

    // A record the port cannot cut cleanly (mid-sentence) is refused, never shipped.
    const stuck = tmp()

    library(stuck, 'hm-qa', {
      skill: '---\nname: hm-qa\ndescription: x\n---\n\n# Q\n\nWe saw 9 of 9 identical here.\n'
    })
    assert.throws(
      () =>
        portSkill('hm-qa', { from: stuck, to: tmp(), ...isolated, ownerNames: owner, spec: shipAll('hm-qa', stuck) }),
      /SKILL\.md \(skill\.delivery-record\)/
    )
  })

  test('r5f X2: the port and its check fail closed without the owner identity setting', () => {
    const from = tmp()
    const to = tmp()

    library(from, 'hm-qa')
    const saved = process.env.PORT_IDENTITY

    delete process.env.PORT_IDENTITY
    try {
      for (const argv of [
        ['--from', from, '--to', to, '--only', 'hm-qa'],
        ['--from', from, '--to', to, '--only', 'hm-qa', '--check']
      ]) {
        assert.equal(
          silently(() => main(argv)),
          2
        )
      }
      assert.equal(fs.existsSync(path.join(to, 'hm-qa')), false, 'nothing written')
      assert.equal(
        silently(() => main([...['--from', from, '--to', to, '--only', 'hm-qa'], '--identity', 'Corvina Example'])),
        0
      )
    } finally {
      process.env.PORT_IDENTITY = saved
    }
  })

  test('K140 r5: a coined name of the machine is aliased where the policy reads a path, and only there', () => {
    // Synthetic coined word (never a name of the owner's): a folder segment, a join() argument, and prose.
    const from = tmp()
    library(from, 'hm-qa', {
      skill:
        '---\nname: hm-qa\ndescription: x\n---\n\n# Q\n\nPages live in `<project>/quillmux/out/`.\nquillmux is a word here.\n',
      files: { 'tools/rec.mjs': 'const OUT = join(ROOT, "quillmux", "out")\n' }
    })
    const options = { to: tmp(), privateNames: null, coinedNames: new Set(['quillmux']) }
    const result = portSkill('hm-qa', { from, ...options, spec: shipAll('hm-qa', from) })
    const text = Object.fromEntries(result.outputs.map(out => [out.rel, out.text]))

    assert.ok(!text['SKILL.md'].includes('/quillmux/'), 'a path segment is aliased')
    assert.ok(text['SKILL.md'].includes('quillmux is a word here.'), 'prose keeps the word')
    assert.ok(!text['tools/rec.mjs'].includes('"quillmux"'), 'a join() argument is aliased')
    assert.ok(result.counts.privateNames >= 2)
  })

  test('portHygiene refuses a layout name in a file, in a file NAME, split by a concatenation or a zero-width space', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'k140r3-home-'))
    const checkout = path.join(home, 'Desktop', 'WORK', 'Quartz', '000 - Main Line', 'app')
    for (const dir of [checkout, path.join(home, 'Desktop', 'WORK', 'Quartz', '001 - QUARTZ HARBOR')]) {
      fs.mkdirSync(dir, { recursive: true })
    }
    const markers = compileMarkers({ layout: machineLayoutShapes({ home, checkouts: [checkout] }) })
    const manifest = { requires: { paths: [] } }

    for (const [out, id] of [
      [{ rel: 'a.md', text: 'see Quartz Harbor\n' }, 'a.md (owner.layout)'],
      [{ rel: 'examples/quartz-harbor.md', text: 'ok\n' }, 'examples/quartz-harbor.md (owner.layout)'],
      [{ rel: 'b.mjs', text: 'join(ROOT, "Quartz" + " Harbor")\n' }, 'b.mjs (owner.layout)'],
      [{ rel: 'c.md', text: 'Quartz\u200b Harbor\n' }, 'c.md (owner.layout)'],
      [{ rel: 'd.md', text: 'the 000 - Main Line folder\n' }, 'd.md (owner.layout)'],
      [{ rel: 'e.md', text: 'p = ~/Desktop/WORK/x\n' }, 'e.md (owner.layout)']
    ]) {
      assert.deepEqual(portHygiene([out], manifest, markers), [id], out.rel)
    }
    assert.deepEqual(portHygiene([{ rel: 'f.md', text: 'Quartz, a harbor, WORK and work\n' }], manifest, markers), [])
  })

  test('the committed tree carries no layout name of THIS machine in any file, file name or manifest (any spelling)', () => {
    const names = machineLayoutNames()
    const layout = layoutNameRegex(names, { prefixed: machineLayoutChildren() })
    const found = []

    for (const name of PORT_NAMES) {
      const dir = path.join(DEFAULT_BUNDLE, name)

      for (const rel of [...listSkillFiles(dir), MANIFEST_FILE]) {
        const raw = fs.readFileSync(path.join(dir, rel), 'utf8')
        const views = [rel, raw, decodeEscapes(raw), foldSplits(decodeEscapes(raw))]

        if (layout && views.some(view => new RegExp(layout.source, layout.flags).test(view))) {
          found.push(`${name}/${rel}`)
        }
      }
    }

    // Counts and files only: a layout name never reaches a test log.
    assert.deepEqual(found, [], `${found.length} file(s) carry a layout name of this machine`)
  })
})
