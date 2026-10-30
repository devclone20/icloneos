"""V3-F critic r4 — my own probes against HEAD fd1cd865f8. Temp HERMES_HOME only (autouse fixture from the plugin tests).
Guard pid is the fake 4242; the only child spawned is my own `sleep`, killed by me."""
# r6 builder: copied verbatim from the r4 critic's file into the branch as a permanent regression. The only edits
# are the expectation drifts listed under "r6 drift" below, each a decision already taken by ticket (never a
# weakening of a floor): grep the file for "r6 drift".
# One scrub, not a drift: the four absolute-home forms use a synthetic home (/Users/u/) in place of the
# machine's real one, so no personal path enters the repo; the shape (an absolute install path) is unchanged.

from __future__ import annotations

import os
import random
import string
import subprocess
import sys

import pytest

from tests.plugins.test_iclone_permissions import (  # noqa: F401
    FakeMain, INFT, KEY, KID, MODES, _body, _decide_all_modes, _events, _isolated, _load, _spawn_env,
    _write_policy, plugin, wired,
)

TOOLS3 = lambda cmd: (("terminal", {"command": cmd}),  # noqa: E731
                      ("process", {"action": "submit", "session_id": "s", "data": cmd}),
                      ("execute_code", {"code": cmd}))


def modes(plugin_mod, tool, args, cwd, **over):
    return {m: (v.outcome, v.rule, c.cls, c.floor, c.facts) for m, (v, c) in _decide_all_modes(plugin_mod, tool, args, cwd, **over).items()}


def floor_everywhere(res, prefix=("confinement", "hardline")):
    return all(v[0] == "refuse" and v[1] == "floor" and v[3] and v[3].startswith(prefix) for v in res.values())


def line(tag, cmd, res):
    print(f"\n{tag}|{cmd!r}|" + "|".join(f"{m}:{v[0]}/{v[1]}/{v[2]}/{(v[3] or '')[:11]}/d={v[4].get('dangerous')}" for m, v in res.items()))


# ------------------------------------------------------------------ T2' kill floor: NEW spellings (mine, beyond the builder's 80)
KILL_NEW = [
    "/usr/bin/env kill 4242",
    "command kill 4242",
    "builtin kill 4242",
    "exec kill 4242",
    "kill -s KILL 4242",
    "kill -KILL 4242",
    "kill -n 9 4242",
    "/bin/sh -c \"kill 4242\"",
    "bash -lc 'pkill Electron'",
    "nohup kill 4242 &",
    "timeout 5 kill 4242",
    "xargs -0 kill < f",
    "pkill -f 'iclone os'",
    "pkill -if electron",
    "killall -9 -c Electron",
    "launchctl bootout gui/$(id -u)/com.iclone.os",
    "launchctl remove com.iclone.os",
    "launchctl remove ai.hermes.gateway",
    "osascript -e 'do shell script \"kill 4242\"'",
    "python3 - <<'EOF'\nimport os\nos.kill(4242, 9)\nEOF",
    "node --eval 'process.kill(4242)'",
    "ruby -rprocess -e 'Process.kill(:KILL, 4242)'",
    "perl -e 'kill 9, 4242'",
    "swift -e 'import Darwin; kill(4242, 9)'",
    "pkill -f /Users/x/hermes-agent/tui_gateway/server.py",
    "kill -9 04242",                                     # leading zero: same pid in /bin/kill and bash
    "sudo -u $USER kill 4242",
    "caffeinate -i kill 4242",
    "find /tmp -name x -exec kill 4242 \\;",
    "( kill 4242 )",
    "{ kill 4242; }",
    "true && kill 4242",
    "false || kill -9 4242",
    "kill -9 4242 2>/dev/null",
    "kill -TERM 4242 4243",
    "kill -9 1234 4242",
    "KiLl -9 4242",
    "PKILL -F ELECTRON",
    "/Applications/Xcode.app/x/kill 4242",
    "kill $(( 4242 ))",
    "kill -9 \"4242\"",
    "kill -9 '4242'",
    "printf 'kill 4242' | sh",
    "echo kill 4242 | bash",
    "$(echo kill) 4242",
    "`echo kill` 4242",
    "eval kill 4242",
    "eval 'kill 4242'",
    "launchctl kill 9 gui/501/com.iclone.os",
    "launchctl kill TERM pid/4242/",
    "launchctl unload -w ~/Library/LaunchAgents/ai.hermes.gateway.plist",
    "launchctl bootout user/501/ai.hermes.gateway",
    # r6 drift (r5 T-M1b/m7): `fuser -k -9` on a port the gate does not hold is a dangerous X — see test_fuser_unheld.
    "python3 -c 'import os; os.kill(os.getppid(), 9)'",
    "python3 -c 'import signal, os; os.kill(4242, signal.SIGTERM)'",
    "python3 -c 'import subprocess; subprocess.run([\"kill\", \"4242\"])'",
    "node -e 'require(\"child_process\").execSync(\"kill 4242\")'",
    "node -e 'process.kill(4242, \"SIGKILL\")'",
    "node -e 'process.kill(-4242)'",
    "ruby -e 'Process.kill(9, -4242)'",
    "perl -e 'kill KILL => 4242'",
    "osascript -l JavaScript -e 'Application(\"icloneOS\").quit()'",
    "osascript -e 'tell application id \"com.iclone.os\" to quit'",
]


