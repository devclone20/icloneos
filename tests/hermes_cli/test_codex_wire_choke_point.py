"""The choke point (FX34, rulings R35-R39): every request that carries a Codex credential is judged once, at the
wire, on the host the client dials and the bearer it carries. ``httpx.Client.send`` and ``httpx.AsyncClient.send``
run the judge before any transport, so the OpenAI SDK, a bare client and every helper pass through it.

Two checks, stateless, on the bearer and the dialed host only (R43): chatgpt.com, on the Codex API paths, takes only
ChatGPT's own token; ChatGPT's own token goes only to chatgpt.com, unless HERMES_CODEX_BASE_URL names that host at that
moment. No row and no config line licenses anything. Nothing here reaches the network: the transport is
a recorder, and a socket use fails the test (the table module's autouse fixtures are reused by import).
"""

import asyncio
import importlib.util
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest

from hermes_cli.auth_constants import AuthError

_REPO = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location(
    "codex_refusal_table_for_wire", _REPO / "tests/hermes_cli/test_codex_credential_refusal_table.py")
T = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(T)
GW, CHATGPT, GW_HOST, CHATGPT_HOST = T.GW, T.CHATGPT, T.GW_HOST, T.CHATGPT_HOST
JWT_CHATGPT, JWT_GATEWAY, OPAQUE = T.JWT_CHATGPT, T.JWT_GATEWAY, T.OPAQUE
LOGIN_B = T._jwt(iss="https://auth.openai.com", sub="b", exp=4102444800, **{T.AUTH_CLAIM: {"chatgpt_account_id": "b"}})
OTHER = "https://openrouter.ai/api/v1"


@pytest.fixture(autouse=True)
def _table_fixtures(monkeypatch):
    """The table's two autouse fixtures, inline: no socket, one warning per credential, config readable after."""
    import socket
    from hermes_cli import auth_codex
    from hermes_cli import config as config_mod

    def _refuse(*_a, **_k):
        pytest.fail("a test of the choke point reached for the network")
    monkeypatch.setattr(socket.socket, "connect", _refuse)
    monkeypatch.setattr(socket, "getaddrinfo", _refuse)
    monkeypatch.setattr(auth_codex, "_codex_refusals_logged", set(), raising=False)
    auth_codex._codex_quota_probe_cache.clear()  # a probe slot is held per token for minutes
    # The Happy-Eyeballs backend replaces the transport; the recorder below sits on the stock one.
    monkeypatch.setattr("agent.process_bootstrap.enable_happy_eyeballs_on_client", lambda client: None, raising=False)
    config_mod._LOAD_CONFIG_CACHE.clear()
    yield
    path = Path(os.environ["HERMES_HOME"]) / "config.yaml"
    if path.exists():
        path.chmod(0o600)


def _cool() -> dict:
    return {"last_status": "exhausted", "last_status_at": time.time(), "last_error_code": 429,
            "last_error_reason": "usage_limit_reached", "last_error_message": "limit",
            "last_error_reset_at": time.time() + 3600}


def _rows(home: Path, *rows) -> None:
    """``(id, token, extra)`` rows; a JWT row is an oauth row with a refresh token, as the real login writes it."""
    pool = []
    for i, (rid, token, extra) in enumerate(rows):
        oauth = token.count(".") == 2
        pool.append({"id": rid, "label": rid, "auth_type": "oauth" if oauth else "api_key", "priority": i,
                     "source": "manual", "access_token": token, "base_url": CHATGPT,
                     **({"refresh_token": "rt-" + rid} if oauth else {}), **extra})
    (home / "auth.json").write_text(json.dumps({"version": 1, "providers": {}, "credential_pool": {"openai-codex": pool}}))


class _Wire:
    """A recorder below ``send``: what reaches it is what would have left the process."""

    def __init__(self, monkeypatch, limited=()):
        self.seen = []
        self.limited = set(limited)
        monkeypatch.setattr(httpx.HTTPTransport, "handle_request", lambda _self, req: self._handle(req))

        async def _async(_self, req):
            await req.aread()
            return self._handle(req)
        monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", _async)

    def _handle(self, req):
        req.read()
        token = req.headers.get("authorization", "").removeprefix("Bearer ").strip()
        if req.url.path.endswith("/oauth/token"):
            from urllib.parse import parse_qs
            refresh = parse_qs(req.content.decode()).get("refresh_token", ["?"])[0]
            self.seen.append((req.url.host, req.url.path, "refresh:" + refresh))
            return httpx.Response(400, json={"error": "invalid_grant"}, request=req)
        self.seen.append((req.url.host, req.url.path, token))
        if "usage" in req.url.path:
            used = 100.0 if token in self.limited else 1.0
            return httpx.Response(200, json={"plan_type": "plus", "rate_limit": {"primary_window": {
                "used_percent": used, "limit_window_seconds": 3600, "reset_after_seconds": 3600}}}, request=req)
        if req.url.path.endswith("/models"):
            return httpx.Response(200, json={"models": [{"slug": "gpt-5.5", "supported_in_api": True,
                                                         "visibility": "list", "context_window": 100000}]}, request=req)
        if req.url.path.endswith("/images/generations") or "image" in req.url.path:
            return httpx.Response(200, json={"data": [{"b64_json": "aGk="}]}, request=req)
        return httpx.Response(200, json={}, request=req)

    def pairs(self):
        return {(host, token) for host, _path, token in self.seen if token and not token.startswith("refresh:")}

    def refreshed(self):
        return {token.removeprefix("refresh:rt-") for _h, _p, token in self.seen if token.startswith("refresh:")}


def _rule_holds(pairs) -> None:
    from hermes_cli.auth_codex import _codex_token_is_chatgpt_own
    for host, token in pairs:
        own = _codex_token_is_chatgpt_own(token)
        assert (host == CHATGPT_HOST) == own, f"wrong pair on the wire: {host} with {'a login' if own else 'a key'}"


# ── R35: the judge sits on send, so a bare client, an async client and the SDK all pass it ───────────────


def test_choke_point_is_installed_on_both_httpx_clients():
    import hermes_cli.auth_codex  # noqa: F401  (any Codex credential reader imports this)
    assert getattr(httpx.Client.send, "_codex_wire_judge", False) is True
    assert getattr(httpx.AsyncClient.send, "_codex_wire_judge", False) is True


