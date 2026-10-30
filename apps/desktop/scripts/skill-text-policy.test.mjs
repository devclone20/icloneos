// V3-R2 r4 — the skill-text policy (R4-1 path-shaped strings deny by default, R4-2 the scanning machine's private
// names), the release scan of a shipped skill tree and the port's rewrites. Every name here is synthetic: the real
// layout is read from the machine by the committed-tree tests at the end, which print counts only.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, test } from 'vitest'

import { SHAPES } from './artifact-hygiene-markers.mjs'
import { compileMarkers, isSkillTree, scanTree } from './artifact-hygiene.mjs'
import { FOLDERS } from './make-distribution.mjs'
import { DEFAULT_BUNDLE, PORT_SET, portSkill, privateTokenIds, rewriteOwnerPaths } from './port-owner-skills.mjs'
import {
  ALIAS_WORDS,
  foldText,
  GENERIC_SEGMENTS,
  HOME_LAYOUT_FOLDERS,
  isPrivateNameShape,
  machineCoinedNames,
  machinePrivateNames,
  NAME_DEPTH,
  NAME_HOME_FOLDERS,
  nameRoots,
  nameWords,
  pathRefusals,
  PORT_PLACEHOLDERS,
  privateNameSpans,
  productNames,
  PUBLIC_NAMES,
  scanSkillTree,
  segmentRefusal,
  skillTextRefusals,
  STANDARD_ENV,
  textOf
} from './skill-text-policy.mjs'
import { nameRows } from './private-markers.mjs'
import { DELIVERY_RECORD_RES, ownerNameSpans, skillRuleId } from './skill-text-policy.mjs'

// Ruling 48: a test never reads the owner's private markers file, whatever the shell exports.
delete process.env.ICLONE_PRIVATE_MARKERS

const key = name => nameWords(name).join(' ')

/**
 * A fake home shaped like the critic's r3 findings (synthetic names): a numbered media folder with a delivery folder
 * and its subtitles (D1), a numbered notes folder beside it (D2) holding two pipeline folders (D3, D4), a work folder
 * under Movies (D5), a folder inside a numbered project (D6), the engine's own folder (label 1), the control plane's
 * plan document (label 2), the delivery folder used as a series name (label 3 = D1's `take_7`). The checkout sits in a
 * numbered project folder; the control plane is its sibling.
 */
function fakeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'r4-home-'))
  const checkout = path.join(home, 'Desktop', 'VAULT', 'Studio', '000 - Main Line', 'app')

  for (const dir of [
    'Desktop/VAULT/ARCHIVE/12_CLIP_LAB_APP/take_7/subtitles',
    'Desktop/VAULT/ARCHIVE/20_NOTES/take_9_pipeline/v2',
    'Desktop/VAULT/ARCHIVE/20_NOTES/take_7_pipeline/text',
    'Desktop/VAULT/Studio/001 - QUARTZ/Quartz Harbor',
    'Desktop/VAULT/Studio/000 - Main Line/app/src',
    'Desktop/VAULT/Studio/000 - Main Line/CONTROL/run',
    'Desktop/clip Forgix/engine',
    'Desktop/the-crew',
    'Movies/take_7_work/wavs',
    'Documents/Lark Notes',
    'Developer/zq-tools/node_modules/left-pad-x',
    'Desktop/.hidden-take_5'
  ]) {
    fs.mkdirSync(path.join(home, dir), { recursive: true })
  }

  fs.writeFileSync(path.join(home, 'Desktop/VAULT/Studio/000 - Main Line/CONTROL/PLAN_Q.md'), '# plan\n')
  fs.writeFileSync(path.join(home, 'Desktop/VAULT/ARCHIVE/20_NOTES/take_9_pipeline/v2/build_take.py'), '')
  fs.writeFileSync(path.join(home, 'Desktop/VAULT/ARCHIVE/20_NOTES/Lark Take 2.mp4'), '')

  return { home, checkouts: [checkout], product: new Set(['app', 'src', 'electron']) }
}

/** The keys the fake machine yields (the policy reads the folders now; nothing is stored). */
const fakeKeys = (options = {}) => machinePrivateNames({ ...fakeHome(), ...options })

