# Track A — updating the Hermes runtime

> **You never run `hermes update` — not on your own, not when the user asks.** The update is the
> user's: Settings › Updates › Agent checks Nous Research on the user's click and, on a second confirmed click, runs
> `hermes update --yes --backup --branch main` through the fork's own hand-off script (full backup first, iclone os
> closes and reopens, no app swap). Your part is to tell the user when the agent is behind (from
> `agent-update-last-check.json` when its `checkedAt` is under 24 h old, else the read-only `hermes update --check`) and
> to open the pane (`it open settings updates`, or the chat link `iclone://open/settings?tab=app-atualisation`). "Update
> it" is answered with the pane, never with a command. Everything below explains what the pane runs and how to read its
> log; of it, only the read-only `--check` and `--plan` are ever yours to run.

`~/.hermes/hermes-agent` is the backend and CLI: **the python that IS you**.
`hermes update` is a real pull of `NousResearch/hermes-agent` plus a dependency
reinstall. It is what the pane's *Update to vX…* runs, and it is safe *when the
pre-flight passes*.

Never hand-patch files in that tree instead. `hermes update` stashes local
edits and, with `--keep-stash` (which the desktop always passes), never gives
them back.

## The shape of the install

    git origin   NousResearch/hermes-agent, branch main
    clone        FULL today (43,945 commits on 2026-09-26); it was SHALLOW
                 (--depth 1) through at least 2026-08-30
    HERMES_HOME  ~/.hermes  — state lives here, NOT in the checkout

Check which one you are on before quoting either rule below:

    git -C ~/.hermes/hermes-agent rev-parse --is-shallow-repository

**On a shallow clone, local counts lie.** A shallow graph cannot measure
distance, which is why `hermes update --check` asks GitHub's compare API
instead. On the full clone `git rev-list --count HEAD..origin/main` is honest
again — after a fetch.

**When history diverged, a pull is a reset.** The updater fast-forwards when it
can; with no usable ancestry (the shallow clone of 2026-08-30) it cannot:

    → Found 487 new commit(s)
    → Pulling updates...
      ⚠ Fast-forward not possible (history diverged), resetting to match remote...

`reset --hard` destroys local commits outright, and `--keep-stash` parks
uncommitted edits where nothing restores them. This is why the clean-tree gate
is a stop and not a warning, full clone or not.

## The flags

| Flag | What it does | Use it? |
|---|---|---|
| `--plan` | Prints install kind, version@sha, every running service and how each restarts. **Documented read-only, safe on a live fleet.** | Always, first |
| `--check` | Behind-count via the GitHub compare API | Always |
| `--yes` | Answers the config-migration and stash prompts. API-key entry is skipped by design — `hermes config migrate` separately if needed | Yes |
| `--backup` | Forces the FULL pre-update backup: quick state snapshot under `state-snapshots/` **plus** `~/.hermes/backups/pre-update-<ts>.zip`, restorable with `hermes import` | **Mandatory here — see below** |
| `--keep-stash` | Stashes local edits and does NOT restore them. The desktop passes this so source edits never ride along | Only if you mean it |
| `--gateway` | Switches prompts to file-based IPC for the GUI | **Never from a terminal** — it looks like a hang |
| `--no-backup` | Disables both backups | **Never** |
| `--branch NAME` | Update against another branch, switching (and auto-stashing) if needed | The pane passes `main`; never yours |

### `--backup` is not optional on this machine

Until 2026-09-26 `~/.hermes/config.yaml` said `pre_update_backup: false`, and
the resolver (`update_cmd.py:_resolve_pre_update_backup_mode`) maps a legacy
`false` to mode **`off`** — which disables the quick state snapshot too, not
just the zip. The line now reads `pre_update_backup: full`. The flag is checked
*before* the config and wins:

    if getattr(args, "no_backup", False): return "off"
    if getattr(args, "backup",    False): return "full"   # config never consulted