def test_httpx_defines_what_the_judge_wraps():
    """The judge reads ``httpx._client`` because ``httpx.Client`` is only a name. An upgrade that moves it lands here."""
    import httpx._client as own
    assert (own.Client, own.AsyncClient, own.URL) == (httpx.Client, httpx.AsyncClient, httpx.URL)


def test_a_replaced_send_gets_the_judge_again(monkeypatch):
    """No flag: the next rule call asks the class itself, so a ``send`` put there later is judged and still runs."""
    from hermes_cli.auth_codex import _codex_host_accepts_credential
    sent = []

    def replaced(self, request, **_kw):
        sent.append(str(request.url))
        return httpx.Response(200, request=request)

    async def replaced_async(self, request, **_kw):
        return httpx.Response(200, request=request)

    monkeypatch.delenv("HERMES_CODEX_BASE_URL", raising=False)
    monkeypatch.setattr(httpx.Client, "send", replaced)
    monkeypatch.setattr(httpx.AsyncClient, "send", replaced_async)

    assert _codex_host_accepts_credential(OPAQUE, GW) is True

    assert getattr(httpx.Client.send, "_codex_wire_judge", False) is True
    assert getattr(httpx.AsyncClient.send, "_codex_wire_judge", False) is True
    with pytest.raises(AuthError):
        httpx.Client().get(CHATGPT + "/responses", headers={"Authorization": f"Bearer {OPAQUE}"})
    assert sent == []
    httpx.Client().get(GW + "/responses", headers={"Authorization": f"Bearer {OPAQUE}"})
    assert sent == [GW + "/responses"]


def test_a_stand_in_bound_to_the_httpx_name_never_takes_the_judge_from_the_real_class(monkeypatch):
    """A fake class under the name ``httpx.Client`` once took the judge and left the real class bare for the process."""
    from hermes_cli.auth_codex import _install_codex_wire_judge

    class StandIn:
        def send(self, request):
            raise AssertionError("not used")

    bare = httpx.Client.send.__wrapped__
    monkeypatch.setattr(httpx._client.Client, "send", bare)
    monkeypatch.setattr(httpx, "Client", StandIn)

    _install_codex_wire_judge()

    assert not hasattr(StandIn.send, "_codex_wire_judge")
    assert getattr(httpx._client.Client.send, "_codex_wire_judge", False) is True


def test_a_client_built_before_the_judge_is_judged(monkeypatch):
    from hermes_cli.auth_codex import _install_codex_wire_judge
    reached = []

    def handler(request):
        reached.append(str(request.url))
        return httpx.Response(200, request=request)

    monkeypatch.setattr(httpx.Client, "send", httpx.Client.send.__wrapped__)
    monkeypatch.delenv("HERMES_CODEX_BASE_URL", raising=False)
    early = httpx.Client(transport=httpx.MockTransport(handler))

    _install_codex_wire_judge()

    with pytest.raises(AuthError):
        early.get(GW + "/responses", headers={"Authorization": f"Bearer {JWT_CHATGPT}"})
    assert reached == []


@pytest.mark.parametrize("first", ["hermes_cli.auth_codex", "httpx"])
def test_a_fresh_process_has_the_judge_before_any_client_or_rule(first):
    """Either import order, no rule run: importing the reader of Codex credentials is enough, and it leaves httpx lazy."""
    probe = (
        "import importlib, sys\n"
        "importlib.import_module(sys.argv[1])\n"
        "assert sys.argv[1] == 'httpx' or 'httpx' not in sys.modules, 'httpx loaded eagerly'\n"
        "import httpx, hermes_cli.auth_codex\n"
        "assert httpx.Client.send._codex_wire_judge is True\n"
        "assert httpx.AsyncClient.send._codex_wire_judge is True\n")
    done = subprocess.run([sys.executable, "-c", probe, first], cwd=_REPO, capture_output=True, text=True, timeout=60)
    assert done.returncode == 0, done.stderr[-400:]


def test_the_lazy_httpx_proxy_keeps_no_module_from_under_a_stand_in(monkeypatch):
    """The cause of the refresh rows going red only after a file that swaps ``sys.modules``: a cached stand-in."""
    from types import SimpleNamespace

    from hermes_cli.auth_constants import httpx as lazy
    with monkeypatch.context() as swapped:
        swapped.setitem(sys.modules, "httpx", SimpleNamespace())
        with pytest.raises(AttributeError):
            lazy.Timeout
    assert lazy.Timeout is httpx.Timeout


def test_picker_usage_route_reads_an_entry_that_only_has_a_stored_token(monkeypatch):
    """Inventory rows are not always pool objects: one with only ``access_token`` and ``base_url`` gets the same route."""
    from types import SimpleNamespace

    from hermes_cli.inventory import _pool_entry_route_base_url
    monkeypatch.delenv("HERMES_CODEX_BASE_URL", raising=False)

    login = SimpleNamespace(access_token=JWT_CHATGPT, base_url=GW)
    key = SimpleNamespace(access_token=OPAQUE, base_url=GW)

    assert httpx.URL(_pool_entry_route_base_url("openai-codex", login)).host == CHATGPT_HOST
    assert httpx.URL(_pool_entry_route_base_url("openai-codex", key)).host == GW_HOST


def test_bare_client_login_to_a_gateway_is_refused_before_the_transport(monkeypatch):
    home = T._home(monkeypatch)
    T._set_config(home, "good")
    wire = _Wire(monkeypatch)
    with pytest.raises(AuthError) as exc:
        httpx.Client().get(GW + "/responses", headers={"Authorization": f"Bearer {JWT_CHATGPT}"})
    assert exc.value.code == "codex_credential_host_unknown" and T.FIX_WORDS in str(exc.value)
    assert wire.seen == []


def test_bare_async_client_login_to_a_gateway_is_refused_before_the_transport(monkeypatch):
    home = T._home(monkeypatch)
    T._set_config(home, "good")
    wire = _Wire(monkeypatch)

    async def go():
        async with httpx.AsyncClient() as client:
            await client.get(GW + "/responses", headers={"Authorization": f"Bearer {JWT_CHATGPT}"})
    with pytest.raises(AuthError):
        asyncio.run(go())
    assert wire.seen == []