def test_fuser_unheld(plugin, tmp_path):
    res = modes(plugin, "terminal", {"command": "fuser -k -9 7777/tcp"}, str(tmp_path), guardPids=[4242])
    assert res["automatic"][0] in ("ask", "refuse") and res["automatic"][4].get("dangerous") is True, res


@pytest.mark.parametrize("cmd", KILL_NEW)
def test_t2_new_kill_forms_three_tools(plugin, tmp_path, cmd):
    out = {}
    for tool, args in TOOLS3(cmd):
        res = modes(plugin, tool, args, str(tmp_path), guardPids=[4242])
        out[tool] = floor_everywhere(res)
        if tool == "terminal":
            line("KILL", cmd, res)
    print(f"\nKILL3|{cmd!r}|" + "|".join(f"{t}={'F' if ok else 'x'}" for t, ok in out.items()))
    assert all(out.values()), (cmd, out)


# ---- the cheap spellings: verb hidden by quoting / ANSI-C / variable / regex pattern. These are MY attack; expected floor.
KILL_CHEAP = [
    "k\\ill 4242",                      # backslash-split verb — runs in /bin/sh (proven: `k\ill -l`)
    "ki''ll 4242",                      # empty-quote-split verb
    "\"k\"ill 4242",
    "$'\\x6bill' 4242",                 # ANSI-C quoting — runs in /bin/sh and zsh (proven)
    "k=kill; $k 4242",                  # variable in command position
    "${k:-kill} 4242",
    "k=pkill; $k -f electron",
    "pkill -f .",                       # regex pattern that selects every process incl. the gate (pgrep -f . → 806/813)
    "pkill -f ''",
    "pkill .",
    "pkill -f '^'",
    "pkill -f serve",                   # the gate is `hermes serve --host 127.0.0.1 --port 0` (backend-command.ts)
    "pkill -f 'serve --host'",
    "pkill -f -- '--port'",
    "pkill -f bin/",                    # every venv/bin/python
    "pkill -f [a-z]",
    "pkill -f 'e.*'",
    "pkill -if 'ICLONE|HERMES|xyz'",   # alternation naming a guard — caught? (the literal is in the text)
    "pkill -f 'h.rmes'",                # regex that spells hermes without the literal
    "pkill -f 'i.lone'",
    "pkill -f 'ele.tron'",
    "pkill -f 'pyth.n'",
    "killall -m 'h.rmes'",              # (already floor via -m)
    "pkill -x Python",                  # exact name: a guard name → floor expected
    "pkill -x python3.11",
    "pkill -x hermes",
    "echo a2lsbCA0MjQy | base64 -d | sh",   # 'kill 4242' — the universal regex limit (INFO unless cheap to close)
    "echo 'a2lsbCA0MjQy' | base64 --decode | bash",
    "kill -9 $(printf 4242)",           # expansion → floor
    "kill -9 \"$X\"",
    "KILLPID=4242; kill -9 $KILLPID",
]


@pytest.mark.parametrize("cmd", KILL_CHEAP)
def test_t2_cheap_spellings(plugin, tmp_path, cmd):
    res = modes(plugin, "terminal", {"command": cmd}, str(tmp_path), guardPids=[4242])
    line("CHEAP", cmd, res)
    assert floor_everywhere(res), (cmd, res)