describe('R4-1: path-shaped strings are refused unless every segment is generic (deny by default)', () => {
  const ctx = { self: new Set(['references', 'pipeline.md', 'tools']), product: new Set(['iclone-x402']) }
  const refused = (text, rel = 'SKILL.md', extra = {}) =>
    pathRefusals(foldText(text), rel, { ...ctx, ...extra }).map(hit => hit.rule)

  test('generic: placeholders, numbers, the tree own names, plain words, identifiers of plain words, product names', () => {
    for (const text of [
      '`<your project folder>/assets/output/`',
      '`{skill_dir}/references/pipeline.md`',
      '`$HOME/.config/x` and `${TMPDIR:-/tmp}/out.mp4`',
      '`/usr/local/bin/ffmpeg` · `/etc/ssh/sshd_config.d/00-hardening.conf`',
      '`v2/1.0.3/out.json` · `MEDIA/REVIEW/clips/`',
      '`site-packages/lark_batches/batch_<k>.json` · `CONTROL/run/state.json`',
      '`~/Movies/<series>/` · `~/Desktop/<name>-agent`',
      '`electron/iclone-x402/skill-defaults.ts`',
      '`Sample Project/assets/` · `<your project folder>/sample_project_work/voice`',
      'and/or, PASS/FAIL, input/output in prose',
      'https://example.com/a/take_7/b and github.com/org/take_7',
      'W=~/.cache/x; ls "$W/logs/out.log"'
    ]) {
      assert.deepEqual(refused(text), [], text)
    }
  })

  test('refused: numbered folders, titles, brand-like names, the owner folder under a home folder, unknown names', () => {
    for (const [text, rule] of [
      ['`12_CLIP_LAB_APP/take_7/subtitles/<nome>.srt`', 'path.numbered'], // D1
      ['`<your project folder>/ARCHIVE/20_NOTES/x.md`', 'path.numbered'], // D2
      ['`20_NOTES/take_9_pipeline/v2/build_take.py`', 'path.numbered'], // D3
      ['`take_7_pipeline/text/cues_<key>.json`', 'path.numbered'], // D4
      ['`~/Movies/take_7_work/wavs/<key>.wav`', 'path.layout'], // D5
      ['`<your project folder>/Quartz Harbor/`', 'path.label'], // D6
      ['`~/Movies/lark_work/x`', 'path.layout'],
      ['Launch `$ENGINE_DIR/clipForge/run.command`', 'path.brand'],
      ['`$TAKE_7_DIR/x.md`', 'path.variable'],
      ['"$HOME/Desktop/VAULT/Agent Lark Voice/engine"', 'path.layout'],
      ['C:\\Users\\pat\\Desktop\\Lark_9', 'path.layout'],
      ['file:///x/take_7/a.md', 'path.numbered'],
      ['see `verdicts9/<F>.json`', 'path.numbered']
    ]) {
      assert.deepEqual(refused(text).slice(0, 1), [rule], text)
    }
  })

  test('the round-3 critic spellings are folded first: full width, a name split across join() arguments (and the rest)', () => {
    for (const text of [
      '`ｔａｋｅ＿７／subtitles／a.srt`', // spelling 1: full width
      'p = join(ROOT, "12_CLIP", "LAB_APP", "x")', // spelling 2: split across two join() arguments
      'p = os.path.join(ROOT, "take_7", "x")',
      'p = ROOT / "take_7" / "x"',
      'p = "take" + "_7/x.md"',
      '`take\u200b_7/x.md`',
      '`take\u00ad_7/x.md`',
      'p = "take%5F7%2Fx.md"',
      'p = "take\\u005f7/x.md"',
      'p = "take&#95;7&sol;x.md"',
      "dofile(os.getenv('HOME') .. '/Movies/take_7_work/a.lua')",
      '`take_7\u2215x.md`'
    ]) {
      assert.ok(refused(text, 'tools/x.mjs').length > 0, text)
    }
  })

  test('a declared interface root (a dot folder in requires.paths) is the requirement own: what is inside it passes', () => {
    const declared = { roots: ['~/.tool/model'], declared: new Set(['.tool', 'model']) }

    assert.deepEqual(refused('`~/.tool/model/take_7_ck9.bin`', 'SKILL.md', declared), [])
    assert.deepEqual(refused('M=~/.tool\ncp "$M/model/take_7_ck9.bin" .', 'tools/x.sh', declared), [])
    assert.deepEqual(refused('`~/.other/take_7/x`', 'SKILL.md', declared), ['path.numbered'])
  })

  test('the committed lists are what the policy allows, frozen: widening one is a reviewed change', () => {
    for (const list of [GENERIC_SEGMENTS, PORT_PLACEHOLDERS, STANDARD_ENV, ALIAS_WORDS, HOME_LAYOUT_FOLDERS]) {
      assert.ok(Object.isFrozen(list))
    }
    // K140 r5: no digest is committed; the sizes pin the lists (a widened list is a reviewed change to this line).
    assert.deepEqual(
      [GENERIC_SEGMENTS, PORT_PLACEHOLDERS, STANDARD_ENV, ALIAS_WORDS, HOME_LAYOUT_FOLDERS].map(list => list.length),
      [89, 5, 20, 2, 8]
    )
    // A placeholder is a declared form, never any name in angle brackets' clothing.
    assert.equal(segmentRefusal('$TAKE_7_DIR', {}), 'path.variable')
    assert.equal(segmentRefusal('$TAKE_DIR', { env: new Set(['TAKE_DIR']) }), null)
    assert.equal(segmentRefusal('clipT', {}), 'path.brand')
    assert.equal(segmentRefusal('take_7', {}), 'path.numbered')
    assert.equal(segmentRefusal('LARK', {}, { strict: true }), 'path.layout')
  })
})

