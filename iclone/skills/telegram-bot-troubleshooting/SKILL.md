---
name: telegram-bot-troubleshooting
description: "Use when a Telegram bot is mute, slow or double-replying. Reads getWebhookInfo, fixes 409 polling-plus-webhook, privacy mode in groups, timeouts that cause redelivery, errors lost behind a webhook, BotFather's stale texts and leaked tokens."
version: 1.0.0
author: iCLONE / CLONE FRAME
license: MIT
platforms: [macos, linux]
metadata:
  hermes:
    tags: [iclone-os, telegram, bot, webhook, troubleshooting]
    related_skills: [telegram-bot-deploy, telegram-bot-build, secret-rotation, diagnostics, consent]
---

# Telegram bot — why it is mute, slow or answers twice

## When to use

A bot does not answer, answers late, answers twice, or says something wrong. If the Hermes gateway itself is the bot, run `diagnostics` (gateway pack) first. Every check below only reads, except `tg deleteWebhook` in step 2. That write, and every fix that touches a server (see `telegram-bot-deploy`), first goes through the consent door — `~/.iclone-os/bin/acp consent request terminal --reason "<what changes on which bot>"` — and waits for the owner's yes.

## Prerequisites

- The bot's `.env` loaded and the `tg` helper from `telegram-bot-build` (keeps `<bot-token>` off argv).
- Read access to the bot's logs (`journalctl -u <bot>.service`, `# example`; truth: `journalctl --help`).

## Quick reference

| Symptom                     | First look              | Usual cause                                                     |
| --------------------------- | ----------------------- | --------------------------------------------------------------- |
| Silent everywhere           | `tg getMe`              | `401` = token revoked or wrong                                  |
| Silent, webhook             | `tg getWebhookInfo`     | `last_error_message`, growing `pending_update_count`            |
| `409 Conflict` in logs      | `tg getWebhookInfo`     | a webhook is set while you poll, or two pollers share one token |
| Silent in groups only       | BotFather `/setprivacy` | privacy mode on, bot not admin                                  |
| Silent on photos or buttons | handler code            | only text is handled                                            |
| Same answer twice           | handler timing          | non-2xx or slow answer → Telegram redelivers                    |
| Wrong public facts          | BotFather `/mybots`     | description and about text live in BotFather                    |

## Procedure

1. **Token alive?**

   ```sh
   tg getMe  # example
   ```

   `"ok":true` → continue. `401` → the token was revoked; get the new one from the owner (see `secret-rotation`).

2. **Who receives updates?**

   ```sh
   tg getWebhookInfo  # example
   ```

   `url` empty = polling mode. `url` set + a poller running = `409`: keep exactly one — `tg deleteWebhook` (a write: consent door and the owner's yes first) or stop the poller. Two hosts polling the same token also give `409 Conflict: terminated by other getUpdates request`; find and stop the second one. `last_error_message` names the webhook failure: certificate, DNS, wrong port (only 443, 80, 88, 8443), `401` from your own secret check, or a timeout.

3. **Slow or double answers.** Telegram repeats any webhook request that does not get a 2xx answer in time. Measure the handler: it must answer `200` immediately and work afterwards, and skip an `update_id` it has already seen. grammY's `webhookCallback` throws after 10 s by default — a sign the work is done inline.

4. **Errors you never see.** With grammY, `bot.catch` only applies to `bot.start()` (polling). Behind `webhookCallback` the error goes to the web framework; if it answers `500`, Telegram retries and the bot looks mute. Wrap the handler and log the error.

5. **Groups.** Privacy mode (default on) shows the bot only commands, replies to it and mentions. The owner disables it in BotFather (`/setprivacy`) or makes the bot admin, then removes and re-adds it to the group.

6. **Partial muteness.** List the update types the code handles against those arriving (`allowed_updates` in `getWebhookInfo`). Text-only filters drop photos, voice, edits and button presses; unanswered `callback_query` leaves the button spinning.

7. **Send failures.** `403 Forbidden` = the user blocked the bot or never sent `/start`; `400 Bad Request: chat not found` = wrong `chat_id`; `429` = flood limit, wait `parameters.retry_after`.

8. **Wrong things said.** Facts in `/setdescription`, `/setabouttext` and the command menu are not in your code; check them in BotFather and in `tg getMyCommands`.

9. **Token in a log, chat or commit.** Treat it as leaked: the owner revokes it in BotFather (`/revoke`), then follow `secret-rotation`.

## Pitfalls

- Restarting fixes nothing when two processes own the token; it only changes which one wins.
- `drop_pending_updates=true` deletes queued messages; ask the owner before using it.
- Updates older than 24 hours are gone from Telegram's side.

## Verification

`tg getWebhookInfo` shows the intended mode with no `last_error_message`, the logs show no `409`, and one test message gets exactly one reply.