KILL_CONTROLS = [
    "kill -l", "kill -0 1234", "kill 1234", "pkill -f my-dev-server", "pkill -x my-dev-server", "pkill -HUP nginx",
    "killall Dock", "launchctl list", "launchctl print gui/501/com.x", "fuser 3000/tcp", "lsof -i :3000",
    "git log --grep=kill", "grep -r 'process.kill' src/", "cat kill.txt", "echo 'kill switch'", "npm run kill-port",
    "docker kill web",  # another namespace: is it floored? (docker kill cannot reach the gate)
    "tmux kill-session -t x", "tmux kill-server",
    "pkill -f vite", "pkill -f 'next dev'", "pkill -f webpack",
]


@pytest.mark.parametrize("cmd", KILL_CONTROLS)
def test_t2_controls(plugin, tmp_path, cmd):
    res = modes(plugin, "terminal", {"command": cmd}, str(tmp_path), guardPids=[4242])
    line("KCTRL", cmd, res)
    assert res["ignore"][3] is None, (cmd, res["ignore"])


# ------------------------------------------------------------------ T8' spend: NEW forms (mine)
SPEND_NEW = [
    "privy wallets rpc --method eth_sendTransaction --wallet w1",
    "privy wallets rpc eth_sendRawTransaction --wallet w1 --params '[\"0x..\"]'",
    "privy wallets rpc solana_signAndSendTransaction --wallet s1",
    "privy wallets rpc signAndSendTransaction --wallet s1",
    "privy wallets rpc --wallet w1 --method=eth_signTypedData_v4 --params x",
    "privy wallets rpc --wallet w1 -m eth_sendTransaction",
    "privy wallets rpc --method 'eth_sendTransaction' --wallet w1",
    "privy wallets rpc --method \"personal_sign\" --wallet w1",
    "privy wallets rpc secp256k1_sign --wallet w1",
    "privy wallets rpc eth_signTypedData --wallet w1",
    "privy wallets rpc ETH_SENDTRANSACTION --wallet w1",
    "onchainos wallet send --to 0x1 --amount 1 --chain base",
    "onchainos dex swap --from ETH --to USDC --amount 1",
    "onchainos bridge --from base --to arb --amount 1",
    "onchainos wallet contract-call --to 0x1 --data 0x",
    "onchainos wallet approve --token 0x1 --spender 0x2",      # not in the verb list — approve moves value
    "onchainos wallet withdraw --to 0x1 --amount 1",          # not in the verb list
    "onchainos wallet deposit --amount 1",
    "onchainos x402 pay --url https://x",
    "onchainos payment pay --url https://x",
    "onchainos gas-station pay --tx 0x",
    "onchainos gateway broadcast --signed 0x",
    "onchainos limit-order create --pair ETH/USDC --price 1",
    "onchainos strategy create-limit --pair ETH/USDC",
    "onchainos defi invest --product p1 --amount 1",
    "onchainos cross-chain send --from base --to eth --amount 1",
    "Privy Wallets RPC eth_sendTransaction --wallet w1",
    "npx privy wallets rpc eth_sendTransaction --wallet w1",
    "~/.privy/bin/privy wallets rpc eth_sendTransaction --wallet w1",       # ABSOLUTE PATH — the documented location of the CLI
    "/Users/u/.privy/bin/privy wallets rpc eth_sendTransaction --wallet w1",
    "$HOME/.privy/bin/privy wallets send --wallet w1 --to 0x1 --value 1",
    "~/.local/bin/onchainos wallet send --to 0x1 --amount 1",              # where onchainos is installed
    "/Users/u/.local/bin/agentcard wallet send 0x1 1",
    "~/.local/bin/acp trade buy --symbol X --amount 1",                    # acp spend behind a path (r2 rule)
    "/Users/u/.local/bin/acp client fund --amount 1",
    "PRIVY_APP_ID=x privy wallets rpc eth_sendTransaction --wallet w1",
    "cd /tmp && privy wallets rpc eth_sendTransaction --wallet w1",
    "privy wallets rpc eth_sendTransaction --wallet w1 | tee out.json",
    "privy  wallets   rpc   eth_sendTransaction",
    "privy wallets rpc\teth_sendTransaction",
    "agentcard wallet send 0x1 1",
    "agentcard request new --limit 5 --merchant x",
    "agentcard card create --limit 50",
    "agentcard checkout --url https://shop/x",
    "agentcard x402 fetch https://paid/x",
    "agentcard wallet pay --to x --amount 1",
    "privy wallets transfer --wallet w1 --to 0x1 --value 1",
    "privy wallet transactions send --wallet w1 --to 0x1",
    "privy --app-id a --app-secret-file f wallets rpc eth_sendTransaction --wallet w1",
    "sh -c 'privy wallets rpc eth_sendTransaction --wallet w1'",
    "bash -c \"onchainos wallet send --to 0x1 --amount 1\"",
    "python3 -c 'import subprocess; subprocess.run([\"privy\",\"wallets\",\"rpc\",\"eth_sendTransaction\"])'",
    "node -e 'require(\"child_process\").execSync(\"onchainos wallet send --to 0x1 --amount 1\")'",
]


