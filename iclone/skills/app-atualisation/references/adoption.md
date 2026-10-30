# Adoption — the inbox, the ledger, the tickets

Upstream lands hundreds of commits a day; about fourteen change-sets a week
matter to this app. Adoption turns that firehose into a short, ranked,
owner-choosable backlog, and keeps a public record of every choice.

## Files

| Path | Committed | What |
|---|---|---|
| `iclone/upstream/adoption/policy.json` | yes | Ordered rules, first match wins, ending in a `**` catch-all; subject overrides (telemetry lowered to watch, security raised) |
| `iclone/upstream/adoption/features.json` | yes | Our feature areas (≤ 40), each pristine / diverged / replaced / absent |
| `iclone/upstream/adoption/ledger.jsonl` | yes | One line per decision. Public: upstream shas, public subjects, impersonal notes |
| `iclone/upstream/adoption/CURSOR` | yes | The last upstream commit the scan triaged |
| `iclone/upstream/adoption/tickets/ADP-*.md` | yes | One ticket per adopted change-set or compat break |
| `.git/iclone/adoption/backlog.json` | never | The current backlog |
| `userData/iclone-compat/decisions.jsonl` | never | The owner's choices from the pane |

## The scan

`scripts/adoption.sh` runs `adoption.ts scan` over `CURSOR..upstream/main` and
prints the top rows. The scan: extracts commits → classifies by area → drops
noise (tests, formatting, locale, reverts, duplicate patch-ids) → clusters into
change-sets (72 h windows, hub files excluded) → scores relevance against
`features.json` → writes the digest. The inbox shows at most 12 rows; every row
lists the terms that ranked it. An optional one-paragraph summary may come from
the runtime's `llm.oneshot`; it sees subjects and diffstats only, is labelled
as a summary, and never affects the score.

## Dispositions

Each change-set gets exactly one: `adopt`, `watch`, `ignore`,
`defer:<YYYY-MM-DD>`, and later `implemented` or `rejected-after-study`.
Two lanes: `compat` (the runtime contract changed — see `compat.md`) and
`adopt` (a capability we choose to re-implement).

## The ledger line

    {"v":1,"at":"<iso>","by":"owner|policy@2|lead","cs":"CS-<sha>","upstream":["<sha>"],
     "patch_ids":["<id>"],"decision":"adopt","lane":"adopt","ticket":"ADP-0001"}

The app never writes the repo. The pane appends owner choices to
`userData/iclone-compat/decisions.jsonl`; `adoption.ts import` (run by this
skill or the lead) moves them into `ledger.jsonl`. Notes are linted: no
absolute home paths, no token-like strings, no e-mail addresses.

## Tickets and commits

- A compat break files a **P0** ticket that names the culprit upstream shas.
- An adopted change-set files an ADP ticket with the upstream shas, the areas
  it touches and the acceptance checks.
- The commit that closes it carries two trailers:

      Adoption: ADP-0001
      Adopts-Upstream: 9f7f2f28c0

  The ledger then records `implemented` (or `rejected-after-study`, with the
  reason), which closes the ticket.

Upstream code is a reference: read their change, then write ours. Never
cherry-pick it, never copy their file over ours.