describe('the port: owner paths become the placeholder, labels a generic name, the rest is refused', () => {
  const ctx = { self: new Set(), product: new Set() }

  test('a refused path that means the owner folder becomes the placeholder (prose and shell); a file name <name>', () => {
    let hits = 0
    const md = rewriteOwnerPaths(
      [
        'Subtitles: `12_CLIP_LAB_APP/take_7/subtitles/<nome>.srt`.\n',
        'Pipeline: `<your project folder>/ARCHIVE/20_NOTES/x.md`.\n',
        'Run `20_NOTES/take_9_pipeline/v2/build_take.py`.\n',
        'Cues in `take_7_pipeline/text/cues_<key>.json`.\n',
        'Work in `~/Movies/take_7_work/wavs/<key>.wav`.\n',
        'Assets in `<your project folder>/Quartz Harbor/`.\n'
      ].join(''),
      'references/x.md',
      ctx,
      () => hits++
    )

    assert.equal(
      md,
      [
        'Subtitles: `<your project folder>/subtitles/<nome>.srt`.',
        'Pipeline: `<your project folder>/x.md`.',
        'Run `<your project folder>/v2/build_take.py`.',
        'Cues in `<your project folder>/text/cues_<key>.json`.',
        'Work in `<your project folder>/wavs/<key>.wav`.',
        'Assets in `<your project folder>/`.',
        ''
      ].join('\n')
    )
    assert.equal(hits, 6)
    assert.equal(
      rewriteOwnerPaths('W=~/Movies/take_7_work/revoice; mkdir -p "$W"\n', 'tools/x.sh', ctx),
      'W=${PROJECT_DIR:?}/revoice; mkdir -p "$W"\n'
    )
    assert.equal(rewriteOwnerPaths('`model/rider_take_7.bin`\n', 'SKILL.md', ctx), '`model/<name>.bin`\n')
  })

  test('a refused path that is not the owner folder refuses the port: a system folder, a named place, code', () => {
    for (const [text, rel] of [
      ['Copy to `/opt/take_7/x`.\n', 'SKILL.md'],
      ['Run `$ENGINE_DIR/clipForge/run.command`.\n', 'SKILL.md'],
      ["p = '~/Movies/take_7_work/a'\n", 'tools/x.py']
    ]) {
      assert.throws(() => rewriteOwnerPaths(text, rel, ctx), /a path the release would refuse/, text)
    }
  })

  test('K140 r5: nothing derived from a private name is committed: no digest table in the port, the policy or their tests', () => {
    // A label of the owner's (a hash of a short name is the name once the repo is public) is never stored: the port
    // reads the private names from the machine at port time; the places come from the porting machine's environment.
    for (const file of [
      'port-owner-skills.mjs',
      'skill-text-policy.mjs',
      'port-owner-skills.test.mjs',
      'skill-text-policy.test.mjs'
    ]) {
      const text = fs.readFileSync(path.join(import.meta.dirname, file), 'utf8')

      assert.deepEqual(text.match(/(?<![0-9a-zA-Z])[0-9a-f]{32,}(?![0-9a-zA-Z])/g) ?? [], [], file)
    }
    assert.ok(Object.values(PORT_SET).every(spec => !('labels' in spec)))
  })
})