@pytest.mark.parametrize("cmd", SPEND_NEW)
def test_t8_new_spend_forms(plugin, tmp_path, cmd):
    grants = [{"id": "g", "cls": "$", "scope": "standing", "sessionId": None, "project": None}]
    res = modes(plugin, "terminal", {"command": cmd}, str(tmp_path), grants=grants)
    line("SPEND", cmd, res)
    assert all(v[2] == "$" and v[0] in ("ask", "refuse") and v[1] != "grant" for v in res.values()), (cmd, res)


@pytest.mark.parametrize("cmd", SPEND_NEW[:12] + [SPEND_NEW[26], SPEND_NEW[28]])
def test_t8_spend_via_process_submit_and_execute_code_never_allowed(plugin, tmp_path, cmd):
    """floor 5 says `$` asks in EVERY mode. The same text through `process submit` / `execute_code`: is it ever allowed?"""
    r1 = modes(plugin, "process", {"action": "submit", "session_id": "s", "data": cmd}, str(tmp_path))
    r2 = modes(plugin, "execute_code", {"code": f"import subprocess; subprocess.run({cmd.split()!r})"}, str(tmp_path))
    r3 = modes(plugin, "execute_code", {"code": f"import os; os.system({cmd!r})"}, str(tmp_path))
    print(f"\nSPENDPROC|{cmd!r}|submit=" + ",".join(f"{m}:{v[0]}" for m, v in r1.items())
          + "|code_argv=" + ",".join(f"{m}:{v[0]}" for m, v in r2.items()) + "|code_sys=" + ",".join(f"{m}:{v[0]}" for m, v in r3.items()))
    assert all(v[0] in ("ask", "refuse") for v in r1.values()), ("process submit", cmd, r1)
    assert all(v[0] in ("ask", "refuse") for v in r2.values()), ("execute_code argv", cmd, r2)
    assert all(v[0] in ("ask", "refuse") for v in r3.values()), ("execute_code system", cmd, r3)


SPEND_NEG = [
    "privy wallets list", "privy wallets get w1", "privy wallets rpc eth_getBalance --wallet w1",
    "privy wallets rpc eth_call --wallet w1 --params '[]'", "privy wallets rpc eth_blockNumber", "privy wallets rpc eth_getTransactionReceipt --params '[\"0x\"]'",
    "privy wallets rpc eth_getTransactionCount --wallet w1", "privy wallets rpc eth_estimateGas --wallet w1", "privy wallets rpc eth_gasPrice",
    "privy wallets rpc --method eth_getCode", "privy users list", "privy apps get",
    "onchainos wallet balance", "onchainos wallet address", "onchainos wallet history", "onchainos wallet addresses --chain base",
    "onchainos market price --token ETH", "onchainos token info ETH", "onchainos portfolio", "onchainos security tx-scan --tx 0x",
    "onchainos dex quote --from ETH --to USDC --amount 1",                      # a quote is a read
    "onchainos wallet tx-status --hash 0x",
    "agentcard wallet balance", "agentcard whoami", "agentcard limit", "agentcard wallet address", "agentcard status",
    "agentcard email list", "agentcard email read --id 7",
    "acp wallet balance", "acp job list", "acp client list-jobs", "acp trade stock-list", "acp provider list",
    "~/.local/bin/onchainos wallet balance", "/Users/u/.privy/bin/privy wallets list",
    "cat privy_wallets_rpc_eth_sendTransaction.log",       # a file name, not a call
    "grep -r 'onchainos wallet send' docs/",
    "echo 'privy wallets rpc eth_sendTransaction' > notes.txt",
    "git log --grep='agentcard wallet send'",
    "man privy", "privy --version", "onchainos --help", "agentcard --help",
]


