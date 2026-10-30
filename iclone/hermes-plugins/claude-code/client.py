"""Claude Code engine: an OpenAI-client-shaped facade over the USER's own `claude` CLI.

Sibling of ``agent.copilot_acp_client``: Hermes keeps the loop, the soul, the skills and the
tools; this client only answers model calls. Tools travel as TEXT through the shared
``agent.acp_openai_bridge`` contract (``<tool_call>{...}</tool_call>``) and Hermes executes them.

One ``claude`` process per Hermes session is kept alive (stream-json in/out). The first call of a
session generation sends the whole transcript; later calls send only the new messages. Any
divergence (edited history, compaction, a changed system prompt or toolset) starts a new
generation. After an idle kill the process is respawned with ``--resume`` and the IDENTICAL argv.

The CLI owns authentication: this module never reads, prints or forwards credentials, and it
strips API-key variables from the child environment so the user's subscription is what runs.
"""

from __future__ import annotations

import hashlib
import json
import os
import queue
import shutil
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, Iterable

# "claude-code" and "claude" are existing Hermes aliases of the anthropic provider; this id must not
# shadow them (additive only), so the engine has its own id.
PROVIDER_ID = "claude-code-cli"
BASE_URL = "acp://claude-code"
MODELS = ("claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5")
DEFAULT_MODEL = MODELS[0]

IDLE_SECONDS = float(os.environ.get("ICLONE_CLAUDE_CODE_IDLE_SECONDS", "600"))
AUTH_CACHE_SECONDS = 60.0
DEFAULT_TIMEOUT_SECONDS = 900.0
MAX_BUDGET_USD = os.environ.get("ICLONE_CLAUDE_CODE_MAX_BUDGET_USD", "5")

# Reasons the turn is retried once on Nous (design §2.4). Anything else surfaces as an error.
FALLBACK_REASONS = frozenset(
    {"binary_missing", "not_logged_in", "window_rejected", "auth_usage", "process_exit", "no_session"}
)
REASON_TEXT = {
    "binary_missing": "Claude Code is not installed",
    "not_logged_in": "Claude Code is not logged in",
    "window_rejected": "the usage window is full",
    "auth_usage": "the subscription refused the request",
    "process_exit": "Claude Code stopped mid-turn",
    "no_session": "the request had no Hermes session",
}

# Child env: these would make `claude` bill an API key instead of the user's subscription.
_STRIPPED_ENV = (
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
)
_LOGIN_MARKERS = (
    "not logged in",
    "please run /login",
    "invalid api key",
    "oauth token revoked",
    "oauth session expired",
    "failed to authenticate",
)
_USAGE_MARKERS = ("usage limit", "hit your limit", "out of extra usage", "rate limit", "resets at")

_NS = uuid.UUID("6f1c2a0e-3d4b-5c6d-8e7f-a1b2c3d4e5f6")
_TRANSCRIPT_LABELS = {
    "system": "System",
    "user": "User",
    "assistant": "Assistant",
    "tool": "Tool",
    "context": "Context",
}
_PROMPT_HEADER = (
    "You are the model behind a Hermes agent. Hermes runs every tool itself.",
    "IMPORTANT: to use a tool, output tool calls using <tool_call>{...}</tool_call> blocks with JSON exactly"
    " in OpenAI function-call shape, and nothing else for that step.",
    "If no tool is needed, answer normally.",
)


class ClaudeCodeUnavailable(RuntimeError):
    """A classified Claude Code failure; ``reason`` is a key of REASON_TEXT (or another tag)."""

    def __init__(self, reason: str, detail: str = "") -> None:
        super().__init__(f"claude-code unavailable: {reason}" + (f" ({detail})" if detail else ""))
        self.reason = reason
        self.detail = detail


# --------------------------------------------------------------------------- paths & status


def plugin_dir() -> Path:
    return Path(__file__).resolve().parent


def _write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(payload, handle)
    os.replace(tmp, path)


def _read_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


_status_lock = threading.Lock()


