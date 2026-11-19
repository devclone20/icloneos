"""v0.0.9 R-f1s-5 — under icloneOS, billing.charge needs main's owner confirm (spent over the permission channel)."""

from __future__ import annotations

import pytest

import hermes_cli.iclone_policy_env as policy_env
import hermes_cli.nous_billing as nb
import tui_gateway.server as srv

TOKEN = "a" * 64


def _call(params: dict) -> dict:
    return srv._methods["billing.charge"](1, params)["result"]


@pytest.fixture
def portal(monkeypatch):
    calls: list[dict] = []

    def post_charge(amount_usd=None, idempotency_key=None):
        calls.append({"amount_usd": amount_usd, "idempotency_key": idempotency_key})
        return {"chargeId": "ch_1"}

    monkeypatch.setattr(nb, "post_charge", post_charge)
    return calls


def _under_icloneos(monkeypatch, confirmed: bool | None):
    """``confirmed`` None = main unreachable."""
    asked: list[tuple] = []
    monkeypatch.setattr(policy_env, "locked", lambda: True)

    def owner_charge_confirmed(token, amount, key, wait=5.0):
        asked.append((token, amount, key))
        return bool(confirmed)

    monkeypatch.setattr(policy_env, "owner_charge_confirmed", owner_charge_confirmed)
    return asked


def test_plain_hermes_is_unchanged(monkeypatch, portal):
    monkeypatch.setattr(policy_env, "locked", lambda: False)
    res = _call({"amount_usd": "25", "idempotency_key": "key-1"})
    assert res["ok"] is True and res["charge_id"] == "ch_1"
    assert portal == [{"amount_usd": "25", "idempotency_key": "key-1"}]


@pytest.mark.parametrize("params", [
    {"amount_usd": "25", "idempotency_key": "key-1"},
    {"amount_usd": "25", "idempotency_key": "key-1", "owner_confirm": "not-hex"},
    {"amount_usd": "25", "idempotency_key": "key-1", "owner_confirm": TOKEN.upper()},
    {"amount_usd": 25, "idempotency_key": "key-1", "owner_confirm": TOKEN},
])
def test_missing_or_malformed_confirm_is_refused_without_a_portal_call(monkeypatch, portal, params):
    asked = _under_icloneos(monkeypatch, confirmed=True)
    res = _call(params)
    assert res["ok"] is False and res["error"] == "owner_confirm"
    assert res["idempotency_key"] == "key-1"
    assert portal == [] and asked == []


@pytest.mark.parametrize("confirmed", [False, None])
def test_main_refusing_or_unreachable_refuses(monkeypatch, portal, confirmed):
    asked = _under_icloneos(monkeypatch, confirmed=confirmed)
    res = _call({"amount_usd": "25", "idempotency_key": "key-1", "owner_confirm": TOKEN})
    assert res["ok"] is False and res["error"] == "owner_confirm"
    assert asked == [(TOKEN, "25", "key-1")]
    assert portal == []


def test_confirmed_charge_reaches_the_portal_once_with_the_same_key(monkeypatch, portal):
    asked = _under_icloneos(monkeypatch, confirmed=True)
    res = _call({"amount_usd": "25", "idempotency_key": "key-1", "owner_confirm": TOKEN})
    assert res["ok"] is True and res["charge_id"] == "ch_1" and res["idempotency_key"] == "key-1"
    assert asked == [(TOKEN, "25", "key-1")]
    assert portal == [{"amount_usd": "25", "idempotency_key": "key-1"}]


def test_owner_charge_confirmed_fails_closed_without_a_gate(monkeypatch):
    monkeypatch.setattr(policy_env, "locked", lambda: True)
    monkeypatch.setattr(policy_env, "_gate", None)
    monkeypatch.setattr("hermes_cli.plugins.discover_plugins", lambda *a, **k: None)
    assert policy_env.owner_charge_confirmed(TOKEN, "25", "key-1") is False