@pytest.mark.parametrize("cred", ["jwt-gateway", "opaque"])
def test_bare_client_key_to_chatgpt_is_refused_before_the_transport(monkeypatch, cred):
    home = T._home(monkeypatch)
    T._set_config(home, "good")
    wire = _Wire(monkeypatch)
    with pytest.raises(AuthError) as exc:
        httpx.Client().get(CHATGPT + "/responses", headers={"Authorization": f"Bearer {T.CREDS[cred]}"})
    assert T.FIX_WORDS in str(exc.value) and T.CREDS[cred] not in str(exc.value)
    assert wire.seen == []


def test_other_providers_and_unauthenticated_requests_pass_untouched(monkeypatch):
    home = T._home(monkeypatch)
    T._set_config(home, "good")
    wire = _Wire(monkeypatch)
    httpx.Client().get(OTHER + "/models", headers={"Authorization": f"Bearer {OPAQUE}"})
    httpx.Client().get(GW + "/models", headers={"Authorization": f"Bearer {OPAQUE}"})
    httpx.Client().get(CHATGPT + "/public")
    assert [h for h, _p, _t in wire.seen] == ["openrouter.ai", GW_HOST, CHATGPT_HOST]


def test_openai_sdk_send_passes_the_same_judge(monkeypatch):
    openai = pytest.importorskip("openai")
    home = T._home(monkeypatch)
    T._set_config(home, "good")
    wire = _Wire(monkeypatch)
    client = openai.OpenAI(api_key=JWT_CHATGPT, base_url=GW, max_retries=0)
    with pytest.raises(Exception) as exc:
        client.models.list()
    cause = exc.value if isinstance(exc.value, AuthError) else exc.value.__cause__
    assert isinstance(cause, AuthError) and cause.code == "codex_credential_host_unknown"
    assert wire.seen == []


# ── R36: the rule is symmetric; the opt-in is an explicit act ─────────────────────────────────────────


def test_login_reaches_the_env_gateway(monkeypatch):
    home = T._home(monkeypatch)
    T._set_config(home, "missing")
    monkeypatch.setenv("HERMES_CODEX_BASE_URL", GW)
    wire = _Wire(monkeypatch)
    httpx.Client().get(GW + "/responses", headers={"Authorization": f"Bearer {JWT_CHATGPT}"})
    assert wire.pairs() == {(GW_HOST, JWT_CHATGPT)}


def test_model_base_url_alone_never_carries_a_login_to_a_gateway(monkeypatch):
    """The behaviour change: a pool holding only logins, config at a gateway, chat refuses and names the opt-in."""
    home = T._home(monkeypatch)
    T._set_config(home, "good")
    _rows(home, ("a", JWT_CHATGPT, {}))
    wire = _Wire(monkeypatch)
    with pytest.raises(AuthError) as exc:
        T._resolve()
    text = str(exc.value)
    assert "HERMES_CODEX_BASE_URL" in text and T.FIX_WORDS in text and JWT_CHATGPT not in text
    assert wire.pairs() == set()


def test_login_with_the_env_gateway_still_chats_there(monkeypatch):
    home = T._home(monkeypatch)
    T._set_config(home, "good")
    monkeypatch.setenv("HERMES_CODEX_BASE_URL", GW)
    _rows(home, ("a", JWT_CHATGPT, {}))
    runtime = T._resolve()
    assert (runtime["api_key"], runtime["base_url"].rstrip("/")) == (JWT_CHATGPT, GW)


# ── R35: the entry points, on one recording wire, in the states the three rounds found ────────────────


STATES = {
    "gw-config, login cooling, key": ("good", [("a", JWT_CHATGPT, _cool()), ("g", OPAQUE, {})]),
    "gw-config, key, login": ("good", [("g", OPAQUE, {}), ("a", JWT_CHATGPT, {})]),
    "gw-config, login cooling, key cooling": ("good", [("a", JWT_CHATGPT, _cool()), ("g", OPAQUE, _cool())]),
    "no config, key, login": ("missing", [("g", OPAQUE, {}), ("a", JWT_CHATGPT, {})]),
    "gw-config, only a login": ("good", [("a", JWT_CHATGPT, {})]),
    "gw-config, two logins": ("good", [("a", JWT_CHATGPT, _cool()), ("b", LOGIN_B, {})]),
}


def _drive_every_entry_point(monkeypatch, home):
    from contextlib import suppress
    from agent import account_usage, auxiliary_client
    from agent.credential_pool import load_pool
    from hermes_cli import inventory
    from hermes_cli.auth import get_codex_auth_status, resolve_codex_runtime_credentials
    with suppress(Exception):
        load_pool("openai-codex").select()  # selection runs the cooldown quota probe
    with suppress(Exception):
        resolve_codex_runtime_credentials()
    with suppress(Exception):
        T._resolve()
    with suppress(Exception):
        get_codex_auth_status()
    with suppress(Exception):
        account_usage.fetch_account_usage("openai-codex")
    with suppress(Exception):
        auxiliary_client._resolve_codex_credential_and_base()
    with suppress(Exception):
        inventory._apply_usage([{"slug": "openai-codex", "name": "Codex"}])
    with suppress(Exception):
        pool = load_pool("openai-codex")
        for entry in pool.entries():
            pool.try_refresh_matching(credential_id=entry.id)
    with suppress(Exception):
        img = T._load_image_plugin()
        monkeypatch.setattr(img, "save_b64_image", lambda b64, prefix="": home / "img.png")
        img.OpenAICodexImageGenProvider().generate("a cat")


@pytest.mark.parametrize("state", list(STATES))
def test_every_entry_point_keeps_the_pair_right_on_the_wire(monkeypatch, state):
    home = T._home(monkeypatch)
    config, rows = STATES[state]
    T._set_config(home, config)
    _rows(home, *rows)
    wire = _Wire(monkeypatch, limited=[JWT_CHATGPT])
    _drive_every_entry_point(monkeypatch, home)
    time.sleep(0.5)  # the picker's usage reads run on a thread
    _rule_holds(wire.pairs())
    logins = {rid for rid, token, _extra in rows if token.count(".") == 2}
    assert wire.refreshed() <= logins, f"a refresh POST left for a row that is not ChatGPT's: {wire.refreshed() - logins}"


# ── R37: a login's probes and usage reads go to chatgpt.com whatever the route ────────────────────────


