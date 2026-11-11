"""A stand-in shaped like a real ChatGPT OAuth access token: issued by OpenAI, with its auth claim.

Hermes routes a Codex credential to chatgpt.com only when it reads as ChatGPT's own, so a test that plays a
ChatGPT login needs this shape. The signature is never verified client-side.
"""

import base64
import json


def chatgpt_jwt(subject: str = "user", *, with_account: bool = True) -> str:
    def part(payload: dict) -> str:
        return base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=").decode()

    claims = {"iss": "https://auth.openai.com", "sub": subject}
    if with_account:
        claims["https://api.openai.com/auth"] = {"chatgpt_account_id": subject}
    return f"{part({'alg': 'RS256'})}.{part(claims)}.sig"
