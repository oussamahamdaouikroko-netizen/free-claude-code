"""Business logic: doctors, clinics, availability, booking, payments (Parts 2-6).

All functions take a sqlite3 connection and raise ServiceError on business
rule violations. Server-side validation is authoritative — the frontend is
never trusted for availability or pricing.
"""
from __future__ import annotations

import json
import re
import sqlite3
from datetime import datetime, timedelta, timezone

from . import db as dbmod
from . import i18n
from .security import clean_text, normalize_phone, valid_date, valid_phone, valid_time

ACTIVE_STATUSES = ("draft", "pending_payment", "payment_verification",
                   "pending_doctor_approval", "confirmed", "rescheduling_requested")


class ServiceError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _utc_str(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%d %H:%M:%S")


# ------------------------------------------------------------------ doctors
def create_doctor(conn, data: dict, actor: str) -> int:
    full_name = clean_text(data.get("full_name"), 200)
    if not full_name:
        raise ServiceError("full_name is required")
    status = data.get("status", "pending_approval")
    if status not in ("active", "pending_approval", "suspended", "inactive"):
        raise ServiceError("invalid status")
    fee = float(data.get("fee", 0) or 0)
    if fee < 0:
        raise ServiceError("fee must be >= 0")
    cur = conn.execute(
        "INSERT INTO doctors (full_name, specialty, phone, whatsapp_number, email, photo_url, "
        "wilaya, city, address, lat, lng, status, fee, duration_min, payment_policy, auto_confirm, booking_rules) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            full_name,
            clean_text(data.get("specialty"), 200),
            clean_text(data.get("phone"), 40),
            clean_text(data.get("whatsapp_number"), 40),
            clean_text(data.get("email"), 200),
            clean_text(data.get("photo_url"), 500),
            clean_text(data.get("wilaya"), 100),
            clean_text(data.get("city"), 100),
            clean_text(data.get("address"), 500),
            data.get("lat"), data.get("lng"),
            status, fee,
            int(data.get("duration_min", 20) or 20),
            data.get("payment_policy", "baridimob"),
            1 if data.get("auto_confirm") else 0,
            json.dumps(data.get("booking_rules", {}) or {}),
        ),
    )
    conn.commit()
    dbmod.audit(conn, actor, "doctor.create", "doctor", cur.lastrowid, full_name)
    return cur.lastrowid


def update_doctor(conn, doctor_id: int, data: dict, actor: str) -> None:
    allowed = {"full_name", "specialty", "phone", "whatsapp_number", "email", "photo_url",
               "wilaya", "city", "address", "lat", "lng", "status", "fee", "duration_min",
               "payment_policy", "auto_confirm", "booking_rules"}
    fields, values = [], []
    for key, value in data.items():
        if key not in allowed:
            continue
        if key == "booking_rules":
            value = json.dumps(value or {})
        fields.append(f"{key} = ?")
        values.append(value)
    if not fields:
        raise ServiceError("nothing to update")
    values.append(doctor_id)
    conn.execute(f"UPDATE doctors SET {', '.join(fields)}, updated_at = datetime('now') WHERE id = ?", values)
    conn.commit()
    dbmod.audit(conn, actor, "doctor.update", "doctor", doctor_id, ",".join(fields))


def set_doctor_status(conn, doctor_id: int, status: str, actor: str) -> None:
    if status not in ("active", "pending_approval", "suspended", "inactive"):
        raise ServiceError("invalid status")
    conn.execute("UPDATE doctors SET status = ?, updated_at = datetime('now') WHERE id = ?",
                 (status, doctor_id))
    conn.commit()
    dbmod.audit(conn, actor, f"doctor.status.{status}", "doctor", doctor_id)