describe("R4-2: the scanning machine's private names, read at scan time to depth 4", () => {
  test('the roots: the home folders, every ancestor of the checkout below the home, the checkout', () => {
    const { home, checkouts } = fakeHome()
    const roots = nameRoots({ home, checkouts }).map(root => path.relative(home, root))

    assert.deepEqual(NAME_HOME_FOLDERS, ['Desktop', 'Movies', 'Developer', 'Documents'])
    assert.equal(NAME_DEPTH, 4)
    for (const root of [
      'Desktop',
      'Movies',
      'Documents',
      'Developer',
      'Desktop/VAULT',
      'Desktop/VAULT/Studio/000 - Main Line'
    ]) {
      assert.ok(roots.includes(root), root)
    }
  })

  test('the names: every private-shaped folder and document to depth 4, the D1–D6 and label shapes included', () => {
    const keys = fakeKeys()

    for (const name of [
      '12_CLIP_LAB_APP', // D1 (depth 2 under the project folder, 3 under the Desktop)
      'take_7', // label 3 (depth 3 / 4)
      '20_NOTES', // D2
      'take_9_pipeline', // D3 (depth 3 / 4)
      'take_7_pipeline', // D4
      'take_7_work', // D5 (Movies)
      'Quartz Harbor', // D6 (depth 4 under the Desktop)
      'clip Forgix', // label 1
      'PLAN_Q', // label 2 (a document of the control plane)
      'Lark Notes',
      'Lark Take 2',
      'the-crew' // K140 r5: an identifier of words is a name too
    ]) {
      assert.ok(keys.has(key(name)), name)
    }
    for (const name of ['VAULT', 'ARCHIVE', 'subtitles', 'text', 'v2', 'engine', 'build_take', 'left-pad-x']) {
      assert.ok(!keys.has(key(name)), name)
    }
    assert.equal(keys.get(key('PLAN_Q')), 'named')
    // The numbered media folder's name after its ordinal is the series' short label (`LARK/HARBOR`-style): read too. Its
    // words are dictionary words, so it counts as an identifier, glued or written as a name, never as words in prose.
    assert.equal(keys.get(key('CLIP_LAB_APP')), 'named')
    assert.equal(privateNameSpans('the clip-lab-app delivery', keys).length, 1)
    assert.equal(privateNameSpans('the Clip Lab App delivery', keys).length, 1)
    assert.equal(privateNameSpans('cliplabapp', keys).length, 1)
    assert.equal(privateNameSpans('a clip lab app', keys).length, 0)
    assert.equal(keys.get(key('clip Forgix')), 'any')
    // The product's own tracked names and the public list are never private.
    assert.ok(!fakeKeys({ product: new Set(['app', 'src', 'Quartz Harbor']) }).has(key('Quartz Harbor')))
    assert.ok(PUBLIC_NAMES.every(name => !keys.has(key(name))))
  })

  test('the shape: two words or more however joined, numbered or CamelCase are private; one common word is not', () => {
    for (const name of [
      'Lark Notes',
      'take_7',
      '001 - X Y',
      'clipForge',
      'clip Forgix',
      'PLAN_Q',
      'ready-9b',
      'lark_batches',
      'lark-guide'
    ]) {
      assert.equal(isPrivateNameShape(name), true, name)
    }
    for (const name of ['MEDIA', 'docs', 'iclone os', 'v1.2.3', 'app 2', 'abc']) {
      assert.equal(isPrivateNameShape(name), false, name)
    }
  })

  test('a private name is found in any case, width, diacritic, joiner, split or path; an identifier only as one', () => {
    const keys = fakeKeys()
    const count = text => Math.max(...[text, foldText(text)].map(view => privateNameSpans(view, keys).length))

    for (const text of [
      'the take_7 series',
      'TAKE-7 and Take 7',
      'ｔａｋｅ＿７', // full width
      'take\u200b_7',
      'join("12_CLIP", "LAB_APP")', // split across join() arguments
      '"Quartz" + " Harbor"',
      'QuartzHarbor_{scene}',
      'Quartz%20Harbor',
      'Quártz Hárbor', // diacritics
      'with clip Forgix (ours)',
      'CONTROL/PLAN_Q.md',
      '~/Movies/take_7_work/a',
      'Lark\\ Notes/x'
    ]) {
      assert.ok(count(text) > 0, text)
    }
    for (const text of [
      'plan q is the plan',
      'take 70',
      'mistake_7',
      'Quartz alone',
      'the crew',
      'deadbeef0123456789'
    ]) {
      assert.equal(count(text), 0, text)
    }
  })

  test('depth: a numbered folder three and four levels down, beside no checkout, is read', () => {
    const shallow = machinePrivateNames({ ...fakeHome(), depth: 2 })
    const deep = fakeKeys()

    assert.ok(deep.has(key('take_9_pipeline')) && deep.has(key('take_7')))
    assert.ok(!shallow.has(key('take_9_pipeline')) && !shallow.has(key('take_7')))
  })
})

/** The fixture skill's rules with its reference files on the ship list (K140 r5: nothing ships unlisted). */
const FIXTURE_SPEC = { ...PORT_SET['hm-qa'], ship: ['SKILL.md', 'references/a.md', 'references/b.mjs'] }

/** A shipped skill tree (synthetic) carrying one fixture per finding, each in its own file. */
const FINDINGS = {
  D1: 'Subtitles: `12_CLIP_LAB_APP/take_7/subtitles/<nome>.srt`.\n',
  D2: 'Pipeline: `<your project folder>/ARCHIVE/20_NOTES/x.md`.\n',
  D3: 'Run `20_NOTES/take_9_pipeline/v2/build_take.py`.\n',
  D4: 'Cues in `take_7_pipeline/text/cues_<key>.json`.\n',
  D5: 'Work in `~/Movies/take_7_work/wavs/<key>.wav`.\n',
  D6: 'Assets in `<your project folder>/Quartz Harbor/`.\n',
  L1: 'Block it with clip Forgix (ours).\n',
  L2: 'Write the plan to `CONTROL/PLAN_Q.md`.\n',
  L3: 'The take_7 series (8 videos).\n',
  S1: 'Subtitles in `ｔａｋｅ＿７／subtitles／`.\n',
  S2: 'p = join(ROOT, "12_CLIP", "LAB_APP", "pages")\n'
}