def test_cooldown_probe_of_a_login_in_a_mixed_pool_asks_chatgpt_not_the_gateway(monkeypatch):
    home = T._home(monkeypatch)
    T._set_config(home, "good")
    _rows(home, ("a", JWT_CHATGPT, _cool()), ("g", OPAQUE, {}))
    wire = _Wire(monkeypatch)
    from agent.credential_pool import load_pool
    selected = load_pool("openai-codex").select()
    assert selected is not None and selected.label == "g"
    probes = [(h, t) for h, p, t in wire.seen if p.endswith("/usage")]
    assert probes == [(CHATGPT_HOST, JWT_CHATGPT)]


def test_picker_usage_reads_send_the_login_to_chatgpt_and_the_key_to_its_gateway(monkeypatch):
    home = T._home(monkeypatch)
    T._set_config(home, "good")
    _rows(home, ("g", OPAQUE, {}), ("a", JWT_CHATGPT, {}))
    wire = _Wire(monkeypatch)
    from hermes_cli import inventory
    inventory._apply_usage([{"slug": "openai-codex", "name": "Codex"}])
    time.sleep(0.5)
    assert wire.pairs() == {(GW_HOST, OPAQUE), (CHATGPT_HOST, JWT_CHATGPT)}


def test_a_gateway_key_probe_never_reaches_chatgpt_and_nothing_refreshes_it(monkeypatch):
    home = T._home(monkeypatch)
    T._set_config(home, "missing")
    _rows(home, ("g", JWT_GATEWAY, _cool()))
    wire = _Wire(monkeypatch)
    from agent.credential_pool import load_pool
    load_pool("openai-codex").select()
    assert wire.pairs() == set()


# ── R38: hermes model, /model, last-good config ───────────────────────────────────────────────────────


def test_hermes_model_on_a_gateway_keeps_model_base_url(monkeypatch):
    home = T._home(monkeypatch)
    T._set_config(home, "good")
    _rows(home, ("g", OPAQUE, {}))
    _Wire(monkeypatch)
    from hermes_cli import model_setup_flows as flows
    monkeypatch.setattr(flows, "_oauth_gate", lambda *a, **k: True)
    monkeypatch.setattr("hermes_cli.codex_models.get_codex_model_ids", lambda **k: ["gpt-5.5", "gpt-5.4"])
    monkeypatch.setattr("hermes_cli.auth._prompt_model_selection", lambda *a, **k: "gpt-5.4")
    from hermes_cli.config import load_config
    flows._model_flow_openai_codex(load_config(), "gpt-5.5")
    text = (home / "config.yaml").read_text()
    assert GW in text and "chatgpt.com" not in text
    assert T._resolve()["base_url"].rstrip("/") == GW


def test_hermes_model_does_not_persist_an_env_only_gateway(monkeypatch):
    home = T._home(monkeypatch)
    T._set_config(home, "missing")
    monkeypatch.setenv("HERMES_CODEX_BASE_URL", GW)
    _rows(home, ("g", OPAQUE, {}))
    _Wire(monkeypatch)
    from hermes_cli import model_setup_flows as flows
    monkeypatch.setattr(flows, "_oauth_gate", lambda *a, **k: True)
    monkeypatch.setattr("hermes_cli.codex_models.get_codex_model_ids", lambda **k: ["gpt-5.4"])
    monkeypatch.setattr("hermes_cli.auth._prompt_model_selection", lambda *a, **k: "gpt-5.4")
    from hermes_cli.config import load_config
    flows._model_flow_openai_codex(load_config(), "")
    assert GW_HOST not in (home / "config.yaml").read_text()


def _no_catalog_refresh(monkeypatch):
    """/model refreshes the models.dev catalog with ``requests``; that is not Codex traffic and stays offline here."""
    monkeypatch.setattr("agent.models_dev._fetch_models_dev_from_network", lambda *a, **k: None)


def test_model_switch_reports_the_quota_of_a_login_beside_a_leftover_row(monkeypatch):
    _no_catalog_refresh(monkeypatch)
    home = T._home(monkeypatch)
    T._set_config(home, "missing")
    _rows(home, ("a", JWT_CHATGPT, _cool()), ("gw", OPAQUE, {}))
    _Wire(monkeypatch, limited=[JWT_CHATGPT])
    from hermes_cli.model_switch import switch_model
    result = switch_model("gpt-5.5", "openai-codex", "gpt-5.5", explicit_provider="openai-codex")
    assert not result.success
    assert "not connected" not in str(result.error_message)
    assert re.search(r"quota|rate.?limit|usage limit", str(result.error_message), re.I), result.error_message


def test_model_switch_reports_the_refusal_and_its_fix_on_a_lost_config(monkeypatch):
    _no_catalog_refresh(monkeypatch)
    home = T._home(monkeypatch)
    T._set_config(home, "missing")
    _rows(home, ("gw", OPAQUE, {}))
    _Wire(monkeypatch)
    from hermes_cli.model_switch import switch_model
    result = switch_model("gpt-5.5", "openai-codex", "gpt-5.5", explicit_provider="openai-codex")
    assert not result.success
    assert "not connected" not in str(result.error_message) and T.FIX_WORDS in str(result.error_message)


@pytest.mark.parametrize("cred", ["opaque", "jwt-chatgpt"])
def test_last_good_config_carries_no_credential_to_a_gateway_the_file_no_longer_names(monkeypatch, cred):
    """A good read at GW, then the file breaks naming another gateway: the key is refused (the file is not
    complete), the login goes to chatgpt.com. The last good copy routes nothing."""
    home = T._home(monkeypatch)
    T._set_config(home, "good")
    _rows(home, ("g", T.CREDS[cred], {}))
    wire = _Wire(monkeypatch)
    from hermes_cli.config import load_config, _LOAD_CONFIG_CACHE
    load_config()
    if cred == "opaque":
        assert T._resolve()["base_url"].rstrip("/") == GW
    else:
        with pytest.raises(AuthError):  # R36: the login does not follow model.base_url while the file names GW
            T._resolve()
    (home / "config.yaml").write_text("model:\n  provider: openai-codex\n  base_url: [https://other-gw.exam")
    os.utime(home / "config.yaml", (time.time() + 5, time.time() + 5))
    _LOAD_CONFIG_CACHE.clear()
    if cred == "opaque":
        with pytest.raises(AuthError) as exc:
            T._resolve()
        assert "readable and complete" in str(exc.value)
    else:
        assert T._resolve()["base_url"].rstrip("/") == CHATGPT
    assert wire.pairs() == set()