def search_doctors(conn, query: str = "", specialty: str = "", wilaya: str = "",
                   city: str = "", clinic: str = "", available: str = "") -> list[dict]:
    """Public search — only verified (active) doctors are ever returned."""
    sql = ("SELECT d.*, GROUP_CONCAT(DISTINCT c.name) AS clinic_names "
           "FROM doctors d LEFT JOIN doctor_clinics dc ON dc.doctor_id = d.id "
           "LEFT JOIN clinics c ON c.id = dc.clinic_id WHERE d.status = 'active'")
    params: list = []
    if query:
        sql += " AND d.full_name LIKE ?"
        params.append(f"%{query}%")
    if specialty:
        sql += " AND d.specialty LIKE ?"
        params.append(f"%{specialty}%")
    if wilaya:
        sql += " AND d.wilaya LIKE ?"
        params.append(f"%{wilaya}%")
    if city:
        sql += " AND d.city LIKE ?"
        params.append(f"%{city}%")
    if clinic:
        sql += " AND c.name LIKE ?"
        params.append(f"%{clinic}%")
    sql += " GROUP BY d.id ORDER BY d.full_name"
    rows = conn.execute(sql, params).fetchall()
    return [dict(r) for r in rows]


def get_doctor(conn, doctor_id: int) -> dict | None:
    row = conn.execute("SELECT * FROM doctors WHERE id = ?", (doctor_id,)).fetchone()
    if row is None:
        return None
    out = dict(row)
    out["clinics"] = [dict(r) for r in conn.execute(
        "SELECT c.*, dc.working_days, dc.start_time, dc.end_time, dc.slot_minutes, dc.max_per_day, dc.active AS schedule_active "
        "FROM doctor_clinics dc JOIN clinics c ON c.id = dc.clinic_id WHERE dc.doctor_id = ?",
        (doctor_id,),
    ).fetchall()]
    return out


# ------------------------------------------------------------------ clinics
def create_clinic(conn, data: dict, actor: str) -> int:
    name = clean_text(data.get("name"), 300)
    if not name:
        raise ServiceError("name is required")
    cur = conn.execute(
        "INSERT INTO clinics (name, address, wilaya, city, phone, lat, lng) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (name, clean_text(data.get("address"), 500), clean_text(data.get("wilaya"), 100),
         clean_text(data.get("city"), 100), clean_text(data.get("phone"), 40),
         data.get("lat"), data.get("lng")),
    )
    conn.commit()
    dbmod.audit(conn, actor, "clinic.create", "clinic", cur.lastrowid, name)
    return cur.lastrowid


def link_doctor_clinic(conn, doctor_id: int, clinic_id: int, data: dict, actor: str) -> None:
    if conn.execute("SELECT 1 FROM doctors WHERE id = ?", (doctor_id,)).fetchone() is None:
        raise ServiceError("doctor not found", 404)
    if conn.execute("SELECT 1 FROM clinics WHERE id = ?", (clinic_id,)).fetchone() is None:
        raise ServiceError("clinic not found", 404)
    working_days = clean_text(data.get("working_days", "0,1,2,3,4"), 100)
    start_time = clean_text(data.get("start_time", "09:00"), 10)
    end_time = clean_text(data.get("end_time", "17:00"), 10)
    if not valid_time(start_time) or not valid_time(end_time):
        raise ServiceError("invalid working hours")
    conn.execute(
        "INSERT INTO doctor_clinics (doctor_id, clinic_id, working_days, start_time, end_time, slot_minutes, max_per_day, active) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(doctor_id, clinic_id) DO UPDATE SET "
        "working_days=excluded.working_days, start_time=excluded.start_time, end_time=excluded.end_time, "
        "slot_minutes=excluded.slot_minutes, max_per_day=excluded.max_per_day, active=excluded.active",
        (doctor_id, clinic_id, working_days, start_time, end_time,
         int(data.get("slot_minutes", 20) or 20), int(data.get("max_per_day", 30) or 30),
         1 if data.get("active", True) else 0),
    )
    conn.commit()
    dbmod.audit(conn, actor, "doctor_clinic.link", "doctor", doctor_id, f"clinic {clinic_id}")


# -------------------------------------------------------------- availability
def _slots_for(schedule: sqlite3.Row) -> list[str]:
    start = schedule["start_time"]
    end = schedule["end_time"]
    step = int(schedule["slot_minutes"] or 20)
    sh, sm = map(int, start.split(":"))
    eh, em = map(int, end.split(":"))
    cur = sh * 60 + sm
    limit = eh * 60 + em
    out = []
    while cur + step <= limit:
        out.append(f"{cur // 60:02d}:{cur % 60:02d}")
        cur += step
    return out


