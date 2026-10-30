"""Fake `claude` CLI for the plugin tests (never the real one). Mode via FAKE_CLAUDE_MODE."""
import json
import os
import stat
import sys

MODE = os.environ.get("FAKE_CLAUDE_MODE", "ok")
LOG = os.environ["FAKE_CLAUDE_LOG"]


def log(entry):
    with open(LOG, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry) + "\n")


def out(obj):
    sys.stdout.write((obj if isinstance(obj, str) else json.dumps(obj)) + "\n")
    sys.stdout.flush()


argv = sys.argv[1:]
if argv[:2] == ["auth", "status"]:
    log({"kind": "auth"})
    if MODE == "notlogged":
        out({"loggedIn": False, "authMethod": "none", "apiProvider": "firstParty"})
        sys.exit(1)
    out({"loggedIn": True, "authMethod": "claude.ai", "subscriptionType": "max", "email": "x@example.invalid"})
    sys.exit(0)

prompt = argv[argv.index("--system-prompt-file") + 1]
mode_bits = stat.S_IMODE(os.stat(prompt).st_mode) if os.path.exists(prompt) else None
log({
    "kind": "spawn",
    "argv": argv,
    "prompt_mode": mode_bits,
    "env_api_key": "ANTHROPIC_API_KEY" in os.environ,
    "env_auth_token": "ANTHROPIC_AUTH_TOKEN" in os.environ,
})
sid = argv[argv.index("--session-id") + 1] if "--session-id" in argv else argv[argv.index("--resume") + 1]
for raw in sys.stdin:
    msg = json.loads(raw)
    content = msg["message"]["content"]
    log({"kind": "turn", "content": content})
    out({"type": "system", "subtype": "init", "session_id": sid})
    if MODE == "exit_mid":
        sys.exit(1)
    if MODE == "malformed":
        out("{not json")
    if MODE == "notlogged_turn":
        out({"type": "result", "subtype": "success", "is_error": True, "result": "Not logged in · Please run /login"})
        continue
    if MODE == "rejected":
        out({"type": "rate_limit_event", "rate_limit_info": {"status": "rejected", "unifiedWindows": {
            "five_hour": {"utilization": 1.0, "resetsAt": 1792205400}}}})
        out({"type": "result", "subtype": "success", "is_error": True, "result": "usage limit reached"})
        continue
    if MODE == "rejected_ok":
        out({"type": "rate_limit_event", "rate_limit_info": {"status": "rejected", "isUsingOverage": True,
            "unifiedWindows": {"five_hour": {"utilization": 1.0, "resetsAt": 1792205400}}}})
    if "USE_TOOL" in content:
        call = {"id": "call_1", "type": "function", "function": {"name": "memory", "arguments": "{\"q\": 1}"}}
        text = "<tool_call>" + json.dumps(call) + "</tool_call>"
    else:
        text = "OK"
    out({"type": "assistant", "message": {"content": [{"type": "text", "text": text}]}})
    out({"type": "rate_limit_event", "rate_limit_info": {"status": "allowed", "unifiedWindows": {
        "five_hour": {"utilization": 0.63, "resetsAt": 1792205400}, "seven_day": {"utilization": 0.2, "resetsAt": 1792805400}}}})
    out({"type": "result", "subtype": "success", "is_error": False, "result": text})
