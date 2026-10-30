# iclone os agent skills

The skills that teach the Hermes agent how to work on **this** app. They are
the owner's, not upstream's, and they had been living in exactly one place —
`~/.hermes/skills/iclone/` — with no version history and no copy anywhere else.
One `rm -rf`, one bad sync, one new machine, and they were gone. They live here
now; `~/.hermes` is the deploy target, not the source of truth.

| Skill | What it is for |
|---|---|
| `app-atualisation` | Updating the app: the Hermes runtime underneath (`hermes update`) and the curated upstream funnel above it |
| `iclone-os` | The app itself — architecture, invariants, how to change it |
| `agent-self-repo` | Working on the agent's own repo, and the secrets discipline for it |
| `it-orchestration` | Driving the iT terminal multiplexer and its panes |
| `browse-and-work` | Browsing and working the web from the surface the agent actually has |
| `economyos` | Acting on the iNFT's economy — email, wallet, card, Hyperliquid, marketplace — through `~/.iclone-os/bin/acp --inft <iNFT>` (the per-iNFT wrapper the app installs) |
| `agentic-economy` | The map and the law (you operate, the owner spends) — routes every commerce request to the skill that carries its commands |
| `acp-offerings` | What the iNFT sells: offerings, resources (references/links), subscriptions — exact CLI flags, the per-iNFT catalogue JSON, `scripts/publish-catalog.py`, the 40-offering cap |
| `acp-jobs` | Doing a job right on both sides of the escrow: state machine, fund only after `budget_set`, execute → verify → submit with proof, the traps |
| `acp-paid-subscription-checkout` | Paying a subscription with the agent's email + card (issue stays in the owner's terminal), 3DS, receipts |
| `acp-signin` | Signing an iNFT's Virtuals ACP session in (again) from the chat: mint the link, the owner approves it, poll until authenticated |
| `acp-troubleshooting` | 26 cataloged failures (E1–E26) with root causes and validated fixes; the offering schema reference |

## Deploying them

**The app deploys them itself.** On every launch, iclone os copies this
tree (packaged as `Resources/hermes-skill`) into `~/.hermes/skills/iclone/`
and into every iNFT profile's `skills/iclone/` — byte-compared, so an
unchanged skill costs nothing — and moves the retired mini-app skills
(`iclone-mini-*`, plus the pre-isolation `virtuals-protocol-cli`) to
`~/.hermes/skills-retired/<stamp>/`, never deleting anything. Settings →
EconomyOS & iNFT → Setup shows what was taught and has a "re-teach" button.
The engine is `apps/desktop/electron/iclone-skills.ts`; this folder is its
ONE source (there is no second copy under `apps/desktop`).

Hermes reads user skills from `~/.hermes/skills/<category>/<name>/SKILL.md`.
That directory survives `hermes update` — verified on 2026-08-30 across a
487-commit runtime update, which touched only upstream's own bundled skills
(86 → 87, two moved category, one added, none of ours altered). Surviving by
design is still not the same as being backed up.

    cp -R iclone/skills/* ~/.hermes/skills/iclone/
    hermes skills list | grep iclone      # all five should read: local · enabled

Going the other way — after editing a skill live on the machine, which is the
natural way to work on one:

    cp -R ~/.hermes/skills/iclone/* iclone/skills/

Then read the diff before committing. These files instruct an agent that has
shell access on the owner's machine; they deserve the same review as code.

## Two rules for editing them

**Never put a secret in a skill.** They are committed here, they are read by
the agent every session, and they end up in prompt snapshots. `.env` and
`auth.json` are named in these files only as things never to read.

**A skill may only claim what has been verified.** Every command in
`app-atualisation` was run on this machine, and its two scripts —
`scripts/preflight.sh` and `scripts/verify.sh` — were run against the real
487-commit update, not written from the documentation. When a procedure here
turns out to be wrong, fix the skill in the same pass as the problem; a skill
that lies is worse than no skill, because the agent will act on it.