function skillTree(name = 'hermes-skill') {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'r4-tree-')), name)

  for (const [id, text] of Object.entries(FINDINGS)) {
    fs.mkdirSync(path.join(root, 'demo', 'references'), { recursive: true })
    fs.writeFileSync(path.join(root, 'demo', 'references', `${id.toLowerCase()}.${id === 'S2' ? 'mjs' : 'md'}`), text)
  }

  fs.writeFileSync(path.join(root, 'demo', 'SKILL.md'), '# Demo\n\nRead `references/d1.md`.\n')

  return root
}

describe('R4-3: the round-3 critic findings (D1–D6, three labels, two spellings) are refused, as permanent fixtures', () => {
  test('the release scan of a skill tree refuses every one of them (ids only, never a value)', () => {
    const keys = fakeKeys()
    const hits = scanSkillTree(skillTree(), { keys })
    const byFile = Object.fromEntries(Object.keys(FINDINGS).map(id => [id, new Set()]))

    for (const hit of hits) {
      const id = path.basename(hit.file).replace(/\..*$/, '').toUpperCase()

      byFile[id]?.add(hit.id)
    }

    for (const [id, ids] of Object.entries(byFile)) {
      assert.ok(ids.size > 0, `${id} is refused`)
    }
    assert.ok(byFile.D5.has('skill.path') && byFile.D5.has('skill.private-name'))
    assert.deepEqual([...byFile.L1], ['skill.private-name'])
    assert.ok(!hits.some(hit => hit.file === 'demo/SKILL.md'))
    assert.ok(
      hits.every(hit => /^demo\/references\/[a-z0-9]+\.(?:md|mjs)$/.test(hit.file) && Number.isInteger(hit.line))
    )
  })

  test('artifact-hygiene reads a hermes-skill tree with the policy; a tree without findings is clean', () => {
    const keys = fakeKeys()
    const markers = compileMarkers({ layout: [], skillNames: keys })
    const root = skillTree()

    assert.ok(isSkillTree(root))
    const hits = scanTree(path.dirname(root), { markers, log: () => {} })

    assert.ok(hits.filter(hit => hit.id.startsWith('skill.')).length >= Object.keys(FINDINGS).length)
    for (const id of Object.keys(FINDINGS)) {
      fs.rmSync(path.join(root, 'demo', 'references', `${id.toLowerCase()}.${id === 'S2' ? 'mjs' : 'md'}`))
    }
    assert.deepEqual(
      scanTree(path.dirname(root), { markers, log: () => {} }).filter(hit => hit.id.startsWith('skill.')),
      []
    )

    // r5e X1: the release scan hands the owner names of its markers to the skill tree (synthetic name).
    const series = createHash('sha256').update('lark harbor').digest('hex')
    const owned = compileMarkers({
      layout: [],
      skillNames: keys,
      ownerNames: { series: new Set([series]), delivery: new Set() }
    })

    fs.writeFileSync(path.join(root, 'demo', 'references', 'notes.md'), 'Tested on Lark Harbor.\n')
    assert.deepEqual(
      scanTree(path.dirname(root), { markers: owned, log: () => {} })
        .filter(hit => hit.id.startsWith('skill.'))
        .map(hit => hit.id),
      ['skill.owner-series']
    )
  })

  test('skillTextRefusals reads a manifest: a waiver and a declared root part are not private names', () => {
    const keys = fakeKeys()
    const manifest = { requires: { paths: ['~/Movies/take_7_work'] }, waivers: [{ kept: 'clip Forgix' }] }

    assert.deepEqual(skillTextRefusals('Block it with clip Forgix (ours).\n', 'SKILL.md', { keys, manifest }), [])
    assert.deepEqual(
      skillTextRefusals('Work in `~/Movies/take_7_work/wavs/a.wav`.\n', 'SKILL.md', { keys, manifest }),
      [{ line: 1, rule: 'name.private' }]
    )
  })

  test('portSkill: a fixture with every finding ports clean (rewritten or aliased) and never ships one', () => {
    const from = fs.mkdtempSync(path.join(os.tmpdir(), 'r4-port-'))
    const dir = path.join(from, 'hm-qa')
    const keys = fakeKeys()

    fs.mkdirSync(path.join(dir, 'references'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '# QA\n\nSee `references/a.md`.\n')
    fs.writeFileSync(
      path.join(dir, 'references', 'a.md'),
      Object.entries(FINDINGS)
        .filter(([id]) => !id.startsWith('S'))
        .map(([, text]) => text)
        .join('')
    )

    const result = portSkill('hm-qa', {
      from,
      to: fs.mkdtempSync(path.join(os.tmpdir(), 'r4-to-')),
      privateNames: keys,
      spec: FIXTURE_SPEC
    })
    const shipped = result.outputs.map(out => out.text).join('\n')

    // The machine's private names are aliased first (K140 r5), then what is left of an owner path becomes the placeholder.
    assert.ok(result.counts.ownerPaths >= 1 && result.counts.privateNames >= 6)
    for (const view of [shipped, foldText(shipped)]) {
      assert.deepEqual(privateNameSpans(view, keys), [])
    }
    assert.match(
      result.outputs.find(out => out.rel === 'SKILL.md').text,
      /a path into the owner's own folders is written/
    )

    // The two spellings cannot be rewritten in place (a full-width path, a name split across join() arguments): the
    // release would refuse them, so the port refuses the skill.
    for (const [file, text] of [
      ['a.md', FINDINGS.S1],
      ['b.mjs', FINDINGS.S2]
    ]) {
      fs.writeFileSync(path.join(dir, 'references', 'a.md'), 'ok\n')
      fs.writeFileSync(path.join(dir, 'references', file), text)
      assert.throws(
        () =>
          portSkill('hm-qa', {
            from,
            to: fs.mkdtempSync(path.join(os.tmpdir(), 'r4-to-')),
            privateNames: keys,
            spec: FIXTURE_SPEC
          }),
        new RegExp(`references/${file.replace('.', '\\.')} \\(skill\\.`),
        file
      )
      fs.rmSync(path.join(dir, 'references', 'b.mjs'), { force: true })
    }
  })
})

/**
 * K140 r5 — the round-4 critic's fake HOME, rebuilt with synthetic names: a title, a numbered folder, a CamelCase one,
 * identifiers of dictionary words (written as titles too), a coined single word, a name only at depth 4 and one at
 * depth 5 (by design not read).
 */
function critHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'r5-home-'))

  for (const dir of [
    'Documents/Lark Notes', // T01–T07, T16–T20
    'Movies/a/b/c/Pale Crane', // T08: depth 4 only
    'Movies/a/b/c/d/Deep Fern', // T11: depth 5, not read
    'Documents/x/take_7', // T09
    'Developer/QuartzHarbor', // T10
    'Desktop/VAULT/plaza-crane', // T12, T13: an identifier of dictionary words
    'Desktop/VAULT/zorbix', // T14: a coined single word
    'Desktop/VAULT/x/kiln-set-robot' // T15: a three-word identifier series
  ]) {
    fs.mkdirSync(path.join(home, dir), { recursive: true })
  }

  return { home, checkouts: [], product: new Set() }
}