So on this machine, an update run without `--backup` used to produce **no
recoverable pre-update state at all** — and it did: every in-app update from
Earlier runs used `--yes --gateway --keep-stash --branch main` with
`pre_update_backup: false ("disabled or failed")` in its receipt. On 2026-09-26
the config line was changed to `pre_update_backup: full` (a dated backup of
config.yaml sits beside it), so the in-app button now takes both backups by
itself. Keep passing `--backup` from a terminal anyway: the flag beats the
config, and a future config migration could reset the line.

### On macOS, you are the only safety gate

Every process-safety check in the updater is Windows-only dead code here.
`_detect_venv_python_processes` opens with

    if not _m()._is_windows():
        return []

and the holder gate behaves the same way; Electron's `releaseBackendLock`
short-circuits on `if (!IS_WINDOWS)`. **Nothing will stop you rewriting the
venv underneath a live backend.** Quitting the apps and killing the surviving
`hermes_cli.main serve` is not politeness — it is the entire protection.

### The in-app button can replace the app itself

The in-app button hands off to `scripts/desktop-update/posix.sh`:

    posix.sh --install-root <root> --branch main --desktop-pid <pid> [--relaunch-target <the running .app>]

which waits for the desktop to exit and runs
`hermes update --yes --gateway --keep-stash --branch main` (no `--backup`: the
backup follows the config). `--relaunch-target` is permission to REPLACE that
bundle: `mac_swap()`
dittos `<install root>/apps/desktop/release/**/Hermes.app` over it and deletes
the `.old` copy on success. Upstream can assume the running app is the app that
repo builds. Here it is not — the owner runs `/Applications/iclone os.app`
while the install root builds a stock `Hermes.app`. Unguarded, the upstream
update flow inside iclone os replaces iclone os with Hermes, unrecoverably.