def update_status(base: Path, **fields: Any) -> dict[str, Any]:
    """Merge ``fields`` into status.json (read by the desktop app). Never holds content."""
    with _status_lock:
        path = base / "status.json"
        data = _read_json(path)
        data.update(fields)
        data["version"] = 1
        data["updatedAt"] = int(time.time() * 1000)
        _write_json_atomic(path, data)
        return data


def window_from_rate_limit(event: dict[str, Any]) -> dict[str, Any]:
    info = event.get("rate_limit_info") if isinstance(event.get("rate_limit_info"), dict) else {}
    windows = info.get("unifiedWindows") if isinstance(info.get("unifiedWindows"), dict) else {}

    def one(key: str) -> dict[str, Any] | None:
        raw = windows.get(key)
        if not isinstance(raw, dict):
            return None
        util = raw.get("utilization")
        resets = raw.get("resetsAt")
        return {
            "utilization": float(util) if isinstance(util, (int, float)) else None,
            "resetsAt": int(resets) if isinstance(resets, (int, float)) else None,
        }

    return {
        "status": str(info.get("status") or "unknown"),
        "fiveHour": one("five_hour"),
        "sevenDay": one("seven_day"),
        "isUsingOverage": bool(info.get("isUsingOverage")),
    }


# --------------------------------------------------------------------------- binary & login


def discover_binary(base: Path | None = None) -> str | None:
    """`claude` path: env override → the app-discovered path (binary.json) → known installs → PATH."""
    base = base or plugin_dir()
    home = Path.home()
    candidates: list[str] = []
    override = os.environ.get("ICLONE_CLAUDE_BIN", "").strip()
    if override:
        candidates.append(override)
    recorded = _read_json(base / "binary.json").get("path")
    if isinstance(recorded, str) and recorded:
        candidates.append(recorded)
    candidates += [
        str(home / ".local/bin/claude"),
        str(home / ".claude/local/claude"),
        "/opt/homebrew/bin/claude",
        "/usr/local/bin/claude",
        str(home / ".bun/bin/claude"),
        str(home / ".volta/bin/claude"),
        str(home / ".npm-global/bin/claude"),
    ]
    for candidate in candidates:
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return shutil.which("claude")


def parse_auth_status(stdout: str) -> dict[str, Any]:
    """`claude auth status --json` → {loggedIn, authMethod, subscriptionType}; identity fields dropped."""
    try:
        data = json.loads(stdout or "")
    except ValueError:
        return {"loggedIn": False, "authMethod": "unknown", "subscriptionType": None}
    if not isinstance(data, dict):
        return {"loggedIn": False, "authMethod": "unknown", "subscriptionType": None}
    if data.get("type") == "result" and data.get("is_error"):
        return {"loggedIn": False, "authMethod": "none", "subscriptionType": None}
    sub = data.get("subscriptionType")
    return {
        "loggedIn": data.get("loggedIn") is True,
        "authMethod": str(data.get("authMethod") or "none"),
        "subscriptionType": str(sub) if isinstance(sub, str) and sub else None,
    }


_auth_cache: dict[str, tuple[float, dict[str, Any]]] = {}


def auth_status(binary: str, *, runner: Callable[..., Any] = subprocess.run, now: float | None = None) -> dict[str, Any]:
    """Zero-turn login check, cached 60 s per binary."""
    now = time.monotonic() if now is None else now
    hit = _auth_cache.get(binary)
    if hit and now - hit[0] < AUTH_CACHE_SECONDS:
        return hit[1]
    try:
        proc = runner(
            [binary, "auth", "status", "--json"],
            capture_output=True,
            text=True,
            timeout=10,
            env=child_env(),
        )
        status = parse_auth_status(proc.stdout)
    except (OSError, subprocess.SubprocessError):
        status = {"loggedIn": False, "authMethod": "unknown", "subscriptionType": None}
    _auth_cache[binary] = (now, status)
    return status


