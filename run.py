#!/usr/bin/env python3
"""Medirdv Central entrypoint: python3 run.py"""
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.config import Config
from app.server import create_server


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    cfg = Config.from_env()
    server = create_server(cfg)
    print(f"Medirdv Central running at http://{cfg.host}:{cfg.port}")
    print(f"WhatsApp mode: {cfg.whatsapp_mode} (mock = local dev only, never a real delivery)")
    print("Default admin: admin@medirdv.dz / admin123 — change immediately in production!")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down…")


if __name__ == "__main__":
    main()