@pytest.mark.parametrize("cmd", SPEND_NEG)
def test_t8_negative_controls(plugin, tmp_path, cmd):
    res = modes(plugin, "terminal", {"command": cmd}, str(tmp_path))
    line("SPENDNEG", cmd, res)
    assert all(v[2] != "$" for v in res.values()), (cmd, res)
    assert res["ignore"][0] == "allow", (cmd, res["ignore"])


# ------------------------------------------------------------------ m1: 5 new forms + controls
M1_FORMS = [
    "cat x > \"/tmp/$(id -u)/.env\"",
    "cat x >| $B/x",                          # clobber redirect — a NEW operator spelling (`>|`)
    "cat x 1>$B/x",
    "cp -r src/ ${DEST}/",
    "sed -i'' -e s/a/b/ $B/config.yaml",
    "sed -i -e s/a/b/ -- $B/config.yaml",
    "perl -i.bak -pe s/a/b/ $B/x",
    "rsync -a --delete a/ $B/",
    "dd if=a of=$B/x",
    "install -m 644 a $(dirname $B)/x",
    "tee -a $B/x < in",
    "mv -f a $B/",
    "ln -sf a $B/x",
    "cp a `echo b`",
    "cat x > $B",
]


@pytest.mark.parametrize("cmd", M1_FORMS)
def test_m1_forms_dangerous_in_automatic(plugin, tmp_path, cmd):
    res = modes(plugin, "terminal", {"command": cmd}, str(tmp_path))
    line("M1", cmd, res)
    assert res["automatic"][0] == "ask" and res["automatic"][4].get("dangerous") is True, (cmd, res["automatic"])
    assert res["ignore"][0] == "allow", (cmd, res["ignore"])


M1_CONTROLS = ["cat x > out.txt", "cp a b", "echo $HOME", "ls $B", "cat $B/x", "cp \\$a b", "grep x $(ls)", "touch a b",
               "cat > a < $B", "echo hi >&2", "sed s/a/b/ $B/x", "cat x | sort > y", "cp a b 2>/dev/null"]
# r6 drift (r4 i2, info): `python3 -c 'print($B)'` is flagged by Hermes' own dangerous-command detector, not by this
# classifier — dangerous there is Hermes' call (it asks in Automatic, never the floor).


@pytest.mark.parametrize("cmd", M1_CONTROLS)
def test_m1_controls_not_dangerous(plugin, tmp_path, cmd):
    from hermes_plugins.iclone_permissions.classify import classify
    c = classify("terminal", {"command": cmd}, str(tmp_path), _body())
    print(f"\nM1CTRL|{cmd!r}|d={c.facts.get('dangerous')}|cls={c.cls}|floor={c.floor}")
    assert c.facts.get("dangerous") is False, (cmd, c.facts)


# ------------------------------------------------------------------ m2: 5 new forms + controls
M2_FORMS = [
    "echo 'tell application \"Hermes\" to quit' | osascript",
    "printf '%s\\n' 'tell app \"icloneOS\" to quit' | osascript -",
    "osascript - <<'EOF'\ntell application \"Electron\" to quit\nEOF",
    "cat <<'X' | osascript -l JavaScript\nApplication('icloneOS').quit()\nX",
    "osascript -e 'tell application \"System Events\"' -e 'tell process \"icloneOS\" to quit' -e 'end tell'",
    "echo 'do shell script \"pkill -f hermes\"' | osascript",
    "s='tell app \"icloneOS\" to quit'; echo \"$s\" | osascript",
    "osascript -e \"$(printf 'tell app \"icloneOS\" to quit')\"",
    "osascript -e 'tell application \"System Events\" to keystroke \"q\" using command down'",   # quits the frontmost app (icloneOS)
    "osascript -e 'tell application \"icloneOS\" to «event aevtquit»'",                          # raw quit event, no `quit` word
]