def available_slots(conn, doctor_id: int, clinic_id: int | None, date_str: str,
                    lead_hours: int = 2) -> list[str]:
    """Server-side availability. The frontend is never trusted."""
    if not valid_date(date_str):
        raise ServiceError("invalid date")
    target = datetime.fromisoformat(date_str).date()
    weekday = str(target.weekday())  # Mon=0 … Sun=6
    query = ("SELECT * FROM doctor_clinics WHERE doctor_id = ? AND active = 1")
    params: list = [doctor_id]
    if clinic_id:
        query += " AND clinic_id = ?"
        params.append(clinic_id)
    schedules = conn.execute(query, params).fetchall()
    if not schedules:
        return []
    # Blocked dates / holidays.
    blocked = conn.execute(
        "SELECT 1 FROM blocked_dates WHERE doctor_id = ? AND date = ? AND (clinic_id IS NULL OR clinic_id = ?)",
        (doctor_id, date_str, clinic_id or 0),
    ).fetchone()
    if blocked:
        return []
    # Daily capacity.
    used = conn.execute(
        "SELECT COUNT(*) AS n FROM appointments WHERE doctor_id = ? AND date = ? "
        "AND status NOT IN ('cancelled','rejected','expired')",
        (doctor_id, date_str),
    ).fetchone()["n"]
    max_per_day = min(int(s["max_per_day"] or 30) for s in schedules)
    if used >= max_per_day:
        return []
    # Taken slots.
    taken = {r["time"] for r in conn.execute(
        "SELECT time FROM appointments WHERE doctor_id = ? AND date = ? "
        "AND status NOT IN ('cancelled','rejected','expired')",
        (doctor_id, date_str),
    ).fetchall()}
    now = _now_utc()
    slots: set[str] = set()
    for schedule in schedules:
        days = [d.strip() for d in (schedule["working_days"] or "").split(",")]
        if weekday not in days:
            continue
        for slot in _slots_for(schedule):
            if slot in taken:
                continue
            slot_dt = datetime.fromisoformat(f"{date_str}T{slot}:00").replace(tzinfo=timezone.utc)
            if slot_dt < now + timedelta(hours=lead_hours):
                continue
            slots.add(slot)
    return sorted(slots)


# ----------------------------------------------------------------- booking
def next_ref(conn) -> str:
    year = _now_utc().year
    row = conn.execute(
        "SELECT COUNT(*) AS n FROM appointments WHERE ref LIKE ?", (f"MR-{year}-%",)
    ).fetchone()
    return f"MR-{year}-{(row['n'] + 1):06d}"