def test_channel_billing_confirm_needs_main_signed_confirmed_true(monkeypatch):
    channel_mod = policy_env._gate_module("channel")
    ch = channel_mod.Channel("/nonexistent.sock", "/nonexistent.token", b"k" * 32, "kid", None)
    sent: list[str] = []

    def request(verb, text, mac, timeout, key_id=None):
        sent.append(verb)
        return channel_mod.MainAnswer(code=0, body={"code": 0, "confirmed": True})

    monkeypatch.setattr(ch, "_request", request)
    assert ch.billing_confirm(TOKEN, "25", "key-1") is True and sent == ["billing"]
    monkeypatch.setattr(ch, "_request", lambda *a, **k: channel_mod.MainAnswer(code=1, body={"code": 1, "confirmed": False}))
    assert ch.billing_confirm(TOKEN, "25", "key-1") is False


# ── v0.0.9 Q (lead decision 1): every billing write that charges or arms a charge takes the same owner confirm ────

def _under_icloneos_actions(monkeypatch, confirmed: bool | None):
    asked: list[tuple] = []
    monkeypatch.setattr(policy_env, "locked", lambda: True)

    def owner_action_confirmed(action, subject, token, key, wait=5.0):
        asked.append((action, subject, token, key))
        return bool(confirmed)

    monkeypatch.setattr(policy_env, "owner_action_confirmed", owner_action_confirmed)
    return asked


@pytest.fixture
def portal_writes(monkeypatch):
    calls: list[tuple] = []

    def upgrade(subscription_type_id=None, idempotency_key=None):
        calls.append(("upgrade", subscription_type_id, idempotency_key))
        return {"status": "completed", "targetTierName": "Pro"}

    def change(subscription_type_id=None, cancel=False):
        calls.append(("change", subscription_type_id, cancel))
        return {"message": "scheduled"}

    def resume():
        calls.append(("resume",))
        return {"message": "resumed"}

    def auto_top_up(enabled=False, threshold=None, top_up_amount=None):
        calls.append(("auto", enabled, threshold, top_up_amount))
        return {}

    monkeypatch.setattr(nb, "post_subscription_upgrade", upgrade)
    monkeypatch.setattr(nb, "put_subscription_pending_change", change)
    monkeypatch.setattr(nb, "delete_subscription_pending_change", resume)
    monkeypatch.setattr(nb, "patch_auto_top_up", auto_top_up)
    return calls


def _rpc(name: str, params: dict) -> dict:
    return srv._methods[name](1, params)["result"]


# (method, params without a confirm, what main is asked: action, subject, key)
_WRITES = [
    ("subscription.upgrade", {"subscription_type_id": "tier_pro", "idempotency_key": "key-up-01"},
     ("subscription-upgrade", "tier_pro", "key-up-01")),
    ("subscription.change", {"subscription_type_id": "tier_lite", "idempotency_key": "key-ch-01"},
     ("subscription-change", "tier_lite", "key-ch-01")),
    ("subscription.resume", {"idempotency_key": "key-re-01"}, ("subscription-resume", "resume", "key-re-01")),
    ("billing.auto_reload", {"enabled": True, "threshold": "10", "top_up_amount": "25.50",
                             "idempotency_key": "key-ar-01"}, ("auto-reload", "on|10|25.50", "key-ar-01")),
]


@pytest.mark.parametrize("name,params,_asked", _WRITES)
def test_billing_writes_without_a_confirm_never_reach_the_portal(monkeypatch, portal_writes, name, params, _asked):
    """Red on the old runtime: subscription.upgrade charged the card and auto_reload armed a charge with no click."""
    asked = _under_icloneos_actions(monkeypatch, confirmed=True)
    res = _rpc(name, params)
    assert res["ok"] is False and res["error"] == "owner_confirm"
    assert portal_writes == [] and asked == []


@pytest.mark.parametrize("confirmed", [False, None])
@pytest.mark.parametrize("name,params,expected", _WRITES)
def test_billing_writes_refused_when_main_refuses_or_is_unreachable(monkeypatch, portal_writes, name, params,
                                                                     expected, confirmed):
    asked = _under_icloneos_actions(monkeypatch, confirmed=confirmed)
    res = _rpc(name, {**params, "owner_confirm": TOKEN})
    assert res["ok"] is False and res["error"] == "owner_confirm"
    assert asked == [(expected[0], expected[1], TOKEN, expected[2])]
    assert portal_writes == []