const T = {
  T01: 'The Lark Notes series.\n',
  T02: 'Read larknotes first.\n',
  T03: 'Ｌａｒｋ Ｎｏｔｅｓ.\n',
  T04: '`<your project folder>/Lark%20Notes/x.md`\n',
  T05: 'Lark​ Notes.\n',
  T06: 'p = join(ROOT, "Lark", "Notes")\n',
  T07: 'LarkNotes_{scene}\n',
  T08: 'The Pale Crane cut.\n',
  T09: 'Series take_7.\n',
  T10: 'With QuartzHarbor.\n',
  T12: 'The Plaza Crane project.\n',
  T13: '`<your project folder>/AI/plaza-crane/x.md`\n',
  T14: 'p = join(ROOT, "zorbix", "out")\n',
  T15: 'The Kiln Set Robot series.\n',
  T16: 'Lark&#32;Notes.\n',
  T17: 'p = "Lark\\u0020Notes"\n',
  T18: 'Lark/Notes.\n',
  T19: 'lark.notes\n',
  T20: 'Lárk Nótes.\n'
}

describe("K140 r5 (R5-3): identifiers, glued and coined names; the critic's surviving rows pinned", () => {
  const options = critHome()
  const keys = machinePrivateNames(options)
  const coined = machineCoinedNames(options)

  function tree(files) {
    const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'r5-tree-')), 'hermes-skill')

    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
      fs.writeFileSync(path.join(root, rel), body)
    }

    return root
  }

  test('T01–T20: every spelling of the fake HOME is refused by the release scan; depth 5 (T11) is not read', () => {
    const root = tree(Object.fromEntries(Object.entries(T).map(([id, text]) => [`demo/references/${id}.md`, text])))
    const refused = new Set(
      scanSkillTree(root, { keys, coined, checkouts: [] }).map(hit => path.basename(hit.file).replace(/\..*$/, ''))
    )

    for (const id of Object.keys(T)) {
      assert.ok(refused.has(id), `${id} is refused`)
    }
    assert.ok(!keys.has(key('Deep Fern')), 'T11: depth 5 is not read, by design')
    assert.ok(coined.has('zorbix'))
    // Prose words are not names: a name of dictionary words in lower case, a non-English word outside a path.
    assert.deepEqual(
      scanSkillTree(tree({ 'demo/a.md': 'the plaza crane and a pale crane; zorbix alone.\n' }), {
        keys,
        coined,
        checkouts: []
      }),
      []
    )
  })

  test('critic C402: a name only at depth 4 is read (depth 3 would lose it)', () => {
    assert.ok(keys.has(key('Pale Crane')))
    assert.ok(!machinePrivateNames({ ...options, depth: 3 }).has(key('Pale Crane')))
  })

  test('critic C409: a private name carried only by a file NAME is refused', () => {
    const hits = scanSkillTree(tree({ 'demo/Lark Notes.md': 'clean\n' }), { keys, coined, checkouts: [] })

    assert.deepEqual(
      hits.map(hit => hit.id),
      ['skill.private-name']
    )
  })

  test('critic C410: a name visible only once the text is folded is refused by the name rule', () => {
    for (const text of [T.T05, T.T16, T.T17, T.T03]) {
      assert.equal(privateNameSpans(text, keys).length === 0 || text === T.T03, true, text)
      assert.ok(
        skillTextRefusals(text, 'SKILL.md', { keys }).some(hit => hit.rule === 'name.private'),
        text
      )
    }
  })

  test('a NUL in a shipped file is never skipped: UTF-16 text is read, any other binary is refused', () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('The Lark Notes series.\n', 'utf16le')])
    const root = tree({ 'demo/a.md': utf16, 'demo/b.md': Buffer.from('ok\u0000\u0001\u0002binary') })
    const hits = scanSkillTree(root, { keys, coined, checkouts: [] })

    assert.deepEqual(hits.map(hit => `${hit.file} ${hit.id}`).sort(), [
      'demo/a.md skill.private-name',
      'demo/b.md skill.binary'
    ])
    assert.equal(textOf(Buffer.from('plain')), 'plain')
  })
})

