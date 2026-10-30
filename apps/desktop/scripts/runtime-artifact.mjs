// V3-RT (K153 / K-S1): the Hermes runtime the app bundles is built from THIS repository, from git objects at one commit,
// so the shipped runtime is byte-for-byte the code the gates tested.
//
// This module is the one definition of the runtime's shipped set (RT-1) and the inventory that proves the repo's
// runtime differs from the upstream pin it tracks only in iclone's own files.
//
// RT-2: the artifact. A deterministic tar.gz built from git objects (never the working tree) at one commit, in the
// layout the installer already takes from the upstream tarball (top directory `hermes-agent-<sha>/`), plus a manifest
// (sha256 per file) whose own sha256 is in iclone/RUNTIME_PIN.json. Same commit => same bytes, on any machine: a
// hand-written ustar/pax writer (sorted entries, uid/gid 0, mtime = the commit time) compressed by Node's zlib at level 9
// with a platform-neutral header (K-RT10; the pin names the zlib build).
//
//   node scripts/runtime-artifact.mjs inventory [--rev <commit>] [--upstream <commit>]
//   node scripts/runtime-artifact.mjs build [--rev <commit>] --out <dir>
//   node scripts/runtime-artifact.mjs pin [--rev <commit>]      # rebuild the pin record + contract lock + types
//
// `check` and `pin` read git objects, never the working tree: both refuse while a shipped file has uncommitted changes.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { crc32, gunzipSync, gzipSync } from 'node:zlib'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isMain } from './utils.mjs'

const here = dirname(fileURLToPath(import.meta.url))

export const REPO_ROOT = resolve(here, '..', '..', '..')
export const UPSTREAM_PIN_FILE = join(REPO_ROOT, 'iclone', 'runtime', 'UPSTREAM_PIN')

/**
 * Top-level entries of the repo that are never part of the runtime: the app and its packaging, iclone's own control
 * files, CI, docs and tests (RT-2), the Hermes web UI and TUI the desktop app does not run (RT-LIC, ruling 27), and the
 * upstream contributor list (thousands of e-mail addresses as file names, read only by release tooling).
 */
export const EXCLUDED_TOP = Object.freeze([
  '.github',
  '.gitleaks.toml',
  '.gitleaksignore',
  '.mailmap',
  'apps',
  // The upstream's brand art (Nous Research trademarks, used by its desktop packaging): no runtime code reads it, and
  // its MIT licence does not cover the marks (critic r1 m1).
  'assets',
  // bench/ is the performance harness: it measures the runtime from outside the app, and neither it nor its results ship.
  'bench',
  'contributors',
  'docs',
  'evals',
  'iclone',
  'packages',
  'packaging',
  'tests',
  'tests-js',
  'ui-tui',
  'web',
  'website'
])

/** A directory with one of these names is excluded wherever it is (tests and docs never ship). */
export const EXCLUDED_SEGMENTS = Object.freeze(['__tests__', 'docs', 'tests'])

/**
 * Paths never shipped because the runtime has no right or no need to carry them (critic r1 m1, lead decision): the
 * research-paper skill's conference templates — style files with no licence statement or under LPPL, and PDFs that
 * embed font programs. They are writing material, not runtime.
 */
export const EXCLUDED_PREFIXES = Object.freeze([
  'optional-skills/research/research-paper-writing/templates/',
  // A third-party voice recording whose licence the repository does not carry; NeuTTS (opt-in) takes the user's own
  // reference voice (tts.neutts.ref_audio / ref_text).
  'tools/neutts_samples/',
  // The repository's test runner (critics' panel M-1). It runs tests/, which never ships (EXCLUDED_TOP), so in the
  // runtime it can only fail; no runtime code runs the runtime's own copy (agent/coding_context.py looks for one in the
  // USER's project). Shipped, every change to the runner silently staled the pin (c494de9e3b, 60ef5b51c1 after
  // ca80ed43a0): a test tool must not be part of what the app verifies byte for byte.
  'scripts/run_tests.sh'
])

/** Font files are never shipped (RT-LIC: no font in the runtime, whatever its licence). */
export const FONT_RE = /\.(eot|otf|ttc|ttf|woff2?)$/i

const EXCLUDED_TOP_SET = new Set(EXCLUDED_TOP)
const EXCLUDED_SEGMENT_SET = new Set(EXCLUDED_SEGMENTS)

/** True when a repo path (forward slashes, relative to the root) is part of the bundled runtime. */
export function isShippedPath(relPath) {
  const parts = relPath.split('/')

  if (EXCLUDED_TOP_SET.has(parts[0])) {
    return false
  }

  for (const segment of parts.slice(0, -1)) {
    if (EXCLUDED_SEGMENT_SET.has(segment)) {
      return false
    }
  }

  if (EXCLUDED_PREFIXES.some(prefix => relPath.startsWith(prefix))) {
    return false
  }

  return !FONT_RE.test(relPath)
}