The fork guards this (`electron/update-swap-guard.ts`). The rule is product
identity, not location: the running bundle is offered as the relaunch target
only when it IS what the updater rebuilds — inside that release tree, or
carrying the same bundle name. Upstream's own flow (an installed `Hermes.app`
kept fresh by its own updater) is untouched; `iclone os.app` is never handed
over. When the guard refuses, the update still runs and the app simply does not
relaunch: iclone os quits and STAYS closed — reopen it from `/Applications`
(the progress screen's "it restarts automatically" is wrong for this fork).
**If you ever see that guard removed, or an `iclone os.app.old` appear beside
the app, stop and tell the owner.**

From a terminal the equivalent, minus the GUI IPC and the swap, is:

    cd ~/.hermes/hermes-agent && hermes update --yes --backup

## The procedure

1. **`bash scripts/preflight.sh`** — every gate plus both backups. A non-zero
   exit is a stop. Then pin the SHA — a reset is untagged, and a tag is the
   cheapest rollback pointer there is:

       git -C ~/.hermes/hermes-agent tag pre-update-$(date +%Y%m%d) HEAD

2. **Quit what holds the runtime open.** Killing a desktop app does NOT kill
   its `hermes_cli.main serve` child; check and kill it too.
3. **Run it from the install root** — the updater resolves the tree it mutates
   from the working directory.
4. **Read the whole log.** Not the exit code: a desktop GUI build failure is
   reported *non-fatal* and the run still exits 0.
5. **`bash scripts/verify.sh`** — then do the three things a script cannot see.

## What a good run looks like

A run of 487 commits, abridged (the shape, not one machine's numbers):

    ◆ Pre-update snapshot: <timestamp>-pre-update
    ◆ Creating pre-update backup...
      Saved:    ~/.hermes/backups/pre-update-<timestamp>.zip (about 100 MB, a few seconds)
      Restore:  hermes import <that path>
    → Found 487 new commit(s)
      ⚠ Fast-forward not possible (history diverged), resetting to match remote...
      ✓ Cleared 120 stale __pycache__ directories
    → Updating Python dependencies...
    → Refreshing 16 active lazy backend(s)...   ✓ 15 already current
    → Updating Node.js dependencies...  ✓ ui-tui, web workspaces installed (desktop skipped)
    → Building web UI...                ✓ Web UI built
    → Checking if desktop app needs rebuilding...  ✓ Desktop app up to date
    ✓ Code updated! [main @ 4f2254350]
    → Syncing bundled skills...
      + 1 new: github
      ↑ 16 updated: ...
      − 25 removed from manifest
      → 2 moved to new upstream paths: codebase-inspection, blocked-page-recovery
    → Checking configuration for new options...  ✓ Configuration is up to date
    ✓ Update complete! (v0.20.6) [main @ 4f2254350]

**Telling afterwards which path was used:** read the receipt,
`~/.hermes/logs/update_receipts/latest.json` (schema 1, no secrets; the dated
`update_*.json` beside it keep the history). `argv` carries `--gateway` for the
in-app button and not for a terminal run; `pre_update` / `post_update` give the
sha and version on each side; the `pre_update_backup` step (or skip) says
whether a backup was taken. Settings → App Atualisation → Runtime shows the
same facts. Older signals still hold: a populated `~/.hermes/logs/update.log`
proves `--gateway` was NOT passed, and without
`~/.hermes/logs/desktop-update-handoff.log` `posix.sh` never ran.

Take the skills sync seriously. "− 25 removed from manifest" and "moved to new
upstream paths" both look like deletions in a bare `ls`. Only a diff against
the pre-flight snapshot tells them apart — `verify.sh` does exactly that. On
this run: 86 → 87 skills, two moved category, one genuinely new, **none of the
owner's `iclone/` skills touched**.

## Compatibility with the app above

Both `Hermes.app` and `/Applications/iclone os.app` run this same runtime —
`electron/main.ts` sets `ACTIVE_HERMES_ROOT = HERMES_HOME/hermes-agent`. So a
Track A update swaps the backend under an iclone os renderer that was built
from the OLD upstream point.

Check the surface actually held before trusting it. Both of these were run
across the 487-commit delta on 2026-08-30:

    # every /api route the backend exposes, at the old base vs upstream tip
    #   -> 227 before, 227 after, 0 removed, 0 added
    # every stream event the renderer switches on
    #   -> 50 checked, none present-then-absent

If a route or event the renderer consumes disappears, it is a **Track B
problem before it is a Track A one**: funnel the change into the fork first.

## Rollback

    osascript -e 'tell application id "io.cloneframe.icloneos" to quit'
    pkill -f "hermes_cli.main serve"
    rm -rf ~/.hermes/hermes-agent
    cp -Rc ~/.hermes-update-backups/hermes-agent-<SHA> ~/.hermes/hermes-agent

The clone restores code, venv and `node_modules` **together** — which is the
point: reverting code alone leaves a venv built for the newer dependency set.

Be honest about what this does not undo: everything written **outside** the
checkout — a migrated `config.yaml`, a migrated state DB schema, rewritten
pairing or cron entries, the bundled-skills sync. That is what the
`--backup` zip is for:

    hermes import ~/.hermes/backups/pre-update-<timestamp>.zip

Restore it deliberately. Do not assume the code rollback covered it.

## The five that actually go wrong

1. **Dirty tree, silently lost.** A diverged pull *resets*; `--keep-stash`
   *parks*. Tell: local commits gone, or `git stash list` grew. Remedy:
   `git stash show -p stash@{0}` and decide with the owner. Prevention: the
   pre-flight gate — this is why it is a stop.
2. **A stale backend survives the app.** Tell: `pgrep -f "hermes_cli.main
   serve"` still returns a pid after both apps quit; the UI shows 503 "Restart
   required" or empty panes. Remedy: kill it, relaunch.
3. **The GUI build failed and the updater called it non-fatal.** Tell: the app
   launches on old assets or not at all, while the run exited 0. Remedy:
   rebuild from the install root; if that fails, roll back and funnel.
4. **A skill vanished in the bundled sync.** Tell: `verify.sh` reports a
   `SKILL.md` gone that the log did not list as moved. Remedy: copy it back
   from the pre-flight state snapshot.
5. **A config migration changed behaviour.** Tell: a provider, model or
   approval setting reads differently afterwards. Remedy: compare against the
   state snapshot and surface the diff. **Never edit `~/.hermes/config.yaml`
   yourself.**
