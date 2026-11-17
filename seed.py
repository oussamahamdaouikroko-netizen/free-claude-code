#!/usr/bin/env python3
"""Seed demo data (clearly labeled DEMO — never use in production).

Usage: python3 seed.py
Creates 2 demo doctors, 2 clinics, schedules and a demo doctor account.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.config import Config
from app.db import connect, migrate
from app.security import hash_password
from app.server import bootstrap


def main() -> None:
    cfg = Config.from_env()
    cfg.ensure_dirs()
    conn = connect(cfg.db_path)
    migrate(conn)
    bootstrap(conn, cfg)

    # Demo doctor account
    conn.execute(
        "INSERT OR IGNORE INTO users (email, password_hash, role, full_name) VALUES (?, ?, 'doctor', ?)",
        ("doctor@medirdv.dz", hash_password("doctor123"), "Dr. Demo (demo)"),
    )
    conn.commit()
    user = conn.execute("SELECT id FROM users WHERE email = 'doctor@medirdv.dz'").fetchone()

    clinics = []
    for name, wilaya, city in [("Clinique Demo Alger", "Alger", "Alger"),
                               ("Clinique Demo Oran", "Oran", "Oran")]:
        cur = conn.execute(
            "INSERT INTO clinics (name, address, wilaya, city) VALUES (?, ?, ?, ?)",
            (name, "Rue Demo 1", wilaya, city),
        )
        clinics.append(cur.lastrowid)
    conn.commit()

    doctors = [
        ("Dr. Amina Benali (demo)", "Médecine générale", "Alger", "Alger", 2000, user["id"]),
        ("Dr. Yacine Mansouri (demo)", "Dentaire", "Oran", "Oran", 3000, None),
    ]
    for full_name, specialty, wilaya, city, fee, user_id in doctors:
        cur = conn.execute(
            "INSERT INTO doctors (full_name, specialty, wilaya, city, fee, status, user_id, whatsapp_number) "
            "VALUES (?, ?, ?, ?, ?, 'active', ?, ?)",
            (full_name, specialty, wilaya, city, fee, user_id, "+213550000001"),
        )
        did = cur.lastrowid
        conn.execute(
            "INSERT INTO doctor_clinics (doctor_id, clinic_id, working_days, start_time, end_time, slot_minutes, max_per_day) "
            "VALUES (?, ?, '0,1,2,3,4,5', '09:00', '17:00', 20, 30)",
            (did, clinics[0] if wilaya == "Alger" else clinics[1]),
        )
        conn.commit()
        print(f"Seeded doctor {did}: {full_name} ({specialty}, {wilaya})")
    print("Demo seed complete. Doctor login: doctor@medirdv.dz / doctor123")


if __name__ == "__main__":
    main()
