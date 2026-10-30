---
name: watchdog-keepalive
description: "Use when a process must stay alive or restart on its own. systemd Restart and WatchdogSec, health-check timers, pid-file ownership, a budget watchdog with a floor, macOS caffeinate and launchd KeepAlive, alerts, and no pattern kills."
version: 1.0.0
author: iCLONE / CLONE FRAME
license: MIT
platforms: [macos, linux]
metadata:
  hermes:
    tags: [iclone-os, watchdog, keepalive, systemd, launchd, server]
    related_skills: [server-agent-service, cron-timers, server-troubleshooting, diagnostics, consent]
---

# Watchdog and keep-alive — restart what dies, stop what overspends

## When to use
- A service must come back after a crash, a hang or a reboot.
- A Mac must stay awake while a long job runs.
- An agent that spends must stop itself when its balance drops below a floor.

`systemctl`, `launchctl`, `caffeinate` and `pmset` are system tools: their man pages are the truth.

## Prerequisites
- A service unit (`server-agent-service`) or a script you own.
- Creating a timer, a launchd agent or a watchdog is a scheduled task: ask through the consent door (`~/.iclone-os/bin/acp consent request scheduledTasks --reason "…"`), say what it restarts or stops and how often, and wait for the owner's yes. Alerts to the owner need `sendMessages`.

## Quick reference
| Need | Tool |
|---|---|
| Restart on crash | `Restart=on-failure`, `RestartSec=10`, `StartLimitBurst=5` |
| Restart on hang | `WatchdogSec=60` + the program sends `WATCHDOG=1` (`Type=notify`) |
| Check from outside | health-check service + timer every 5 min |
| Stop on low balance | budget watchdog with `<floor-usdc>` |
| macOS stay awake | `caffeinate -ims -t <seconds>` with a pid file |
| macOS keep alive | launchd `KeepAlive` + `ThrottleInterval` |

## Procedure
1. Crash restarts: add the restart lines above to the unit's `[Service]` and `[Unit]` (`StartLimitIntervalSec=300`, `StartLimitBurst=5`). Use `WatchdogSec` only if the program pings systemd; otherwise systemd kills a healthy process every interval.
2. Health check from outside — a oneshot unit and its timer:
```ini
# example: <agent>-health.service runs /usr/local/bin/<agent>-health.sh (Type=oneshot)
# example: <agent>-health.timer
[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
```
The script checks one thing (a local health URL, the age of a heartbeat file) and on failure runs `systemctl restart <agent>` and alerts once.
```sh
sudo systemctl daemon-reload && sudo systemctl enable --now <agent>-health.timer  # example
```
3. Pid-file ownership — stop only the process you started, and only if the pid still is that program:
```sh
pid=$(cat "<pid-file>") && [ "$(basename "$(ps -p "$pid" -o comm=)")" = "<program>" ] && kill "$pid"  # example
```
   `comm` is a full path on macOS (hence `basename`) and at most 15 characters on Linux: compare with the name as `ps` prints it.
4. Budget watchdog: on a timer, read the balance with the read-only wallet call from `economyos`; below `<floor-usdc>`, stop the spending service and alert the owner. It may only stop; it never tops up, moves or swaps funds (economyos law 1).
```sh
sudo systemctl stop <agent>  # example
```
5. macOS stay-awake, owned by a pid file, checked without guessing:
```sh
caffeinate -ims -t <seconds> & echo $! > "<pid-file>"  # example
pmset -g assertions | grep -i caffeinate  # example
```
6. macOS keep-alive: in `~/Library/LaunchAgents/<label>.plist` set `KeepAlive` to a dict with `SuccessfulExit` false and `ThrottleInterval` 30, then:
```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<label>.plist && launchctl print gui/$(id -u)/<label>  # example
```
A program that cannot work yet (no login, no network) should wait 60 s before it exits, or launchd restarts it in a tight loop.

## Pitfalls
- Endless restart loops hide the real error: keep the start limit and read `journalctl -u <agent>` (`server-troubleshooting`).
- A health check that restarts on every slow response causes the outage it watches for: require two failures in a row.
- One alert per incident, not one per check.

## Never
- Never `pkill -f`, `killall` or kill by name; never `kill -9` before a plain `kill`.
- Never kill a process you did not start.
- Never let a watchdog move value or change limits.

## Verification
```sh
systemctl show -p NRestarts,ActiveState <agent> && systemctl list-timers <agent>-health.timer  # example
```
Pass = `ActiveState=active`, the timer shows a NEXT time, and after an owner-approved `sudo systemctl kill -s SIGKILL <agent>` the unit is `active` again with `NRestarts` one higher.