@pytest.mark.parametrize("cmd", M2_FORMS)
def test_m2_forms(plugin, tmp_path, cmd):
    out = {}
    for tool, args in TOOLS3(cmd):
        res = modes(plugin, tool, args, str(tmp_path), guardPids=[4242])
        out[tool] = res
        if tool == "terminal":
            line("M2", cmd, res)
    print(f"\nM2-3|{cmd!r}|" + "|".join(f"{t}={'F' if floor_everywhere(r) else ('never-allow' if all(v[0] != 'allow' for v in r.values()) else 'ALLOW')}" for t, r in out.items()))
    assert all(all(v[0] != "allow" for v in r.values()) for r in out.values()), (cmd, out)


M2_CONTROLS = ["osascript -e 'display notification \"hi\"'", "echo 'quit app \"Notes\"' | osascript", "osascript x.scpt",
               "osascript -e 'tell app \"Finder\" to activate'", "osascript -e 'tell application \"Electron\" to activate'"]


@pytest.mark.parametrize("cmd", M2_CONTROLS)
def test_m2_controls_s_and_ask(plugin, tmp_path, cmd):
    res = modes(plugin, "terminal", {"command": cmd}, str(tmp_path), guardPids=[4242])
    line("M2CTRL", cmd, res)
    assert all(v[2] == "S" and v[0] in ("ask", "refuse") for v in res.values()), (cmd, res)


# ------------------------------------------------------------------ the builder's honest over-floors: measure, then judge
OVERFLOORS = [
    "python3 -c 'import subprocess; p=subprocess.Popen([\"sleep\",\"9\"]); p.terminate()'",
    "python3 -c 'import subprocess; subprocess.Popen([\"sleep\",\"9\"]).kill()'",
    "python3 -c 'import os; os.kill(os.getpid(), 15)'",
    "pkill -P 99999",
    "pkill -P $$ sleep",
    "fuser -k 3000/tcp",
    "fuser -k 8080/tcp",
    "onchainos gateway gas --chain base",
    "onchainos gateway simulate --tx x",
    "onchainos gateway chains",
    "onchainos strategy list",
    "onchainos defi list",
    "onchainos payment list",
    "onchainos x402 list",
    "cp \"$f\" \"$f.bak\"",
    "mv $a $b",
    "for f in *.log; do mv \"$f\" \"$f.old\"; done",
    "pkill -f my-dev-server",
    "pkill -f 'node .*vite'",
    "pkill -u $USER -f my-dev-server",
    "pkill -t ttys003 vim",
    "killall -u $USER node",            # kills node — a guard name anyway
    "launchctl stop com.example.my-agent",
    "launchctl bootout gui/501/com.example.my-agent",
    "launchctl kickstart -k gui/501/com.example.my-agent",
    "timeout -s KILL 5 ./slow",
    "docker kill web",
    "tmux kill-server",
]


@pytest.mark.parametrize("cmd", OVERFLOORS)
def test_overfloors_measure(plugin, tmp_path, cmd):
    res = modes(plugin, "terminal", {"command": cmd}, str(tmp_path), guardPids=[4242])
    line("OVER", cmd, res)


# ------------------------------------------------------------------ extra commit: agentcard email ⇒ M
EMAIL = ["agentcard email send --to a@b.c --subject hi --body x", "agentcard email reply --id 7 --body ok", "agentcard email forward --id 7 --to a@b.c",
         "agentcard email compose --to a@b.c", "~/.local/bin/agentcard email send --to a@b.c", "agentcard --json email send --to a@b.c",
         "sh -c 'agentcard email send --to a@b.c'", "agentcard email draft --to a@b.c", "agentcard email list", "agentcard email read --id 7"]


@pytest.mark.parametrize("cmd", EMAIL)
def test_email_measure(plugin, tmp_path, cmd):
    res = modes(plugin, "terminal", {"command": cmd}, str(tmp_path))
    line("EMAIL", cmd, res)


# ------------------------------------------------------------------ no regression: r3 T1/T3 are TS/paths — T3 5 forms here; fuzz; concurrency is -k in the suite
def _hroot(tmp_path):
    root = tmp_path / "hermes-agent"
    (root / "tools").mkdir(parents=True)
    (root / "plugins" / "iclone-permissions").mkdir(parents=True)
    return root, [str(root)]