def child_env(base_env: dict[str, str] | None = None) -> dict[str, str]:
    env = dict(os.environ if base_env is None else base_env)
    for name in _STRIPPED_ENV:
        env.pop(name, None)
    env["DISABLE_AUTOUPDATER"] = "1"
    env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] = "1"
    return env


# --------------------------------------------------------------------------- classification


def classify_result(event: dict[str, Any]) -> str | None:
    """A `result` event → None (success) or a failure reason."""
    if not event.get("is_error"):
        return None
    text = str(event.get("result") or "").lower()
    if any(marker in text for marker in _LOGIN_MARKERS):
        return "not_logged_in"
    if any(marker in text for marker in _USAGE_MARKERS):
        return "auth_usage"
    subtype = str(event.get("subtype") or "")
    if subtype == "error_max_budget_usd":
        return "budget"
    return "error"


# --------------------------------------------------------------------------- transcript


def render_content(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, dict):
        return str(content.get("text") or content.get("content") or "").strip()
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"])
        return "\n".join(p.strip() for p in parts if p and p.strip())
    return str(content).strip()


def _render_tool_calls(message: dict[str, Any]) -> str:
    blocks: list[str] = []
    for call in message.get("tool_calls") or []:
        fn = call.get("function") if isinstance(call, dict) else getattr(call, "function", None)
        if fn is None:
            continue
        name = fn.get("name") if isinstance(fn, dict) else getattr(fn, "name", "")
        args = fn.get("arguments") if isinstance(fn, dict) else getattr(fn, "arguments", "")
        call_id = call.get("id") if isinstance(call, dict) else getattr(call, "id", "")
        payload = {"id": call_id, "type": "function", "function": {"name": name, "arguments": args}}
        blocks.append(f"<tool_call>{json.dumps(payload)}</tool_call>")
    return "\n".join(blocks)


def _label_message(message: dict[str, Any]) -> str | None:
    role = str(message.get("role") or "unknown").strip().lower()
    if role not in _TRANSCRIPT_LABELS:
        role = "context"
    rendered = render_content(message.get("content"))
    if role == "assistant":
        calls = _render_tool_calls(message)
        rendered = "\n".join(part for part in (rendered, calls) if part)
    if not rendered:
        return None
    return f"{_TRANSCRIPT_LABELS[role]}:\n{rendered}"


def format_transcript(messages: Iterable[dict[str, Any]]) -> str:
    """copilot-acp's transcript strategy: role-labelled flattening of the conversation."""
    lines = [label for label in (_label_message(m) for m in messages if isinstance(m, dict)) if label]
    if not lines:
        return ""
    return (
        "Conversation transcript:\n\n"
        + "\n\n".join(lines)
        + "\n\nContinue the conversation from the latest user request."
    )


def format_delta(messages: list[dict[str, Any]]) -> str:
    parts: list[str] = []
    saw_tool = False
    for message in messages:
        role = str(message.get("role") or "").lower()
        text = render_content(message.get("content"))
        if role == "tool":
            saw_tool = True
            parts.append(f"Tool result ({message.get('tool_call_id') or 'call'}):\n{text}")
        elif role == "user":
            parts.append(text)
        else:
            label = _label_message(message)
            if label:
                parts.append(label)
    if saw_tool:
        parts.append("Continue from the tool results above.")
    return "\n\n".join(p for p in parts if p)


def _fingerprint(messages: list[dict[str, Any]]) -> str:
    digest = hashlib.sha256()
    for message in messages:
        digest.update(
            json.dumps(
                [message.get("role"), render_content(message.get("content")), message.get("tool_call_id")],
                sort_keys=True,
                default=str,
            ).encode()
        )
    return digest.hexdigest()


def build_system_prompt(messages: list[dict[str, Any]], tools: Any, tool_choice: Any) -> str:
    from agent.acp_openai_bridge import render_tool_bridge_sections

    sections = list(_PROMPT_HEADER)
    system = [render_content(m.get("content")) for m in messages if m.get("role") == "system"]
    sections.extend(s for s in system if s)
    sections.extend(render_tool_bridge_sections(tools, tool_choice))
    return "\n\n".join(s.strip() for s in sections if s and s.strip())


