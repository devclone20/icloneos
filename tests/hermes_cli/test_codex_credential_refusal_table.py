"""A pool credential reaches chatgpt.com only when it is positively ChatGPT's own (FX34).

The table runs every credential shape against every state config.yaml can be in, through the real
entry points: image, /usage, the /usage 401 retry, the auxiliary resolver and chat. Image and /usage
record the host that received the bearer on a recording client. The auxiliary and chat columns are
resolver-level: they report the base_url the sender is handed, or the refusal and the fix it names.
Nothing here makes a request: every client is a recorder, and a socket use fails the test.
"""

import base64
import importlib.util
import json
import os
import socket
import time
from pathlib import Path
from contextlib import suppress
from types import SimpleNamespace
from unittest.mock import MagicMock
from urllib.parse import urlparse

import httpx

from hermes_cli.auth_constants import AuthError
import pytest

GW = "https://codex-gw.example/backend-api/codex"
OTHER_GW = "https://other-gw.example/backend-api/codex"
CHATGPT = "https://chatgpt.com/backend-api/codex"
GW_HOST = "codex-gw.example"
CHATGPT_HOST = "chatgpt.com"
_REPO = Path(__file__).resolve().parents[2]
FIX_WORDS = "model.base_url"


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _jwt(**claims) -> str:
    return f'{_b64(json.dumps({"alg": "RS256"}).encode())}.{_b64(json.dumps(claims).encode())}.sig'


AUTH_CLAIM = "https://api.openai.com/auth"
JWT_CHATGPT = _jwt(iss="https://auth.openai.com", sub="u", **{AUTH_CLAIM: {"chatgpt_account_id": "acct"}})
JWT_GATEWAY = _jwt(iss="https://codex-gw.example", sub="gateway-user")
OPAQUE = "dummy-gateway-pool-key"

CREDS = {"jwt-chatgpt": JWT_CHATGPT, "jwt-gateway": JWT_GATEWAY, "opaque": OPAQUE}
CONFIGS = ("good", "empty", "missing", "unreadable", "half-written")
ENTRIES = ("image", "usage", "usage-401-retry", "aux-resolve", "chat")


def _home(monkeypatch) -> Path:
    home = Path(os.environ["HERMES_HOME"])
    home.mkdir(parents=True, exist_ok=True)
    monkeypatch.delenv("HERMES_CODEX_BASE_URL", raising=False)
    return home


def _yaml_model(**model) -> str:
    import hermes_yaml as yaml
    return yaml.safe_dump({"model": {"provider": "openai-codex", "default": "gpt-5.5", **model}})


def _set_config(home: Path, state: str) -> None:
    path = home / "config.yaml"
    if path.exists():
        path.chmod(0o600)
    if state == "good":
        path.write_text(_yaml_model(base_url=GW))
    elif state == "empty":
        path.write_text("")
    elif state == "missing":
        path.unlink(missing_ok=True)
    elif state == "unreadable":
        path.write_text(_yaml_model(base_url=GW))
        path.chmod(0o000)
    elif state == "half-written":
        path.write_text("model:\n  provider: openai-codex\n  base_url: [https://codex-gw.exam")
    else:
        raise AssertionError(state)


@pytest.fixture(autouse=True)
def _config_readable_after(monkeypatch):
    from hermes_cli import auth_codex
    monkeypatch.setattr(auth_codex, "_codex_refusals_logged", set(), raising=False)
    yield
    path = Path(os.environ["HERMES_HOME"]) / "config.yaml"
    if path.exists():
        path.chmod(0o600)


@pytest.fixture(autouse=True)
def _no_real_sockets(monkeypatch):
    def _refuse(*_a, **_k):
        pytest.fail("a test in the refusal table reached for the network")
    monkeypatch.setattr(socket.socket, "connect", _refuse)
    monkeypatch.setattr(socket, "getaddrinfo", _refuse)


def _write_pool(home: Path, key: str, *, row_base: str = CHATGPT) -> None:
    (home / "auth.json").write_text(json.dumps({
        "version": 1, "providers": {},
        "credential_pool": {"openai-codex": [{
            "id": "row", "label": "row", "auth_type": "api_key", "priority": 0,
            "source": "manual", "access_token": key, "base_url": row_base,
        }]},
    }))


def _hosts(seen) -> set:
    return {urlparse(url).hostname for url, auth in seen if auth}


# ── the entry points. Each returns ``(hosts, base_or_None, refusal_text_or_None)``. ──────────────