def create_booking(conn, data: dict, idempotency_key: str | None, cfg) -> dict:
    """Create a booking. Idempotent: same key returns the existing booking."""
    if idempotency_key:
        existing = conn.execute(
            "SELECT * FROM appointments WHERE idempotency_key = ?", (idempotency_key,)
        ).fetchone()
        if existing:
            return {"appointment": dict(existing), "duplicate": True}

    doctor_id = int(data.get("doctor_id") or 0)
    clinic_id = data.get("clinic_id")
    date_str = clean_text(data.get("date"), 10)
    time_str = clean_text(data.get("time"), 10)
    patient_name = clean_text(data.get("patient_name"), 200)
    patient_phone = clean_text(data.get("patient_phone"), 40)
    lang = data.get("lang", "fr") if data.get("lang") in ("fr", "ar") else "fr"

    if not patient_name or not valid_phone(patient_phone):
        raise ServiceError("patient_name and a valid patient_phone are required")
    if not valid_date(date_str) or not valid_time(time_str):
        raise ServiceError("invalid date/time")

    doctor = conn.execute("SELECT * FROM doctors WHERE id = ?", (doctor_id,)).fetchone()
    if doctor is None or doctor["status"] != "active":
        raise ServiceError("doctor not available", 404)

    lead_hours = int(dbmod.get_setting(conn, "booking_lead_hours", str(cfg.booking_lead_hours)))
    slots = available_slots(conn, doctor_id, int(clinic_id) if clinic_id else None, date_str, lead_hours)
    if time_str not in slots:
        raise ServiceError("selected slot is not available", 409)

    # Find or create the patient (guest booking: no account required).
    phone_norm = normalize_phone(patient_phone)
    patient = conn.execute("SELECT * FROM patients WHERE phone_norm = ?", (phone_norm,)).fetchone()
    if patient is None:
        cur = conn.execute(
            "INSERT INTO patients (full_name, phone, phone_norm, lang) VALUES (?, ?, ?, ?)",
            (patient_name, patient_phone, phone_norm, lang),
        )
        patient_id = cur.lastrowid
    else:
        patient_id = patient["id"]

    ref = next_ref(conn)
    fee = float(doctor["fee"] or 0)
    policy = doctor["payment_policy"]
    if fee > 0 and policy == "baridimob":
        status, pay_status = "pending_payment", "awaiting_payment"
    elif fee > 0 and policy == "cash_at_clinic":
        status, pay_status = "pending_doctor_approval", "awaiting_payment"
    else:
        status, pay_status = "pending_doctor_approval", "paid"

    deadline = _utc_str(_now_utc() + timedelta(hours=int(dbmod.get_setting(
        conn, "doctor_response_hours", str(cfg.doctor_response_hours)))))
    try:
        cur = conn.execute(
            "INSERT INTO appointments (ref, idempotency_key, patient_id, patient_name, patient_phone, "
            "doctor_id, clinic_id, date, time, status, payment_status, response_deadline) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (ref, idempotency_key, patient_id, patient_name, patient_phone,
             doctor_id, int(clinic_id) if clinic_id else None, date_str, time_str,
             status, pay_status, deadline),
        )
    except sqlite3.IntegrityError as exc:
        # Unique partial index hit → double booking prevented at DB level.
        raise ServiceError("slot just taken, please choose another time", 409) from exc
    appt_id = cur.lastrowid
    conn.execute(
        "INSERT INTO appointment_events (appointment_id, kind, detail) VALUES (?, 'created', ?)",
        (appt_id, f"status={status} fee={fee}"),
    )
    if fee > 0 and policy == "baridimob":
        recipient = dbmod.get_setting(conn, "baridimob_recipient", "")
        conn.execute(
            "INSERT INTO payments (appointment_id, amount, method, recipient_info, status) "
            "VALUES (?, ?, 'baridimob', ?, 'awaiting_payment')",
            (appt_id, fee, recipient),
        )
    conn.commit()
    appt = conn.execute("SELECT * FROM appointments WHERE id = ?", (appt_id,)).fetchone()
    dbmod.audit(conn, "patient", "booking.create", "appointment", appt_id, ref)
    return {"appointment": dict(appt), "duplicate": False}


def track_booking(conn, ref: str, phone: str) -> dict | None:
    """Track by reference + phone verification (no account needed)."""
    if not valid_phone(phone):
        return None
    phone_norm = normalize_phone(phone)
    appt = conn.execute("SELECT * FROM appointments WHERE ref = ?", (ref,)).fetchone()
    if appt is None or normalize_phone(appt["patient_phone"]) != phone_norm:
        return None
    out = dict(appt)
    out["events"] = [dict(r) for r in conn.execute(
        "SELECT kind, detail, created_at FROM appointment_events WHERE appointment_id = ? ORDER BY id",
        (appt["id"],),
    ).fetchall()]
    out["payment"] = _payment_for(conn, appt["id"])
    return out


def _payment_for(conn, appointment_id: int) -> dict | None:
    row = conn.execute(
        "SELECT * FROM payments WHERE appointment_id = ? ORDER BY id DESC LIMIT 1",
        (appointment_id,),
    ).fetchone()
    return dict(row) if row else None


def cancel_booking(conn, ref: str, phone: str, actor: str) -> dict:
    appt = conn.execute("SELECT * FROM appointments WHERE ref = ?", (ref,)).fetchone()
    if appt is None or normalize_phone(appt["patient_phone"]) != normalize_phone(phone):
        raise ServiceError("booking not found", 404)
    if appt["status"] in ("completed", "cancelled"):
        raise ServiceError("booking cannot be cancelled in its current state", 409)
    conn.execute("UPDATE appointments SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?",
                 (appt["id"],))
    conn.execute(
        "INSERT INTO appointment_events (appointment_id, kind, detail) VALUES (?, 'cancelled', ?)",
        (appt["id"], f"by {actor}"),
    )
    conn.commit()
    dbmod.audit(conn, actor, "booking.cancel", "appointment", appt["id"], ref)
    return {"ref": ref, "status": "cancelled"}