def test_t3_five_forms_still_floor(plugin, tmp_path):
    root, protected = _hroot(tmp_path)
    forms = [f"cp /tmp/x {root}/tools/file_tools.py", f"tee {root}/tools/approval.py < /tmp/x", f"git -C {root} reset --hard HEAD~1",
             f"sed -i '' s/a/b/ {root}/plugins/iclone-permissions/classify.py", f"cd {root}/tools && cp /tmp/x ./approval.py"]
    for cmd in forms:
        res = modes(plugin, "terminal", {"command": cmd}, str(tmp_path), protectedPaths=protected)
        print(f"\nT3|{cmd!r}|" + "|".join(f"{m}:{v[0]}/{v[1]}" for m, v in res.items()))
        assert all(v[0] == "refuse" and v[1] == "floor" for v in res.values()), (cmd, res)


def test_fuzz_300_exceptions_at_three_sites(wired, monkeypatch):
    mod, main, _ = wired(_body(standing="ignore"))
    import hermes_plugins.iclone_permissions.classify as C
    import hermes_plugins.iclone_permissions.policy as Pol

    rng = random.Random(11)
    sites = {"_kill_targets_guard": C, "_code_kills_guard": C, "_pkill_selects_more_than_a_name": C, "_osascript_stops_guard": C,
             "_inft_floor": C, "decide": Pol}
    inj = {"site": None, "hit": 0}
    errs = [RuntimeError("x"), ValueError("v"), OSError(36, "long"), RecursionError(), MemoryError(), KeyError("k"), TypeError("t"),
            AttributeError("a"), IndexError("i"), UnicodeDecodeError("utf-8", b"\xff", 0, 1, "bad")]

    def flaky(name, real):
        def w(*a, **k):
            if inj["site"] == name:
                inj["hit"] += 1
                raise rng.choice(errs)
            return real(*a, **k)
        return w

    for n, m in sites.items():
        monkeypatch.setattr(m, n, flaky(n, getattr(m, n)))

    def junk(d=0):
        p = rng.randrange(8)
        if p == 0:
            return "".join(rng.choice(string.printable + "\0​") for _ in range(rng.randrange(0, 200)))
        if p == 1:
            return rng.choice(["kill -9 $PPID", "pkill -f .", "/bin/kill 4242", "privy wallets rpc eth_sendTransaction", "onchainos dex swap",
                               "launchctl bootout gui/501", "python -c 'os.kill(4242,9)'", "echo x | osascript", "cp a $B",
                               "agentcard email send --to a", "cast send " + INFT[2:] + " 'approve(address,uint256)' 0x1 1"])
        if p == 2 and d < 3:
            return {rng.choice(["command", "path", "data", "code", "argv"]): junk(d + 1) for _ in range(2)}
        return rng.choice([None, 0, -1, 2 ** 70, float("nan"), True, b"\xff", [junk(d + 1)] if d < 3 else 1])

    tools = ["terminal", "process", "write_file", "patch", "execute_code", "mcp_x", "read_file"]
    bad = 0
    for i in range(300):
        inj["site"] = rng.choice(list(sites)) if i % 10 < 5 else None
        before = inj["hit"]
        tool = rng.choice(tools)
        args = rng.choice([{"command": junk()}, {"path": junk()}, {"patch": junk(), "mode": "patch"}, {"code": junk()},
                          {"action": rng.choice(["submit", "write", "poll"]), "data": junk(), "session_id": "s"}, junk()])
        result = mod.on_pre_tool_call(tool, args, "t", "s1")
        if inj["hit"] > before and result is None:
            bad += 1
    print(f"\nFUZZ hits={inj['hit']} allowed_on_exception={bad}")
    assert inj["hit"] >= 50
    assert bad == 0


def test_own_child_kill_is_not_floor_but_guard_pgrp_is(plugin, tmp_path):
    from hermes_plugins.iclone_permissions.classify import classify
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    try:
        assert classify("terminal", {"command": f"kill -TERM {child.pid}"}, str(tmp_path), _body(guardPids=[4242])).floor is None
        assert classify("terminal", {"command": f"kill -9 -{os.getpgrp()}"}, str(tmp_path), _body()).floor
    finally:
        child.kill()
        child.wait()