describe('r5e X1: the owner series and delivery names (from the private side) and delivery records', () => {
  const sha = text => createHash('sha256').update(text).digest('hex')
  // Synthetic names (never the owner's): a two-word series, a one-word series, a delivery-folder word.
  const OWNER = { series: new Set([sha('lark harbor'), sha('kilnhouse')]), delivery: new Set([sha('drop')]) }
  const kinds = text => ownerNameSpans(text, OWNER).map(span => [text.slice(span.start, span.end), span.kind])

  test('a series name in any case and joiner, a one-word series, a delivery folder; nothing without the names', () => {
    assert.deepEqual(kinds('the Lark Harbor series, LARK HARBOR, lark-harbor.v1 and (Kilnhouse)'), [
      ['Lark Harbor', 'series'],
      ['LARK HARBOR', 'series'],
      ['lark-harbor', 'series'],
      ['Kilnhouse', 'series']
    ])
    assert.deepEqual(kinds('work on drop_3 / drop-4-10 / dropzone / drop it'), [
      ['drop_3', 'delivery'],
      ['drop-4-10', 'delivery']
    ])
    assert.deepEqual(ownerNameSpans('Lark Harbor drop_3', null), [])
    assert.deepEqual(kinds('a lark over the harbor'), [])
  })

  test('r5f M1: a short form (a leading run of a longer series), plurals, glued, an and joiner, format characters', () => {
    // The rows the private file holds for a three-word series and a one-word one (nameRows), plus an identity name.
    const rows = [...nameRows('series', 'Lark Harbor Kiln'), ...nameRows('series', 'Kilnhouse')]
    const owner = {
      series: new Set(rows.map(row => row.sha256)),
      delivery: new Set([sha('drop')]),
      identity: new Set(nameRows('identity', 'Corvina Example').map(row => row.sha256))
    }
    const found = text => ownerNameSpans(text, owner).map(span => [text.slice(span.start, span.end), span.kind])

    for (const [text, match] of [
      ['no LARK/HARBOR pages', 'LARK/HARBOR'],
      ['the Lark Harbor Kiln set', 'Lark Harbor Kiln'],
      ['two Kilnhouses', 'Kilnhouses'],
      ['the larkharbor tool', 'larkharbor'],
      ['LARKHARBORKILN', 'LARKHARBORKILN'],
      ['Lark and Harbor', 'Lark and Harbor'],
      ['Lark\u200dHarbor', 'Lark\u200dHarbor'],
      ['Lark\u2011Harbor', 'Lark\u2011Harbor'],
      ['Lark\u00a0Harbor', 'Lark\u00a0Harbor']
    ]) {
      assert.deepEqual(found(text), [[match, 'series']], text)
    }
    assert.deepEqual(found('written by Corvina Example'), [['Corvina Example', 'identity']])
    // A lone word of a longer series is not the series; a plain word is not a name.
    assert.deepEqual(found('a lark, a harbor, a kiln'), [])
  })

  test('the delivery record shapes: counts of identical files, its N videos, N videos and minutes of film', () => {
    const hit = text => DELIVERY_RECORD_RES.some(re => new RegExp(re.source, 'i').test(text))

    for (const text of [
      '— 9 of 9 identical',
      'the series and its 4 videos',
      '(2026-01-02: 5 videos, 12 min of film, 1 GB)',
      '"9 of 9 · 1920 × 1080 · 60 fps · 12 min · 1.5 GB"',
      '"9 of 9 · 1920 × 1080"',
      '"60 fps · 12 min · 1.5 GB"',
      'delivered 7 videos (21 min, 2 GB)',
      'and its 3 vídeos'
    ]) {
      assert.ok(hit(text), text)
    }
    for (const text of [
      'one of the identical frames',
      'its videos',
      '5 videos in a list',
      '12 min of silence',
      '"N of N · <minutes> · <size>"'
    ]) {
      assert.ok(!hit(text), text)
    }
  })

  test('the skill-tree gate reads them with the names given, as their own ids; a manifest never names them', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r5e-'))

    try {
      fs.mkdirSync(path.join(root, 'demo'), { recursive: true })
      fs.writeFileSync(path.join(root, 'demo', 'manifest.json'), '{}\n')
      fs.writeFileSync(
        path.join(root, 'demo', 'SKILL.md'),
        '# Demo\n\nTested on Lark Harbor.\nDelivered to drop_3.\nThe series and its 4 videos.\n'
      )
      const ids = owner =>
        scanSkillTree(root, { keys: new Map(), coined: new Set(), owner })
          .map(hit => hit.id)
          .sort()

      assert.deepEqual(ids(OWNER), ['skill.delivery-record', 'skill.owner-delivery', 'skill.owner-series'])
      assert.deepEqual(ids({ series: new Set(), delivery: new Set() }), ['skill.delivery-record'])
      assert.equal(skillRuleId('name.series'), 'skill.owner-series')
      assert.equal(skillRuleId('name.delivery'), 'skill.owner-delivery')
      assert.equal(skillRuleId('record.delivery'), 'skill.delivery-record')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)
})

describe('R5-4: the product owns what it tracks and what its ignore rules say it builds', () => {
  test('productNames: tracked parts, ignored folders and two levels built inside them; nothing deeper', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'r54-'))
    const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' })

    git('init', '-q')
    fs.writeFileSync(path.join(repo, '.gitignore'), 'out/\n')
    fs.mkdirSync(path.join(repo, 'src'))
    fs.writeFileSync(path.join(repo, 'src', 'tracked-file.txt'), 'x\n')
    fs.mkdirSync(path.join(repo, 'out', 'kiln-build', 'stage-two', 'deep-three'), { recursive: true })
    fs.writeFileSync(path.join(repo, 'out', 'kiln-build', 'stage-two', 'deep-three', 'leaf.txt'), 'x\n')
    git('add', '.gitignore', 'src')

    const names = productNames([repo])

    for (const name of ['src', 'tracked-file.txt', 'out', 'kiln-build', 'stage-two']) {
      assert.ok(names.has(name), name)
    }
    assert.ok(!names.has('deep-three'))
    fs.rmSync(repo, { recursive: true, force: true })
  })
})