def _load_image_plugin():
    spec = importlib.util.spec_from_file_location(
        "codex_img_refusal_test", _REPO / "plugins/image_gen/openai-codex/__init__.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _via_image(monkeypatch, home, key):
    img = _load_image_plugin()
    seen = []

    def handler(request):
        seen.append((str(request.url), request.headers.get("authorization", "")))
        return httpx.Response(200, json={"data": [{"b64_json": "aGk="}]}, request=request)

    real_client = httpx.Client
    monkeypatch.setattr(httpx, "Client", lambda *a, **kw: real_client(
        transport=httpx.MockTransport(handler), headers=kw.get("headers"), timeout=kw.get("timeout")))
    monkeypatch.setattr(img, "save_b64_image", lambda b64, prefix="": home / "img.png")
    result = img.OpenAICodexImageGenProvider().generate("a cat")
    if result.get("success"):
        assert seen and all(auth == f"Bearer {key}" for _, auth in seen)
        return _hosts(seen), None, None
    return _hosts(seen), None, str(result.get("error"))


def _usage_client(monkeypatch, seen, *, status_first=200, on_first=None):
    from agent import account_usage
    real_client = httpx.Client
    calls = []

    def handler(request):
        seen.append((str(request.url), request.headers.get("authorization", "")))
        calls.append(1)
        if len(calls) == 1 and status_first != 200:
            if on_first:
                on_first()
            return httpx.Response(status_first, json={}, request=request)
        return httpx.Response(200, json={"rate_limit": {"primary_window": {"used_percent": 10}}}, request=request)

    monkeypatch.setattr(account_usage.httpx, "Client", lambda *a, **kw: real_client(
        transport=httpx.MockTransport(handler), timeout=kw.get("timeout")))


def _refresh_returns_the_same_row(monkeypatch):
    """The refresh POST is the only network step of a forced retry; the rest of the path stays real."""
    from agent.credential_pool import CredentialPool

    def refreshed(self, api_key_hint=None, credential_id=None):
        return self.entries()[0] if self.entries() else None

    monkeypatch.setattr(CredentialPool, "try_refresh_matching", refreshed)


def _usage_refusal():
    from agent import account_usage
    from hermes_cli.auth_constants import AuthError
    try:
        account_usage._resolve_codex_usage_credentials(None, None)
    except AuthError as exc:
        return str(exc)
    return None


def _via_usage(monkeypatch, home, key):
    from agent import account_usage
    seen = []
    _usage_client(monkeypatch, seen)
    account_usage.fetch_account_usage("openai-codex")
    return _hosts(seen), None, _usage_refusal() if not seen else None


def _via_usage_retry(monkeypatch, home, key):
    from agent import account_usage
    seen = []
    _refresh_returns_the_same_row(monkeypatch)
    _usage_client(monkeypatch, seen, status_first=401)
    account_usage.fetch_account_usage("openai-codex")
    if seen:
        assert len(seen) == 2, f"the 401 retry did not send: {seen}"
        assert all(auth == f"Bearer {key}" for _, auth in seen)
    return _hosts(seen), None, _usage_refusal() if not seen else None


def _via_aux(monkeypatch, home, key):
    from agent import auxiliary_client
    from hermes_cli.auth_constants import AuthError
    try:
        token, base = auxiliary_client._resolve_codex_credential_and_base()
    except AuthError as exc:
        assert auxiliary_client._build_codex_client("gpt-5.5") == (None, None)
        return set(), None, str(exc)
    assert token == key
    return {urlparse(base).hostname}, base, None


def _via_chat(monkeypatch, home, key):
    from hermes_cli.auth_constants import AuthError
    from hermes_cli.runtime_provider import resolve_runtime_provider
    try:
        runtime = resolve_runtime_provider(requested="openai-codex")
    except AuthError as exc:
        return set(), None, str(exc)
    assert runtime["api_key"] == key
    return {urlparse(runtime["base_url"]).hostname}, runtime["base_url"], None


VIA = {"image": _via_image, "usage": _via_usage, "usage-401-retry": _via_usage_retry,
       "aux-resolve": _via_aux, "chat": _via_chat}


def _assert_sent_to(result, host):
    hosts, _base, refusal = result
    assert refusal is None, refusal
    assert hosts == {host}


def _assert_refused(result):
    hosts, _base, refusal = result
    assert CHATGPT_HOST not in hosts
    assert hosts == set(), f"a refused credential was sent: {hosts}"
    assert refusal and FIX_WORDS in refusal, f"no refusal naming the fix: {refusal!r}"
    assert JWT_GATEWAY not in refusal and OPAQUE not in refusal


# ── the table ────────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("entry", ENTRIES)
@pytest.mark.parametrize("config", CONFIGS)
@pytest.mark.parametrize("cred", CREDS)
def test_credential_reaches_chatgpt_only_when_it_is_chatgpts_own(monkeypatch, cred, config, entry):
    home = _home(monkeypatch)
    _set_config(home, config)
    _write_pool(home, CREDS[cred])

    result = VIA[entry](monkeypatch, home, CREDS[cred])

    if config == "good" and cred != "jwt-chatgpt":
        _assert_sent_to(result, GW_HOST)
    elif cred == "jwt-chatgpt" and config != "good":
        _assert_sent_to(result, CHATGPT_HOST)
    elif cred == "jwt-chatgpt":  # R36: model.base_url alone never carries a login to a gateway; the fix is named
        _assert_refused(result)
        assert "HERMES_CODEX_BASE_URL" in result[2]
    else:
        _assert_refused(result)


@pytest.mark.parametrize("entry", ENTRIES)
@pytest.mark.parametrize("config", CONFIGS)
@pytest.mark.parametrize("cred", ["jwt-gateway", "opaque"])
def test_row_bound_to_its_gateway_needs_no_config(monkeypatch, cred, config, entry):
    """Design rule 1: the row stored its gateway, so no config state can move the key off it."""
    home = _home(monkeypatch)
    _set_config(home, config)
    _write_pool(home, CREDS[cred], row_base=GW)

    _assert_sent_to(VIA[entry](monkeypatch, home, CREDS[cred]), GW_HOST)


@pytest.mark.parametrize("config", ["empty", "missing", "unreadable"])
@pytest.mark.parametrize("cred", ["jwt-gateway", "opaque"])
def test_usage_retry_when_the_config_dies_after_the_first_try(monkeypatch, cred, config):
    """Good config on the first send, 401, config gone before the retry resolves its host. A login never sends
    under this config (the row above), so only keys are driven."""
    from agent import account_usage

    home = _home(monkeypatch)
    _set_config(home, "good")
    _write_pool(home, CREDS[cred])
    _refresh_returns_the_same_row(monkeypatch)
    seen = []
    _usage_client(monkeypatch, seen, status_first=401, on_first=lambda: _set_config(home, config))

    account_usage.fetch_account_usage("openai-codex")

    assert urlparse(seen[0][0]).hostname == GW_HOST
    # R38: the last good copy the process still holds names no gateway; the retry is refused in every state.
    assert len(seen) == 1, f"the retry sent a gateway credential: {seen}"


# ── other ways the host can be missing or wrong ──────────────────────────────────────────────


@pytest.mark.parametrize("entry", ENTRIES)
@pytest.mark.parametrize("cred", ["jwt-gateway", "opaque"])
def test_good_config_that_names_no_gateway_refuses(monkeypatch, cred, entry):
    home = _home(monkeypatch)
    (home / "config.yaml").write_text(_yaml_model())
    _write_pool(home, CREDS[cred])

    _assert_refused(VIA[entry](monkeypatch, home, CREDS[cred]))


@pytest.mark.parametrize("entry", ENTRIES)
def test_config_gateway_of_another_provider_is_not_this_keys_host(monkeypatch, entry):
    home = _home(monkeypatch)
    (home / "config.yaml").write_text(_yaml_model(provider="openrouter", base_url=GW))
    _write_pool(home, OPAQUE)

    _assert_refused(VIA[entry](monkeypatch, home, OPAQUE))


@pytest.mark.parametrize("entry", ENTRIES)
@pytest.mark.parametrize("target", [CHATGPT, "https://CHATGPT.com/backend-api/codex", "https://ab.chatgpt.com/x"])
def test_config_pointing_at_chatgpt_does_not_make_a_gateway_key_chatgpts(monkeypatch, entry, target):
    home = _home(monkeypatch)
    (home / "config.yaml").write_text(_yaml_model(base_url=target))
    _write_pool(home, OPAQUE)

    _assert_refused(VIA[entry](monkeypatch, home, OPAQUE))


@pytest.mark.parametrize("entry", ENTRIES)
@pytest.mark.parametrize("cred", CREDS)
def test_env_override_keeps_working_with_no_config(monkeypatch, cred, entry):
    home = _home(monkeypatch)
    monkeypatch.setenv("HERMES_CODEX_BASE_URL", GW)
    _write_pool(home, CREDS[cred])

    _assert_sent_to(VIA[entry](monkeypatch, home, CREDS[cred]), GW_HOST)


@pytest.mark.parametrize("entry", ENTRIES)
def test_env_override_at_chatgpt_refuses_a_gateway_key(monkeypatch, entry):
    home = _home(monkeypatch)
    monkeypatch.setenv("HERMES_CODEX_BASE_URL", CHATGPT)
    _write_pool(home, OPAQUE)

    _assert_refused(VIA[entry](monkeypatch, home, OPAQUE))


# ── what counts as ChatGPT's own ─────────────────────────────────────────────────────────────


@pytest.mark.parametrize("token, own", [
    (JWT_CHATGPT, True),
    (_jwt(iss="https://auth.openai.com"), True),
    (_jwt(iss="https://auth0.openai.com/"), True),
    (_jwt(**{AUTH_CLAIM: {"chatgpt_account_id": "a"}}), True),
    (JWT_GATEWAY, False),
    (_jwt(sub="u", exp=9999999999), False),
    (_jwt(iss="https://codex-gw.example", **{AUTH_CLAIM: {"chatgpt_account_id": "a"}}), False),
    (_jwt(iss="https://auth.openai.com.evil.example"), False),
    (_jwt(iss="https://notopenai.com"), False),
    (_jwt(iss=7, **{AUTH_CLAIM: {"chatgpt_account_id": "a"}}), False),
    (_jwt(**{AUTH_CLAIM: {}}), False),
    (_jwt(**{AUTH_CLAIM: "chatgpt"}), False),
    (OPAQUE, False),
    ("a.b.c", False),
    ("", False),
    (None, False),
], ids=["real", "issuer-only", "old-issuer", "claim-only", "gateway-issuer", "no-claims", "claim-under-gateway-issuer",
        "lookalike-issuer", "suffix-issuer", "junk-issuer", "empty-claim", "non-dict-claim", "opaque", "dots", "empty",
        "none"])
def test_chatgpt_own_token_rule(token, own):
    from hermes_cli.auth_codex import _codex_token_is_chatgpt_own
    assert _codex_token_is_chatgpt_own(token) is own


# ── binding at add and refresh ───────────────────────────────────────────────────────────────


def _pool_row(home: Path) -> dict:
    return json.loads((home / "auth.json").read_text())["credential_pool"]["openai-codex"][0]


def _add(home: Path, key: str) -> None:
    from agent.credential_pool import AUTH_TYPE_API_KEY, SOURCE_MANUAL, PooledCredential, load_pool
    (home / "auth.json").write_text(json.dumps({"version": 1, "providers": {}}))
    load_pool("openai-codex").add_entry(PooledCredential(
        provider="openai-codex", id="new", label="new", auth_type=AUTH_TYPE_API_KEY, priority=0,
        source=SOURCE_MANUAL, access_token=key, base_url=CHATGPT))


def test_add_leaves_chatgpts_own_token_on_chatgpt(monkeypatch):
    """It must go direct once the gateway is removed from config, not stay on a gateway forever."""
    home = _home(monkeypatch)
    _set_config(home, "good")

    _add(home, JWT_CHATGPT)
    assert _pool_row(home)["base_url"] == CHATGPT

    _set_config(home, "empty")
    _assert_sent_to(_via_chat(monkeypatch, home, JWT_CHATGPT), CHATGPT_HOST)


@pytest.mark.parametrize("config", ["empty", "missing", "unreadable", "half-written"])
def test_add_gains_nothing_from_a_config_it_cannot_read(monkeypatch, config):
    home = _home(monkeypatch)
    _set_config(home, config)

    _add(home, OPAQUE)

    assert _pool_row(home)["base_url"] == CHATGPT


def test_add_keeps_a_row_that_already_names_its_gateway(monkeypatch):
    from agent.credential_pool import AUTH_TYPE_API_KEY, SOURCE_MANUAL, PooledCredential, load_pool
    home = _home(monkeypatch)
    _set_config(home, "good")
    (home / "auth.json").write_text(json.dumps({"version": 1, "providers": {}}))

    load_pool("openai-codex").add_entry(PooledCredential(
        provider="openai-codex", id="new", label="new", auth_type=AUTH_TYPE_API_KEY, priority=0,
        source=SOURCE_MANUAL, access_token=OPAQUE, base_url=OTHER_GW))

    assert _pool_row(home)["base_url"] == OTHER_GW


def test_existing_rows_are_not_rewritten_by_loading_them(monkeypatch):
    from agent.credential_pool import load_pool
    home = _home(monkeypatch)
    _set_config(home, "good")
    _write_pool(home, OPAQUE)

    load_pool("openai-codex").select()

    assert _pool_row(home)["base_url"] == CHATGPT


# ── the other senders ────────────────────────────────────────────────────────────────────────


def _fake_agent(base_url=GW):
    agent = MagicMock()
    agent.provider, agent.base_url, agent.model, agent.api_mode = "openai-codex", base_url, "gpt-5.5", "codex_responses"
    agent._client_kwargs = {}
    return agent


@pytest.mark.parametrize("cred", ["jwt-gateway", "opaque"])
def test_rotation_onto_a_gateway_key_goes_to_its_route(monkeypatch, cred):
    """The row holds the canonical URL; rotating onto it with a good config stays on the gateway."""
    from agent.client_lifecycle import ClientLifecycleMixin
    home = _home(monkeypatch)
    _set_config(home, "good")
    agent = _fake_agent()
    entry = SimpleNamespace(id="b", runtime_api_key=CREDS[cred], runtime_base_url=CHATGPT, base_url=CHATGPT)

    assert ClientLifecycleMixin._swap_credential(agent, entry) is True

    assert (agent.api_key, agent.base_url) == (CREDS[cred], GW)


@pytest.mark.parametrize("config", ["empty", "missing", "unreadable", "half-written"])
@pytest.mark.parametrize("cred", ["jwt-gateway", "opaque"])
def test_rotation_refuses_a_key_with_no_known_host(monkeypatch, cred, config):
    from agent.client_lifecycle import ClientLifecycleMixin
    home = _home(monkeypatch)
    _set_config(home, config)
    agent = _fake_agent(CHATGPT)
    agent.api_key = "the-live-key"
    entry = SimpleNamespace(id="b", runtime_api_key=CREDS[cred], runtime_base_url=CHATGPT, base_url=CHATGPT)

    assert ClientLifecycleMixin._swap_credential(agent, entry) is False

    assert (agent.api_key, agent.base_url) == ("the-live-key", CHATGPT)


@pytest.mark.parametrize("token, base, allowed", [
    (JWT_CHATGPT, CHATGPT, True), (JWT_GATEWAY, CHATGPT, False), (OPAQUE, CHATGPT, False),
    (JWT_CHATGPT, "", True), (JWT_GATEWAY, "", False), (OPAQUE, "", False),
    (JWT_GATEWAY, GW, True), (OPAQUE, GW, True),
])
def test_catalog_probe_applies_the_same_rule(token, base, allowed):
    from agent.model_metadata import _codex_catalog_probe_allowed
    assert _codex_catalog_probe_allowed(token, base) is allowed


def test_quota_probe_never_takes_a_gateway_jwt_to_chatgpt(monkeypatch):
    from hermes_cli import auth_codex
    monkeypatch.setattr(auth_codex, "_codex_http_client", lambda **kw: pytest.fail("a request was made"))

    assert auth_codex._probe_codex_quota_restored(JWT_GATEWAY, base_url=CHATGPT) is None


def test_usage_explicit_key_with_no_base_is_refused(monkeypatch):
    """A caller holding a key and no URL: the sender would fall back to chatgpt.com."""
    from agent import account_usage
    from hermes_cli.auth_constants import AuthError
    _home(monkeypatch)
    with pytest.raises(AuthError, match=FIX_WORDS):
        account_usage._resolve_codex_usage_credentials(None, OPAQUE)


# ── credentials that are not in the pool ─────────────────────────────────────────────────────


def _write_singleton(home: Path, token: str) -> None:
    (home / "auth.json").write_text(json.dumps({
        "version": 1, "active_provider": "openai-codex",
        "providers": {"openai-codex": {
            "tokens": {"access_token": token, "refresh_token": "rt"},
            "last_refresh": "2026-09-24T00:00:00Z", "auth_mode": "chatgpt"}},
    }))


@pytest.mark.parametrize("entry", ["image", "usage", "aux-resolve", "chat"])
@pytest.mark.parametrize("config", ["empty", "missing"])
def test_store_login_without_a_config_still_works(monkeypatch, config, entry):
    home = _home(monkeypatch)
    _set_config(home, config)
    _write_singleton(home, JWT_CHATGPT)

    _assert_sent_to(VIA[entry](monkeypatch, home, JWT_CHATGPT), CHATGPT_HOST)


@pytest.mark.parametrize("entry", ["image", "usage", "aux-resolve", "chat"])
@pytest.mark.parametrize("cred", ["jwt-gateway", "opaque"])
def test_hand_edited_store_token_is_refused(monkeypatch, cred, entry):
    home = _home(monkeypatch)
    _write_singleton(home, CREDS[cred])

    _assert_refused(VIA[entry](monkeypatch, home, CREDS[cred]))


@pytest.mark.parametrize("key, base, refused", [
    (OPAQUE, None, True), (JWT_GATEWAY, None, True), (JWT_CHATGPT, None, False), (OPAQUE, GW, False)])
def test_explicit_api_key_follows_the_same_rule(monkeypatch, key, base, refused):
    from hermes_cli.auth_constants import AuthError
    from hermes_cli.runtime_provider import resolve_runtime_provider
    _home(monkeypatch)
    if refused:
        with pytest.raises(AuthError, match=FIX_WORDS):
            resolve_runtime_provider(requested="openai-codex", explicit_api_key=key, explicit_base_url=base)
    else:
        runtime = resolve_runtime_provider(requested="openai-codex", explicit_api_key=key, explicit_base_url=base)
        assert (runtime["api_key"], runtime["base_url"]) == (key, base or CHATGPT)


@pytest.mark.parametrize("cred", ["jwt-gateway", "opaque"])
def test_store_token_is_checked_by_the_runtime_resolver_itself(monkeypatch, cred):
    """The picker, status and login flows read this resolver directly, with no pool row in between."""
    from hermes_cli.auth_codex import resolve_codex_runtime_credentials
    from hermes_cli.auth_constants import AuthError
    home = _home(monkeypatch)
    _write_singleton(home, CREDS[cred])

    with pytest.raises(AuthError, match=FIX_WORDS):
        resolve_codex_runtime_credentials(read_only=True)


@pytest.mark.parametrize("cred", ["jwt-gateway", "opaque"])
def test_aux_store_branch_is_checked_when_the_pool_selects_nothing(monkeypatch, cred):
    from agent import auxiliary_client
    from hermes_cli.auth_constants import AuthError
    home = _home(monkeypatch)
    _write_singleton(home, CREDS[cred])
    monkeypatch.setattr(auxiliary_client, "_select_pool_entry", lambda provider: (False, None))

    with pytest.raises(AuthError, match=FIX_WORDS):
        auxiliary_client._resolve_codex_credential_and_base()


def test_add_with_an_env_gateway_keeps_a_row_that_names_its_own(monkeypatch):
    """The env wins at send time while it is set; it must not overwrite the row for good."""
    from agent.credential_pool import AUTH_TYPE_API_KEY, SOURCE_MANUAL, PooledCredential, load_pool
    home = _home(monkeypatch)
    monkeypatch.setenv("HERMES_CODEX_BASE_URL", OTHER_GW)
    (home / "auth.json").write_text(json.dumps({"version": 1, "providers": {}}))

    load_pool("openai-codex").add_entry(PooledCredential(
        provider="openai-codex", id="new", label="new", auth_type=AUTH_TYPE_API_KEY, priority=0,
        source=SOURCE_MANUAL, access_token=OPAQUE, base_url=GW))

    assert _pool_row(home)["base_url"] == GW


# ── FX34b: choosing skips refused rows, a final pair is judged once. ───────────


def _write_rows(home: Path, *rows, store=None) -> None:
    pool = [{"id": rid, "label": rid, "auth_type": "api_key", "priority": i, "source": "manual",
             "access_token": token, "base_url": CHATGPT, **extra} for i, (rid, token, extra) in enumerate(rows)]
    (home / "auth.json").write_text(json.dumps({
        "version": 1, "providers": store or {}, "credential_pool": {"openai-codex": pool}}))


def _rows(home: Path) -> dict:
    return {r["id"]: r for r in json.loads((home / "auth.json").read_text())["credential_pool"]["openai-codex"]}


def _resolve(**kwargs) -> dict:
    from hermes_cli.runtime_provider import resolve_runtime_provider
    return resolve_runtime_provider(requested="openai-codex", **kwargs)


def _rotate(monkeypatch, pool, agent_key, agent_id, base_url):
    """One real 429 recovery: real pool, real ``recover_with_credential_pool``, real ``_swap_credential``."""
    from agent.agent_runtime_helpers import recover_with_credential_pool
    from agent.client_lifecycle import ClientLifecycleMixin
    from hermes_cli import auth as auth_mod
    monkeypatch.setattr(auth_mod, "_probe_codex_quota_restored", lambda *_a, **_k: False)  # the bench stands
    agent = _fake_agent(base_url)
    agent.api_key, agent._credential_pool, agent._credential_pool_entry_id = agent_key, pool, agent_id
    agent._credential_pool_revert_id = None
    agent._swap_credential = lambda entry: ClientLifecycleMixin._swap_credential(agent, entry)
    recovered, _ = recover_with_credential_pool(agent, status_code=429, has_retried_429=True)
    return recovered, agent


JWT_C = _jwt(iss="https://auth.openai.com", sub="c", **{AUTH_CLAIM: {"chatgpt_account_id": "c"}})


@pytest.mark.parametrize("config", ["empty", "missing"])
def test_refused_row_above_a_good_row_chat_takes_the_good_row(monkeypatch, caplog, config):
    home = _home(monkeypatch)
    _set_config(home, config)
    _write_rows(home, ("gw", OPAQUE, {}), ("real", JWT_CHATGPT, {}))

    with caplog.at_level("WARNING"):
        first, second = _resolve(), _resolve()

    assert (first["api_key"], first["base_url"]) == (JWT_CHATGPT, CHATGPT)
    assert second["api_key"] == JWT_CHATGPT
    warned = [r.getMessage() for r in caplog.records if "pool row gw" in r.getMessage()]
    assert len(warned) == 1 and "hermes auth remove" in warned[0] and OPAQUE not in warned[0]
    assert _rows(home)["gw"].get("last_status") is None


def test_real_login_after_a_leftover_gateway_row_reaches_chatgpt(monkeypatch):
    from hermes_cli.auth import _save_codex_tokens
    home = _home(monkeypatch)
    _set_config(home, "empty")
    _write_rows(home, ("gw", OPAQUE, {}))
    with pytest.raises(AuthError):
        _resolve()

    _save_codex_tokens({"access_token": JWT_CHATGPT, "refresh_token": "r"})

    assert (lambda r: (r["api_key"], r["base_url"]))(_resolve()) == (JWT_CHATGPT, CHATGPT)


def test_real_rotation_with_no_gateway_skips_the_refused_row(monkeypatch):
    """A real ChatGPT row, a leftover gateway key, a real ChatGPT row: a 429 moves to the third."""
    from agent.credential_pool import load_pool
    home = _home(monkeypatch)
    _set_config(home, "empty")
    _write_rows(home, ("a", JWT_CHATGPT, {}), ("b", OPAQUE, {}), ("c", JWT_C, {}))

    recovered, agent = _rotate(monkeypatch, load_pool("openai-codex"), JWT_CHATGPT, "a", CHATGPT)

    assert recovered is True
    assert agent.api_key == JWT_C and agent.api_key != OPAQUE
    assert _rows(home)["b"].get("last_status") is None
    assert _resolve()["api_key"] == JWT_C  # a new session after the rotation takes the same row


def test_real_rotation_with_only_a_refused_row_left_stops_and_leaves_it_unmarked(monkeypatch):
    from agent.credential_pool import load_pool
    home = _home(monkeypatch)
    _set_config(home, "empty")
    _write_rows(home, ("a", JWT_CHATGPT, {}), ("b", OPAQUE, {}))

    recovered, agent = _rotate(monkeypatch, load_pool("openai-codex"), JWT_CHATGPT, "a", CHATGPT)

    assert recovered is False and agent.api_key == JWT_CHATGPT
    assert _rows(home)["b"].get("last_status") is None


def test_real_rotation_with_a_good_config_keeps_the_session_on_its_gateway(monkeypatch):
    """Both rows follow the config. The session stays on the gateway at this version and at v0.0.5."""
    from agent.credential_pool import load_pool
    home = _home(monkeypatch)
    _set_config(home, "good")
    _write_rows(home, ("a", OPAQUE, {}), ("b", "dummy-second-gateway-key", {}))

    _recovered, agent = _rotate(monkeypatch, load_pool("openai-codex"), OPAQUE, "a", GW)

    assert agent.base_url == GW


def test_the_refusal_names_the_row_and_the_action_that_clears_it(monkeypatch):
    from agent.credential_pool import load_pool
    home = _home(monkeypatch)
    _set_config(home, "empty")
    _write_rows(home, ("gw", OPAQUE, {}))

    with pytest.raises(AuthError) as refused:
        _resolve()
    assert "pool row gw" in str(refused.value) and "hermes auth remove openai-codex" in str(refused.value)

    load_pool("openai-codex").remove_index(1)
    _write_singleton(home, JWT_CHATGPT)
    assert _resolve()["api_key"] == JWT_CHATGPT


@pytest.mark.parametrize("stored", ["pool", "store"])
def test_explicit_base_url_at_a_gateway_sends_the_stored_key(monkeypatch, stored):
    home = _home(monkeypatch)
    _set_config(home, "empty")
    _write_rows(home, ("gw", OPAQUE, {})) if stored == "pool" else _write_singleton(home, OPAQUE)

    runtime = _resolve(explicit_base_url=GW)

    assert (runtime["api_key"], runtime["base_url"]) == (OPAQUE, GW)


@pytest.mark.parametrize("stored", ["pool", "store"])
def test_explicit_base_url_at_chatgpt_refuses_a_stored_gateway_key(monkeypatch, stored):
    home = _home(monkeypatch)
    _set_config(home, "good")
    _write_rows(home, ("gw", OPAQUE, {})) if stored == "pool" else _write_singleton(home, OPAQUE)

    with pytest.raises(AuthError) as refused:
        _resolve(explicit_base_url=CHATGPT)
    assert refused.value.code == "codex_credential_host_unknown"


@pytest.mark.parametrize(("url", "key"), [(GW, OPAQUE), (CHATGPT, JWT_CHATGPT)])
def test_explicit_base_url_judges_the_rows_on_the_final_url(monkeypatch, url, key):
    home = _home(monkeypatch)
    _set_config(home, "empty")
    _write_rows(home, ("gw", OPAQUE, {}), ("real", JWT_CHATGPT, {}))

    assert (lambda r: (r["api_key"], r["base_url"]))(_resolve(explicit_base_url=url)) == (key, url)


def test_gateway_change_after_add_follows_the_config(monkeypatch):
    home = _home(monkeypatch)
    _set_config(home, "good")
    _add(home, OPAQUE)
    assert _pool_row(home)["base_url"] == CHATGPT

    (home / "config.yaml").write_text(_yaml_model(base_url=OTHER_GW))
    assert _resolve()["base_url"] == OTHER_GW

    _set_config(home, "empty")  # config gives none: nothing is remembered, the key is refused
    with pytest.raises(AuthError):
        _resolve()


def test_a_hand_set_row_url_beats_config(monkeypatch):
    home = _home(monkeypatch)
    _set_config(home, "good")
    _write_rows(home, ("hand", OPAQUE, {"base_url": OTHER_GW}))

    assert _resolve()["base_url"] == OTHER_GW


EXPIRED_GATEWAY = _jwt(iss="https://codex-gw.example", exp=1)


@pytest.fixture
def _posts(monkeypatch):
    seen = []

    def _send(self, request, **_kwargs):
        seen.append(str(request.url))
        return httpx.Response(400, json={"error": "invalid_grant"}, request=request)
    monkeypatch.setattr(httpx.Client, "send", _send)
    return seen


def _oauth_row(token, **extra):
    return ("row", token, {"auth_type": "oauth", "refresh_token": "dummy-gateway-refresh", "source": "manual", **extra})


@pytest.mark.parametrize("token", [OPAQUE, EXPIRED_GATEWAY], ids=["opaque", "expired-jwt"])
@pytest.mark.parametrize("config", ["good", "empty"])
@pytest.mark.parametrize("path", ["select", "try_refresh_current", "chat", "usage-forced", "resolver-forced"])
def test_oauth_gateway_row_makes_zero_posts_and_stays_unmarked(monkeypatch, _posts, token, config, path):
    from agent.account_usage import _resolve_codex_usage_credentials
    from agent.credential_pool import load_pool
    from hermes_cli.auth_codex import resolve_codex_runtime_credentials
    home = _home(monkeypatch)
    _set_config(home, config)
    _write_rows(home, _oauth_row(token))

    pool = load_pool("openai-codex")
    with suppress(AuthError):
        if path == "select":
            pool.select()
        elif path == "try_refresh_current":
            pool.select()
            assert pool.try_refresh_current() is None
        elif path == "chat":
            _resolve()
        elif path == "usage-forced":
            _resolve_codex_usage_credentials(None, None, force_refresh=True)
        else:
            resolve_codex_runtime_credentials(force_refresh=True)

    assert _posts == []
    row = _rows(home)["row"]
    assert row.get("last_status") is None and row["access_token"] == token


def test_oauth_gateway_token_in_the_store_makes_zero_posts(monkeypatch, _posts):
    from hermes_cli.auth_codex import resolve_codex_runtime_credentials
    home = _home(monkeypatch)
    _set_config(home, "empty")
    (home / "auth.json").write_text(json.dumps({"version": 1, "providers": {"openai-codex": {
        "tokens": {"access_token": EXPIRED_GATEWAY, "refresh_token": "dummy-gateway-refresh"}}}}))

    with pytest.raises(AuthError) as refused:
        resolve_codex_runtime_credentials(force_refresh=True)

    assert _posts == [] and refused.value.code == "codex_credential_host_unknown"


def test_an_empty_access_token_stays_refreshable(monkeypatch, _posts):
    from agent.credential_pool import load_pool
    home = _home(monkeypatch)
    _set_config(home, "empty")
    _write_rows(home, _oauth_row(""))

    pool = load_pool("openai-codex")
    pool._refresh_entry(pool.entries()[0], force=True)

    assert _posts and urlparse(_posts[0]).hostname == "auth.openai.com"


def test_forced_refresh_of_a_refused_api_key_row_refuses_and_leaves_it_unmarked(monkeypatch, _posts):
    from hermes_cli.auth_codex import resolve_codex_runtime_credentials
    home = _home(monkeypatch)
    _set_config(home, "empty")
    _write_rows(home, ("gw", OPAQUE, {}))

    with pytest.raises(AuthError) as refused:
        resolve_codex_runtime_credentials(force_refresh=True)

    assert refused.value.code == "codex_credential_host_unknown"
    assert _rows(home)["gw"].get("last_status") is None


def _child(parent_key, parent_url, **overrides):
    from tools.delegate_tool_config import _resolve_child_runtime
    parent = MagicMock()
    parent.provider, parent.base_url, parent.api_key, parent.model = "openai-codex", parent_url, parent_key, "gpt-5.5"
    parent._client_kwargs, parent.client, parent.max_tokens = overrides.pop("live", None), None, None
    kwargs = {"model": None, "override_provider": None, "override_base_url": None, "override_api_key": None,
              "override_api_mode": None, "override_acp_command": None, "override_acp_args": None, **overrides}
    return _resolve_child_runtime(parent, {}, parent_key, **kwargs)


@pytest.mark.parametrize("override", [CHATGPT, OTHER_GW])
def test_delegation_never_carries_the_parents_key_off_its_route(override):
    with pytest.raises(ValueError, match="delegation.api_key") as refused:
        _child(OPAQUE, GW, override_base_url=override)
    assert OPAQUE not in str(refused.value)


def test_delegation_inherits_on_the_parents_own_route():
    runtime = _child(OPAQUE, GW, override_base_url=GW + "/")
    assert (runtime["api_key"], runtime["base_url"]) == (OPAQUE, GW + "/")


def test_delegation_final_pair_passes_the_host_rule():
    with pytest.raises(AuthError):
        _child(OPAQUE, GW, override_base_url=CHATGPT, override_api_key="dummy-child-key")
    with pytest.raises(AuthError):
        _child(OPAQUE, CHATGPT)
    assert _child(OPAQUE, GW, override_base_url=CHATGPT, override_api_key=JWT_CHATGPT)["api_key"] == JWT_CHATGPT
    assert _child(JWT_CHATGPT, CHATGPT)["api_key"] == JWT_CHATGPT


IDNA_SPELLINGS = ["https://chatgpt。com/backend-api/codex", "https://chatgpt．com/backend-api/codex",
                  "https://chatgpt｡com/backend-api/codex", "https://ｃhatgpt.com/backend-api/codex",
                  "https://CHATGPT.COM/backend-api/codex", "https://chatgpt.com./backend-api/codex"]


@pytest.mark.parametrize("url", IDNA_SPELLINGS)
def test_idna_spellings_of_chatgpt_are_refused(monkeypatch, url):
    home = _home(monkeypatch)
    (home / "config.yaml").write_text(_yaml_model(base_url=url))
    _write_pool(home, OPAQUE)

    with pytest.raises(AuthError):
        _resolve()


@pytest.mark.parametrize("url", IDNA_SPELLINGS[:3])
def test_the_http_client_dials_chatgpt_for_those_dots(url):
    assert httpx.URL(url).host == "chatgpt.com"


def test_malformed_url_fails_closed_with_the_named_fix(monkeypatch):
    from agent.client_lifecycle import ClientLifecycleMixin
    home = _home(monkeypatch)
    (home / "config.yaml").write_text(_yaml_model(base_url="https://[oops"))
    _write_pool(home, OPAQUE)

    with pytest.raises(AuthError) as refused:
        _resolve()
    assert refused.value.code == "codex_credential_host_unknown"
    entry = SimpleNamespace(id="b", runtime_api_key=OPAQUE, runtime_base_url=CHATGPT, base_url=CHATGPT)
    assert ClientLifecycleMixin._swap_credential(_fake_agent(), entry) is False


def test_malformed_issuer_is_not_chatgpts_and_does_not_raise(monkeypatch):
    from agent.credential_pool import AUTH_TYPE_API_KEY, SOURCE_MANUAL, PooledCredential, load_pool
    from hermes_cli.auth_codex import _codex_token_is_chatgpt_own
    home = _home(monkeypatch)
    _set_config(home, "empty")
    bad = _jwt(iss="https://[x")
    assert _codex_token_is_chatgpt_own(bad) is False

    (home / "auth.json").write_text(json.dumps({"version": 1, "providers": {}}))
    load_pool("openai-codex").add_entry(PooledCredential(
        provider="openai-codex", id="n", label="n", auth_type=AUTH_TYPE_API_KEY, priority=0,
        source=SOURCE_MANUAL, access_token=bad, base_url=CHATGPT))
    with pytest.raises(AuthError):
        _resolve()


@pytest.mark.parametrize(("issuer", "own"), [
    ("https://auth.openai.com", True), ("https://auth.openai.com/", True), ("https://auth0.openai.com/", True),
    ("https://AUTH.openai.com", True), ("auth.openai.com", True),
    ("https://evil.test\\@auth.openai.com", False), ("https://evil.test\\.openai.com", False), ("openai.com", False),
    ("http://auth.openai.com", False), ("https://auth.openai.com:8443", False), ("https://x.openai.com", False),
    ("https://user@auth.openai.com", False), ("https://auth.openai.com.evil", False), (None, False), (0, False),
])
def test_issuer_is_compared_by_exact_host(issuer, own):
    from hermes_cli.auth_codex import _codex_token_is_chatgpt_own
    assert _codex_token_is_chatgpt_own(_jwt(iss=issuer)) is own


def test_provider_custom_aimed_at_chatgpt_passes_the_rule(monkeypatch):
    from agent.auxiliary_client import resolve_provider_client
    from hermes_cli.runtime_provider import resolve_runtime_provider
    home = _home(monkeypatch)
    _set_config(home, "empty")

    with pytest.raises(AuthError):
        resolve_runtime_provider(requested="custom", explicit_base_url=CHATGPT, explicit_api_key=OPAQUE)
    assert resolve_provider_client("custom", explicit_base_url=CHATGPT, explicit_api_key=OPAQUE) == (None, None)
    runtime = resolve_runtime_provider(requested="custom", explicit_base_url=GW, explicit_api_key=OPAQUE)
    assert runtime["base_url"] == GW


def test_status_reports_the_refusal_chat_would_give(monkeypatch):
    from hermes_cli.auth import get_codex_auth_status
    home = _home(monkeypatch)
    _set_config(home, "empty")
    _write_rows(home, ("gw", OPAQUE, {}))

    status = get_codex_auth_status()

    assert status["logged_in"] is False and "hermes auth remove" in status["error"]
    assert OPAQUE not in json.dumps(status)

    _write_rows(home, ("gw", OPAQUE, {}), ("real", JWT_CHATGPT, {}))
    assert get_codex_auth_status()["logged_in"] is True


def test_child_lease_is_released_when_its_swap_is_refused(monkeypatch):
    from agent.credential_pool import load_pool
    from tools import delegate_tool_child_run as run
    home = _home(monkeypatch)
    _set_config(home, "empty")
    _write_rows(home, ("gw", OPAQUE, {}))
    pool = load_pool("openai-codex")
    child = MagicMock()
    child._credential_pool, child.base_url = pool, CHATGPT
    child._swap_credential = MagicMock(return_value=False)

    _pool, leased = run._lease_child_credential(child)

    child._swap_credential.assert_called_once()
    assert leased is None and not pool._active_leases


# ── round 2: the binding is gone, one rule for the final URL (R23 to R29). ───────────────────────

LOST_CONFIGS = ["empty", "missing", "unreadable", "half-written"]


def _cooldown(reset_in: float = 3000.0) -> dict:
    return {"last_status": "exhausted", "last_error_code": 429, "last_error_reason": "usage_limit",
            "last_error_message": "Codex quota reached", "last_status_at": time.time(),
            "last_error_reset_at": time.time() + reset_in}


def _stand_the_bench(monkeypatch) -> None:
    from hermes_cli import auth as auth_mod, auth_codex
    monkeypatch.setattr(auth_mod, "_probe_codex_quota_restored", lambda *_a, **_k: False)
    monkeypatch.setattr(auth_codex, "_probe_codex_quota_restored", lambda *_a, **_k: False)


def _code(raises) -> str:
    return getattr(raises.value, "code", "")


@pytest.mark.parametrize("config", LOST_CONFIGS)
@pytest.mark.parametrize("cred", ["jwt-gateway", "opaque"])
def test_gateway_key_with_a_lost_config_is_refused_with_the_named_fix_and_sends_nothing(monkeypatch, _posts, cred, config):
    from hermes_cli.auth import get_codex_auth_status
    from hermes_cli.auth_codex import CODEX_HOST_UNKNOWN_CODE
    home = _home(monkeypatch)
    if config in ("empty", "missing"):
        _set_config(home, "good")
        _add(home, CREDS[cred])
    else:  # no good parse behind it; with one the last good copy serves, see the next test
        _write_rows(home, ("new", CREDS[cred], {}))
    _set_config(home, config)

    with pytest.raises(AuthError) as refused:
        _resolve()

    text = str(refused.value)
    assert _code(refused) == CODEX_HOST_UNKNOWN_CODE and not refused.value.relogin_required
    assert FIX_WORDS in text and "HERMES_CODEX_BASE_URL" in text and "hermes auth remove" in text
    assert CREDS[cred] not in text
    assert _posts == []
    status = get_codex_auth_status()
    assert status["logged_in"] is False and FIX_WORDS in status["error"]


@pytest.mark.parametrize("config", ["unreadable", "half-written"])
def test_a_config_broken_after_a_good_parse_refuses_the_key_and_sends_nothing(monkeypatch, config):
    """hermes_cli/config.py keeps the last good copy when a parse fails; that copy routes no credential (R38):
    the key is refused with the fix that names the file, and chatgpt.com is never the fallback."""
    home = _home(monkeypatch)
    _set_config(home, "good")
    _add(home, OPAQUE)
    assert _resolve()["base_url"] == GW

    _set_config(home, config)

    with pytest.raises(AuthError) as refused:
        _resolve()
    assert refused.value.code == "codex_credential_host_unknown" and "readable and complete" in str(refused.value)


@pytest.mark.parametrize("cred", ["jwt-gateway", "opaque"])
def test_gateway_key_is_served_while_the_config_names_the_gateway(monkeypatch, cred):
    home = _home(monkeypatch)
    _set_config(home, "good")
    _add(home, CREDS[cred])

    _assert_sent_to(_via_chat(monkeypatch, home, CREDS[cred]), GW_HOST)


@pytest.mark.parametrize("config", ["empty", "missing"])
def test_nothing_is_stored_at_add_or_refresh_beyond_the_row(monkeypatch, config):
    from agent.credential_pool import load_pool
    home = _home(monkeypatch)
    _set_config(home, "good")
    _add(home, OPAQUE)
    pool = load_pool("openai-codex")
    pool._adopt(pool.entries()[0], access_token="dummy-refreshed-gateway-key")

    row = _pool_row(home)
    assert row["access_token"] == "dummy-refreshed-gateway-key" and row["base_url"] == CHATGPT
    assert not [k for k in row if "bound" in k]
    _set_config(home, config)
    with pytest.raises(AuthError):
        _resolve()


def test_a_binding_in_a_file_routes_nothing(monkeypatch):
    home = _home(monkeypatch)
    _set_config(home, "empty")
    _write_rows(home, ("gw", OPAQUE, {"bound_base_url": GW}))

    with pytest.raises(AuthError):
        _resolve()


def test_real_login_after_a_key_added_under_a_gateway_reaches_chatgpt(monkeypatch):
    from hermes_cli.auth import _save_codex_tokens, get_codex_auth_status
    home = _home(monkeypatch)
    _set_config(home, "good")
    _add(home, OPAQUE)
    _set_config(home, "empty")

    _save_codex_tokens({"access_token": JWT_CHATGPT, "refresh_token": "dummy-login-refresh"})

    runtime = _resolve()
    assert (runtime["api_key"], runtime["base_url"]) == (JWT_CHATGPT, CHATGPT)
    assert get_codex_auth_status()["logged_in"] is True


def test_a_session_on_the_configured_gateway_rotates_between_its_rows(monkeypatch):
    from agent.credential_pool import load_pool
    home = _home(monkeypatch)
    _set_config(home, "good")
    _write_rows(home, ("a", OPAQUE, {}), ("b", "dummy-second-key", {}))

    recovered, agent = _rotate(monkeypatch, load_pool("openai-codex"), OPAQUE, "a", GW)

    assert recovered is True and (agent.api_key, agent.base_url) == ("dummy-second-key", GW)


def test_a_config_read_that_raises_gives_the_rows_own_url(monkeypatch):
    from hermes_cli import config as config_mod
    from hermes_cli.auth_codex import _codex_pool_route_unchecked
    _home(monkeypatch)
    monkeypatch.setattr(config_mod, "load_config_readonly", lambda: (_ for _ in ()).throw(OSError("unreadable")))

    assert _codex_pool_route_unchecked(CHATGPT) == CHATGPT
    assert _codex_pool_route_unchecked(OTHER_GW) == OTHER_GW


@pytest.mark.parametrize("config", ["good", "empty", "missing"])
def test_mixed_pool_moves_to_the_next_row_it_may_send(monkeypatch, config):
    from agent.credential_pool import load_pool
    home = _home(monkeypatch)
    _set_config(home, config)
    _write_rows(home, ("gw", OPAQUE, {"base_url": OTHER_GW}), ("real", JWT_CHATGPT, {}))
    assert load_pool("openai-codex").select().id == "gw"  # a row it may send stays first

    _set_config(home, "empty")
    _write_rows(home, ("left", "dummy-left-key", {}), ("hand", OPAQUE, {"base_url": OTHER_GW}), ("real", JWT_CHATGPT, {}))
    pool = load_pool("openai-codex")
    picked = pool.select()
    assert picked.id == "hand" and _resolve()["base_url"] == OTHER_GW


# R24
def test_real_login_at_its_quota_stays_logged_in_and_setup_is_not_taken(monkeypatch):
    from hermes_cli.auth import get_codex_auth_status
    from hermes_cli.main import _has_any_provider_configured
    home = _home(monkeypatch)
    _set_config(home, "empty")
    _write_rows(home, ("real", JWT_CHATGPT, {"auth_type": "oauth", "refresh_token": "dummy-r", **_cooldown()}))
    store = json.loads((home / "auth.json").read_text())
    store["active_provider"] = "openai-codex"
    (home / "auth.json").write_text(json.dumps(store))

    status = get_codex_auth_status()

    assert status["logged_in"] is True and status["rate_limited"] is True
    assert status["error"] == "Codex quota reached"
    assert _has_any_provider_configured() is True


# R25
@pytest.mark.parametrize("config", ["good", "empty", "missing"])
@pytest.mark.parametrize("token", [OPAQUE, EXPIRED_GATEWAY], ids=["opaque", "expired-jwt"])
@pytest.mark.parametrize("path", ["store-resolver", "runtime", "pool-probe"])
def test_cooldown_probe_of_a_gateway_row_makes_zero_refresh_posts(monkeypatch, _posts, config, token, path):
    from agent.credential_pool import load_pool
    from hermes_cli.auth import _codex_quota_probe_cache
    from hermes_cli.auth_codex import resolve_codex_runtime_credentials
    _codex_quota_probe_cache.clear()  # a slot left by another cell would hide the POST
    home = _home(monkeypatch)
    _set_config(home, config)
    _write_rows(home, _oauth_row(token, **_cooldown()))

    with suppress(AuthError):
        if path == "store-resolver":
            resolve_codex_runtime_credentials()
        elif path == "runtime":
            _resolve()
        else:
            pool = load_pool("openai-codex")
            pool._codex_quota_restored_upstream(pool.entries()[0])

    assert [u for u in _posts if "auth.openai.com" in u] == []
    assert _rows(home)["row"]["access_token"] == token


@pytest.mark.parametrize("token", [OPAQUE, JWT_GATEWAY, EXPIRED_GATEWAY], ids=["opaque", "jwt-gateway", "expired-jwt"])
def test_the_one_refresh_post_refuses_what_is_not_chatgpts_own(_posts, token):
    from hermes_cli.auth_codex import CODEX_HOST_UNKNOWN_CODE, refresh_codex_oauth_pure

    with pytest.raises(AuthError) as refused:
        refresh_codex_oauth_pure(token, "dummy-gateway-refresh")

    assert _code(refused) == CODEX_HOST_UNKNOWN_CODE and _posts == [] and token not in str(refused.value)


LOGIN_SHAPES = {
    "iss": _jwt(iss="https://auth.openai.com", exp=1, **{AUTH_CLAIM: {"chatgpt_account_id": "acct"}}),
    "iss-slash": _jwt(iss="https://auth.openai.com/", exp=1, sub="u"),
    "iss-auth0": _jwt(iss="https://auth0.openai.com/", exp=1, sub="u"),
    "claim-no-iss": _jwt(exp=1, **{AUTH_CLAIM: {"chatgpt_account_id": "acct"}}),
    "empty": "",
}


@pytest.mark.parametrize("shape", LOGIN_SHAPES)
def test_real_login_shapes_still_reach_the_refresh_post(_posts, shape):
    from hermes_cli.auth_codex import refresh_codex_oauth_pure

    with pytest.raises(AuthError):  # the recorder answers 400
        refresh_codex_oauth_pure(LOGIN_SHAPES[shape], "dummy-login-refresh")

    assert len(_posts) == 1 and "auth.openai.com" in _posts[0]


# R26
def test_real_login_in_cooldown_beside_a_leftover_row_reports_the_quota(monkeypatch):
    from hermes_cli.auth import get_codex_auth_status
    from hermes_cli.auth_codex import resolve_codex_runtime_credentials
    from hermes_cli.main import _has_any_provider_configured
    home = _home(monkeypatch)
    _set_config(home, "empty")
    _write_rows(home, ("gw", OPAQUE, {}), ("real", JWT_CHATGPT, _cooldown()))
    _stand_the_bench(monkeypatch)
    store = json.loads((home / "auth.json").read_text())
    store["active_provider"] = "openai-codex"
    (home / "auth.json").write_text(json.dumps(store))

    for call in (_resolve, resolve_codex_runtime_credentials):
        with pytest.raises(AuthError) as limited:
            call()
        assert _code(limited) == "codex_rate_limited", call
    status = get_codex_auth_status()
    assert status["logged_in"] is True and status["rate_limited"] is True and status["source"] == "pool:real"
    assert _has_any_provider_configured() is True


def test_a_hand_set_gateway_row_in_cooldown_beside_a_leftover_row_reports_the_quota(monkeypatch):
    home = _home(monkeypatch)
    _set_config(home, "empty")
    _write_rows(home, ("gw", OPAQUE, {}), ("hand", "dummy-hand-key", {"base_url": OTHER_GW, **_cooldown()}))
    _stand_the_bench(monkeypatch)

    with pytest.raises(AuthError) as limited:
        _resolve()
    assert _code(limited) == "codex_rate_limited"


@pytest.mark.parametrize("rows", [
    (("gw", OPAQUE, {}),),
    (("gw", OPAQUE, {}), ("gw2", "dummy-second-key", "cooldown")),
    (("gw", OPAQUE, "cooldown"),),
], ids=["alone", "beside-a-refused-cooldown", "itself-in-cooldown"])
def test_the_refusal_stands_when_no_row_is_chatgpts_own_or_names_a_gateway(monkeypatch, rows):
    from hermes_cli.auth import get_codex_auth_status
    from hermes_cli.auth_codex import CODEX_HOST_UNKNOWN_CODE, resolve_codex_runtime_credentials
    home = _home(monkeypatch)
    _set_config(home, "empty")
    _write_rows(home, *[(i, k, _cooldown() if e == "cooldown" else e) for i, k, e in rows])

    for call in (_resolve, resolve_codex_runtime_credentials):
        with pytest.raises(AuthError) as refused:
            call()
        assert _code(refused) == CODEX_HOST_UNKNOWN_CODE, call
    status = get_codex_auth_status()
    assert status["logged_in"] is False and not status.get("rate_limited") and FIX_WORDS in status["error"]


# R27
def _switch_to(base_url, key=OPAQUE, monkeypatch=None):
    from agent import models_dev
    from hermes_cli.model_switch import switch_model
    monkeypatch.setattr(models_dev, "fetch_models_dev", lambda *_a, **_k: {})  # the label lookup stays offline
    return switch_model("gpt-5.5", "openrouter", "m", explicit_provider="mygw", user_providers={
        "mygw": {"name": "mygw", "base_url": base_url, "api_key": key, "default_model": "gpt-5.5"}})


@pytest.mark.parametrize("url", [CHATGPT, "https://chatgpt.com", "https://CHATGPT.com/backend-api/codex/"])
def test_model_switch_to_a_provider_at_chatgpt_is_refused_with_the_fix(monkeypatch, url):
    home = _home(monkeypatch)
    _set_config(home, "empty")

    result = _switch_to(url, monkeypatch=monkeypatch)

    assert result.success is False and FIX_WORDS in result.error_message
    assert OPAQUE not in result.error_message and not result.api_key


def test_model_switch_to_a_provider_at_chatgpt_takes_chatgpts_own_token(monkeypatch):
    from hermes_cli import model_switch, models_validate
    home = _home(monkeypatch)
    _set_config(home, "empty")
    monkeypatch.setattr(models_validate, "validate_requested_model",
                        lambda *_a, **_k: {"accepted": True, "persist": True, "recognized": True, "message": None})
    monkeypatch.setattr(model_switch, "_build_switch_result", lambda st: SimpleNamespace(
        success=True, api_key=st.api_key, base_url=st.base_url))

    result = _switch_to(CHATGPT, key=JWT_CHATGPT, monkeypatch=monkeypatch)
    assert result.success is True and result.api_key == JWT_CHATGPT


def test_model_switch_to_a_provider_at_its_gateway_passes(monkeypatch):
    from hermes_cli import model_switch, models_validate
    home = _home(monkeypatch)
    _set_config(home, "empty")
    monkeypatch.setattr(models_validate, "validate_requested_model",
                        lambda *_a, **_k: {"accepted": True, "persist": True, "recognized": True, "message": None})
    monkeypatch.setattr(model_switch, "_build_switch_result", lambda st: SimpleNamespace(
        success=True, api_key=st.api_key, base_url=st.base_url))

    result = _switch_to(GW, monkeypatch=monkeypatch)
    assert result.success is True and result.api_key == OPAQUE and result.base_url.startswith(GW)


# R29
def test_a_lease_skips_a_refused_row(monkeypatch):
    from agent.credential_pool import load_pool
    home = _home(monkeypatch)
    _set_config(home, "empty")
    _write_rows(home, ("gw", OPAQUE, {}), ("real", JWT_CHATGPT, {}))

    pool = load_pool("openai-codex")

    assert pool.acquire_lease() == "real"
    assert pool.current().id == "real"


@pytest.mark.parametrize("method", ["try_refresh_current", "try_refresh_matching"])
def test_forced_refresh_of_a_refused_key_row_through_the_pool_leaves_it_unmarked(monkeypatch, _posts, method):
    from agent.credential_pool import load_pool
    home = _home(monkeypatch)
    _set_config(home, "empty")
    _write_rows(home, ("gw", OPAQUE, {}))
    pool = load_pool("openai-codex")
    pool._current_id = "gw"

    getattr(pool, method)(*([OPAQUE] if method == "try_refresh_matching" else []))

    assert _rows(home)["gw"].get("last_status") is None and _posts == []


@pytest.mark.parametrize("spelling", [
    "https://GW.example/v1", "HTTPS://gw.example/v1", "https://gw.example:443/v1", "https://gw.example/v1/"])
def test_delegation_takes_the_same_route_however_it_is_spelled(spelling):
    runtime = _child(OPAQUE, "https://gw.example/v1", override_base_url=spelling)
    assert runtime["api_key"] == OPAQUE


def test_delegation_sends_the_live_key_with_the_live_url():
    runtime = _child("surface-key", "https://stale.example/v1", override_base_url="https://live.example/v1",
                     live={"base_url": "https://live.example/v1", "api_key": "live-key"})
    assert runtime["api_key"] == "live-key"


@pytest.mark.parametrize("key", ["", None])
def test_delegation_to_a_keyless_server_says_a_placeholder_is_enough(key):
    with pytest.raises(ValueError, match="placeholder") as refused:
        _child(key, "http://localhost:8080/v1", override_base_url="http://localhost:9090/v1")
    assert "parent's key does not go" not in str(refused.value)


def test_a_refusal_at_child_build_reaches_the_caller_as_the_error():
    from tools import delegate_tool
    seen = {}

    def _raise(**_k):
        seen["called"] = True
        raise AuthError("refused", provider="openai-codex", code="codex_credential_host_unknown")
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(delegate_tool, "_build_child_preserving_parent_tools", _raise)
        children, error = delegate_tool._build_children(
            [{"goal": "g"}], [None], dict.fromkeys(("provider", "base_url", "api_key", "api_mode", "model")),
            parent_agent=MagicMock(), routing_cfg=None, top_role="leaf", max_iterations=1, live_deleg_id=None,
            live_writers=[], task_images=None)
    assert seen and children == [] and error == "refused"


def test_api_key_flag_follows_the_config_and_env_like_every_other_route(monkeypatch):
    home = _home(monkeypatch)
    _set_config(home, "good")
    assert _resolve(explicit_api_key=OPAQUE)["base_url"] == GW

    monkeypatch.setenv("HERMES_CODEX_BASE_URL", OTHER_GW)
    assert _resolve(explicit_api_key=OPAQUE)["base_url"] == OTHER_GW

    monkeypatch.delenv("HERMES_CODEX_BASE_URL")
    _set_config(home, "empty")
    with pytest.raises(AuthError):
        _resolve(explicit_api_key=OPAQUE)


@pytest.mark.parametrize("url", ["https://", "https", "https:", "http://", "://"])
def test_a_config_url_with_no_host_gets_the_refusal_that_names_the_fix(monkeypatch, url):
    from hermes_cli.auth_codex import _is_chatgpt_route
    home = _home(monkeypatch)
    (home / "config.yaml").write_text(_yaml_model(base_url=url))
    _write_rows(home, ("gw", OPAQUE, {}))

    assert _is_chatgpt_route(url) is True
    with pytest.raises(AuthError) as refused:
        _resolve()
    assert FIX_WORDS in str(refused.value)


def test_auth_list_marks_a_refused_row(monkeypatch, capsys):
    from hermes_cli.auth_commands import auth_list_command
    home = _home(monkeypatch)
    _set_config(home, "empty")
    _write_rows(home, ("gw", OPAQUE, {}), ("real", JWT_CHATGPT, {}))

    auth_list_command(SimpleNamespace(provider="openai-codex"))

    lines = {line.split()[1]: line for line in capsys.readouterr().out.splitlines() if line.strip().startswith("#")}
    assert "refused: no known host" in lines["gw"] and "refused" not in lines["real"]
    assert OPAQUE not in lines["gw"]


# R30: on a route that is not chatgpt.com, automatic choice skips a row that is ChatGPT's own.
def _gateway_rows(home, *rows, config="good", store=None):
    _set_config(home, config)
    _write_rows(home, *rows, store=store)


def test_rotation_on_a_gateway_skips_a_login_row_for_the_next_key(monkeypatch):
    from agent.credential_pool import load_pool
    home = _home(monkeypatch)
    _gateway_rows(home, ("a", OPAQUE, {}), ("login", JWT_CHATGPT, {}), ("b", "dummy-second-key", {}))

    recovered, agent = _rotate(monkeypatch, load_pool("openai-codex"), OPAQUE, "a", GW)

    assert recovered is True and (agent.api_key, agent.base_url) == ("dummy-second-key", GW)


def test_rotation_on_a_gateway_with_only_a_login_row_left_keeps_the_rate_limit_error(monkeypatch):
    from agent.credential_pool import load_pool
    home = _home(monkeypatch)
    _gateway_rows(home, ("a", OPAQUE, {}), ("login", JWT_CHATGPT, {}))

    recovered, agent = _rotate(monkeypatch, load_pool("openai-codex"), OPAQUE, "a", GW)

    assert recovered is False and (agent.api_key, agent.base_url) == (OPAQUE, GW)
    assert _rows(home)["login"].get("last_status") in (None, "ok")


def test_rotation_between_two_logins_on_a_gateway_stops(monkeypatch):
    """The first login is the user's own config; moving a second real token there would be the app's choice."""
    from agent.credential_pool import load_pool
    home = _home(monkeypatch)
    _gateway_rows(home, ("a", JWT_CHATGPT, {}), ("b", JWT_C, {}))

    recovered, agent = _rotate(monkeypatch, load_pool("openai-codex"), JWT_CHATGPT, "a", GW)

    assert recovered is False and agent.api_key == JWT_CHATGPT


def test_rotation_from_a_model_scoped_failure_skips_a_login_row(monkeypatch):
    from agent.credential_pool import load_pool
    home = _home(monkeypatch)
    _gateway_rows(home, ("a", JWT_CHATGPT, {}), ("b", JWT_C, {}))
    pool = load_pool("openai-codex")
    assert pool.select().id == "a"
    monkeypatch.setattr(pool, "_is_model_scoped_failure", lambda *_a, **_k: True)

    assert pool.mark_exhausted_and_rotate(status_code=429, credential_id="a", model="m") is None


def test_rotation_from_an_unmatched_failure_skips_a_login_row(monkeypatch):
    from agent.credential_pool import load_pool
    home = _home(monkeypatch)
    _gateway_rows(home, ("login", JWT_CHATGPT, {}), ("login2", JWT_C, {}))

    assert load_pool("openai-codex").mark_exhausted_and_rotate(status_code=401, api_key_hint="matches-no-row") is None


@pytest.mark.parametrize("choose", ["select", "peek", "lease"])
def test_selection_on_a_gateway_skips_a_login_row_listed_first(monkeypatch, choose):
    from agent.credential_pool import load_pool
    home = _home(monkeypatch)
    _gateway_rows(home, ("login", JWT_CHATGPT, {}), ("gw", OPAQUE, {}))
    pool = load_pool("openai-codex")

    picked = {"select": lambda: pool.select().id, "peek": lambda: pool.peek().id, "lease": pool.acquire_lease}[choose]()

    assert picked == "gw"
    assert _resolve()["api_key"] == OPAQUE


@pytest.mark.parametrize("choose", ["select", "peek", "lease"])
def test_selection_with_the_gateway_key_cooling_chooses_no_login(monkeypatch, choose):
    from agent.credential_pool import load_pool
    home = _home(monkeypatch)
    _gateway_rows(home, ("gw", OPAQUE, _cooldown()), ("login", JWT_CHATGPT, {}))
    _stand_the_bench(monkeypatch)
    pool = load_pool("openai-codex")

    assert {"select": pool.select, "peek": pool.peek, "lease": pool.acquire_lease}[choose]() is None


def test_a_new_session_with_the_gateway_key_cooling_gets_the_quota_error_not_the_login(monkeypatch):
    from hermes_cli.auth_codex import _pool_codex_credential
    home = _home(monkeypatch)
    _gateway_rows(home, ("gw", OPAQUE, _cooldown()), ("login", JWT_CHATGPT, {}))
    _stand_the_bench(monkeypatch)

    assert _pool_codex_credential() == ("", "")
    with pytest.raises(AuthError) as limited:
        _resolve()
    assert limited.value.code != "codex_credential_host_unknown" and "quota" in str(limited.value).lower()


def test_an_explicit_base_url_at_a_gateway_skips_a_login_row(monkeypatch):
    home = _home(monkeypatch)
    _gateway_rows(home, ("login", JWT_CHATGPT, {}), ("gw", OPAQUE, {}), config="empty")

    resolved = _resolve(explicit_base_url=GW)

    assert (resolved["api_key"], resolved["base_url"]) == (OPAQUE, GW)


# R36 replaces the limit R30 declared: a pool of only logins with model.base_url at a gateway sends nothing.
def test_a_pool_of_only_a_login_with_a_gateway_config_is_refused_naming_the_opt_in(monkeypatch):
    home = _home(monkeypatch)
    _gateway_rows(home, ("login", JWT_CHATGPT, {}))

    with pytest.raises(AuthError) as refused:
        _resolve()
    text = str(refused.value)
    assert refused.value.code == "codex_credential_host_unknown"
    assert "HERMES_CODEX_BASE_URL" in text and FIX_WORDS in text and JWT_CHATGPT not in text


def test_limit_a_store_login_with_the_gateway_key_cooling_follows_the_store_route(monkeypatch):
    """Not a pool row. It goes to chatgpt.com under model.base_url and to the gateway only under the env override."""
    home = _home(monkeypatch)
    _write_singleton(home, JWT_CHATGPT)
    store = json.loads((home / "auth.json").read_text())
    _gateway_rows(home, ("gw", OPAQUE, _cooldown()), store=store["providers"])
    _stand_the_bench(monkeypatch)

    resolved = _resolve()
    assert (resolved["api_key"], resolved["base_url"]) == (JWT_CHATGPT, CHATGPT)

    monkeypatch.setenv("HERMES_CODEX_BASE_URL", GW)
    resolved = _resolve()
    assert (resolved["api_key"], resolved["base_url"]) == (JWT_CHATGPT, GW)


def test_the_env_gateway_carries_a_login_row_whatever_its_own_url(monkeypatch):
    """R36: HERMES_CODEX_BASE_URL is the user's explicit act, so a login follows it, with or without a row URL."""
    from agent.credential_pool import load_pool
    home = _home(monkeypatch)
    _gateway_rows(home, ("hand", JWT_CHATGPT, {"base_url": OTHER_GW}), ("gw", OPAQUE, {}), config="empty")
    monkeypatch.setenv("HERMES_CODEX_BASE_URL", GW)

    assert load_pool("openai-codex").select().id == "hand"

    _write_rows(home, ("login", JWT_CHATGPT, {}), ("gw", OPAQUE, {}))
    assert load_pool("openai-codex").select().id == "login"


@pytest.mark.parametrize("config", ["empty", "missing"])
def test_on_chatgpt_a_session_still_rotates_between_logins(monkeypatch, config):
    from agent.credential_pool import load_pool
    home = _home(monkeypatch)
    _gateway_rows(home, ("a", JWT_CHATGPT, {}), ("b", JWT_C, {}), config=config)

    recovered, agent = _rotate(monkeypatch, load_pool("openai-codex"), JWT_CHATGPT, "a", CHATGPT)

    assert recovered is True and (agent.api_key, agent.base_url) == (JWT_C, CHATGPT)


def test_a_config_that_spells_chatgpt_its_own_way_is_still_chatgpt(monkeypatch):
    """The route differs from the row's URL by spelling only, so the login is not off its route."""
    from agent.credential_pool import load_pool
    spelled = "https://CHATGPT.com/backend-api/codex"
    home = _home(monkeypatch)
    (home / "config.yaml").write_text(_yaml_model(base_url=spelled))
    _write_rows(home, ("a", JWT_CHATGPT, {}), ("b", JWT_C, {}))

    recovered, agent = _rotate(monkeypatch, load_pool("openai-codex"), JWT_CHATGPT, "a", spelled)

    assert recovered is True and agent.api_key == JWT_C


# The hostless URL the last pass left: a real login at a URL with no host fails by name, not in the client.
@pytest.mark.parametrize("stored", ["pool", "store", "explicit"])
@pytest.mark.parametrize("url", ["https://", "https", "https:", "http://", "://"])
def test_a_chatgpt_token_with_a_url_with_no_host_gets_a_named_failure(monkeypatch, url, stored):
    home = _home(monkeypatch)
    (home / "config.yaml").write_text(_yaml_model(base_url=url))
    if stored == "store":
        _write_singleton(home, JWT_CHATGPT)
        monkeypatch.setenv("HERMES_CODEX_BASE_URL", url)
    elif stored == "pool":
        _write_rows(home, ("login", JWT_CHATGPT, {}))

    with pytest.raises(AuthError) as refused:
        _resolve(**({"explicit_api_key": JWT_CHATGPT} if stored == "explicit" else {}))

    assert refused.value.code == "codex_credential_host_unknown"
    assert "no host" in str(refused.value) and FIX_WORDS in str(refused.value)
    assert "not a ChatGPT login" not in str(refused.value) and JWT_CHATGPT not in str(refused.value)