@pytest.mark.parametrize("name,params,expected", _WRITES)
def test_confirmed_billing_writes_reach_the_portal_once(monkeypatch, portal_writes, name, params, expected):
    asked = _under_icloneos_actions(monkeypatch, confirmed=True)
    res = _rpc(name, {**params, "owner_confirm": TOKEN})
    assert res["ok"] is True
    assert asked == [(expected[0], expected[1], TOKEN, expected[2])]
    assert len(portal_writes) == 1


def test_upgrade_mints_a_key_and_binds_the_confirm_to_it(monkeypatch, portal_writes):
    """No key from the app: the route mints one, so a confirm bound to any other key cannot match."""
    asked = _under_icloneos_actions(monkeypatch, confirmed=True)
    res = _rpc("subscription.upgrade", {"subscription_type_id": "tier_pro", "owner_confirm": TOKEN})
    assert res["ok"] is True and asked[0][0] == "subscription-upgrade"
    assert asked[0][3] == res["idempotency_key"] == portal_writes[0][2]


@pytest.mark.parametrize("params", [
    {"enabled": True, "threshold": 10, "top_up_amount": "25", "idempotency_key": "key-ar-01"},
    {"enabled": True, "threshold": "10", "top_up_amount": "2.555", "idempotency_key": "key-ar-01"},
    {"enabled": True, "threshold": "10", "top_up_amount": "25"},
])
def test_auto_reload_on_with_an_unbindable_rule_or_no_key_is_refused(monkeypatch, portal_writes, params):
    asked = _under_icloneos_actions(monkeypatch, confirmed=True)
    res = _rpc("billing.auto_reload", {**params, "owner_confirm": TOKEN})
    assert res["ok"] is False and res["error"] == "owner_confirm"
    assert asked == [] and portal_writes == []


def test_turning_auto_reload_off_and_cancelling_need_no_confirm(monkeypatch, portal_writes):
    asked = _under_icloneos_actions(monkeypatch, confirmed=False)
    assert _rpc("billing.auto_reload", {"enabled": False, "threshold": "10", "top_up_amount": "25"})["ok"] is True
    assert _rpc("subscription.change", {"cancel": True})["ok"] is True
    assert asked == [] and [c[0] for c in portal_writes] == ["auto", "change"]


def test_plain_hermes_billing_writes_are_unchanged(monkeypatch, portal_writes):
    monkeypatch.setattr(policy_env, "locked", lambda: False)
    for name, params, _ in _WRITES:
        assert _rpc(name, params)["ok"] is True
    assert len(portal_writes) == 4


def test_channel_wire_matches_the_shared_fixture(monkeypatch):
    """tests-perf 13: the payload and MAC the runtime sends are byte-for-byte what main's test feeds permVerb
    (electron/iclone-permissions/socket-verb-billing.test.ts reads the same file)."""
    import json
    from pathlib import Path

    fixture = json.loads((Path(__file__).resolve().parents[1] / "fixtures" / "perm_billing_wire.json").read_text())
    channel_mod = policy_env._gate_module("channel")
    ch = channel_mod.Channel("/nonexistent.sock", "/nonexistent.token", bytes.fromhex(fixture["keyHex"]),
                             fixture["keyId"], None)
    ch._pid = fixture["pid"]
    sent: list[tuple] = []

    def request(verb, text, mac, timeout, key_id=None):
        sent.append((verb, text, mac))
        return channel_mod.MainAnswer(code=0, body={"code": 0, "confirmed": True})

    monkeypatch.setattr(ch, "_request", request)
    for case in fixture["cases"]:
        sent.clear()
        if case["action"] == "charge":
            assert ch.billing_confirm(case["ownerConfirm"], case["subject"], case["idempotencyKey"]) is True
        else:
            assert ch.billing_action_confirm(case["action"], case["subject"], case["ownerConfirm"],
                                             case["idempotencyKey"]) is True
        assert sent == [(fixture["verb"], case["text"], case["mac"])]