# ── minors from the third lens ───────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("url", ["my-host/v1", "localhost:11434/v1", "chatgpt.com/backend-api/codex"])
def test_a_url_with_no_scheme_has_no_host_for_the_client_and_is_treated_so(url):
    from hermes_cli.auth_codex import _codex_host_accepts_credential, _codex_url_has_no_host
    assert _codex_url_has_no_host(url) is True
    assert _codex_host_accepts_credential(JWT_CHATGPT, url) is False


def test_auth_list_draws_no_arrow_on_a_refused_row(monkeypatch, capsys):
    import argparse
    home = T._home(monkeypatch)
    T._set_config(home, "missing")
    _rows(home, ("a", JWT_CHATGPT, _cool()), ("gw", OPAQUE, {}))
    _Wire(monkeypatch, limited=[JWT_CHATGPT])
    from hermes_cli.auth_commands import auth_list_command
    auth_list_command(argparse.Namespace(provider="openai-codex"))
    lines = [line for line in capsys.readouterr().out.splitlines() if "refused" in line]
    assert lines and all("←" not in line for line in lines)


# Files that read a Codex credential and also carry another HTTP stack, each with the reason it is not a bypass.
_OTHER_STACK_BESIDE_CODEX = {
    "hermes_cli/models.py": "urllib is the catalog stack, and /model validation can hand it a Codex token through "
                            "probe_api_models; _get_json, its one sender, runs the same two checks "
                            "(test_the_catalog_urllib_carries_the_same_two_checks)",
}


def test_no_product_module_sends_a_codex_bearer_outside_httpx():
    """Static leg of R35: a file that reads a Codex credential and builds a bearer uses httpx, where the judge
    sits, or is listed above with the reason. A new file doing both fails here until it is read and listed."""
    offenders = []
    for folder in ("agent", "hermes_cli", "plugins/image_gen/openai-codex"):
        for path in (_REPO / folder).rglob("*.py"):
            text = path.read_text(errors="replace")
            if "Bearer {" not in text or not re.search(
                    r"resolve_codex_runtime_credentials|_pool_codex_credential|_read_codex|codex_account_headers|"
                    r"codex_cloudflare_headers|_resolve_codex_", text):
                continue
            if re.search(r"^\s*(import requests|from requests|import aiohttp|from aiohttp|import urllib\.request|"
                         r"from urllib\.request|import http\.client|from http\.client)", text, re.M):
                offenders.append(str(path.relative_to(_REPO)))
    assert sorted(offenders) == sorted(_OTHER_STACK_BESIDE_CODEX)


# ── R43: two checks on the bearer and the dialed host, no state, no row ──────────────────────────────────


def _send(token, url):
    return httpx.Client().get(url, headers={"Authorization": f"Bearer {token}"})


@pytest.mark.parametrize("source", ["manual", "device_code", "manual:device_code"])
def test_a_row_url_licenses_nothing_for_a_login(monkeypatch, source):
    home = T._home(monkeypatch)
    T._set_config(home, "missing")
    _rows(home, ("a", JWT_CHATGPT, {"base_url": GW, "source": source}))
    wire = _Wire(monkeypatch)
    with pytest.raises(AuthError):
        _send(JWT_CHATGPT, GW + "/responses")
    assert wire.seen == []


def test_another_rows_url_licenses_nothing_for_a_login(monkeypatch):
    home = T._home(monkeypatch)
    T._set_config(home, "missing")
    _rows(home, ("a", JWT_CHATGPT, {}), ("g", OPAQUE, {"base_url": GW}))
    wire = _Wire(monkeypatch)
    with pytest.raises(AuthError):
        _send(JWT_CHATGPT, GW + "/responses")
    assert wire.seen == []


def test_a_key_row_url_still_says_where_the_key_goes(monkeypatch):
    home = T._home(monkeypatch)
    T._set_config(home, "missing")
    _rows(home, ("g", OPAQUE, {"base_url": GW}))
    _Wire(monkeypatch)
    assert T._resolve()["base_url"].rstrip("/") == GW


def test_the_env_counts_at_that_moment_on_a_client_already_built(monkeypatch):
    home = T._home(monkeypatch)
    T._set_config(home, "missing")
    wire = _Wire(monkeypatch)
    client = httpx.Client(headers={"Authorization": f"Bearer {JWT_CHATGPT}"})
    monkeypatch.setenv("HERMES_CODEX_BASE_URL", GW)
    client.get(GW + "/responses")
    assert wire.pairs() == {(GW_HOST, JWT_CHATGPT)}
    monkeypatch.delenv("HERMES_CODEX_BASE_URL")
    with pytest.raises(AuthError):
        client.get(GW + "/responses")
    assert len(wire.seen) == 1


def test_the_env_naming_another_host_licenses_nothing_here(monkeypatch):
    T._set_config(T._home(monkeypatch), "missing")
    monkeypatch.setenv("HERMES_CODEX_BASE_URL", "https://other.example/v1")
    wire = _Wire(monkeypatch)
    with pytest.raises(AuthError):
        _send(JWT_CHATGPT, GW + "/responses")
    assert wire.seen == []


def test_the_env_in_the_profile_scope_alone_reaches_that_host(monkeypatch):
    from agent.secret_scope import reset_secret_scope, set_secret_scope
    T._set_config(T._home(monkeypatch), "missing")
    monkeypatch.delenv("HERMES_CODEX_BASE_URL", raising=False)
    wire = _Wire(monkeypatch)
    token = set_secret_scope({"HERMES_CODEX_BASE_URL": GW})
    try:
        _send(JWT_CHATGPT, GW + "/responses")
    finally:
        reset_secret_scope(token)
    assert wire.pairs() == {(GW_HOST, JWT_CHATGPT)}