describe('the committed tree on THIS machine (counts only: a private name never reaches a test log)', () => {
  test('the shipped skill tree passes the release skill-text policy: 0 refusals', () => {
    const hits = scanSkillTree(path.resolve(DEFAULT_BUNDLE))

    assert.equal(hits.length, 0, `${hits.length} refusal(s): ${[...new Set(hits.map(hit => hit.id))].join(', ')}`)
  }, 60_000)

  // R5-4: the repo gate. The machine-derived scan runs over this front's whole tree (the policy, the port, the release
  // scanner and its markers, their tests, and the shipped skill tree above). Public by construction, never by a list
  // of the owner's names: what PORT_SET declares, the distribution layout the product writes (make-distribution
  // FOLDERS), and the release's own control-plane and lab names, which its markers refuse by id.
  test('R5-4 repo gate: the front tree holds no private name of this machine (0 outside the owner sources)', () => {
    const declared = new Set(
      [
        ...Object.values(PORT_SET).flatMap(spec => [
          ...(spec.requires.paths ?? []).flat().flatMap(p => String(p).split('/')),
          ...(spec.waivers ?? []).map(w => w.kept)
        ]),
        ...Object.values(FOLDERS)
      ].flatMap(name => [key(name), key(String(name).replace(/^\d+[-_ ]*/, ''))])
    )
    const lab = SHAPES.filter(shape => shape.id.startsWith('lab.'))
    const release = name =>
      ['.', '/', '-', '_', ' '].some(joiner => {
        const spelt = `${name.replaceAll(' ', joiner)}/`

        return privateTokenIds(spelt).length > 0 || lab.some(shape => new RegExp(shape.re.source, 'u').test(spelt))
      })
    const keys = new Map([...machinePrivateNames()].filter(([name]) => !declared.has(name) && !release(name)))
    const files = [
      'skill-text-policy.mjs',
      'skill-text-policy.test.mjs',
      'port-owner-skills.mjs',
      'port-owner-skills.test.mjs',
      'artifact-hygiene.mjs',
      'artifact-hygiene.test.mjs',
      'artifact-hygiene-markers.mjs'
    ]
    const found = files.filter(file => {
      const text = fs.readFileSync(path.join(import.meta.dirname, file), 'utf8')

      return [text, foldText(text)].some(view => privateNameSpans(view, keys).length > 0)
    })

    assert.equal(found.length, 0, `${found.length} file(s) name a private name of this machine`)
  }, 60_000)
})
