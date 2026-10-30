---
name: acp-trade-hyperliquid
description: "Use when swapping tokens or trading on Hyperliquid. Reads first, a dry-run preview, the exact flags for swaps, Hyperliquid deposits, spot, perps (size, leverage, reduce-only, TP/SL), cancels and withdrawals, each behind the owner's yes."
version: 1.0.0
author: iCLONE / CLONE FRAME
license: MIT
platforms: [macos, linux]
metadata:
  hermes:
    tags: [iclone-os, EconomyOS, ACP, Virtuals, trade, Hyperliquid, perps, swap]
    related_skills: [economyos, consent, acp-wallet-ops, acp-troubleshooting]
---

# ACP trade and Hyperliquid — preview, ask, then one command

## When to use

- The owner asks to swap, bridge, buy a tokenized stock, deposit to or withdraw from Hyperliquid, or open, close or
  protect a perp position.
- The owner asks what is open on Hyperliquid.

The Hyperliquid app playbook is in `economyos`. This skill is the full flag set and the order that keeps trades safe.

## Prerequisites

- Agent with a signer (`acp-agent-identity`) and a balance on the source chain (`acp-wallet-ops`).
- Chains: `1` Ethereum, `42161` Arbitrum, `8453` Base (default), `1337` Hyperliquid. Commands run through
  `~/.iclone-os/bin/acp --inft <iNFT>`.

## Quick reference — reads

```sh
~/.iclone-os/bin/acp --inft <iNFT> trade hl-status --json
~/.iclone-os/bin/acp --inft <iNFT> trade hl-orders --coin <symbol> --json
~/.iclone-os/bin/acp --inft <iNFT> trade stock-list <symbol> --json
~/.iclone-os/bin/acp --inft <iNFT> wallet balance --json
```

## Quick reference — writes (a line with `--dry-run` previews; drop the flag only after the owner's yes)

```sh
~/.iclone-os/bin/acp --inft <iNFT> trade --token-in usdc --chain-in 8453 --amount-in <amount> --token-out <symbol> --chain-out 8453 --slippage <pct> --dry-run --json
~/.iclone-os/bin/acp --inft <iNFT> trade --token-in usdc --chain-in 8453 --amount-in <amount> --token-out usdc --chain-out 1337 --dry-run --json
~/.iclone-os/bin/acp --inft <iNFT> trade --token-in usdc --chain-in 1337 --amount-in <amount> --token-out <symbol> --chain-out 1337 --price <price> --dry-run --json
~/.iclone-os/bin/acp --inft <iNFT> trade --token <symbol> --side long --size <token-units> --leverage <n> --isolated --stop-loss <price> --dry-run --json
~/.iclone-os/bin/acp --inft <iNFT> trade --token <symbol> --side short --size <token-units> --reduce-only --dry-run --json
~/.iclone-os/bin/acp --inft <iNFT> trade --token <symbol> --amount-usdc <amount> --dry-run --json
~/.iclone-os/bin/acp --inft <iNFT> trade hl-set-tpsl --coin <symbol> --tp <price> --sl <price> --json
~/.iclone-os/bin/acp --inft <iNFT> trade hl-cancel --coin <symbol> --oid <order-id> --json
~/.iclone-os/bin/acp --inft <iNFT> trade withdraw-from-hl --amount <usdc> --dry-run --json
```

Lines, in order: swap on Base · deposit USDC into Hyperliquid · Hyperliquid spot limit (omit `--price` for market) · open a
perp · close it · buy a tokenized stock · set TP/SL on an open position · cancel an order (`--tp` / `--sl` cancel those
triggers) · withdraw (settles to Arbitrum; `--to-chain <id>` bridges onward, `--destination <0xTo>` pays elsewhere).

## Procedure

1. Read: `hl-status` (positions, margin), `hl-orders` (open orders), `wallet balance` (funds per chain). For a stock,
   `stock-list <symbol>` first: it says which venues trade it.
2. Build the line and run it with `--dry-run`. It prints the route, size, margin and fees without signing.
3. Show the owner the preview in words: side, size, leverage, entry, stop, fees, chain. Then ask through the consent door
   and wait for the yes (you operate, the owner spends — `economyos` law 1):

   ```sh
   ~/.iclone-os/bin/acp --inft <iNFT> consent request spendTrade --reason "Long <size> <symbol> at <n>x, stop <price>, margin about <usd> USDC"
   ```

4. Run the same line without `--dry-run`. A deposit or a bridge blocks until it settles: wait, never re-issue it.
5. Read `hl-status` / `hl-orders` again and report what is now open.

## Pitfalls

- `--size` is in TOKEN units, not dollars (`0.01` = 0.01 of the token). `--amount-in` is what you spend, not what you get.
- `--reduce-only` closes or shrinks: its `--side` is the OPPOSITE of the position. Never set it when opening — the venue
  rejects it.
- `--leverage` changes the token's leverage before the order; `--isolated` keeps the loss to that position's margin.
- `--take-profit` / `--stop-loss` alone (no size) attach to the existing position and close at market;
  `--take-profit-limit <price>` / `--stop-loss-limit <price>` rest them as limit orders instead.
- Hyperliquid orders default to 5 % slippage; swaps use the server default unless you pass `--slippage`.
- `--accept-impact` overrides the server's price-impact warning: only after the owner read that warning.
- Selling a tokenized stock needs `--chain` (the venue holding the shares, from `wallet balance`) with `--amount-shares`.
- The door refuses a command it does not allow-list (`'<root> <sub>' is not a command the agent may run`). Report the
  refusal verbatim to the owner; never run the CLI another way.

## Never

- Never run a trade, deposit, withdrawal, TP/SL change or cancel without the owner's yes through the consent door
  (`spendTrade`), with amounts restated.
- Never pick the size, leverage or venue for the owner; present options.
- Never retry a trade that timed out before `hl-status` shows it did not land.

## Verification

`trade hl-status --json` shows the position (side, size, entry) the owner approved, or `trade hl-orders --json` shows the
resting order; for a swap, `wallet balance` shows the new token.