def test_a_multiplexed_siblings_process_env_is_not_this_profiles_act(monkeypatch):
    from agent.secret_scope import reset_multiplex_context, reset_secret_scope, set_multiplex_context, set_secret_scope
    T._set_config(T._home(monkeypatch), "missing")
    monkeypatch.setenv("HERMES_CODEX_BASE_URL", GW)
    wire = _Wire(monkeypatch)
    mode, scope = set_multiplex_context(True), set_secret_scope({})
    try:
        with pytest.raises(AuthError):
            _send(JWT_CHATGPT, GW + "/responses")
    finally:
        reset_secret_scope(scope)
        reset_multiplex_context(mode)
    assert wire.seen == []


def test_the_judge_reads_no_row_and_keeps_nothing(monkeypatch):
    from hermes_cli import auth_codex
    T._set_config(T._home(monkeypatch), "missing")
    _Wire(monkeypatch)

    def _no_row(*_a, **_k):
        pytest.fail("the judge read a row")
    monkeypatch.setattr("hermes_cli.auth.read_credential_pool", _no_row)
    monkeypatch.setattr("hermes_cli.auth._load_auth_store", _no_row)
    monkeypatch.setattr("hermes_cli.config.load_config_readonly", _no_row)
    for _ in range(2):
        with pytest.raises(AuthError):
            _send(JWT_CHATGPT, GW + "/responses")
        with pytest.raises(AuthError):
            _send(OPAQUE, CHATGPT + "/responses")
    assert auth_codex._codex_refusals_logged == set()


@pytest.mark.parametrize("header", [f"bearer {OPAQUE}", f"BEARER {OPAQUE}", f"Bearer  {OPAQUE}"])
def test_any_spelling_of_bearer_is_judged_on_the_way_to_chatgpt(monkeypatch, header):
    T._set_config(T._home(monkeypatch), "missing")
    wire = _Wire(monkeypatch)
    with pytest.raises(AuthError):
        httpx.Client().get(CHATGPT + "/responses", headers={"Authorization": header})
    assert wire.seen == []


def test_a_login_behind_two_spaces_is_still_a_login(monkeypatch):
    T._set_config(T._home(monkeypatch), "missing")
    wire = _Wire(monkeypatch)
    with pytest.raises(AuthError):
        httpx.Client().get(GW + "/responses", headers={"Authorization": f"Bearer  {JWT_CHATGPT}"})
    assert wire.seen == []


# ── R46: check (a) stops at the Codex API paths ──────────────────────────────────────────────────────────


@pytest.mark.parametrize("path", [
    "/backend-api/codex", "/backend-api/codex/responses", "/backend-api/codex/models", "/backend-api/wham/usage",
    "/api/codex/usage", "//backend-api/codex/responses", "/x/../backend-api/codex/responses",
    "/BACKEND-API/CODEX/responses", "/backend-api%2Fcodex/responses"])
def test_check_a_holds_on_the_codex_api_paths(monkeypatch, path):
    T._set_config(T._home(monkeypatch), "missing")
    wire = _Wire(monkeypatch)
    with pytest.raises(AuthError):
        _send(OPAQUE, "https://chatgpt.com" + path)
    assert wire.seen == []


@pytest.mark.parametrize("url", [
    "https://chatgpt.com/backend-api/me", "https://chatgpt.com/backend-api/codexfoo", "https://chatgpt.com/",
    "https://cdn.chatgpt.com/assets/a.js"])
def test_an_unrelated_bearer_on_another_chatgpt_path_passes(monkeypatch, url):
    T._set_config(T._home(monkeypatch), "missing")
    wire = _Wire(monkeypatch)
    _send(OPAQUE, url)
    assert len(wire.seen) == 1


def test_the_route_rule_treats_all_of_chatgpt_as_codex(monkeypatch):
    """Choosing a row reads a base URL, not a request: a key is not routed to chatgpt.com on any path of it."""
    from hermes_cli.auth_codex import _codex_host_accepts_credential
    T._set_config(T._home(monkeypatch), "missing")
    assert not _codex_host_accepts_credential(OPAQUE, "https://chatgpt.com")
    assert not _codex_host_accepts_credential(OPAQUE, "https://chatgpt.com/v1")
    assert _codex_host_accepts_credential(JWT_CHATGPT, "https://chatgpt.com")


def test_a_long_url_is_judged_as_the_client_holds_it(monkeypatch):
    """No second parse at the wire: a percent-encoded URL past the parser's limit is not a URL with no host."""
    T._set_config(T._home(monkeypatch), "missing")
    wire = _Wire(monkeypatch)
    long_query = "/s?q=" + "é" * 20000
    _send(OPAQUE, "https://api.example.com" + long_query)
    _send(JWT_CHATGPT, "https://chatgpt.com/backend-api/codex" + long_query)
    assert len(wire.seen) == 2
    with pytest.raises(AuthError):
        _send(OPAQUE, "https://chatgpt.com/backend-api/codex" + long_query)
    assert len(wire.seen) == 2


def test_a_blank_bearer_carries_nothing_to_judge(monkeypatch):
    T._set_config(T._home(monkeypatch), "missing")
    wire = _Wire(monkeypatch)
    httpx.Client().get(CHATGPT + "/responses", headers={"Authorization": "Bearer    "})
    assert len(wire.seen) == 1


def test_the_login_refusal_says_only_what_the_judge_knows(monkeypatch):
    T._set_config(T._home(monkeypatch), "missing")
    _Wire(monkeypatch)
    with pytest.raises(AuthError) as refused:
        _send(JWT_CHATGPT, "https://my.api.example/x")
    text = str(refused.value)
    assert "my.api.example" in text and "HERMES_CODEX_BASE_URL" in text
    assert "Codex credential" not in text and "alone does not carry" not in text and "own row" not in text
    assert JWT_CHATGPT not in text


def test_an_explicit_url_refusal_does_not_assume_a_config_line(monkeypatch):
    from hermes_cli.runtime_provider import resolve_runtime_provider
    home = T._home(monkeypatch)
    T._set_config(home, "missing")
    _rows(home, ("a", JWT_CHATGPT, {}))
    _Wire(monkeypatch)
    with pytest.raises(AuthError) as refused:
        resolve_runtime_provider(requested="openai-codex", explicit_base_url=GW)
    assert "--base-url" in str(refused.value) and "alone does not carry" not in str(refused.value)


# ── R44: a refused send is not an outage ─────────────────────────────────────────────────────────────────