export function git(args, { cwd = REPO_ROOT, input } = {}) {
  const out = spawnSync('git', args, { cwd, input, maxBuffer: 1 << 30 })

  if (out.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${String(out.stderr).trim().slice(0, 400)}`)
  }

  return out.stdout
}

export function resolveCommit(rev, cwd = REPO_ROOT) {
  return String(git(['rev-parse', '--verify', `${rev}^{commit}`], { cwd })).trim()
}

/**
 * The shipped-set paths of the working tree that are not HEAD's (modified, staged, deleted, renamed or untracked),
 * sorted. Everything here reads git objects, so an uncommitted edit to a shipped file is invisible to `pin` and `check`:
 * they refuse while this is non-empty, instead of pinning or verifying a runtime that is not the tree the author sees.
 */
export function dirtyShippedPaths({ cwd = REPO_ROOT } = {}) {
  const records = git(['status', '--porcelain', '--untracked-files=all', '-z'], { cwd })
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
  const paths = []

  for (let i = 0; i < records.length; i++) {
    paths.push(records[i].slice(3))

    // A rename or copy is followed by its source path as its own record.
    if (/[RC]/.test(records[i].slice(0, 2))) {
      paths.push(records[++i])
    }
  }

  return paths.filter(isShippedPath).sort()
}

/** Throws, naming every dirty shipped path, when `command` would read git objects that differ from the working tree. */
export function assertCleanShippedTree(command, { cwd = REPO_ROOT } = {}) {
  const dirty = dirtyShippedPaths({ cwd })

  if (dirty.length) {
    throw new Error(
      `${command} reads git objects, but the working tree has uncommitted changes to ${dirty.length} shipped file(s); ` +
        `commit or stash them first:\n  ${dirty.join('\n  ')}`
    )
  }
}

/**
 * Every git entry of `rev` (blobs and links; submodules refuse), as `{ mode, oid, path }`, sorted by path bytes.
 * `shipped` filters to the runtime's shipped set.
 */
export function listTree(rev, { cwd = REPO_ROOT, shipped = true } = {}) {
  const raw = git(['ls-tree', '-r', '-z', '--full-tree', rev], { cwd }).toString('utf8')
  const entries = []

  for (const record of raw.split('\0')) {
    if (!record) {
      continue
    }

    const tab = record.indexOf('\t')
    const [mode, type, oid] = record.slice(0, tab).split(' ')
    const path = record.slice(tab + 1)

    if (shipped && !isShippedPath(path)) {
      continue
    }

    if (type !== 'blob') {
      throw new Error(`${path}: a ${type} entry cannot ship in the runtime`)
    }

    if (!['100644', '100755', '120000'].includes(mode)) {
      throw new Error(`${path}: unsupported git mode ${mode}`)
    }

    entries.push({ mode, oid, path })
  }

  return entries.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
}

/**
 * RT-1: the iclone files of the runtime. Every path of the shipped set that differs from the upstream pin must be one
 * of these (anything else is upstream drift the repo did not take), and each one must still differ (a stale row hides
 * a lost iclone change). `class` says why it ships.
 */
export const ICLONE_RUNTIME_PATHS = Object.freeze({
  // iclone core: V3-F/V3-G gate hooks re-implemented on the pin (V3-UP), U2 auto-titles.
  'agent/agent_runtime_helpers.py': 'core',
  'agent/title_generator.py': 'core',
  'agent/tool_executor.py': 'core',
  // (also critic r1 M1: an app-shipped tree goes after the standard library, before site-packages)
  'hermes_bootstrap.py': 'core',
  // Critic r1 M1: an app-shipped tree goes after the standard library on the fast startup path too.
  'hermes_cli/_startup_fast.py': 'core',
  'hermes_cli/env_loader.py': 'core',
  'hermes_cli/iclone_policy_env.py': 'core',
  'hermes_cli/plugins.py': 'core',
  'hermes_cli/plugins_discovery.py': 'core',
  'hermes_cli/plugins_dispatch.py': 'core',
  // K-RT9 / K-RT14: git never looks above the runtime root, nor into the user's ~/.hermes/hermes-agent, for the
  // runtime's own identity.
  'hermes_cli/banner.py': 'core',
  'hermes_cli/version_info.py': 'core',
  // V3-J (fix m-r4-1, ported onto 1ac3f97): a pay env belongs to the profile it was minted for.
  'hermes_cli/iclone_pay_env.py': 'core',
  // V3-UP r5 (main 21214f4a74; rulings 50, 56, 60): agent tools, helper programs and the browser started inside
  // macOS Seatbelt through the spawn guard; the (h) interpreter children carry the guard and the env seal.
  'agent/lsp/__init__.py': 'core',
  'agent/lsp/install.py': 'core',
  'agent/shell_hooks.py': 'core',
  'agent/skill_preprocessing.py': 'core',
  'gateway/platforms/base.py': 'core',
  'hermes_constants.py': 'core',
  'plugins/google_meet/meet_bot.py': 'core',
  'plugins/google_meet/process_manager.py': 'core',
  'plugins/iclone-confinement/programs.py': 'plugin',
  'plugins/iclone-confinement/spawn_sites.json': 'plugin',
  'plugins/web/ddgs/_search_worker.py': 'core',
  'tools/browser_tool.py': 'core',
  'tools/browser_tool_session.py': 'core',
  'tools/browser_use_cli.py': 'core',
  'tools/checkpoint_manager.py': 'core',
  'tools/env_probe.py': 'core',
  'tools/environments/host_lane.py': 'core',
  'tools/file_operations_lint.py': 'core',
  'tools/file_tools.py': 'core',
  'tools/mcp_death_supervisor.py': 'core',
  'tools/mcp_oauth.py': 'core',
  'tools/mcp_tool_transport.py': 'core',
  'tools/neutts_synth.py': 'core',
  'tools/read_extract.py': 'core',
  'tools/subagent_worktree.py': 'core',
  'tools/transcription_audio.py': 'core',
  'tools/transcription_chunking.py': 'core',
  'tools/transcription_local.py': 'core',
  'tools/tts_tool_delivery.py': 'core',
  'tools/tts_tool_local.py': 'core',
  'tools/vision_tools_image_prep.py': 'core',
  'tui_gateway/compute_host.py': 'core',
  'tui_gateway/host_supervisor.py': 'core',
  'tui_gateway/methods_prompt.py': 'core',
  'tui_gateway/server.py': 'core',
  'hermes_cli/kanban_db_dispatch.py': 'core',
  'hermes_cli/main.py': 'core',
  // V3-J (J6 m-r5-1, m-r6-1, ported onto 1ac3f97): every child env factory binds the pay env to the child's home.
  'hermes_cli/web_server_chat.py': 'core',
  'tools/environments/local.py': 'core',
  'tui_gateway/entry.py': 'core',
  'tui_gateway/slash_worker.py': 'core',
  'model_tools.py': 'core',
  // K-RT15b: an app-shipped runtime's environment imports the verified tree; PM's build copy is deleted.
  'pm/packages.py': 'core',
  'pm/workspace.py': 'core',
  // Critic r1 M1: an app-shipped runtime keeps the standard library first on its own sys.path.
  'pm/environments.py': 'core',
  // From V3-RT-B r2: PM's uv runs get generous network timeouts and retries.
  'pm/environment.py': 'core',
  'pm/index_config.py': 'core',
  // Ruling 57.2: the telemetry distributions PM never installs.
  'pm/runtime-venv-exclusions.txt': 'core',
  // The docstring is a raw string: no SyntaxWarning on stderr at every spawn (upstream bug, fixed at the source).
  'pm/shell.py': 'core',
  'tools/approval.py': 'core',
  'tools/approval_context.py': 'core',
  // V3-UP r2 M3: the in-process file lane never serves a confining environment.
  'tools/file_operations.py': 'core',
  'tui_gateway/methods_config_set.py': 'core',
  // V3-FX (rulings 47, 54, 57, 63): telemetry removed — no sink can be enabled, no upload, the denylist and the
  // exclusion list PM applies on every sync, refusals for plugins and extras that would pull a telemetry distribution.
  'agent/copilot_acp_client.py': 'core',
  'agent/monitoring/gateway_health_export.py': 'core',
  'agent/monitoring/otlp_exporter.py': 'core',
  'agent/relay_runtime.py': 'core',
  'hermes_cli/config.py': 'core',
  'hermes_cli/debug.py': 'core',
  'hermes_cli/diagnostics_upload.py': 'core',
  'hermes_cli/iclone_no_upload.py': 'core',
  'hermes_cli/iclone_sinks.py': 'core',
  'hermes_cli/kanban_pr_acceptance.py': 'core',
  'hermes_cli/observability/shared_metrics_send_config.py': 'core',
  'hermes_cli/observability/shared_metrics_sender.py': 'core',
  'hermes_cli/plugin_host.py': 'core',
  'hermes_cli/plugins_cmd_install.py': 'core',
  'hermes_cli/proxy_cli.py': 'core',
  'hermes_cli/send_cmd.py': 'core',
  'plugins/observability/langfuse/__init__.py': 'core',
  'plugins/platforms/photon/adapter.py': 'core',
  'pm/cli.py': 'core',
  'pm/install.py': 'core',
  'pm/progress.py': 'core',
  'tools/bot_relay.py': 'core',
  'tools/computer_use/cua_backend.py': 'core',
  'tools/mcp_tool_config.py': 'core',
  'plugins/iclone-consent/__init__.py': 'plugin',
  'plugins/iclone-consent/importgate.py': 'plugin',
  'plugins/iclone-consent/micgate.py': 'plugin',
  'plugins/iclone-consent/noupload.py': 'plugin',
  'plugins/iclone-consent/plugin.yaml': 'plugin',
  // The iclone Hermes plugins (V3-F permissions, V3-G confinement); V3-S installs the same bytes from the app bundle.
  'plugins/iclone-confinement/__init__.py': 'plugin',
  'plugins/iclone-confinement/core.py': 'plugin',
  'plugins/iclone-confinement/plugin.yaml': 'plugin',
  'plugins/iclone-confinement/providers.py': 'plugin',
  'plugins/iclone-confinement/seatbelt.py': 'plugin',
  'plugins/iclone-permissions/__init__.py': 'plugin',
  'plugins/iclone-permissions/channel.py': 'plugin',
  'plugins/iclone-permissions/classify.py': 'plugin',
  'plugins/iclone-permissions/functions.py': 'plugin',
  'plugins/iclone-permissions/normalize.py': 'plugin',
  'plugins/iclone-permissions/plugin.yaml': 'plugin',
  'plugins/iclone-permissions/policy.py': 'plugin',
  // v0.0.4 deps (r4): PyJWT >= 2.14 refuses JWKS redirects, so the dashboard providers and the Chronos verifier
  // resolve the JWKS URL by the OIDC discovery redirect rule (same origin only); PM's pip check is handed the project so
  // it tolerates only the exact uv overrides of ruling 92 (pm/environment.py holds the rule).
  'plugins/cron_providers/chronos/verify.py': 'core',
  'plugins/dashboard_auth/_shared.py': 'core',
  'plugins/dashboard_auth/self_hosted/__init__.py': 'core',
  'pm/operations.py': 'core',
  // Runtime locks (owner, 2026-10-28): the opt-in bridges pin fixed releases of a dependency by an override —
  // undici 7.30.1 in the Photon sidecar (GHSA-xjj6-f33q-929c, GHSA-qrxm-fqhp-jwvm), body-parser 1.20.9 in the
  // WhatsApp bridge (GHSA-27r3-jxmh-p828); v0.0.4 (review M2): @grpc/grpc-js 1.14.5 (GHSA-m9gg-hp2v-232j,
  // GHSA-f596-whhp-79r4) and zod 4.6.6 (GHSA-mrhx-c7xc-m3w5) in the sidecar, sharp 0.35.5 (GHSA-wq5f-xc86-pv6w) in the
  // bridge. Each manifest and its lock move together; audit-gate.mjs SUB_LOCKS judges both locks (G-45).
  'plugins/platforms/photon/sidecar/package-lock.json': 'deps',
  'plugins/platforms/photon/sidecar/package.json': 'deps',
  'scripts/whatsapp-bridge/package-lock.json': 'deps',
  'scripts/whatsapp-bridge/package.json': 'deps',
  // Runtime security pins (v0.0.4): fixed releases above the upstream pin's (Pillow 13.0.0 by an exact uv override,
  // PyJWT 2.15.0, aiohttp 3.14.4, urllib3 2.8.0, certifi, brotlicffi). The project and its lock move together.
  'pyproject.toml': 'deps',
  'uv.lock': 'deps',
  // The Settings › Updates › Agent hand-off script (the door is disabled in 0.0.3, K-RT3; the script stays inert).
  'scripts/desktop-update/iclone-agent-update.sh': 'script',
  // Licence and notices of the fork.
  LICENSE: 'legal',
  NOTICE: 'legal',
  'THIRD_PARTY_NOTICES.md': 'legal',
  // Top-level documents of the fork (the upstream translations were removed).
  'CONTRIBUTING.es.md': 'doc',
  'CONTRIBUTING.md': 'doc',
  'README.es.md': 'doc',
  'README.md': 'doc',
  'README.ur-pk.md': 'doc',
  'README.zh-CN.md': 'doc',
  'SECURITY.es.md': 'doc',
  'SECURITY.md': 'doc',
  // Repo configuration of the fork (the root npm workspace carries apps/desktop; the runtime never runs npm without
  // ui-tui/ or web/: hermes_cli/source_build.py source_frontends()).
  '.coderabbit.yaml': 'repo-config',
  '.gitattributes': 'repo-config',
  '.gitignore': 'repo-config',
  '.npmrc': 'repo-config',
  'package-lock.json': 'repo-config',
  'package.json': 'repo-config'
})

export function readUpstreamPin(file = UPSTREAM_PIN_FILE) {
  const sha = readFileSync(file, 'utf8')
    .split('\n')
    .map(line => line.trim())
    .find(line => /^[0-9a-f]{40}$/.test(line))

  if (!sha) {
    throw new Error(`${file} names no 40-hex upstream commit`)
  }

  return sha
}

/**
 * RT-1 inventory: every shipped-set path whose content differs between `upstream` and `rev`, classified. `drift` (a
 * difference that is not iclone's) and `stale` (an iclone row that no longer differs) must both be empty.
 */
export function inventory({ cwd = REPO_ROOT, rev = 'HEAD', upstream = readUpstreamPin() } = {}) {
  const ours = new Map(listTree(rev, { cwd }).map(entry => [entry.path, entry]))
  const theirs = new Map(listTree(upstream, { cwd }).map(entry => [entry.path, entry]))
  const rows = []

  for (const path of [...new Set([...ours.keys(), ...theirs.keys()])].sort()) {
    const a = theirs.get(path)
    const b = ours.get(path)

    if (a && b && a.oid === b.oid && a.mode === b.mode) {
      continue
    }

    rows.push({
      class: ICLONE_RUNTIME_PATHS[path] ?? 'drift',
      path,
      status: !a ? 'added' : !b ? 'removed' : a.oid === b.oid ? 'mode' : 'modified'
    })
  }

  const differing = new Set(rows.map(row => row.path))
  const stale = Object.keys(ICLONE_RUNTIME_PATHS)
    .filter(path => !differing.has(path))
    .sort()

  return {
    drift: rows.filter(row => row.class === 'drift'),
    rev: resolveCommit(rev, cwd),
    rows,
    shipped: ours.size,
    stale,
    upstream: resolveCommit(upstream, cwd)
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// RT-2: the artifact
// ---------------------------------------------------------------------------------------------------------------------

export const MANIFEST_SCHEMA = 1
export const RUNTIME_MANIFEST_FILE = 'RUNTIME_MANIFEST.json'
export const INSTALL_SH = 'scripts/install.sh'

export const sha256 = data => createHash('sha256').update(data).digest('hex')

/** Every blob of `oids` (one `git cat-file --batch`), by oid. */
export function readBlobs(oids, { cwd = REPO_ROOT } = {}) {
  const unique = [...new Set(oids)]
  const out = git(['cat-file', '--batch'], { cwd, input: `${unique.join('\n')}\n` })
  const blobs = new Map()
  let at = 0

  for (const oid of unique) {
    const eol = out.indexOf(0x0a, at)
    const [gotOid, type, size] = out.subarray(at, eol).toString('utf8').split(' ')

    if (gotOid !== oid || type !== 'blob') {
      throw new Error(`git cat-file: expected blob ${oid}, got ${gotOid} ${type}`)
    }

    const start = eol + 1
    const end = start + Number(size)
    blobs.set(oid, out.subarray(start, end))
    at = end + 1
  }

  return blobs
}

const MODE_NAME = { 100644: '644', 100755: '755', 120000: 'link' }

/** The manifest of a file list: `[path, mode, size, sha256]` rows sorted by path bytes. */
export function manifestOf(files, { python = null, pycs = 0, sha, upstream }) {
  const entries = files
    .map(file => [file.path, file.mode, file.data.length, sha256(file.data)])
    .sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])))

  return {
    schema: MANIFEST_SCHEMA,
    source: 'repo',
    sha,
    upstream,
    ...(python ? { python, pycs } : {}),
    files: entries.length,
    bytes: entries.reduce((sum, row) => sum + row[2], 0),
    entries
  }
}

/** Canonical bytes of a manifest: fixed key order, one entry per line (diffable, and hashed as-is). */
export function manifestText(manifest) {
  const head = ['schema', 'source', 'sha', 'upstream', 'python', 'pycs', 'files', 'bytes']
    .filter(key => manifest[key] !== undefined)
    .map(key => `  ${JSON.stringify(key)}: ${JSON.stringify(manifest[key])},`)

  const rows = manifest.entries.map(
    (row, i) => `    ${JSON.stringify(row)}${i === manifest.entries.length - 1 ? '' : ','}`
  )

  return `{\n${head.join('\n')}\n  "entries": [\n${rows.join('\n')}\n  ]\n}\n`
}

/** Parses and checks a manifest's shape (every field the verifier relies on). */
export function parseManifest(text) {
  const manifest = JSON.parse(text)

  if (
    manifest?.schema !== MANIFEST_SCHEMA ||
    manifest.source !== 'repo' ||
    !/^[0-9a-f]{40}$/.test(manifest.sha ?? '') ||
    !Array.isArray(manifest.entries) ||
    manifest.entries.length !== manifest.files
  ) {
    throw new Error('not a runtime manifest (schema 1, source repo)')
  }

  for (const row of manifest.entries) {
    if (
      !Array.isArray(row) ||
      typeof row[0] !== 'string' ||
      !['644', '755', 'link'].includes(row[1]) ||
      !Number.isInteger(row[2]) ||
      !/^[0-9a-f]{64}$/.test(row[3] ?? '')
    ) {
      throw new Error(`bad manifest row ${JSON.stringify(row).slice(0, 120)}`)
    }
  }

  return manifest
}

/** The shipped files of `rev`, with their content from git objects. */
export function shippedFiles(rev, { cwd = REPO_ROOT } = {}) {
  const entries = listTree(rev, { cwd })
  const blobs = readBlobs(
    entries.map(entry => entry.oid),
    { cwd }
  )

  return entries.map(entry => ({ path: entry.path, mode: MODE_NAME[entry.mode], data: blobs.get(entry.oid) }))
}

// --- bytecode (ruling 37) ----------------------------------------------------------------------------------------------

/**
 * The plugin folders V3-S installs and verifies strictly (its own bytecode policy): no bytecode is shipped in them, or
 * the two checks would undo each other on every spawn.
 */
export const PYC_EXCLUDED = /^plugins\/iclone-[^/]+\//

const COMPILE_PY = `
import importlib.util, json, os, platform, py_compile, sys, warnings
src, out = sys.argv[1], sys.argv[2]
rels = json.loads(sys.stdin.read())
done, failed, warned = [], [], []
for rel in rels:
    cache = importlib.util.cache_from_source(rel)
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        try:
            py_compile.compile(os.path.join(src, rel), cfile=os.path.join(out, cache), dfile=rel,
                               invalidation_mode=py_compile.PycInvalidationMode.CHECKED_HASH, doraise=True)
            done.append([rel, cache])
        except py_compile.PyCompileError:
            failed.append(rel)
    warned += [[rel, f"{w.lineno}: {w.message}"] for w in caught if issubclass(w.category, SyntaxWarning)]
print(json.dumps({"python": platform.python_version(), "tag": sys.implementation.cache_tag, "done": done,
                  "failed": failed, "warned": warned}))
`

/**
 * PEP 552 checked-hash bytecode of every shipped `.py` (except PYC_EXCLUDED), compiled by `python` in byte order in one
 * process: no timestamp in the files, `co_filename` relative (the loader fixes it up on import), so the same sources and
 * the same CPython version give the same bytes on any machine. Files that are not valid Python for that version (skill
 * templates) are skipped and counted.
 */
export function compilePycs(files, { python }) {
  const sources = files.filter(
    file => file.path.endsWith('.py') && file.mode !== 'link' && !PYC_EXCLUDED.test(file.path)
  )
  const work = mkdtempSync(join(tmpdir(), 'rt-pyc-'))

  try {
    for (const file of sources) {
      mkdirSync(dirname(join(work, 'src', file.path)), { recursive: true })
      writeFileSync(join(work, 'src', file.path), file.data)
    }

    const out = spawnSync(python, ['-I', '-B', '-c', COMPILE_PY, join(work, 'src'), join(work, 'out')], {
      input: JSON.stringify(sources.map(file => file.path)),
      maxBuffer: 1 << 28
    })

    if (out.status !== 0) {
      throw new Error(`${python} could not compile the runtime: ${String(out.stderr).trim().slice(-400)}`)
    }

    const result = JSON.parse(String(out.stdout))

    // A SyntaxWarning in a shipped module is printed on stderr by every spawn that compiles it: never ship one.
    if (result.warned.length > 0) {
      throw new Error(
        `the runtime has SyntaxWarnings under ${result.python}: ${result.warned.map(w => w.join(':')).join('; ')}`
      )
    }

    const pycs = result.done.map(([, cache]) => ({
      path: cache,
      mode: '644',
      data: readFileSync(join(work, 'out', cache))
    }))

    return { failed: result.failed, pycs, python: result.python, tag: result.tag }
  } finally {
    rmSync(work, { force: true, recursive: true })
  }
}

/**
 * Critic r1 m5: which CPython build compiled the bytecode, so a rebuild can be checked — its full version line, its
 * build tag and the sha256 of its interpreter binary. The pin records it; the bundle step refuses another build.
 */
export function pythonBuildIdentity(python) {
  const out = spawnSync(
    python,
    [
      '-I',
      '-c',
      'import hashlib,json,os,platform,sys;' +
        'b=open(os.path.realpath(sys.executable),"rb").read();' +
        'print(json.dumps({"version":sys.version,"build":list(platform.python_build()),' +
        '"executable_sha256":hashlib.sha256(b).hexdigest()}))'
    ],
    { encoding: 'utf8' }
  )

  if (out.status !== 0) {
    throw new Error(`${python} could not describe its build: ${String(out.stderr).trim().slice(-200)}`)
  }

  return JSON.parse(out.stdout)
}

/**
 * findRuntimePython, or null when this machine has no such interpreter (tests skip the rows that need it). With
 * `executableSha256` (the pin's python_build.executable_sha256), an interpreter of the right version but another build
 * is null too (critics' panel, minor 4): uv's 3.14.7 is not the pin's 3.14.7, and fetch-runtime-pin refuses it.
 */
export function tryRuntimePython(version, executableSha256 = null) {
  try {
    const python = findRuntimePython(version)

    return !executableSha256 || pythonBuildIdentity(python).executable_sha256 === executableSha256 ? python : null
  } catch {
    return null
  }
}

/** The CPython version the runtime's installer pins (pm/lock.json packages.python.version, build tag dropped). */
export function readLockPython(cwd = REPO_ROOT) {
  const lock = JSON.parse(readFileSync(join(cwd, 'pm', 'lock.json'), 'utf8'))

  return String(lock.packages.python.version).split('+')[0]
}

/** Why `candidate` is not a CPython `version` interpreter (null = it is): cannot run, exits non-zero, prints another version. */
function notPython(candidate, version) {
  const got = spawnSync(candidate, ['-I', '-c', 'import platform;print(platform.python_version())'], {
    encoding: 'utf8'
  })

  if (got.error) {
    return `it cannot be run (${got.error.code ?? got.error.message})`
  }

  if (got.status !== 0) {
    return `it exited ${got.status}: ${String(got.stderr).trim().slice(-200)}`
  }

  const printed = got.stdout.trim()

  return printed === version ? null : `it is Python ${printed || '(nothing printed)'}`
}

/**
 * The Python the pin compiles with. ICLONE_RUNTIME_PY, when set (non-empty), is the answer or an error — a named
 * interpreter that is not CPython `version` never falls back to another (the gate relies on the one it names). Unset
 * or empty: uv's managed interpreter of that exact version.
 */
export function findRuntimePython(version, { env = process.env } = {}) {
  const pinned = env.ICLONE_RUNTIME_PY

  if (pinned) {
    const reason = notPython(pinned, version)

    if (reason) {
      throw new Error(`ICLONE_RUNTIME_PY=${pinned} is not CPython ${version}: ${reason}`)
    }

    return pinned
  }

  const found = spawnSync('uv', ['python', 'find', '--managed-python', version], { encoding: 'utf8' })
  const managed = found.status === 0 ? found.stdout.trim() : ''

  if (managed && !notPython(managed, version)) {
    return managed
  }

  throw new Error(
    `no Python ${version} to compile the runtime's bytecode with: set ICLONE_RUNTIME_PY, or run uv python install ${version}`
  )
}

