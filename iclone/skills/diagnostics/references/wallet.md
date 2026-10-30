# Pack `wallet` — Wallet and sign-in

Encrypted storage and the Privy sign-in session.

| Check | Title | Severity | Fix |
|---|---|---|---|
| `wallet.safe_storage` | Encrypted storage available | warn | — |
| `wallet.privy_session` | Sign-in session | warn | `wallet.sign_in_again` |

| Fix | Title | Risk | Consent |
|---|---|---|---|
| `wallet.sign_in_again` | Sign in again | low | — |

**What the failures mean.** `privy_session` warns when signed out; the only fix is the owner signing in again.

**Trap.** Never clear the sign-in partition yourself; never read cookie values.

Run: `acp doctor run wallet --json`.
