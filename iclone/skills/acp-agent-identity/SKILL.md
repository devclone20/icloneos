---
name: acp-agent-identity
description: "Use when creating an agent, signer or ERC-8004 entry. The split sign-in, agent list before create, the non-blocking signer flow with an explicit policy, ERC-8004 registration, migration, and the error codes that say which step is missing."
version: 1.0.0
author: iCLONE / CLONE FRAME
license: MIT
platforms: [macos, linux]
metadata:
  hermes:
    tags: [iclone-os, EconomyOS, ACP, Virtuals, identity, signer, ERC-8004]
    related_skills: [economyos, consent, acp-wallet-ops, acp-troubleshooting]
---

# ACP agent identity — sign in, one agent, one signer, on the record

## When to use

- A command answers `NOT_AUTHENTICATED`, `NO_ACTIVE_AGENT`, `NO_SIGNER` or `AGENT_NOT_FOUND`.
- The owner asks you to do a Setup step yourself (the wizard's "ask hermes" button), or to register the agent on ERC-8004.
- A legacy agent must move to ACP SDK 2.0.

The owner normally completes Setup in Settings → EconomyOS & iNFT → Setup; `economyos` → Identity and setup has the
summary. One iNFT = one agent: never point this iNFT at another agent without the owner saying so.

## Prerequisites

- iclone os open (the door runs every command): `~/.iclone-os/bin/acp --inft <iNFT> … --json`.
- The owner at hand: sign-in and signer approval need them in a browser within minutes.

## Quick reference (acp 1.0.38)

```sh
~/.iclone-os/bin/acp --inft <iNFT> configure start --json
~/.iclone-os/bin/acp --inft <iNFT> configure complete --request-id <request-id> --wait --timeout 300 --json
~/.iclone-os/bin/acp --inft <iNFT> agent whoami --json
~/.iclone-os/bin/acp --inft <iNFT> agent list --page 1 --page-size 20 --json
~/.iclone-os/bin/acp --inft <iNFT> agent create --name "<name>" --description "<text>" --image <image-url> --json
~/.iclone-os/bin/acp --inft <iNFT> agent use --agent-id <agent-id> --json
~/.iclone-os/bin/acp --inft <iNFT> agent add-signer --agent-id <agent-id> --policy restricted --no-wait --json
~/.iclone-os/bin/acp --inft <iNFT> agent signer-status --request-id <request-id> --public-key <public-key> --agent-id <agent-id> --wait --timeout 300 --json
~/.iclone-os/bin/acp --inft <iNFT> agent register-erc8004 --agent-id <agent-id> --chain-id 8453 --json
~/.iclone-os/bin/acp --inft <iNFT> agent migrate --agent-id <agent-id> --json
```

## Procedure

1. **Sign in** (`NOT_AUTHENTICATED`). `configure start` returns an auth URL and a request id and exits. Paste the URL raw
   on its own line (`economyos` law 2), then `configure complete --request-id <request-id> --wait`. It answers
   `pending` until the owner finishes. Never run bare `configure`: it blocks.
2. **Pick the agent** (`NO_ACTIVE_AGENT`). `agent list` first — the owner may already have one. Reuse it with
   `agent use`; create a new one only when the list has none the owner wants.
3. **Add the signer** (`NO_SIGNER`). Always pass `--policy` explicitly: `restricted` (authorises ACP transactions — the
   usual choice), `deny-all` (every transaction needs manual approval), `unrestricted` (no approval). The policy is the
   owner's call (`economyos` law 5). `--no-wait` prints `signerUrl`, `requestId` and `publicKey`: paste `signerUrl` raw,
   then run `signer-status` with both values. The approval window is 5 minutes (expired: `acp-troubleshooting` E16).
4. **ERC-8004.** `register-erc8004` writes the agent to the on-chain identity registry and signs: same consent step.
   Check `agent whoami` afterwards for the registry id.
5. **Migrate** a legacy agent to ACP SDK 2.0 with `agent migrate --agent-id <agent-id>`; an in-progress migration is
   finished by the same command plus `--complete`. Report what it returned before you finish it.

Creating or switching an agent, adding a signer, changing its policy (`agent set-signer-policy`) and registering on
ERC-8004 sign or commit the owner's wallet. Before each, state what will happen, then ask through the consent door and wait
for the owner's yes (you operate, the owner spends — `economyos` law 1):

```sh
~/.iclone-os/bin/acp --inft <iNFT> consent request spendTrade --reason "Add a restricted signer to agent <agent-id>"
```

## Error map

| Code | Missing step | Do |
|---|---|---|
| `NOT_AUTHENTICATED` | sign-in | step 1 |
| `NO_ACTIVE_AGENT` | active agent | step 2 |
| `NO_SIGNER` | signer | step 3 |
| `AGENT_NOT_FOUND` | wrong id | `agent list`, then step 2 |
| `KeyRevoked` on writes | unlocked keyring (headless box) | `acp-troubleshooting` E4 first; step 3 only off a headless box, once the owner confirms the signer was revoked |

A `REAUTH:<state>:<email>` answer comes from `card` commands, not from identity: see `economyos` → Bank Card.

## Pitfalls

- `agent tokenize` launches a public token for the agent: irreversible and market-facing. Never on your own initiative;
  only on the owner's explicit instruction, after `agent quote-tokens --chain-id 8453`, with every parameter restated.
- `agent create --signer` without `--policy` leaves the policy to a default. Create first, then step 3.
- The door refuses a command it does not allow-list (`'<root> <sub>' is not a command the agent may run`). Report the
  refusal verbatim to the owner; never run the CLI another way.

## Never

- Never create, switch, sign, change a policy, register or tokenize without the owner's yes through the consent door.
- Never copy or read the CLI's config or key files, and never move them between iNFTs.

## Verification

`agent whoami --json` shows the agent the owner chose, its wallet and (after step 4) its ERC-8004 id;
`agent signer-policy --json` shows the policy the owner approved.
