"""A JWKS endpoint that redirects (v0.0.4 deps r4, F1).

PyJWT >= 2.14 refuses redirects when ``PyJWKClient`` fetches a JWKS; that protection is kept. Both app callers
(the self-hosted OIDC dashboard provider and the Chronos cron-fire verifier) resolve the ``jwks_uri`` first, by the
OIDC discovery redirect rule (``_shared.require_same_origin``), and build ``PyJWKClient`` on the final URL.

Real loopback HTTP servers, real httpx and real PyJWT: a redirect on the jwks_uri's own origin verifies, a redirect
to another origin fails closed with the rule's own refusal.
"""

from __future__ import annotations

import http.server
import json
import logging
import threading
import time

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from jwt.algorithms import RSAAlgorithm

from hermes_cli.dashboard_auth import ProviderError
from plugins.cron_providers.chronos import verify as chronos_verify
from plugins.dashboard_auth import _shared as shared
from plugins.dashboard_auth import self_hosted as oidc_plugin

CLIENT_ID = "hermes-dashboard"
FIRE_AUDIENCE = "hermes-cron"
REDIRECTS = [301, 302, 307, 308]
REFUSED = "outside the jwks_uri's origin"


@pytest.fixture(scope="module")
def key():
    private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    jwk = json.loads(RSAAlgorithm.to_jwk(private.public_key()))
    jwk.update({"kid": "k1", "alg": "RS256", "use": "sig"})
    return private, json.dumps({"keys": [jwk]}).encode()


class _Server:
    """A loopback HTTP server answering ``routes[path] = (status, headers, body)``; counts the hits per path."""

    def __init__(self) -> None:
        self.routes: dict[str, tuple[int, dict, bytes]] = {}
        self.hits: dict[str, int] = {}
        server = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802 (http.server API)
                server.hits[self.path] = server.hits.get(self.path, 0) + 1
                status, headers, body = server.routes.get(self.path, (404, {}, b""))
                self.send_response(status)
                for name, value in headers.items():
                    self.send_header(name, value)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.origin = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


@pytest.fixture
def servers():
    made: list[_Server] = []

    def make() -> _Server:
        made.append(_Server())
        return made[-1]

    yield make
    for server in made:
        server.close()


def _jwks_redirect(idp: _Server, status: int, target: str, keys: bytes) -> None:
    idp.routes["/jwks"] = (status, {"Location": target}, b"")
    idp.routes["/keys"] = (200, {"Content-Type": "application/json"}, keys)


# ---- self-hosted OIDC dashboard provider ----------------------------------------------------------------------


def _oidc_provider(idp: _Server):
    idp.routes["/.well-known/openid-configuration"] = (
        200,
        {"Content-Type": "application/json"},
        json.dumps({
            "issuer": idp.origin,
            "authorization_endpoint": f"{idp.origin}/authorize",
            "token_endpoint": f"{idp.origin}/token",
            "jwks_uri": f"{idp.origin}/jwks",
        }).encode(),
    )
    return oidc_plugin.SelfHostedOIDCProvider(issuer=idp.origin, client_id=CLIENT_ID)


def _id_token(private, issuer: str) -> str:
    now = int(time.time())
    claims = {
        "iss": issuer,
        "aud": CLIENT_ID,
        "sub": "user-1",
        "email": "user@example.test",
        "iat": now,
        "exp": now + 300,
    }
    return jwt.encode(claims, private, algorithm="RS256", headers={"kid": "k1"})


@pytest.mark.parametrize("status", REDIRECTS)
def test_dashboard_login_verifies_through_a_same_origin_jwks_redirect(
    servers, key, status
):
    private, keys = key
    idp = servers()
    _jwks_redirect(idp, status, f"{idp.origin}/keys", keys)
    provider = _oidc_provider(idp)

    session = provider.verify_session(access_token=_id_token(private, idp.origin))
    again = provider.verify_session(access_token=_id_token(private, idp.origin))

    assert session is not None and session.user_id == "user-1"
    assert again is not None
    # Resolved once and cached (like discovery): the second verification does not resolve again.
    assert idp.hits["/jwks"] == 1


def test_dashboard_login_refuses_a_jwks_redirect_to_another_origin(servers, key):
    private, keys = key
    idp, foreign = servers(), servers()
    foreign.routes["/keys"] = (
        200,
        {"Content-Type": "application/json"},
        keys,
    )  # valid keys, wrong place
    idp.routes["/jwks"] = (302, {"Location": f"{foreign.origin}/keys"}, b"")
    provider = _oidc_provider(idp)

    with pytest.raises(ProviderError, match=REFUSED):
        provider.verify_session(access_token=_id_token(private, idp.origin))


def test_a_cleartext_jwks_landing_is_refused(monkeypatch):
    """https -> http is another origin (the scheme is part of it): refused like a discovery downgrade."""

    def landed_on_cleartext(method, url, **kwargs):
        assert kwargs["follow_redirects"] is True
        return httpx.Response(
            200,
            content=b'{"keys": []}',
            request=httpx.Request(method, "http://idp.example/keys"),
        )

    monkeypatch.setattr(shared, "_request_limited_response", landed_on_cleartext)
    with pytest.raises(ProviderError, match=REFUSED):
        shared.resolve_jwks_url("https://idp.example/jwks")


def test_an_opaque_bearer_is_not_ours_before_any_jwks_request(servers):
    """#94558 stays true: a non-JWT bearer is an InvalidCodeError (None), even with the JWKS unreachable."""
    idp = servers()
    provider = _oidc_provider(
        idp
    )  # /jwks answers 404: resolving it would be a ProviderError
    assert provider.verify_session(access_token="not-a-jwt-peer-key") is None
    assert "/jwks" not in idp.hits


# ---- Chronos cron-fire verifier -------------------------------------------------------------------------------


def _fire_token(private) -> str:
    now = int(time.time())
    claims = {
        "aud": FIRE_AUDIENCE,
        "purpose": "cron_fire",
        "iat": now,
        "exp": now + 300,
    }
    return jwt.encode(claims, private, algorithm="RS256", headers={"kid": "k1"})


@pytest.fixture
def no_cached_clients(monkeypatch):
    monkeypatch.setattr(chronos_verify, "_JWK_CLIENTS", {})


@pytest.mark.parametrize("status", REDIRECTS)
def test_cron_fire_verifies_through_a_same_origin_jwks_redirect(
    servers, key, no_cached_clients, status
):
    private, keys = key
    nas = servers()
    _jwks_redirect(nas, status, f"{nas.origin}/keys", keys)

    claims = chronos_verify.verify_nas_fire_token(
        token=_fire_token(private),
        expected_audience=FIRE_AUDIENCE,
        jwks_or_key=f"{nas.origin}/jwks",
    )

    assert claims is not None and claims["purpose"] == "cron_fire"


def test_cron_fire_refuses_a_jwks_redirect_to_another_origin(
    servers, key, no_cached_clients, caplog
):
    private, keys = key
    nas, foreign = servers(), servers()
    foreign.routes["/keys"] = (200, {"Content-Type": "application/json"}, keys)
    nas.routes["/jwks"] = (302, {"Location": f"{foreign.origin}/keys"}, b"")

    with caplog.at_level(logging.WARNING, logger="cron.chronos.verify"):
        claims = chronos_verify.verify_nas_fire_token(
            token=_fire_token(private),
            expected_audience=FIRE_AUDIENCE,
            jwks_or_key=f"{nas.origin}/jwks",
        )

    assert claims is None
    # Refused by the discovery rule, not by a transport failure.
    assert REFUSED in caplog.text
