"""Security primitives (Part 10): hashing, tokens, encryption, validation.

- Passwords: PBKDF2-HMAC-SHA256, 200k iterations, per-password salt.
- Sessions: random tokens, only the SHA-256 hash is stored.
- WhatsApp tokens at rest: HMAC-CTR stream cipher with integrity tag,
  keyed from ENCRYPTION_KEY. For production, prefer a KMS (AWS KMS /
  HSM) — see docs/SECURITY.md. This stdlib implementation avoids any
  pip dependency while still encrypting at rest.
- Rate limiting: simple in-memory per-IP token bucket.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import re
import secrets
import time
from collections import defaultdict

PBKDF2_ROUNDS = 200_000
_PHONE_RE = re.compile(r"^\+?[0-9\s\-()]{8,20}$")
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_REF_RE = re.compile(r"^MR-\d{4}-\d{6}$")


# ---------------------------------------------------------------- passwords
def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PBKDF2_ROUNDS)
    return f"pbkdf2_sha256${PBKDF2_ROUNDS}${base64.b64encode(salt).decode()}${base64.b64encode(dk).decode()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, rounds, salt_b64, dk_b64 = stored.split("$", 3)
        if algo != "pbkdf2_sha256":
            return False
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(dk_b64)
        dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, int(rounds))
        return hmac.compare_digest(dk, expected)
    except Exception:
        return False


# ---------------------------------------------------------------- sessions
def new_session_token() -> tuple[str, str]:
    """Return (raw_token, token_hash). Only the hash is stored."""
    raw = secrets.token_urlsafe(32)
    return raw, hashlib.sha256(raw.encode()).hexdigest()


def hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


# ------------------------------------------------------- encryption at rest
def _keystream(key: bytes, nonce: bytes, length: int) -> bytes:
    out = bytearray()
    counter = 0
    while len(out) < length:
        out.extend(hmac.new(key, nonce + counter.to_bytes(4, "big"), hashlib.sha256).digest())
        counter += 1
    return bytes(out[:length])


def encrypt_text(plaintext: str, master_key: str) -> str:
    key = hashlib.sha256(master_key.encode()).digest()
    nonce = secrets.token_bytes(16)
    data = plaintext.encode()
    cipher = bytes(b ^ k for b, k in zip(data, _keystream(key, nonce, len(data))))
    tag = hmac.new(key, nonce + cipher, hashlib.sha256).digest()[:16]
    return base64.b64encode(nonce + tag + cipher).decode()


def decrypt_text(blob: str, master_key: str) -> str:
    key = hashlib.sha256(master_key.encode()).digest()
    raw = base64.b64decode(blob)
    nonce, tag, cipher = raw[:16], raw[16:32], raw[32:]
    expected = hmac.new(key, nonce + cipher, hashlib.sha256).digest()[:16]
    if not hmac.compare_digest(tag, expected):
        raise ValueError("decryption failed: integrity check")
    plain = bytes(c ^ k for c, k in zip(cipher, _keystream(key, nonce, len(cipher))))
    return plain.decode()


# ---------------------------------------------------------------- validation
def valid_email(email: str) -> bool:
    return bool(_EMAIL_RE.match(email or ""))


def valid_phone(phone: str) -> bool:
    return bool(_PHONE_RE.match(phone or ""))


def normalize_phone(phone: str) -> str:
    digits = re.sub(r"\D", "", phone or "")
    if digits.startswith("00"):
        digits = digits[2:]
    if digits.startswith("0") and len(digits) == 10:
        digits = "213" + digits[1:]
    if len(digits) == 9:
        digits = "213" + digits
    return digits


def valid_ref(ref: str) -> bool:
    return bool(_REF_RE.match(ref or ""))


def clean_text(value: object, max_len: int = 500) -> str:
    return str(value or "").strip()[:max_len]


def valid_date(value: str) -> bool:
    try:
        from datetime import date

        date.fromisoformat(value or "")
        return True
    except ValueError:
        return False


def valid_time(value: str) -> bool:
    return bool(re.match(r"^([01]\d|2[0-3]):[0-5]\d$", value or ""))


# ------------------------------------------------------------- rate limiting
class RateLimiter:
    """In-memory per-key token bucket. Good enough for a single process;
    behind a reverse proxy, also enforce limits at the proxy layer."""

    def __init__(self, capacity: int = 120, refill_per_minute: int = 120):
        self.capacity = capacity
        self.refill_per_minute = refill_per_minute
        self._buckets: dict[str, tuple[float, float]] = defaultdict(lambda: (float(capacity), time.time()))

    def allow(self, key: str) -> bool:
        now = time.time()
        tokens, updated = self._buckets[key]
        refill = (now - updated) * (self.refill_per_minute / 60.0)
        tokens = min(self.capacity, tokens + refill)
        if tokens < 1:
            self._buckets[key] = (tokens, now)
            return False
        self._buckets[key] = (tokens - 1, now)
        return True


def verify_webhook_signature(app_secret: str, raw_body: bytes, signature_header: str) -> bool:
    """Verify Meta's X-Hub-Signature-256 (HMAC-SHA256 over raw body)."""
    if not app_secret or not signature_header:
        return False
    expected = "sha256=" + hmac.new(app_secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature_header.strip())
