"""Environment-based configuration for Medirdv Central (Part 13).

All secrets come from environment variables / .env. Nothing is hardcoded.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, str(default)))
    except ValueError:
        return default


def _env_bool(name: str, default: bool = False) -> bool:
    return os.environ.get(name, str(default)).lower() in ("1", "true", "yes")


@dataclass
class Config:
    host: str = "0.0.0.0"
    port: int = 8080
    data_dir: Path = field(default_factory=lambda: Path("./data"))
    db_path: Path = field(default_factory=lambda: Path("./data/medirdv_central.db"))
    receipts_dir: Path = field(default_factory=lambda: Path("./data/receipts"))
    timezone: str = "Africa/Algiers"
    session_secret: str = ""
    encryption_key: str = ""
    cookie_secure: bool = False
    # cloud = real Meta API | mock = local dev/tests only (logged, never real) | disabled
    whatsapp_mode: str = "mock"
    whatsapp_app_secret: str = ""
    whatsapp_verify_token: str = ""
    meta_graph_version: str = "v21.0"
    meta_graph_base: str = "https://graph.facebook.com"
    doctor_response_hours: int = 24
    booking_lead_hours: int = 2
    currency: str = "DZD"
    bootstrap_admin_email: str = "admin@medirdv.dz"
    bootstrap_admin_password: str = "admin123"

    @classmethod
    def from_env(cls, base_dir: Path | None = None) -> "Config":
        base = base_dir or Path(__file__).resolve().parent.parent
        _load_dotenv(base / ".env")
        data_dir = Path(_env("DATA_DIR", str(base / "data")))
        return cls(
            host=_env("HOST", "0.0.0.0"),
            port=_env_int("PORT", 8080),
            data_dir=data_dir,
            db_path=Path(_env("DB_PATH", str(data_dir / "medirdv_central.db"))),
            receipts_dir=Path(_env("RECEIPTS_DIR", str(data_dir / "receipts"))),
            timezone=_env("TIMEZONE", "Africa/Algiers"),
            session_secret=_env("SESSION_SECRET", "dev-only-insecure-secret-change-me"),
            encryption_key=_env("ENCRYPTION_KEY", "dev-only-insecure-key-change-me"),
            cookie_secure=_env_bool("COOKIE_SECURE", False),
            whatsapp_mode=_env("WHATSAPP_MODE", "mock").lower(),
            whatsapp_app_secret=_env("WHATSAPP_APP_SECRET", ""),
            whatsapp_verify_token=_env("WHATSAPP_VERIFY_TOKEN", "change-me-verify-token"),
            meta_graph_version=_env("META_GRAPH_VERSION", "v21.0"),
            meta_graph_base=_env("META_GRAPH_BASE", "https://graph.facebook.com"),
            doctor_response_hours=_env_int("DOCTOR_RESPONSE_HOURS", 24),
            booking_lead_hours=_env_int("BOOKING_LEAD_HOURS", 2),
            currency=_env("CURRENCY", "DZD"),
            bootstrap_admin_email=_env("BOOTSTRAP_ADMIN_EMAIL", "admin@medirdv.dz"),
            bootstrap_admin_password=_env("BOOTSTRAP_ADMIN_PASSWORD", "admin123"),
        )

    def ensure_dirs(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.receipts_dir.mkdir(parents=True, exist_ok=True)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
