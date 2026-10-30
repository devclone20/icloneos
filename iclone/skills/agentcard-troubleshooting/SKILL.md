---
name: agentcard-troubleshooting
description: "Use when a card is held, declined, blocked or missing. Map the acp card answer to its cause: 403/429 holds that survive a restart, signin-pending, refused card issue, last4-only listings, the 3DS window, KYC links and a declined-payment checklist."
version: 1.1.0
author: iCLONE / CLONE FRAME
license: MIT
platforms: [macos, linux]
metadata:
  hermes:
    tags: [iclone-os, EconomyOS, AgentCard, card, troubleshooting, 3DS]
    related_skills: [agentcard-signup, agentcard-cli, agentcard, economyos, consent, diagnostics, acp-troubleshooting]
---

# AgentCard troubleshooting — read the answer, never retry blind

All commands run as `~/.iclone-os/bin/acp --inft <iNFT> card … --json` (`economyos`). Card answers reach you as JSON
with the secrets removed (number, CVV, expiry, ZIP, cardholder name): you see ids, amounts, statuses, dates and `last4`.
This skill only reads; every fix that spends goes to the owner.

**Which path.** These answers are the iNFT's card through Virtuals (`acp card`), the one the Bank window shows. An
answer from the `agentcard` CLI (`Session expired`, `Not logged in`, KYC `requires_input`) is the owner's direct
agentcard.ai account: open `agentcard-cli`. In 0.4.0 `agentcard create` and `agentcard agentic …` are gone — use
`agentcard request …` and `agentcard sources …`; an instruction naming the old families is out of date.

## When to use

- A card command failed, the app refused it, or `card whoami` is not `verified`.
- A merchant declined a card, asked for a 3DS code, or a card the owner issued is not where you expect it.

## Prerequisites

- The iNFT's ACP session is live (`card whoami` answers; see `acp-troubleshooting` when it times out).
- Reads need no consent. Anything that spends or signs up goes through the door (`spendTrade`, `sendMessages`).

## Quick reference

| Answer | Meaning | Do |
|---|---|---|
| HTTP 429 / rate limit | short rate limit | wait 60 s, then one `card whoami` |
| HTTP 403, "blocked", "locked", "suspended" | account blocked | 15-minute hold; never sign up again; owner contacts AgentCard |
| "…not sending another until <time>" | the app's hold from the last signup | wait until that time; the hold survives a restart |
| "a signup is still running for this iNFT" | one signup is in flight | poll it (`agentcard-signup`), never send another |
| HTTP 401 error carrying `REAUTH:<state>:<email>` | signin-pending, state known | resume that state (`agentcard-signup`) |
| plain HTTP 401 / "unauthorized", or 200 `verified: false` | signin-pending, no state token | fetch the link from the inbox; a new signup needs the owner's explicit yes |
| HTTP 400/404, "not set up" | no account | the only answer that allows a signup (`agentcard-signup`) |
| `agentcard`: "Session expired" / "Not logged in" | the owner's direct account is signed out | `agentcard-cli`; not this iNFT's card |
| `agentcard identity`: `requires_input` / not verified | the direct account needs KYC | relay the URL to the owner only (it carries his token) |
| "'card issue' … refused here (owner rule)" | by design | the owner runs `card issue --amount <cents>` in their own terminal |
| "'card 3ds' is not a command the agent may run" | not on the app's allow-list | the owner reads the code in their terminal |
| `{"requests":[]}` | `card list` is empty | nothing was issued for this iNFT |
| HTTP 5xx, empty `{}`, anything else | not an answer about the card | keep the last known state; one `card whoami` later |

## Procedure

1. Read the state, then the account's numbers:

       ~/.iclone-os/bin/acp --inft <iNFT> card whoami --json
       ~/.iclone-os/bin/acp --inft <iNFT> card limit --json

   A probe that could not run (timeout, no output) keeps the last known state: it is not "no account".
   Right after a signup the app re-reads the card (the due mark survives a restart): trust the fresh read, not an old "none".
2. Find the card the owner issued:

       ~/.iclone-os/bin/acp --inft <iNFT> card list --json
       ~/.iclone-os/bin/acp --inft <iNFT> card get --request-id <spend-request-id> --json

   The answer is `{"requests":[…]}`; each entry in `requests` has `id`, `amountCents`, `status`, `createdAt`, `expiresAt`, `issuedAt`, `capturedAmountCents`, `capturedAt`,
   `last4`. Name a card to the owner by its `last4` and amount only.
3. Declined at checkout — check in this order and report what you found:
   - `status` and `expiresAt`: the card is single-use; a captured or expired card will not pay again.
   - The charge vs `amountCents`: the total (tax, shipping) must fit the card's amount.
   - `card limit`: `remainingCents` covers the charge.
   - 3DS: the merchant asked for a code and nobody entered it in time.
   - Payment method: `card profile --json` and its `nextStep` say whether setup is complete; if not, run
     `card payment-method --json` and relay the fresh `url` raw, on its own line.
   - Billing fields: you cannot see them; the owner compares the merchant form with the card in their terminal.
   Never ask for a replacement card on your own: state the amount and merchant, and wait for the owner's yes.
4. 3DS challenge: the code is listed for about 5 minutes after the merchant sends it. The app does not let you run
   `card 3ds`: ask the owner to run it in their terminal at once and type the code whose amount matches (newest first).
   No match after a few seconds → the merchant did not send a challenge; check again once, then report.
5. KYC or identity check: when an answer or `nextStep` carries a verification URL, relay it raw on its own line and
   wait. Never ask the owner to send identity documents to you.
6. Still unclear: run the diagnostics door (`diagnostics`, pack `acp`) and read the ACP error catalog
   (`acp-troubleshooting`) before you change anything.

## Pitfalls

- A hold is not "try again later with another route": the app refuses every signup until it ends, and so must you.
- Words such as "already", "inactive" or "pending" inside a message are not states: read the JSON fields.
- Never work around a refusal with a plain `acp`, another config dir or a script (`economyos`).
- The card cap for one issue is $1–$75 in whole dollars (100–7500 cents); a bigger total needs the owner's decision.

## Never

- Never run `card issue` at all: the owner issues cards in their own terminal.
- Never run a second signup, `card limit set` or `card payment-method` without the owner's yes through the consent
  door (`spendTrade` for money, `sendMessages` for a signup).
- Never paste 3DS codes, KYC links you were not asked to relay, or any card data into chat or notes.

## Verification

The fix holds when `card whoami --json` prints `verified: true` and the card in `card get --request-id <spend-request-id> --json` shows the `status` the owner expects.