def _live_agent(monkeypatch, token, url, *, pool=False):
    import threading
    from hermes_cli import auth_codex
    judged = []
    original = auth_codex._codex_wire_judge

    def _counted(request):
        judged.append(request.url.host)
        return original(request)
    monkeypatch.setattr(auth_codex, "_codex_wire_judge", _counted)
    real_sleep, real_wait = time.sleep, threading.Event.wait
    monkeypatch.setattr(time, "sleep", lambda s: real_sleep(min(s, 0.01)))
    monkeypatch.setattr(threading.Event, "wait", lambda self, timeout=None: real_wait(self, 0.01 if timeout is not None else 1))
    from run_agent import AIAgent
    extra = {}
    if pool:
        from agent.credential_pool import load_pool
        extra["credential_pool"] = load_pool("openai-codex")
    agent = AIAgent(base_url=url, api_key=token, provider="openai-codex", api_mode="codex_responses", model="gpt-5.5",
                    quiet_mode=True, skip_context_files=True, skip_memory=True, enabled_toolsets=[], max_iterations=1, **extra)
    return agent, judged


def _turn(agent, seconds=60):
    import threading
    result = {}
    thread = threading.Thread(target=lambda: result.update(agent.run_conversation("hi") or {}), daemon=True)
    thread.start()
    thread.join(seconds)
    assert not thread.is_alive(), "the refused turn is still retrying"
    return result


@pytest.mark.parametrize("token,url,fix", [
    (JWT_CHATGPT, GW, "HERMES_CODEX_BASE_URL"), (OPAQUE, CHATGPT, "hermes auth list")], ids=["login-to-gateway", "key-to-chatgpt"])
@pytest.mark.parametrize("pool", [False, True], ids=["no-pool", "pool"])
def test_a_refused_send_surfaces_once_with_its_fix_in_a_real_agent(monkeypatch, token, url, fix, pool):
    home = T._home(monkeypatch)
    T._set_config(home, "missing")
    _rows(home, ("a", JWT_CHATGPT, {}))
    wire = _Wire(monkeypatch)
    agent, judged = _live_agent(monkeypatch, token, url, pool=pool)
    for turn in (1, 2):  # the same live session, a second turn too
        judged.clear()
        result = _turn(agent)
        assert len(judged) == 1, f"turn {turn}: the refusal was retried {len(judged)} times"
        text = str(result.get("final_response")) + " " + str(result.get("error"))
        assert fix in text and "temporarily unavailable" not in text and "Connection error" not in text
        assert "Provider said" not in text and token not in text
        assert result.get("failed") and result.get("failure_retryable") is False
    assert [seen for seen in wire.seen if seen[2]] == []


def test_the_classifier_reads_the_refusal_under_the_sdks_wrapper():
    import openai
    from agent.error_classifier import FailoverReason, classify_api_error
    from hermes_cli.auth_codex import CODEX_HOST_UNKNOWN_CODE
    from hermes_cli.auth_constants import _codex_err
    cause = _codex_err("named fix", CODEX_HOST_UNKNOWN_CODE, relogin=False)
    wrapped = openai.APIConnectionError(request=httpx.Request("GET", GW))
    wrapped.__cause__ = cause
    verdict = classify_api_error(wrapped, provider="openai-codex", model="m")
    assert verdict.reason == FailoverReason.auth_permanent and not verdict.retryable and not verdict.should_fallback
    assert verdict.message == "named fix"
    plain = openai.APIConnectionError(request=httpx.Request("GET", GW))
    assert classify_api_error(plain, provider="openai-codex", model="m").retryable


# ── R45: every command a refusal names works, run through the real parser ────────────────────────────────


def _run_cli(line: str) -> None:
    import argparse
    import shlex
    from hermes_cli.auth_commands import auth_command
    from hermes_cli.subcommands.auth import build_auth_parser
    parser = argparse.ArgumentParser()
    build_auth_parser(parser.add_subparsers(dest="command"), cmd_auth=auth_command)
    argv = shlex.split(line.replace("<key>", "sk-gateway-key-from-the-message").replace("<n>", "1"))
    assert argv[0] == "hermes", line
    args = parser.parse_args(argv[1:])
    args.func(args)


def _commands_in(text: str) -> list:
    return re.findall(r"`(hermes [^`]+)`", text)


def _refusals(monkeypatch):
    from hermes_cli.auth_codex import _codex_login_route_message, _codex_no_host_message, _codex_refusal_message
    return _codex_login_route_message(GW_HOST), _codex_refusal_message(), _codex_no_host_message()


def test_the_refusals_name_the_commands_and_the_env(monkeypatch):
    T._set_config(T._home(monkeypatch), "missing")
    login, key, _none = _refusals(monkeypatch)
    assert "hermes auth add openai-codex --type api-key --api-key <key>" in _commands_in(login)
    assert {"hermes auth list", "hermes auth remove openai-codex <n>"} <= set(_commands_in(login))
    assert {"hermes auth list", "hermes auth remove openai-codex <n>"} <= set(_commands_in(key))
    assert "HERMES_CODEX_BASE_URL" in login and "HERMES_CODEX_BASE_URL" in key


def test_every_command_in_a_refusal_runs_and_does_what_it_says(monkeypatch, capsys):
    from hermes_cli.auth import read_credential_pool
    home = T._home(monkeypatch)
    T._set_config(home, "good")
    monkeypatch.setattr("hermes_cli.auth._codex_device_code_login", lambda *a, **k: {
        "tokens": {"access_token": LOGIN_B, "refresh_token": "rt-b"}, "base_url": CHATGPT, "last_refresh": None})
    named = {c for message in _refusals(monkeypatch) for c in _commands_in(message)}
    assert named
    _rows(home, ("a", JWT_CHATGPT, {}))
    for line in sorted(named, key=lambda c: "remove" in c):  # remove last: it needs what the others add
        before = {str(r.get("access_token")) for r in read_credential_pool("openai-codex")}
        _run_cli(line)
        after = {str(r.get("access_token")) for r in read_credential_pool("openai-codex")}
        if "--api-key <key>" in line:
            assert "sk-gateway-key-from-the-message" in after - before
        elif "add" in line:
            assert LOGIN_B in after - before
        elif "remove" in line:
            assert before - after
        else:
            assert "openai-codex" in capsys.readouterr().out
    assert "--api-key" in " ".join(named)