// --- tar (ustar + pax) ---------------------------------------------------------------------------------------------

function octal(value, width) {
  return `${value.toString(8).padStart(width - 1, '0')}\0`
}

function header({ name, mode, size, mtime, type, linkname = '' }) {
  const block = Buffer.alloc(512)
  const put = (offset, width, text) => block.write(text, offset, width, 'utf8')
  let prefix = ''
  let short = name

  if (Buffer.byteLength(name) > 100) {
    const slash = name.lastIndexOf('/', name.length - 2)
    prefix = name.slice(0, slash)
    short = name.slice(slash + 1)
  }

  put(0, 100, short)
  put(100, 8, octal(mode, 8))
  put(108, 8, octal(0, 8))
  put(116, 8, octal(0, 8))
  put(124, 12, octal(size, 12))
  put(136, 12, octal(mtime, 12))
  block.fill(0x20, 148, 156)
  put(156, 1, type)
  put(157, 100, linkname)
  put(257, 6, 'ustar\0')
  put(263, 2, '00')
  put(345, 155, prefix)

  let sum = 0

  for (const byte of block) {
    sum += byte
  }

  put(148, 8, `${sum.toString(8).padStart(6, '0')}\0 `)

  return block
}

/** True when `name` fits a plain ustar header (ASCII; name <= 100 bytes or prefix <= 155 + name <= 100). */
function fitsUstar(name, linkname = '') {
  if (!/^[\x20-\x7e]*$/.test(name + linkname) || linkname.length > 100) {
    return false
  }

  if (name.length <= 100) {
    return true
  }

  const slash = name.lastIndexOf('/', name.length - 2)

  return slash > 0 && slash <= 155 && name.length - slash - 1 <= 100
}