def build_argv(binary: str, *, model: str, prompt_file: str, session_id: str, resume: bool) -> list[str]:
    """S1 §3 lean argv. Identical on resume except the session flag (snapshot semantics)."""
    argv = [
        binary,
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        model,
        "--tools",
        "",
        "--restricted",
        "--permission-mode",
        "dontAsk",
        "--strict-mcp-config",
        "--mcp-config",
        '{"mcpServers":{}}',
        "--setting-sources",
        "",
        "--system-prompt-file",
        prompt_file,
        "--max-budget-usd",
        str(MAX_BUDGET_USD),
    ]
    return argv + (["--resume", session_id] if resume else ["--session-id", session_id])


# --------------------------------------------------------------------------- session processes


@dataclass
class _Session:
    key: str
    generation: int = 0
    session_id: str = ""
    proc: subprocess.Popen | None = None
    lines: "queue.Queue[str | None] | None" = None
    started: bool = False
    model: str = ""
    prompt_hash: str = ""
    system_prompt: str = ""
    sent_len: int = 0
    sent_fp: str = ""
    last_used: float = field(default_factory=time.monotonic)
    lock: threading.Lock = field(default_factory=threading.Lock)


_sessions: dict[str, _Session] = {}
_sessions_lock = threading.Lock()
_reaper_started = False


def _kill(proc: subprocess.Popen | None) -> None:
    if proc is None:
        return
    if proc.poll() is None:
        try:
            proc.terminate()
            proc.wait(timeout=3)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
    for pipe in (proc.stdin, proc.stdout, proc.stderr):
        try:
            if pipe is not None:
                pipe.close()
        except Exception:
            pass


def reap_idle(now: float | None = None, idle_seconds: float | None = None) -> int:
    """Kill processes idle past the limit; the session stays resumable. Returns the kill count."""
    now = time.monotonic() if now is None else now
    limit = IDLE_SECONDS if idle_seconds is None else idle_seconds
    killed = 0
    with _sessions_lock:
        sessions = list(_sessions.values())
    for session in sessions:
        if session.proc is not None and now - session.last_used >= limit and session.lock.acquire(blocking=False):
            try:
                if session.proc is not None and session.proc.poll() is None:
                    _kill(session.proc)
                    killed += 1
                session.proc = None
            finally:
                session.lock.release()
    return killed


def _ensure_reaper() -> None:
    global _reaper_started
    if _reaper_started:
        return
    _reaper_started = True

    def loop() -> None:
        while True:
            time.sleep(30)
            try:
                reap_idle()
            except Exception:
                pass

    threading.Thread(target=loop, name="claude-code-reaper", daemon=True).start()


def shutdown_all() -> None:
    with _sessions_lock:
        sessions = list(_sessions.values())
        _sessions.clear()
    for session in sessions:
        _kill(session.proc)


def _pump(proc: subprocess.Popen, sink: "queue.Queue[str | None]") -> None:
    try:
        assert proc.stdout is not None
        for line in proc.stdout:
            sink.put(line)
    except (OSError, ValueError):  # the pipe was closed by _kill
        pass
    finally:
        sink.put(None)


# --------------------------------------------------------------------------- the client


class _Completions:
    def __init__(self, client: "ClaudeCodeClient") -> None:
        self._client = client

    def create(self, **kwargs: Any) -> Any:
        return self._client._create_chat_completion(**kwargs)


class _Chat:
    def __init__(self, client: "ClaudeCodeClient") -> None:
        self.completions = _Completions(client)


def _effective_timeout(timeout: Any) -> float:
    if timeout is None:
        return DEFAULT_TIMEOUT_SECONDS
    if isinstance(timeout, (int, float)):
        return float(timeout)
    values = [getattr(timeout, a, None) for a in ("read", "write", "connect", "pool", "timeout")]
    numeric = [float(v) for v in values if isinstance(v, (int, float))]
    return max(numeric) if numeric else DEFAULT_TIMEOUT_SECONDS


