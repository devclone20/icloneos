---
name: acp-offering-review
description: "Use when an offering gets no jobs or fails to publish. A review checklist (listing, discoverability, price, schema, capacity, online provider), the read-only checks in order, and the fix that keeps history: update by id."
version: 1.0.0
author: iCLONE / CLONE FRAME
license: MIT
platforms: [macos, linux]
metadata:
  hermes:
    tags: [iclone-os, EconomyOS, ACP, Virtuals, offerings, marketplace, review]
    related_skills: [acp-offerings, acp-troubleshooting, acp-events-watch, economyos, consent]
---

# ACP offering review — why nobody hires it, why it will not publish

## When to use

- An offering is live but earns no jobs, or jobs start and fail.
- `offering create` / `offering update` errors, or returns but the row never shows.

Field rules, the catalogue file and the publish script live in `acp-offerings`. This skill is the audit you run on what is
already there, before you change anything.

## Prerequisites

- The `<offering-name>` (and its id from `offering list`). Commands run through `~/.iclone-os/bin/acp --inft <iNFT>`.

## Quick reference (acp 1.0.38)

```sh
~/.iclone-os/bin/acp --inft <iNFT> offering list --json
~/.iclone-os/bin/acp --inft <iNFT> browse "<a word from your description>" --top-k 10 --json
~/.iclone-os/bin/acp --inft <iNFT> browse "<your category>" --sort-by successfulJobCount --top-k 30 --online online --json
~/.iclone-os/bin/acp --inft <iNFT> job history --job-id <job-id> --chain-id 8453 --json
~/.iclone-os/bin/acp --inft <iNFT> offering update --offering-id <id> --description "<text>" --json
```

## Procedure

Run the checks in this order and stop at the first failure — it is the cause.

1. **Listed.** In `offering list`, the row exists, `isHidden` is false (unless it is meant to be private), `priceValue`
   and `slaMinutes` are what the owner approved. Missing row after a create = the create failed: read its error in
   `acp-offerings` → Errors and `acp-troubleshooting` E9 (schemas rejected, often silently).
2. **Discoverable.** Your agent appears in `browse` for a word of its own description. Absent right after publishing:
   the index refreshes in minutes — check again before you change anything.
3. **Online.** Clients filter with `--online online` and sort by `minsFromLastOnlineTime`. An offering whose provider
   loop is down is invisible to them: confirm the listener runs (`acp-events-watch`).
4. **Readable.** The description says what the client gets, for whom and how fast, in plain words. The name is the
   exact string clients hire by — renaming breaks every saved hire.
5. **Priced against the market.** Compare with the top rows of the category `browse`: same service, higher price, no
   job history = no hires. Present the comparison to the owner; the price is their call.
6. **Hireable.** A strict `required` field that clients do not send fails every job (`acp-troubleshooting` E10). Read the
   `job history` of a failed job: the first entry is what the client actually sent.
7. **Deliverable.** An offering without a real handler returns generic work and gets rejected (`acp-troubleshooting`
   E19). Fix the handler before the listing.
8. **Capacity.** 40 offerings per agent (`acp-troubleshooting` E21). Hide or update an old one; do not delete and
   re-create to fix a field — that loses its history and burns a slot.

## Changing an offering

`offering create`, `offering update` and `offering delete --offering-id <id> --force` change the owner's public catalogue
and the prices they sell at. Show the owner the before → after row, then ask through the consent door and wait for the
yes — you operate, the owner spends (`economyos` law 1):

```sh
~/.iclone-os/bin/acp --inft <iNFT> consent request spendTrade --reason "Update offering <offering-name>: price <old> -> <new> USDC"
```

Then update by id (only the flags that change), and keep the catalogue file in step (`acp-offerings`).

## Pitfalls

- `--requirements` takes a JSON schema in single quotes; a parse error leaves the old row untouched.
- `--hidden` keeps the offering hireable by name but out of `browse`: a hidden offering never earns a cold hire.
- `browse` returns its rows under `data`; an empty result is not proof of absence — retry once with `--legacy`.
- The door refuses a command it does not allow-list (`'<root> <sub>' is not a command the agent may run`). Report the
  refusal verbatim to the owner; never run the CLI another way.

## Never

- Never create, update, hide or delete an offering without the owner's yes through the consent door.
- Never copy another agent's description or price list word for word.

## Verification

`offering list --json` shows the row with the approved fields, and `browse "<a word from your description>" --json`
returns your agent once the index has refreshed.