function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`
  let length = Buffer.byteLength(body)

  while (String(length).length + Buffer.byteLength(body) !== length) {
    length = String(length).length + Buffer.byteLength(body)
  }

  return `${length}${body}`
}

const pad512 = size => Buffer.alloc((512 - (size % 512)) % 512)

function tarEntry(chunks, { name, mode, data, mtime, type, linkname = '' }) {
  if (!fitsUstar(name, linkname)) {
    const records = Buffer.from(paxRecord('path', name) + (linkname ? paxRecord('linkpath', linkname) : ''), 'utf8')
    chunks.push(header({ name: 'PaxHeader', mode: 0o644, size: records.length, mtime, type: 'x' }), records)
    chunks.push(pad512(records.length))
    name = name.replace(/[^\x20-\x7e]/g, '_').slice(-100)
    linkname = linkname.replace(/[^\x20-\x7e]/g, '_').slice(-100)
  }

  chunks.push(header({ name, mode, size: data.length, mtime, type, linkname }))

  if (data.length) {
    chunks.push(data, pad512(data.length))
  }
}

/** The tar of `files` under `<top>/`: directories first in path order, then files, all sorted, owner 0:0. */
export function tarOf(files, { top, mtime }) {
  const chunks = []
  const dirs = new Set([top])

  for (const file of files) {
    const parts = file.path.split('/')

    for (let i = 1; i < parts.length; i++) {
      dirs.add(`${top}/${parts.slice(0, i).join('/')}`)
    }
  }

  const byBytes = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))
  const empty = Buffer.alloc(0)

  for (const dir of [...dirs].sort(byBytes)) {
    tarEntry(chunks, { name: `${dir}/`, mode: 0o755, data: empty, mtime, type: '5' })
  }

  for (const file of files) {
    const name = `${top}/${file.path}`

    if (file.mode === 'link') {
      tarEntry(chunks, { name, mode: 0o777, data: empty, mtime, type: '2', linkname: file.data.toString('utf8') })
    } else {
      tarEntry(chunks, { name, mode: file.mode === '755' ? 0o755 : 0o644, data: file.data, mtime, type: '0' })
    }
  }

  chunks.push(Buffer.alloc(1024))

  return Buffer.concat(chunks)
}

/** gzip of `data` as stored deflate blocks: byte-identical output for the same input, whatever zlib is installed. */
export function gzipStored(data) {
  const blocks = [Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0x00, 0xff])]
  const MAX = 0xffff

  for (let at = 0; at < data.length || at === 0; at += MAX) {
    const chunk = data.subarray(at, Math.min(at + MAX, data.length))
    const head = Buffer.alloc(5)
    head[0] = at + MAX >= data.length ? 1 : 0
    head.writeUInt16LE(chunk.length, 1)
    head.writeUInt16LE(~chunk.length & 0xffff, 3)
    blocks.push(head, chunk)

    if (data.length === 0) {
      break
    }
  }

  const tail = Buffer.alloc(8)
  tail.writeUInt32LE(crc32(data) >>> 0, 0)
  tail.writeUInt32LE(data.length >>> 0, 4)
  blocks.push(tail)

  return Buffer.concat(blocks)
}

/**
 * K-RT10 (lead decision): the tarball is compressed by Node's own zlib at level 9 — the same bytes for the same input and
 * the same zlib build. The header carries mtime 0 and no name (Node's default); the OS byte, which zlib sets per
 * platform (19 on macOS, 3 on Linux), is set to 255 ("unknown") so the bytes do not depend on where the build ran. The
 * pin records the zlib build (`gzip`); a build with another one is refused before any sha comparison.
 */
export const GZIP_LEVEL = 9
export const gzipIdentity = () => `zlib ${process.versions.zlib} level ${GZIP_LEVEL}`

export function gzipDeterministic(data) {
  const out = gzipSync(data, { level: GZIP_LEVEL })
  out[9] = 0xff

  return out
}

export const tarballName = sha => `hermes-agent-${sha}.tar.gz`

/** Ruling 57.2: V3-FX's exclusion list (the source of truth, not shipped) and the copy PM ships and applies. */
export const FX_EXCLUSIONS_FILE = 'iclone/telemetry/runtime-venv-exclusions.txt'
export const PM_EXCLUSIONS_FILE = 'pm/runtime-venv-exclusions.txt'

const exclusionNames = text =>
  text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .sort()

/**
 * Ruling 57.2: why the runtime of `sha` must not be packed (empty = it may): V3-FX's list and the list PM ships are
 * both read from git at `sha`, and must name the same distributions. A missing or empty list refuses (fail closed).
 */
export function venvExclusionProblems(sha, { cwd = REPO_ROOT } = {}) {
  const lists = {}

  for (const rel of [FX_EXCLUSIONS_FILE, PM_EXCLUSIONS_FILE]) {
    const out = spawnSync('git', ['cat-file', 'blob', `${sha}:${rel}`], { cwd, maxBuffer: 1 << 20 })
    // No blob at `sha` reads as an empty list: the comparison below only ever sees arrays.
    lists[rel] = out.status === 0 ? exclusionNames(out.stdout.toString('utf8')) : []
  }

  // Fail closed: a list git has no blob for, or that names nothing, refuses before any comparison.
  const missing = Object.entries(lists)
    .filter(([, names]) => !names?.length)
    .map(([rel]) => `the telemetry exclusion list ${rel} is missing or empty`)

  if (missing.length) {
    return missing
  }

  const [fx, shipped] = [lists[FX_EXCLUSIONS_FILE], lists[PM_EXCLUSIONS_FILE]]

  return fx.join('\n') === shipped.join('\n')
    ? []
    : [
        `${PM_EXCLUSIONS_FILE} (${shipped.join(', ')}) does not name the distributions of ${FX_EXCLUSIONS_FILE} (${fx.join(', ')})`
      ]
}

/** The whole artifact of `rev`, in memory: tarball, manifest and the installer that ships inside it. */
export function buildRuntimeArtifact({
  cwd = REPO_ROOT,
  python = null,
  rev = 'HEAD',
  upstream = readUpstreamPin()
} = {}) {
  const sha = resolveCommit(rev, cwd)
  const committed = Number(String(git(['show', '-s', '--format=%ct', sha], { cwd })).trim())
  const sources = shippedFiles(sha, { cwd })
  const compiled = python ? compilePycs(sources, { python }) : null
  const files = [...sources, ...(compiled?.pycs ?? [])].sort((a, b) =>
    Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))
  )
  const installSh = files.find(file => file.path === INSTALL_SH)

  for (const required of ['pyproject.toml', INSTALL_SH, 'hermes_cli/iclone_policy_env.py']) {
    if (!files.some(file => file.path === required)) {
      throw new Error(`the runtime of ${sha.slice(0, 12)} has no ${required}`)
    }
  }

  const excluded = venvExclusionProblems(sha, { cwd })

  if (excluded.length) {
    throw new Error(`the runtime of ${sha.slice(0, 12)} is not packed: ${excluded.join('; ')}`)
  }

  const manifest = manifestOf(files, {
    python: compiled?.python ?? null,
    pycs: compiled?.pycs.length ?? 0,
    sha,
    upstream
  })
  const manifestBytes = Buffer.from(manifestText(manifest), 'utf8')
  const tarball = gzipDeterministic(tarOf(files, { top: `hermes-agent-${sha}`, mtime: committed }))

  return {
    sha,
    gzip: gzipIdentity(),
    node: process.version,
    python: compiled?.python ?? null,
    pythonBuild: python ? pythonBuildIdentity(python) : null,
    pycs: compiled?.pycs.length ?? 0,
    pycFailed: compiled?.failed ?? [],
    date: new Date(committed * 1000).toISOString().slice(0, 10),
    files: manifest.files,
    bytes: manifest.bytes,
    manifest,
    manifestBytes,
    manifestSha256: sha256(manifestBytes),
    tarball,
    tarballSha256: sha256(tarball),
    installSh: installSh.data,
    installShSha256: sha256(installSh.data)
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// RT-5: the bundled runtime IS the repository at the build commit
// ---------------------------------------------------------------------------------------------------------------------

/** Every regular file and link of a tar.gz (ustar + pax), as manifest rows `[path, mode, size, sha256]` under `top/`. */
export function tarRows(tarGz, top) {
  const tar = gunzipSync(tarGz)
  const rows = []
  let at = 0
  let pax = {}

  const field = (offset, width) => {
    const raw = tar.subarray(at + offset, at + offset + width)
    const end = raw.indexOf(0)

    return raw.subarray(0, end < 0 ? width : end).toString('utf8')
  }

  while (at + 512 <= tar.length) {
    if (tar.subarray(at, at + 512).every(byte => byte === 0)) {
      break
    }

    const size = parseInt(field(124, 12).trim() || '0', 8)
    const type = field(156, 1) || '0'
    const prefix = field(345, 155)
    const name = pax.path ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100))
    const linkname = pax.linkpath ?? field(157, 100)
    const mode = parseInt(field(100, 8).trim() || '0', 8)
    const body = tar.subarray(at + 512, at + 512 + size)
    at += 512 + Math.ceil(size / 512) * 512

    if (type === 'x') {
      pax = {}

      for (const record of body.toString('utf8').split('\n')) {
        const eq = record.indexOf('=')
        const space = record.indexOf(' ')

        if (eq > space && space > 0) {
          pax[record.slice(space + 1, eq)] = record.slice(eq + 1)
        }
      }

      continue
    }

    pax = {}

    if (!name.startsWith(`${top}/`)) {
      throw new Error(`tar entry outside ${top}/: ${name}`)
    }

    const rel = name.slice(top.length + 1)

    if (type === '5') {
      continue
    }

    if (type === '2') {
      rows.push([rel, 'link', Buffer.byteLength(linkname), sha256(Buffer.from(linkname))])
    } else if (type === '0') {
      rows.push([rel, mode & 0o111 ? '755' : '644', size, sha256(body)])
    } else {
      throw new Error(`tar entry ${rel} has type ${type}; only files, folders and links ship`)
    }
  }

  return rows.sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])))
}

function diffRows(want, got) {
  const a = new Map(want.map(row => [row[0], JSON.stringify(row)]))
  const b = new Map(got.map(row => [row[0], JSON.stringify(row)]))
  const out = []

  for (const [path, row] of a) {
    if (!b.has(path)) out.push(`missing ${path}`)
    else if (b.get(path) !== row) out.push(`differs ${path}`)
  }

  for (const path of b.keys()) {
    if (!a.has(path)) out.push(`extra ${path}`)
  }

  return out
}

/**
 * RT-5: every reason the bundle in `dir` is not the repository at `rev` (empty = it is). Checks, in order: the pin is a
 * repo pin (an upstream tarball is refused); the bundled tarball, manifest and installer hash to the pin; the tarball's
 * entries ARE the manifest; the manifest's files ARE the git content of the shipped set at `rev`; the iclone core and
 * plugins are in it.
 */
export const REQUIRED_ICLONE_PATHS = Object.freeze(
  Object.entries(ICLONE_RUNTIME_PATHS)
    .filter(([, cls]) => cls === 'core' || cls === 'plugin')
    .map(([path]) => path)
)

export function runtimeEqualsRepo({
  cwd = REPO_ROOT,
  dir,
  pin,
  python = null,
  required = REQUIRED_ICLONE_PATHS,
  rev = 'HEAD'
}) {
  const problems = []

  if (pin.source !== 'repo') {
    return [
      `the pinned runtime is not built from this repository (source ${pin.source ?? 'upstream'}, sha ${String(pin.sha).slice(0, 12)})`
    ]
  }

  const read = name => {
    try {
      return readFileSync(join(dir, name))
    } catch {
      problems.push(`missing ${name}`)

      return null
    }
  }

  const tarball = read(tarballName(pin.sha))
  const manifestBytes = read(RUNTIME_MANIFEST_FILE)
  const installSh = read('install.sh')

  if (problems.length) {
    return problems
  }

  // Review r1, major D: the ruling-57.2 gate (the list PM ships must name exactly the V3-FX list) ran ONLY inside
  // buildRuntimeArtifact, at the build rev — and the packer always builds at pin.sha, where the two lists agree by
  // construction. Since `iclone/telemetry/runtime-venv-exclusions.txt` is OUTSIDE the shipped set, a change to it
  // after the pin neither stales the pin nor reaches the packer, so the refusal could be walked around by landing it
  // late. `check` now runs the same gate against the commit it is checking, which is the one that ships.
  for (const problem of venvExclusionProblems(resolveCommit(rev, cwd), { cwd })) {
    problems.push(problem)
  }

  if (sha256(tarball) !== pin.tarball_sha256) problems.push('tarball sha256 is not the pin')
  if (sha256(manifestBytes) !== pin.manifest_sha256) problems.push('manifest sha256 is not the pin')
  if (sha256(installSh) !== pin.install_sh_sha256) problems.push('install.sh sha256 is not the pin')

  let manifest

  try {
    manifest = parseManifest(manifestBytes.toString('utf8'))
  } catch (error) {
    return [...problems, `manifest: ${error.message}`]
  }

  if (manifest.sha !== pin.sha || manifest.files !== pin.files) {
    problems.push(
      `manifest names ${manifest.sha.slice(0, 12)} / ${manifest.files} files, the pin ${pin.sha.slice(0, 12)} / ${pin.files}`
    )
  }

  const inTar = diffRows(manifest.entries, tarRows(tarball, `hermes-agent-${pin.sha}`))

  if (inTar.length) {
    problems.push(`the tarball is not the manifest (${inTar.length}: ${inTar.slice(0, 5).join(', ')})`)
  }

  // The bytecode is re-compiled from HEAD's sources with the pin's Python (ruling 37): a pyc that is not what those
  // sources compile to is as much a difference as a changed source.
  if (manifest.python && !python) {
    return [
      ...problems,
      `the bundle ships Python ${manifest.python} bytecode; re-verifying it needs that Python (ICLONE_RUNTIME_PY)`
    ]
  }

  const sources = shippedFiles(rev, { cwd })
  const compiled = manifest.python ? compilePycs(sources, { python }) : null

  if (compiled && compiled.python !== manifest.python) {
    return [...problems, `bytecode compiled by Python ${compiled.python}, the bundle's by ${manifest.python}`]
  }

  const head = manifestOf([...sources, ...(compiled?.pycs ?? [])], {
    sha: manifest.sha,
    upstream: manifest.upstream
  })
  const inRepo = diffRows(head.entries, manifest.entries)

  if (inRepo.length) {
    problems.push(
      `the bundled runtime is not the repository at ${resolveCommit(rev, cwd).slice(0, 12)} (${inRepo.length}: ${inRepo
        .slice(0, 5)
        .join(', ')}); rebuild the pin: node scripts/runtime-artifact.mjs pin`
    )
  }

  const shipped = new Set(manifest.entries.map(row => row[0]))
  const lost = required.filter(path => !shipped.has(path))

  if (lost.length) {
    problems.push(`the iclone core is not all in the runtime (missing ${lost.join(', ')})`)
  }

  return problems
}