def named_custom_base_url(provider: Any, module: Any = None) -> str:
    """The base_url a named ``custom:<slug>`` declares itself in config; '' for bare ``custom``, an unknown
    slug, or a build without the lookup. Such a slug's key belongs to that URL, never to a recorded one.
    Any non-empty string counts (no scheme or case filter): it only ever skips an injection, the safe side."""
    if not str(provider or "").strip().lower().startswith("custom:"):
        return ""
    if module is None:
        module = sys.modules.get("hermes_cli.runtime_provider")
    lookup = getattr(module, "_get_named_custom_provider", None)
    if not callable(lookup):
        return ""
    try:
        entry = lookup(str(provider).strip())
    except Exception:
        return ""
    url = entry.get("base_url") if isinstance(entry, dict) else None
    return url.strip() if isinstance(url, str) else ""


def _default_fallback(base: Path, reason: str, kwargs: dict[str, Any]) -> Any:
    """Retry the same request ONCE on the recorded engine (Nous by default) through Hermes's resolvers."""
    target = _read_json(base / "fallback.json")
    provider = str(target.get("provider") or "nous")
    model = target.get("model") if isinstance(target.get("model"), str) else None
    base_url = target.get("base_url") if isinstance(target.get("base_url"), str) else ""
    from agent.auxiliary_client import resolve_provider_client

    if base_url.startswith(("http://", "https://")):
        # A custom/local endpoint: Hermes resolves its own credentials for that URL. A named slug that
        # declares its own base_url resolves itself, so its key never travels to the recorded URL.
        import importlib

        runtime_provider = importlib.import_module("hermes_cli.runtime_provider")
        if named_custom_base_url(provider, runtime_provider):
            runtime = runtime_provider.resolve_runtime_provider(requested=provider)
        else:
            runtime = runtime_provider.resolve_runtime_provider(requested=provider, explicit_base_url=base_url)
        client, resolved_model = resolve_provider_client(provider, model, main_runtime=runtime)
    else:
        client, resolved_model = resolve_provider_client(provider, model)
    if client is None:
        raise ClaudeCodeUnavailable(reason, f"{provider} fallback unavailable")
    request = {k: v for k, v in kwargs.items() if k in {"messages", "tools", "tool_choice", "stream", "timeout"}}
    if not request.get("tools"):
        request.pop("tools", None)
        request.pop("tool_choice", None)
    return client.chat.completions.create(model=resolved_model or model, **request)