def doctor_respond(conn, doctor_id: int, appointment_id: int, action: str, actor: str) -> dict:
    """Doctor dashboard response (alternative to WhatsApp buttons)."""
    appt = conn.execute("SELECT * FROM appointments WHERE id = ?", (appointment_id,)).fetchone()
    if appt is None:
        raise ServiceError("booking not found", 404)
    if appt["doctor_id"] != doctor_id:
        raise ServiceError("forbidden: not your booking", 403)
    if action not in ("accept", "reject", "reschedule", "complete"):
        raise ServiceError("invalid action")
    mapping = {"accept": "confirmed", "reject": "rejected",
               "reschedule": "rescheduling_requested", "complete": "completed"}
    new_status = mapping[action]
    conn.execute(
        "UPDATE appointments SET status = ?, doctor_response = ?, doctor_responded_at = datetime('now') "
        "WHERE id = ?", (new_status, action, appointment_id),
    )
    conn.execute(
        "INSERT INTO appointment_events (appointment_id, kind, detail) VALUES (?, ?, ?)",
        (appointment_id, f"doctor_{action}", f"by {actor}"),
    )
    conn.commit()
    dbmod.audit(conn, actor, f"doctor.{action}", "appointment", appointment_id)
    return {"id": appointment_id, "status": new_status}


def expire_overdue(conn, actor: str = "system") -> int:
    """Expire bookings whose doctor response deadline has passed."""
    now = _utc_str(_now_utc())
    rows = conn.execute(
        "SELECT * FROM appointments WHERE status = 'pending_doctor_approval' "
        "AND response_deadline IS NOT NULL AND response_deadline < ?",
        (now,),
    ).fetchall()
    for appt in rows:
        conn.execute("UPDATE appointments SET status = 'expired' WHERE id = ?", (appt["id"],))
        conn.execute(
            "INSERT INTO appointment_events (appointment_id, kind, detail) VALUES (?, 'expired', 'response deadline passed')",
            (appt["id"],),
        )
        patient = conn.execute("SELECT lang FROM patients WHERE id = ?", (appt["patient_id"],)).fetchone()
        lang = (patient["lang"] if patient else "fr") or "fr"
        body = i18n.t("booking_expired", lang, ref=appt["ref"], date=appt["date"], time=appt["time"])
        conn.execute(
            "INSERT INTO notifications (appointment_id, channel, recipient, body, status) VALUES (?, 'in_app', ?, ?, 'sent')",
            (appt["id"], appt["patient_phone"], body),
        )
    conn.commit()
    if rows:
        dbmod.audit(conn, actor, "booking.expire_sweep", "appointment", "", f"{len(rows)} expired")
    return len(rows)


# ----------------------------------------------------------------- payments
def submit_payment(conn, ref: str, phone: str, txn_ref: str, receipt_path: str | None,
                   actor: str) -> dict:
    """Patient submits a BaridiMob transaction reference (+ receipt).

    Never marks the payment Paid — only an authorized verifier can do that.
    """
    appt = conn.execute("SELECT * FROM appointments WHERE ref = ?", (ref,)).fetchone()
    if appt is None or normalize_phone(appt["patient_phone"]) != normalize_phone(phone):
        raise ServiceError("booking not found", 404)
    txn_ref = clean_text(txn_ref, 120)
    if not txn_ref:
        raise ServiceError("transaction reference is required")
    payment = _payment_for(conn, appt["id"])
    if payment is None:
        raise ServiceError("no payment expected for this booking", 409)
    if payment["status"] in ("paid",):
        raise ServiceError("payment already verified", 409)
    # Duplicate transaction reference protection (DB unique index + check).
    dup = conn.execute(
        "SELECT id FROM payments WHERE txn_ref = ? AND id != ?", (txn_ref, payment["id"])
    ).fetchone()
    if dup:
        raise ServiceError("duplicate transaction reference", 409)
    try:
        conn.execute(
            "UPDATE payments SET txn_ref = ?, receipt_path = COALESCE(?, receipt_path), "
            "status = 'under_verification', updated_at = datetime('now') WHERE id = ?",
            (txn_ref, receipt_path, payment["id"]),
        )
        conn.execute(
            "UPDATE appointments SET status = 'payment_verification', payment_status = 'under_verification' "
            "WHERE id = ?", (appt["id"],),
        )
        conn.execute(
            "INSERT INTO payment_audit_logs (payment_id, actor, action, detail) VALUES (?, ?, 'submitted', ?)",
            (payment["id"], actor, txn_ref),
        )
        conn.execute(
            "INSERT INTO appointment_events (appointment_id, kind, detail) VALUES (?, 'payment_submitted', ?)",
            (appt["id"], txn_ref),
        )
        conn.commit()
    except sqlite3.IntegrityError as exc:
        raise ServiceError("duplicate transaction reference", 409) from exc
    dbmod.audit(conn, actor, "payment.submit", "payment", payment["id"], txn_ref)
    return {"ref": ref, "payment_status": "under_verification"}


