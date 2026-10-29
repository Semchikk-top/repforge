"""Каноничный JSON, ключи и подписи: байт в байт то же, что src/social/crypto.ts.

Клиент подписывает canonicalJson(объект без sig): ключи по алфавиту, без пробелов, строки как JSON.stringify.
Ed25519 проверяется напрямую, ECDSA P-256 приходит в формате WebCrypto (r||s, 64 байта) и переводится в DER.
"""
from __future__ import annotations

import base64
import hashlib
import json
import re
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature

PUBLIC_KEY_RE = re.compile(r"^(ed25519|p256):[A-Za-z0-9_-]{40,120}$")
PROFILE_ID_RE = re.compile(r"^p_[A-Za-z0-9_-]{22}$")


def canonical_json(v: Any) -> str:
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        # JS печатает 12.0 как «12»; числа в снимках округлены и далеки от экспоненциальной записи
        return str(int(v)) if v.is_integer() and abs(v) < 1e15 else json.dumps(v)
    if isinstance(v, str):
        return json.dumps(v, ensure_ascii=False)
    if isinstance(v, list):
        return "[" + ",".join(canonical_json(x) for x in v) + "]"
    if isinstance(v, dict):
        return "{" + ",".join(json.dumps(k, ensure_ascii=False) + ":" + canonical_json(v[k]) for k in sorted(v)) + "}"
    raise TypeError(f"не JSON: {type(v)}")


def b64u_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def b64u_encode(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def profile_id_for(public_key: str) -> str:
    """Личность выводится из ключа (как profileIdFor на клиенте): чужой profileId без ключа не присвоить."""
    return "p_" + b64u_encode(hashlib.sha256(("profile|" + public_key).encode()).digest())[:22]


def _split_key(public_key: str) -> tuple[str, bytes] | None:
    if not isinstance(public_key, str) or not PUBLIC_KEY_RE.match(public_key):
        return None
    alg, body = public_key.split(":", 1)
    try:
        raw = b64u_decode(body)
    except Exception:
        return None
    if (alg == "ed25519" and len(raw) == 32) or (alg == "p256" and len(raw) == 65):
        return alg, raw
    return None


def key_is_valid(public_key: str) -> bool:
    k = _split_key(public_key)
    if not k:
        return False
    try:
        if k[0] == "ed25519":
            Ed25519PublicKey.from_public_bytes(k[1])
        else:
            ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), k[1])
        return True
    except Exception:
        return False


def verify(public_key: str, text: str, sig: str) -> bool:
    k = _split_key(public_key)
    if not k or not isinstance(sig, str) or len(sig) > 200:
        return False
    try:
        raw_sig = b64u_decode(sig)
        data = text.encode("utf-8")
        if k[0] == "ed25519":
            Ed25519PublicKey.from_public_bytes(k[1]).verify(raw_sig, data)
        else:
            if len(raw_sig) != 64:
                return False
            der = encode_dss_signature(int.from_bytes(raw_sig[:32], "big"), int.from_bytes(raw_sig[32:], "big"))
            ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), k[1]).verify(der, data, ec.ECDSA(hashes.SHA256()))
        return True
    except (InvalidSignature, ValueError, TypeError):
        return False


def verify_object(public_key: str, obj: dict) -> bool:
    """Подпись считается по объекту без поля sig, включая неизвестные поля (как на клиенте)."""
    sig = obj.get("sig")
    rest = {k: v for k, v in obj.items() if k != "sig"}
    return verify(public_key, canonical_json(rest), sig)
