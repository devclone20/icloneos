# Track B — curated adoption

iclone os was imported once from the Nous Research Hermes desktop and is ours
from then on. Upstream keeps shipping power — agent improvements, desktop
capabilities, fixes. This is the ONE process by which that power reaches the
app: **Collect → Funnel → Re-implement → Verify & record**. Upstream code is a
reference: we study a change and write our own implementation in our design.
Nothing is merged or cherry-picked, and our visual identity, names and
organization never change. You drive every stage; the owner decides at the
gates.

Repo: the app's source checkout (`<your project folder>/app`), the icloneOS development repository (the public
release is `devclone20/icloneos`), remote
`upstream` = `NousResearch/hermes-agent` (read-only, fetched for study).

---

## 1 · Collect — facts only, nothing applied

Our root commit is a PARENTLESS import of the upstream tree, so HEAD and
`upstream/main` share **no common ancestor**. `git rev-list --count
HEAD..upstream/main` counts upstream's entire history, and anything three-dot
fails. Two recorded points answer every distance question instead:

| File | Meaning | Moves? |
|---|---|---|
| `iclone/UPSTREAM_BASE` | The import origin (`10b38830`) | Never |
| `iclone/upstream/adoption/CURSOR` | The last upstream commit the adoption scan triaged | After each scan |

Run the scan through the skill's script (≤ 30 lines out, no repo writes):

    bash iclone/skills/app-atualisation/scripts/adoption.sh

It fetches nothing by itself. When `upstream` is older than a day, fetch it
first (`git fetch upstream`, app repo only), then rerun. The scan reads
`CURSOR..upstream/main` incrementally, drops noise (tests, formatting, locale,
reverts, duplicate patch-ids), clusters what remains into change-sets, scores
them for relevance to our feature map, and writes the backlog to
`.git/iclone/adoption/backlog.json` (never committed). Every fetch also runs the
contract check at `upstream/main` (see `compat.md`): a RED result files a P0
ADP ticket before anything else is triaged.

The pane (Settings → App Atualisation → Inbox) shows the same backlog, top 12
rows per week, each with the terms that ranked it.

---

## 2 · Funnel — classify, with the owner

`iclone/upstream/adoption/policy.json` gives every change-set exactly one
disposition, first rule wins:

- **adopt** — power we want: desktop capabilities, performance, security fixes.
- **watch** — relevant but not yet worth the work; it stays in the inbox.
- **ignore** — their CI, their release notes, platforms we do not ship.
- **defer:<date>** — wanted later; it comes back on that date.

Agent and runtime changes (python: agent loop, tools, gateway, providers) reach
the machine through **Track A** (`hermes update`), not through this funnel.
They matter here only when they change the contract — that is the compat lane.

Read the actual diffs (`git show <sha>`) for anything unclear. If it is still
unclear, research it — commit messages, linked PRs, release notes — and never
re-implement what you do not understand. Present the top rows to the owner as a
short table; the owner's choice is the disposition.

---

## 3 · Re-implement — in our design

- **Ours wins, always**: the invariants in SKILL.md. The change's FUNCTION lands
  without its LOOK or naming.
- **Engine logic** we never styled is re-written from upstream's intent, with
  our tests, in our module layout.
- **New features** are skinned with our tokens (`--dt-*`, frosted glass,
  champagne on ink) and registered in OUR structure (the settings registry
  `src/app/settings/panes.tsx`, the home layers) — never bolted on the upstream
  way.

Port upstream's *intent* into *our file*. Never copy their file over ours.

---

## 4 · Verify & record — branch, prove, report

    git checkout -b adoption/<ADP-id>

1. `npx tsc -p . --noEmit` and `npx tsc -p tsconfig.electron.json --noEmit` — clean.
2. `npx eslint <touched files>` and `npx prettier --check <touched files>` — clean.
3. `npx vitest run --project ui` and `--project electron` — green against the
   known baseline. A new failure is yours.
4. `bash iclone/skills/app-atualisation/scripts/contract.sh` — the lock still
   regenerates with a 0 diff, or the diff is the change you meant.
5. Restart the dev app **and** the backend — killing the app does NOT kill
   `hermes_cli.main serve`; a stale backend causes code-skew (503 "Restart
   required", empty panes).
6. Live verification: screenshots of home (stage + dock + island), the three
   themes, Message and Settings. Compare against the invariants.
7. Record the decision: the pane writes owner choices to
   `userData/iclone-compat/decisions.jsonl`; `adoption.ts import` appends them
   to the public `ledger.jsonl` (upstream shas, public subjects, impersonal
   notes). Commit with the trailers `Adoption: ADP-<n>` and
   `Adopts-Upstream: <sha>` (`git commit -F <file>` — never backticks or `$`
   inside `-m`), and push the BRANCH. **Never merge to main and never push main
   without the owner's explicit OK.**

---

## Rebuilding and reinstalling the app afterwards

An adoption is not delivered until the app the owner double-clicks is the new
one:

    cd apps/desktop && npm run install:mac

That builds, installs to `/Applications`, signs at the destination and
registers it with Launch Services. Signing must happen at the destination —
`~/Desktop` is file-provider synced and keeps re-stamping
`com.apple.FinderInfo`, which `codesign` refuses to seal.

**If the working tree is not yours alone.** Another session may have
uncommitted work in this repo. A build reads the whole tree, so building would
ship their unfinished change into the owner's installed app. Do not stash their
files. Build from an isolated worktree at the commit you actually pushed:

    git worktree add -q --detach /tmp/build-wt HEAD
    ln -s "$PWD/node_modules"             /tmp/build-wt/node_modules
    ln -s "$PWD/apps/desktop/node_modules" /tmp/build-wt/apps/desktop/node_modules
    cd /tmp/build-wt/apps/desktop && npm run pack
    # then install that bundle, and: git worktree remove --force /tmp/build-wt

Check `git -C /tmp/build-wt status --short` is empty before trusting the
build: that empty output is the proof you are shipping only what is committed.