class ClaudeCodeClient:
    """Minimal OpenAI-client-compatible facade over the user's `claude` CLI."""

    def __init__(
        self,
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        session_key: str | Callable[[], Any] | None = None,
        command: str | None = None,
        acp_command: str | None = None,
        plugin_base: str | Path | None = None,
        fallback: Callable[[Path, str, dict[str, Any]], Any] | None = None,
        auxiliary: bool = False,
        **_: Any,
    ) -> None:
        # The placeholder id only satisfies callers that expect the attribute; it is never sent.
        self.api_key = PROVIDER_ID
        self.base_url = base_url or BASE_URL
        self.chat = _Chat(self)
        self.is_closed = False
        self._base = Path(plugin_base) if plugin_base else plugin_dir()
        self._command = acp_command or command
        self._session_key = session_key
        self._fallback = fallback or _default_fallback
        self._auxiliary = auxiliary
        self.last_fallback_reason: str | None = None

    def close(self) -> None:
        self.is_closed = True

    # The turn itself -------------------------------------------------------

    def current_session_key(self) -> str:
        """The Hermes session this call belongs to, read now: the agent assigns it after building the client."""
        key = self._session_key() if callable(self._session_key) else self._session_key
        return str(key) if key else ""

    def _create_chat_completion(self, **kwargs: Any) -> Any:
        if self._auxiliary:
            # Pinned to the fallback engine by design: no `claude`, and no "unavailable" banner.
            return self._fallback(self._base, "aux", kwargs)
        try:
            if not self.current_session_key():
                # Auxiliary tasks never get here (they are pinned to the fallback engine); a call
                # without a session is answered there too, and never spawns `claude`.
                raise ClaudeCodeUnavailable("no_session")
            return self._claude_completion(**kwargs)
        except ClaudeCodeUnavailable as exc:
            if exc.reason not in FALLBACK_REASONS:
                raise
            self.last_fallback_reason = exc.reason
            update_status(
                self._base,
                lastFallback={
                    "reason": exc.reason,
                    "text": REASON_TEXT.get(exc.reason, exc.reason),
                    "at": int(time.time() * 1000),
                },
            )
            return self._fallback(self._base, exc.reason, kwargs)

    def _resolve_binary(self) -> str:
        binary = self._command if self._command and os.path.isfile(self._command) else None
        binary = binary or discover_binary(self._base)
        if not binary:
            raise ClaudeCodeUnavailable("binary_missing")
        return binary

    def _claude_completion(
        self,
        *,
        model: str | None = None,
        messages: list[dict[str, Any]] | None = None,
        timeout: Any = None,
        tools: list[dict[str, Any]] | None = None,
        tool_choice: Any = None,
        stream: bool = False,
        **_: Any,
    ) -> Any:
        from agent.acp_openai_bridge import completion_to_stream_chunks, extract_tool_calls_from_text

        binary = self._resolve_binary()
        login = auth_status(binary)
        if not login.get("loggedIn"):
            raise ClaudeCodeUnavailable("not_logged_in")

        messages = [m for m in (messages or []) if isinstance(m, dict)]
        model_id = model if model in MODELS else DEFAULT_MODEL
        text, reasoning = self._run_turn(binary, model_id, messages, tools, tool_choice, _effective_timeout(timeout))
        tool_calls, cleaned = extract_tool_calls_from_text(text)
        message = SimpleNamespace(
            content=cleaned,
            tool_calls=tool_calls,
            reasoning=reasoning or None,
            reasoning_content=reasoning or None,
            reasoning_details=None,
        )
        completion = SimpleNamespace(
            choices=[SimpleNamespace(message=message, finish_reason="tool_calls" if tool_calls else "stop")],
            usage=SimpleNamespace(
                prompt_tokens=0,
                completion_tokens=0,
                total_tokens=0,
                prompt_tokens_details=SimpleNamespace(cached_tokens=0),
            ),
            model=model_id,
        )
        return completion_to_stream_chunks(completion) if stream else completion

    def _session(self) -> _Session:
        key = self.current_session_key()
        with _sessions_lock:
            session = _sessions.get(key)
            if session is None:
                session = _Session(key=key, session_id=str(uuid.uuid5(_NS, f"{key}:0")))
                _sessions[key] = session
        return session

    def _run_turn(
        self,
        binary: str,
        model: str,
        messages: list[dict[str, Any]],
        tools: Any,
        tool_choice: Any,
        timeout: float,
    ) -> tuple[str, str]:
        session = self._session()
        system_prompt = build_system_prompt(messages, tools, tool_choice)
        prompt_hash = hashlib.sha256(f"{model}\0{system_prompt}".encode()).hexdigest()
        convo = [m for m in messages if m.get("role") != "system"]

        with session.lock:
            session.last_used = time.monotonic()
            continues = (
                session.sent_len > 0
                and session.prompt_hash == prompt_hash
                and len(convo) > session.sent_len + 1
                and _fingerprint(convo[: session.sent_len]) == session.sent_fp
                and convo[session.sent_len].get("role") == "assistant"
            )
            if continues:
                turn_text = format_delta(convo[session.sent_len + 1 :])
            else:
                if session.sent_len > 0 or (session.prompt_hash and session.prompt_hash != prompt_hash):
                    _kill(session.proc)
                    session.proc = None
                    session.generation += 1
                    session.session_id = str(uuid.uuid5(_NS, f"{session.key}:{session.generation}"))
                    session.started = False
                session.prompt_hash = prompt_hash
                session.system_prompt = system_prompt
                session.model = model
                turn_text = format_transcript(convo)

            text, reasoning = self._exchange(binary, session, turn_text, timeout)
            session.sent_len = len(convo)
            session.sent_fp = _fingerprint(convo)
            session.last_used = time.monotonic()
            _ensure_reaper()
            return text, reasoning

    def _spawn(self, binary: str, session: _Session) -> None:
        work = self._base / "work"
        prompts = work / ".prompts"
        prompts.mkdir(parents=True, exist_ok=True, mode=0o700)
        prompt_path = prompts / f"{session.session_id}.txt"
        fd = os.open(prompt_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(session.system_prompt)
        argv = build_argv(
            binary,
            model=session.model,
            prompt_file=str(prompt_path),
            session_id=session.session_id,
            resume=session.started,
        )
        try:
            proc = subprocess.Popen(
                argv,
                cwd=str(work),
                env=child_env(),
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                bufsize=1,
            )
        except OSError as exc:
            prompt_path.unlink(missing_ok=True)
            raise ClaudeCodeUnavailable("binary_missing", type(exc).__name__) from None
        session.proc = proc
        session.lines = queue.Queue()
        threading.Thread(target=_pump, args=(proc, session.lines), daemon=True).start()
        self._prompt_path = prompt_path

    def _exchange(self, binary: str, session: _Session, turn_text: str, timeout: float) -> tuple[str, str]:
        self._prompt_path: Path | None = None
        if session.proc is None or session.proc.poll() is not None:
            self._spawn(binary, session)
        proc = session.proc
        lines = session.lines
        assert proc is not None and proc.stdin is not None and lines is not None
        try:
            proc.stdin.write(json.dumps({"type": "user", "message": {"role": "user", "content": turn_text}}) + "\n")
            proc.stdin.flush()
        except (BrokenPipeError, OSError):
            session.proc = None
            raise ClaudeCodeUnavailable("process_exit", "stdin closed") from None

        texts: list[str] = []
        thinking: list[str] = []
        rejected = False
        deadline = time.monotonic() + timeout
        try:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    _kill(proc)
                    session.proc = None
                    raise ClaudeCodeUnavailable("timeout")
                try:
                    line = lines.get(timeout=min(remaining, 1.0))
                except queue.Empty:
                    continue
                if line is None:
                    session.proc = None
                    session.started = True
                    raise ClaudeCodeUnavailable("process_exit", f"exit {proc.poll()}")
                try:
                    event = json.loads(line)
                except ValueError:
                    continue  # malformed line: skipped, never logged (it may hold content)
                if not isinstance(event, dict):
                    continue
                kind = event.get("type")
                if kind == "system" and event.get("subtype") == "init":
                    session.started = True
                elif kind == "assistant":
                    content = (event.get("message") or {}).get("content") or []
                    for block in content if isinstance(content, list) else []:
                        if isinstance(block, dict) and block.get("type") == "text":
                            texts.append(str(block.get("text") or ""))
                        elif isinstance(block, dict) and block.get("type") == "thinking":
                            thinking.append(str(block.get("thinking") or ""))
                elif kind == "rate_limit_event":
                    window = window_from_rate_limit(event)
                    update_status(self._base, window=window)
                    rejected = rejected or window["status"] == "rejected"
                elif kind == "result":
                    session.started = True
                    reason = classify_result(event)
                    # A "rejected" window with a successful result means overage paid the turn: keep it.
                    if rejected and reason in ("error", "auth_usage"):
                        raise ClaudeCodeUnavailable("window_rejected")
                    if reason:
                        raise ClaudeCodeUnavailable(reason)
                    text = "".join(texts) or str(event.get("result") or "")
                    return text, "".join(thinking)
        finally:
            if self._prompt_path is not None:
                self._prompt_path.unlink(missing_ok=True)