def test_following_the_key_command_makes_the_refused_gateway_work(monkeypatch):
    home = T._home(monkeypatch)
    T._set_config(home, "good")  # model.base_url at the gateway
    _rows(home, ("a", JWT_CHATGPT, {"priority": 9}))
    from hermes_cli.auth_codex import _codex_login_route_message
    line = next(c for c in _commands_in(_codex_login_route_message(GW_HOST)) if "--api-key" in c)
    _run_cli(line)
    _Wire(monkeypatch)
    resolved = T._resolve()
    assert resolved["base_url"].rstrip("/") == GW and resolved["api_key"] == "sk-gateway-key-from-the-message"


def test_the_api_key_flag_alone_adds_a_key_and_is_not_ignored(monkeypatch):
    from hermes_cli.auth import read_credential_pool
    home = T._home(monkeypatch)
    T._set_config(home, "good")
    monkeypatch.setattr("hermes_cli.auth._codex_device_code_login", lambda *a, **k: pytest.fail("started a ChatGPT login"))
    _run_cli("hermes auth add openai-codex --api-key sk-only-the-flag")
    assert any(r.get("access_token") == "sk-only-the-flag" and r.get("auth_type") == "api_key"
               for r in read_credential_pool("openai-codex"))


def test_auth_add_with_the_env_set_writes_no_host_on_the_login_row(monkeypatch):
    from hermes_cli.auth import read_credential_pool
    home = T._home(monkeypatch)
    T._set_config(home, "missing")
    monkeypatch.setenv("HERMES_CODEX_BASE_URL", GW)
    monkeypatch.setattr("hermes_cli.auth._codex_device_code_login", lambda *a, **k: {
        "tokens": {"access_token": JWT_CHATGPT, "refresh_token": "rt"}, "base_url": GW, "last_refresh": None})
    _run_cli("hermes auth add openai-codex --type oauth")
    assert [r.get("base_url") for r in read_credential_pool("openai-codex")] == [CHATGPT]
    monkeypatch.delenv("HERMES_CODEX_BASE_URL")
    assert T._resolve()["base_url"].rstrip("/") == CHATGPT


def test_auth_list_draws_no_arrow_on_a_refused_sole_row(monkeypatch, capsys):
    home = T._home(monkeypatch)
    T._set_config(home, "missing")
    _rows(home, ("gw", OPAQUE, {}))
    _Wire(monkeypatch)
    _run_cli("hermes auth list")
    lines = [line for line in capsys.readouterr().out.splitlines() if "refused" in line]
    assert lines and all("←" not in line for line in lines)


# ── R46: hermes model says what model.base_url holds; urllib carries the same two checks ─────────────────


def _model_flow(monkeypatch):
    from hermes_cli import model_setup_flows as flows
    from hermes_cli.config import load_config
    monkeypatch.setattr(flows, "_oauth_gate", lambda *a, **k: True)
    monkeypatch.setattr("hermes_cli.codex_models.get_codex_model_ids", lambda **k: ["gpt-5.5"])
    monkeypatch.setattr("hermes_cli.auth._prompt_model_selection", lambda *a, **k: "gpt-5.5")
    flows._model_flow_openai_codex(load_config(), "gpt-5.5")


def test_hermes_model_says_what_the_line_holds_when_chat_would_be_refused(monkeypatch, capsys):
    home = T._home(monkeypatch)
    T._set_config(home, "good")
    _rows(home, ("a", JWT_CHATGPT, {}))
    _Wire(monkeypatch)
    _model_flow(monkeypatch)
    out = capsys.readouterr().out
    assert GW in out and "model.base_url" in out and "HERMES_CODEX_BASE_URL" in out and "refused" in out
    assert "refused" in next(line for line in out.splitlines() if "Default model set to" in line)
    with pytest.raises(AuthError):
        T._resolve()


def test_hermes_model_warns_of_nothing_when_the_line_works(monkeypatch, capsys):
    home = T._home(monkeypatch)
    T._set_config(home, "good")
    _rows(home, ("g", OPAQUE, {}))
    _Wire(monkeypatch)
    _model_flow(monkeypatch)
    assert "refused" not in capsys.readouterr().out


def test_hermes_model_warns_of_nothing_when_the_env_names_the_line(monkeypatch, capsys):
    home = T._home(monkeypatch)
    T._set_config(home, "good")
    monkeypatch.setenv("HERMES_CODEX_BASE_URL", GW)
    _rows(home, ("a", JWT_CHATGPT, {}))
    _Wire(monkeypatch)
    _model_flow(monkeypatch)
    assert "refused" not in capsys.readouterr().out


@pytest.mark.parametrize("token,url,sent", [
    (JWT_CHATGPT, GW + "/models", False), (OPAQUE, CHATGPT + "/models", False),
    (JWT_CHATGPT, CHATGPT + "/models", True), (OPAQUE, GW + "/models", True)])
def test_the_catalog_urllib_carries_the_same_two_checks(monkeypatch, token, url, sent):
    import contextlib
    import io
    from hermes_cli import models
    T._set_config(T._home(monkeypatch), "missing")
    opened = []

    @contextlib.contextmanager
    def _open(req, **_k):
        opened.append(req.full_url)
        yield type("R", (io.BytesIO,), {"headers": {}})(b"{}")
    monkeypatch.setattr(models, "_urlopen_model_catalog_request", _open)
    if sent:
        models._get_json(url, timeout=1, headers={"Authorization": f"Bearer {token}"})
    else:
        with pytest.raises(AuthError):
            models._get_json(url, timeout=1, headers={"Authorization": f"Bearer {token}"})
    assert bool(opened) is sent


def test_the_model_switch_guard_covers_both_directions(monkeypatch):
    from types import SimpleNamespace
    from hermes_cli.model_switch import _refuse_pair_off_the_rule as guard
    T._set_config(T._home(monkeypatch), "missing")
    def state(token, url):
        return SimpleNamespace(api_key=token, base_url=url, fail_on_target=lambda message: message)
    assert "HERMES_CODEX_BASE_URL" in guard(state(JWT_CHATGPT, GW))
    assert guard(state(OPAQUE, CHATGPT))
    assert guard(state(JWT_CHATGPT, CHATGPT)) is None and guard(state(OPAQUE, GW)) is None