def verify_payment(conn, payment_id: int, decision: str, notes: str, actor: str,
                   verifier_user_id: int) -> dict:
    """Authorized verification: confirm actual receipt of funds, or reject."""
    if decision not in ("paid", "rejected"):
        raise ServiceError("decision must be paid or rejected")
    payment = conn.execute("SELECT * FROM payments WHERE id = ?", (payment_id,)).fetchone()
    if payment is None:
        raise ServiceError("payment not found", 404)
    if payment["status"] == "paid":
        raise ServiceError("payment already verified", 409)
    conn.execute(
        "UPDATE payments SET status = ?, notes = ?, verified_by = ?, verified_at = datetime('now'), "
        "updated_at = datetime('now') WHERE id = ?",
        (decision, clean_text(notes, 1000), verifier_user_id, payment_id),
    )
    conn.execute(
        "INSERT INTO payment_audit_logs (payment_id, actor, action, detail) VALUES (?, ?, ?, ?)",
        (payment_id, actor, decision, clean_text(notes, 1000)),
    )
    appt = conn.execute("SELECT * FROM appointments WHERE id = ?", (payment["appointment_id"],)).fetchone()
    if decision == "paid":
        conn.execute(
            "UPDATE appointments SET payment_status = 'paid', status = 'pending_doctor_approval', "
            "response_deadline = ? WHERE id = ?",
            (_utc_str(_now_utc() + timedelta(hours=24)), appt["id"]),
        )
        conn.execute(
            "INSERT INTO appointment_events (appointment_id, kind, detail) VALUES (?, 'payment_verified', ?)",
            (appt["id"], f"by {actor}"),
        )
        patient = conn.execute("SELECT lang FROM patients WHERE id = ?", (appt["patient_id"],)).fetchone()
        lang = (patient["lang"] if patient else "fr") or "fr"
        body = i18n.t("payment_received", lang, ref=appt["ref"], date=appt["date"], time=appt["time"])
        conn.execute(
            "INSERT INTO notifications (appointment_id, channel, recipient, body, status) VALUES (?, 'in_app', ?, ?, 'sent')",
            (appt["id"], appt["patient_phone"], body),
        )
    else:
        conn.execute(
            "UPDATE appointments SET payment_status = 'rejected', status = 'pending_payment' WHERE id = ?",
            (appt["id"],),
        )
        conn.execute(
            "INSERT INTO appointment_events (appointment_id, kind, detail) VALUES (?, 'payment_rejected', ?)",
            (appt["id"], clean_text(notes, 500)),
        )
        patient = conn.execute("SELECT lang FROM patients WHERE id = ?", (appt["patient_id"],)).fetchone()
        lang = (patient["lang"] if patient else "fr") or "fr"
        body = i18n.t("payment_rejected", lang, ref=appt["ref"], date=appt["date"], time=appt["time"],
                      reason=clean_text(notes, 200) or "—")
        conn.execute(
            "INSERT INTO notifications (appointment_id, channel, recipient, body, status) VALUES (?, 'in_app', ?, ?, 'sent')",
            (appt["id"], appt["patient_phone"], body),
        )
    conn.commit()
    dbmod.audit(conn, actor, f"payment.{decision}", "payment", payment_id, clean_text(notes, 500))
    return {"payment_id": payment_id, "status": decision, "ref": appt["ref"]}


