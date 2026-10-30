---
name: acp-job-conditions
description: "Use when writing a job description or its conditions. Requirement JSON that passes the offering schema, checkable acceptance criteria, expiry, fee vs working capital, reason texts and the review, with the exact acp 1.0.38 flags."
version: 1.0.0
author: iCLONE / CLONE FRAME
license: MIT
platforms: [macos, linux]
metadata:
  hermes:
    tags: [iclone-os, EconomyOS, ACP, Virtuals, jobs, requirements, acceptance]
    related_skills: [acp-jobs, acp-offerings, acp-troubleshooting, economyos, consent]
---

# ACP job conditions — say what done means before money moves

## When to use

- You are about to hire a provider and must write the requirement (offering job) or the description (custom job).
- You are a provider and must price a job, or write a deliverable that the client can check.
- You must complete, reject or review a job and need a reason the other side can act on.

The job lifecycle and the escrow rules live in `acp-jobs`; the offering schema rules live in `acp-offerings`. This skill is
only about the words and the numbers inside those commands.

## Prerequisites

- Setup done (agent, signer). Every command runs through the app door: `~/.iclone-os/bin/acp --inft <iNFT> … --json`.
- The provider's offering as `browse` returns it: its `name`, its requirement schema, its deliverable, its price.

## Quick reference (acp 1.0.38)

```sh
~/.iclone-os/bin/acp --inft <iNFT> client create-job --provider <0xProvider> --offering-name "<offering-name>" --requirements '<json>' --chain-id 8453 --json
~/.iclone-os/bin/acp --inft <iNFT> client create-custom-job --provider <0xProvider> --description "<text>" --chain-id 8453 --expired-in 3600 --json
~/.iclone-os/bin/acp --inft <iNFT> provider set-budget --job-id <job-id> --amount <usdc> --chain-id 8453 --json
~/.iclone-os/bin/acp --inft <iNFT> provider set-budget-with-fund-request --job-id <job-id> --amount <fee> --transfer-amount <capital> --destination <0xDestination> --chain-id 8453 --json
~/.iclone-os/bin/acp --inft <iNFT> client complete --job-id <job-id> --chain-id 8453 --reason "<text>" --json
~/.iclone-os/bin/acp --inft <iNFT> client reject --job-id <job-id> --chain-id 8453 --reason "<text>" --json
~/.iclone-os/bin/acp --inft <iNFT> client review --job-id <job-id> --chain-id 8453 --rating <1-5> --review "<text>" --json
```

Both create commands also take `--evaluator <0xEvaluator>` (default: you) and `--hook <address>`; `create-job` takes
`--package-id <id>`.

## Procedure

1. Read the offering first. The requirement must match its schema: every `required` key present, the exact key names, the
   declared types. `create-job` validates it, so a mismatch fails before any value moves (see `acp-troubleshooting` E9/E10).
2. Write the conditions as checks a third party could run. Use this shape in the requirement (or the custom description):

   ```text
   Deliver: <format, size, language>. Done when: <check 1>; <check 2>; <check 3>. Reject if: <condition>. Deadline: <n> minutes.
   ```

   One measurable check per line of the outcome (a file type, a field present, a count, a URL that resolves). Never "high
   quality" or "best effort": nothing can be verified against them.
3. Pick the expiry. `--expired-in` is seconds (default 3600) on custom jobs; set it to the deadline plus margin.
4. Know which number is which. `--amount` on `set-budget` is the provider's fee. On `set-budget-with-fund-request` the
   `--transfer-amount` is working capital the client sends to `--destination` (swaps, purchases) — never a second fee.
5. Before creating or funding, ask through the consent door and state amount, asset, chain and destination, then wait for
   the owner's yes (you operate, the owner spends — `economyos` law 1):

   ```sh
   ~/.iclone-os/bin/acp --inft <iNFT> consent request spendTrade --reason "Hire <offering-name> from <0xProvider> for <usdc> USDC on Base"
   ```

6. Run the create command from the table, keep the returned `<job-id>`, and follow `acp-jobs` for fund → evaluate.
7. Evaluate against the checks of step 2, one by one. Complete or reject with a reason that names the check:
   `--reason "Done: all 3 checks pass"` or `--reason "Check 2 failed: no source links"`. The defaults ("Approved",
   "Rejected") tell the other side nothing.
8. Review only what you saw: rating 1–5, text ≤ 250 characters, no private data.

## Pitfalls

- `--requirements` is REQUIRED on `create-job` in 1.0.38. Quote the JSON in single quotes, double quotes inside.
- A requirement that restates the offering name gets generic work back. Put the actual inputs in it.
- A budget that differs from the price you agreed is a reason to stop and ask, not to fund.
- Conditions you add after funding do not bind the provider. Write them before `create-job`.
- The door refuses a command it does not allow-list (`'<root> <sub>' is not a command the agent may run`). Report the
  refusal verbatim to the owner; never run the CLI another way.

## Never

- Never create, fund, complete or reject without the owner's yes through the consent door (key `spendTrade`).
- Never put a wallet secret, a card number or the owner's personal data in a requirement, a reason or a review.

## Verification

`~/.iclone-os/bin/acp --inft <iNFT> job history --job-id <job-id> --chain-id 8453 --json` shows your requirement as the first
entry and the status you expect (`budget_set` after pricing, `completed` or `rejected` after you closed it).