export const PIN_FILE = join(REPO_ROOT, 'iclone', 'RUNTIME_PIN.json')
const CONTRACT = join(REPO_ROOT, 'iclone', 'contract')

/** The pin record of an artifact (`verified` is filled from the contract lock by `repin`, never typed by hand). */
export function pinRecord(artifact, { minApp, verified }) {
  return {
    sha: artifact.sha,
    date: artifact.date,
    ...(artifact.python ? { python: artifact.python, pycs: artifact.pycs } : {}),
    ...(artifact.pythonBuild ? { python_build: artifact.pythonBuild } : {}),
    gzip: artifact.gzip,
    node: artifact.node,
    source: 'repo',
    upstream: artifact.manifest.upstream,
    tarball_sha256: artifact.tarballSha256,
    tarball_bytes: artifact.tarball.length,
    install_sh_sha256: artifact.installShSha256,
    manifest_sha256: artifact.manifestSha256,
    files: artifact.files,
    bytes: artifact.bytes,
    min_app: minApp,
    verified
  }
}

function run(command, args, { cwd = REPO_ROOT } = {}) {
  const out = spawnSync(command, args, { cwd, stdio: ['ignore', 'inherit', 'inherit'] })

  if (out.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${out.status}`)
  }
}

/**
 * Re-pins the runtime to `rev`: builds the artifact, re-extracts the provider spec at that commit (served.py), the
 * contract lock (extract.mjs, whose verifiedAgainst becomes `rev` with its COMPUTED verdict), writes the pin record with
 * that verdict, and regenerates the types (gen-types.mjs and --runtime-pin). One truth for all four files.
 */
export function repin({
  rev = 'HEAD',
  python = process.env.PYTHON || 'python3',
  runtimePython = findRuntimePython(readLockPython()),
  log = console.log
} = {}) {
  const artifact = buildRuntimeArtifact({ python: runtimePython, rev })
  const previous = JSON.parse(readFileSync(PIN_FILE, 'utf8'))

  run(python, [
    '-B',
    join(CONTRACT, 'served.py'),
    '--repo',
    REPO_ROOT,
    '--rev',
    artifact.sha,
    '--out',
    join(CONTRACT, 'runtime.spec.json')
  ])
  run(process.execPath, [join(CONTRACT, 'extract.mjs')])

  const against = JSON.parse(readFileSync(join(CONTRACT, 'runtime.lock.json'), 'utf8')).verifiedAgainst

  if (against?.rev !== artifact.sha || !/^(green|amber|red|unknown):\d+-roots$/.test(against?.result ?? '')) {
    throw new Error(`the contract lock is not verified against ${artifact.sha} (${JSON.stringify(against)})`)
  }

  writeFileSync(
    PIN_FILE,
    `${JSON.stringify(pinRecord(artifact, { minApp: previous.min_app, verified: against.result }), null, 2)}\n`
  )
  run(process.execPath, [join(CONTRACT, 'gen-types.mjs')])
  run(process.execPath, [join(CONTRACT, 'gen-types.mjs'), '--runtime-pin'])
  log(
    `[runtime-artifact] pinned ${artifact.sha}: ${artifact.files} files, ${artifact.bytes} bytes, tarball ` +
      `${artifact.tarball.length} bytes sha256 ${artifact.tarballSha256}, manifest ${artifact.manifestSha256}, verified ${against.result}`
  )

  return artifact
}

function argValue(argv, name, fallback) {
  const i = argv.indexOf(name)

  return i >= 0 ? argv[i + 1] : fallback
}

if (isMain(import.meta.url)) {
  const [command, ...argv] = process.argv.slice(2)

  if (command === 'inventory') {
    const result = inventory({
      rev: argValue(argv, '--rev', 'HEAD'),
      upstream: argValue(argv, '--upstream', undefined)
    })
    const counts = {}

    for (const row of result.rows) {
      counts[row.class] = (counts[row.class] ?? 0) + 1
    }

    for (const row of result.rows) {
      console.log(`${row.class.padEnd(11)} ${row.status.padEnd(8)} ${row.path}`)
    }

    console.log(
      `[runtime-artifact] inventory ${result.rev.slice(0, 12)} vs upstream ${result.upstream.slice(0, 12)}: ` +
        `${result.shipped} shipped files, ${result.rows.length} differ (${Object.entries(counts)
          .map(([k, v]) => `${k} ${v}`)
          .join(', ')}); drift ${result.drift.length}, stale ${result.stale.length}`
    )

    if (result.stale.length) {
      console.error(`[runtime-artifact] iclone rows that no longer differ: ${result.stale.join(', ')}`)
    }

    process.exit(result.drift.length || result.stale.length ? 1 : 0)
  }

  if (command === 'build') {
    const out = argValue(argv, '--out', null)

    if (!out) {
      console.error('build needs --out <dir>')
      process.exit(64)
    }

    // Critic r1 m6: the build CLI makes the pinned artifact (bytecode by the pin's CPython), or nothing.
    const artifact = buildRuntimeArtifact({
      python: findRuntimePython(readLockPython()),
      rev: argValue(argv, '--rev', 'HEAD')
    })
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, tarballName(artifact.sha)), artifact.tarball)
    writeFileSync(join(out, RUNTIME_MANIFEST_FILE), artifact.manifestBytes)
    console.log(
      `[runtime-artifact] ${tarballName(artifact.sha)}: ${artifact.files} files, ${artifact.tarball.length} bytes, ` +
        `sha256 ${artifact.tarballSha256}, manifest ${artifact.manifestSha256}`
    )
    process.exit(0)
  }

  if (command === 'check') {
    assertCleanShippedTree('check')
    const pin = JSON.parse(readFileSync(PIN_FILE, 'utf8'))
    const dir = argValue(argv, '--dir', join(REPO_ROOT, 'apps', 'desktop', 'build', 'hermes-runtime'))
    const problems = runtimeEqualsRepo({
      dir,
      pin,
      python: pin.python ? findRuntimePython(pin.python) : null,
      rev: argValue(argv, '--rev', 'HEAD')
    })

    for (const problem of problems) {
      console.error(`[runtime-artifact] RED ${problem}`)
    }

    console.log(
      problems.length
        ? `[runtime-artifact] check: ${problems.length} problem(s)`
        : `[runtime-artifact] check: ${dir} is the repository at ${argValue(argv, '--rev', 'HEAD')} (${pin.files} files, manifest ${pin.manifest_sha256.slice(0, 12)})`
    )
    process.exit(problems.length ? 1 : 0)
  }

  if (command === 'pin') {
    assertCleanShippedTree('pin')
    repin({ rev: argValue(argv, '--rev', 'HEAD'), python: argValue(argv, '--python', undefined) })
    process.exit(0)
  }

  console.error(
    'usage: node scripts/runtime-artifact.mjs inventory|build|check|pin [--rev <commit>] [--upstream <commit>] [--out <dir>] [--python <exe>]'
  )
  process.exit(64)
}