def refund_payment(conn, payment_id: int, notes: str, actor: str) -> dict:
    payment = conn.execute("SELECT * FROM payments WHERE id = ?", (payment_id,)).fetchone()
    if payment is None:
        raise ServiceError("payment not found", 404)
    if payment["status"] != "paid":
        raise ServiceError("only paid payments can be refunded", 409)
    conn.execute("UPDATE payments SET status = 'refunded', notes = ?, updated_at = datetime('now') WHERE id = ?",
                 (clean_text(notes, 1000), payment_id))
    conn.execute(
        "INSERT INTO payment_audit_logs (payment_id, actor, action, detail) VALUES (?, ?, 'refunded', ?)",
        (payment_id, actor, clean_text(notes, 1000)),
    )
    conn.commit()
    dbmod.audit(conn, actor, "payment.refunded", "payment", payment_id)
    return {"payment_id": payment_id, "status": "refunded"}


# --------------------------------------------------------------- analytics
def dashboard_stats(conn) -> dict:
    today = _now_utc().strftime("%Y-%m-%d")
    def count(sql, params=()):
        return conn.execute(sql, params).fetchone()[0]
    stats = {
        "doctors_total": count("SELECT COUNT(*) FROM doctors"),
        "doctors_active": count("SELECT COUNT(*) FROM doctors WHERE status = 'active'"),
        "clinics_total": count("SELECT COUNT(*) FROM clinics"),
        "patients_total": count("SELECT COUNT(*) FROM patients"),
        "bookings_today": count("SELECT COUNT(*) FROM appointments WHERE date(date) = date('now')"),
        "pending_bookings": count("SELECT COUNT(*) FROM appointments WHERE status IN ('pending_payment','payment_verification','pending_doctor_approval')"),
        "confirmed_bookings": count("SELECT COUNT(*) FROM appointments WHERE status = 'confirmed'"),
        "cancelled_bookings": count("SELECT COUNT(*) FROM appointments WHERE status = 'cancelled'"),
        "payments_pending": count("SELECT COUNT(*) FROM payments WHERE status IN ('awaiting_payment','submitted','under_verification')"),
        "payments_verified": count("SELECT COUNT(*) FROM payments WHERE status = 'paid'"),
        "total_collected": count("SELECT COALESCE(SUM(amount),0) FROM payments WHERE status = 'paid'"),
        "whatsapp_connected": count("SELECT COUNT(*) FROM whatsapp_accounts WHERE status = 'connected'"),
        "whatsapp_total": count("SELECT COUNT(*) FROM whatsapp_accounts"),
        "daily_bookings": [dict(r) for r in conn.execute(
            "SELECT date(created_at) AS day, COUNT(*) AS n FROM appointments GROUP BY day ORDER BY day DESC LIMIT 14"
        ).fetchall()],
        "monthly_bookings": [dict(r) for r in conn.execute(
            "SELECT strftime('%Y-%m', created_at) AS month, COUNT(*) AS n FROM appointments GROUP BY month ORDER BY month DESC LIMIT 12"
        ).fetchall()],
        "payment_stats": [dict(r) for r in conn.execute(
            "SELECT status, COUNT(*) AS n, COALESCE(SUM(amount),0) AS total FROM payments GROUP BY status"
        ).fetchall()],
        "top_specialties": [dict(r) for r in conn.execute(
            "SELECT specialty, COUNT(*) AS n FROM appointments a JOIN doctors d ON d.id = a.doctor_id "
            "GROUP BY specialty ORDER BY n DESC LIMIT 8"
        ).fetchall()],
        "by_wilaya": [dict(r) for r in conn.execute(
            "SELECT wilaya, COUNT(*) AS n FROM doctors WHERE status='active' GROUP BY wilaya ORDER BY n DESC LIMIT 10"
        ).fetchall()],
        "recent_activity": [dict(r) for r in conn.execute(
            "SELECT actor, action, entity, entity_id, created_at FROM audit_logs ORDER BY id DESC LIMIT 20"
        ).fetchall()],
    }
    return stats
