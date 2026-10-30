---
name: telegram-bot-build
description: "Use when building a Telegram bot from scratch. BotFather token, privacy mode, command menus by scope, an allowed-user list, a minimal long-polling bot that answers every message and button press, and Telegram's flood limits."
version: 1.0.0
author: iCLONE / CLONE FRAME
license: MIT
platforms: [macos, linux]
metadata:
  hermes:
    tags: [iclone-os, telegram, bot, botfather, polling]
    related_skills: [telegram-bot-deploy, telegram-bot-troubleshooting, secret-rotation, consent, hermes-agent]
---

# Telegram bot — build it right the first time

## When to use

The owner wants a new Telegram bot. Hosting it 24/7 or behind a webhook: `telegram-bot-deploy`. Only the Hermes agent on Telegram? The Hermes gateway already does it (`hermes-agent`); write no new bot.

## Prerequisites

- The owner's Telegram account: only the owner talks to @BotFather; you tell them what to type.
- `curl` and `python3` (or Node 18+). Installing anything → ask through the consent door first: `~/.iclone-os/bin/acp consent request installSoftware --reason "<what and why>"`.
- Truth for every method: https://core.telegram.org/bots/api

## Quick reference

- @BotFather: `/newbot` (token), `/setprivacy` (groups), `/setdescription` + `/setabouttext` (public texts, not in code), `/revoke` (leak → `secret-rotation`).

## Procedure

1. **Create.** The owner sends `/newbot` to @BotFather, picks a name and a username ending in `bot`, and receives `<bot-token>`. The token goes straight into a file only the bot user can read — never into chat, code, argv or git:

   ```sh
   D=~/.config/<bot>; mkdir -p -m 700 "$D" && { [ -e "$D/.env" ] || install -m 600 /dev/null "$D/.env"; } && "${EDITOR:-nano}" "$D/.env"  # example — add TELEGRAM_BOT_TOKEN=<bot-token> and ALLOWED_USERS=<id>,<id>
   ```

2. **Check the token** without putting it on a command line (`ps` shows argv). Define the helper once per shell:

   ```sh
   set -a; . ~/.config/<bot>/.env; set +a; tg() { m=$1; shift; printf 'url = "https://api.telegram.org/bot%s/%s"\n' "$TELEGRAM_BOT_TOKEN" "$m" | curl -sS -K - "$@"; }; tg getMe  # example
   ```

   `"ok":true` with your bot's `username` = good token; `401 Unauthorized` = wrong or revoked.

3. **Allowlist.** Numeric user ids, not usernames (usernames change). The owner sends any message to the bot, then `tg getUpdates` shows `message.from.id`. Every handler drops updates from ids outside `ALLOWED_USERS` before any work.

4. **Privacy mode.** On by default: in groups the bot only gets commands, replies to it and mentions. If it must read the whole group, the owner sends `/setprivacy` → Disable (or makes it admin), then removes and re-adds the bot to the group.

5. **Command menu by scope** (`all_private_chats`, `all_group_chats`, `chat`, …):

   ```sh
   tg setMyCommands -H 'Content-Type: application/json' -d '{"commands":[{"command":"status","description":"Show status"}],"scope":{"type":"all_private_chats"}}'  # example
   ```

6. **Minimal long-polling bot** (stdlib only, zero inbound ports). It receives `message` and `callback_query` only (extend `allowed_updates` as you add handlers), confirms each update via `offset`, answers buttons (else they spin), replies to non-text instead of going mute, and survives network errors, 403 and 409; on 429 it waits `retry_after` and retries once:

   ```python
   # example — bot.py, run with the .env loaded
   import json, os, time, urllib.request
   API = "https://api.telegram.org/bot" + os.environ["TELEGRAM_BOT_TOKEN"] + "/"
   ALLOWED = {int(x) for x in os.environ["ALLOWED_USERS"].split(",") if x}
   def call(method, **params):
       req = urllib.request.Request(API + method, json.dumps(params).encode(), {"Content-Type": "application/json"})
       for retry in (False, True):
           try:
               with urllib.request.urlopen(req, timeout=60) as r:
                   return json.load(r)["result"]
           except Exception as e:  # 429 flood limit: wait retry_after, retry once
               if retry or getattr(e, "code", 0) != 429:
                   raise
               time.sleep(json.loads(e.read()).get("parameters", {}).get("retry_after", 5))
   offset = 0
   while True:
       try:
           for u in call("getUpdates", offset=offset, timeout=50, allowed_updates=["message", "callback_query"]):
               offset = u["update_id"] + 1
               cq, msg = u.get("callback_query"), u.get("message") or {}
               if (cq or msg).get("from", {}).get("id") not in ALLOWED:
                   continue
               if cq:
                   call("answerCallbackQuery", callback_query_id=cq["id"])
               elif "text" in msg:
                   call("sendMessage", chat_id=msg["chat"]["id"], text="You said: " + msg["text"][:4000])
               else:
                   call("sendMessage", chat_id=msg["chat"]["id"], text="I only read text for now.")
       except Exception as e:  # network blip, 403, 409: log, back off, never exit
           print("error:", type(e).__name__, getattr(e, "code", ""), flush=True)
           time.sleep(5)
   ```

7. **Sending for the owner** (broadcasts, notifications to others) → `~/.iclone-os/bin/acp consent request sendMessages --reason "<to whom and why>"` and wait for the yes.

## Pitfalls

- Filtering only text = a bot mute on photos, voice and buttons.
- `chat_member`, `message_reaction` and `message_reaction_count` arrive only when listed in `allowed_updates`.
- Flood limits (Bot FAQ): about 1 message per second per chat, 20 per minute per group, about 30 per second in total.
- A bot cannot message a user first: `403 Forbidden` until that user sends `/start`.
- Updates wait at most 24 h on Telegram's side; polling plus a webhook = `409 Conflict` (see `telegram-bot-troubleshooting`).

## Never

- Never paste `<bot-token>` into chat, a commit, a URL you share, or a command argument.
- Never message people other than the owner without the `sendMessages` yes.

## Verification

`tg getMe` returns `"ok":true`, and a message from an allowed id gets an answer while a message from any other id gets none.
