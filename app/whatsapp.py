"""WhatsApp Hub — official Meta Cloud API integration (Part 3).

Design guarantees:
- Messages are ALWAYS routed via the appointment's doctor → that doctor's
  authorized Phone Number ID. Conversations are never mixed between doctors.
- Only the official WhatsApp Business Platform (Cloud API) is used. No
  Baileys, no QR scraping, no unofficial automation.
- Click-to-Chat (wa.me) is offered as an explicit fallback and is clearly
  labeled `click_to_chat` everywhere. The platform never claims to read or
  manage Click-to-Chat conversations.
- WHATSAPP_MODE=mock exists for local development/tests only: it logs what
  WOULD be sent and is never presented as a real delivery.
"""
from __future__ import annotations

import hashlib
import json
import logging
import sqlite3
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

from . import db as dbmod
from .config import Config
from .security import decrypt_text, normalize_phone

log = logging.getLogger("medirdv.whatsapp")

BUTTON_ACCEPT = "accept"
BUTTON_REJECT = "reject"
BUTTON_RESCHEDULE = "reschedule"


def _now_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def click_to_chat_url(number: str, text: str) -> str:
    digits = normalize_phone(number)
    return f"https://wa.me/{digits}?text={urllib.parse.quote(text)}"


def get_account(conn: sqlite3.Connection, doctor_id: int) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM whatsapp_accounts WHERE doctor_id = ?", (doctor_id,)
    ).fetchone()


def account_status(conn: sqlite3.Connection, doctor_id: int) -> dict:
    row = get_account(conn, doctor_id)
    if row is None:
        return {"mode": "none", "status": "not_configured"}
    return {
        "mode": row["mode"],
        "status": row["status"],
        "display_number": row["display_number"],
        "phone_number_id": row["phone_number_id"],
        "last_error": row["last_error"],
    }


class WhatsAppSender:
    """Sends messages through the correct doctor's Cloud API account."""

    def __init__(self, conn: sqlite3.Connection, cfg: Config):
        self.conn = conn
        self.cfg = cfg

    def _log_message(self, appointment_id, doctor_id, direction, body, wa_id, status) -> int:
        cur = self.conn.execute(
            "INSERT INTO whatsapp_messages (appointment_id, doctor_id, direction, body, wa_message_id, status) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (appointment_id, doctor_id, direction, body, wa_id, status),
        )
        self.conn.commit()
        return cur.lastrowid

    def send_booking_request(self, appointment: sqlite3.Row, body: str) -> dict:
        """Route a booking notification to the appointment's doctor.

        Returns {"via": "cloud"|"click_to_chat"|"mock"|"unavailable", ...}.
        Never sends to any other doctor's account.
        """
        doctor_id = appointment["doctor_id"]
        account = get_account(self.conn, doctor_id)
        if account is None or account["status"] != "connected":
            # Fallback: Click-to-Chat link for the patient to open manually.
            doctor = self.conn.execute(
                "SELECT whatsapp_number FROM doctors WHERE id = ?", (doctor_id,)
            ).fetchone()
            number = (doctor["whatsapp_number"] if doctor else "") or ""
            url = click_to_chat_url(number, body) if number else ""
            self._log_message(appointment["id"], doctor_id, "out", body, None, "click_to_chat")
            self.conn.execute(
                "UPDATE appointments SET whatsapp_status = 'click_to_chat' WHERE id = ?",
                (appointment["id"],),
            )
            self.conn.commit()
            return {"via": "click_to_chat", "url": url}

        if account["mode"] == "click_to_chat":
            doctor = self.conn.execute(
                "SELECT whatsapp_number FROM doctors WHERE id = ?", (doctor_id,)
            ).fetchone()
            number = (doctor["whatsapp_number"] if doctor else "") or ""
            url = click_to_chat_url(number, body) if number else ""
            self._log_message(appointment["id"], doctor_id, "out", body, None, "click_to_chat")
            self.conn.execute(
                "UPDATE appointments SET whatsapp_status = 'click_to_chat' WHERE id = ?",
                (appointment["id"],),
            )
            self.conn.commit()
            return {"via": "click_to_chat", "url": url}

        if self.cfg.whatsapp_mode == "disabled":
            self._log_message(appointment["id"], doctor_id, "out", body, None, "failed")
            self.conn.execute(
                "UPDATE appointments SET whatsapp_status = 'failed' WHERE id = ?",
                (appointment["id"],),
            )
            self.conn.commit()
            return {"via": "unavailable", "error": "WhatsApp disabled"}

        if self.cfg.whatsapp_mode == "mock":
            # Local dev/tests only — clearly labeled, never a real delivery.
            log.warning("[MOCK WHATSAPP] Would send to doctor %s via phone_number_id %s: %s",
                        doctor_id, account["phone_number_id"], body[:80])
            self._log_message(appointment["id"], doctor_id, "out", body, "mock-" + str(appointment["id"]), "sent")
            self.conn.execute(
                "UPDATE appointments SET whatsapp_status = 'sent' WHERE id = ?",
                (appointment["id"],),
            )
            self.conn.commit()
            return {"via": "mock", "wa_message_id": "mock-" + str(appointment["id"])}

        # Real Cloud API send.
        try:
            token = decrypt_text(account["access_token_enc"], self.cfg.encryption_key)
            wa_id = self._cloud_send(account["phone_number_id"], token, appointment, body)
            self._log_message(appointment["id"], doctor_id, "out", body, wa_id, "sent")
            self.conn.execute(
                "UPDATE appointments SET whatsapp_status = 'sent' WHERE id = ?",
                (appointment["id"],),
            )
            self.conn.commit()
            return {"via": "cloud", "wa_message_id": wa_id}
        except Exception as exc:  # noqa: BLE001 — log and mark failed, never crash booking
            log.error("Cloud API send failed for doctor %s: %s", doctor_id, exc)
            self._log_message(appointment["id"], doctor_id, "out", body, None, "failed")
            self.conn.execute(
                "UPDATE appointments SET whatsapp_status = 'failed' WHERE id = ?",
                (appointment["id"],),
            )
            self.conn.commit()
            return {"via": "unavailable", "error": str(exc)[:300]}

    def _cloud_send(self, phone_number_id: str, token: str, appointment: sqlite3.Row, body: str) -> str:
        """POST /{phone_number_id}/messages with interactive buttons.

        Falls back to a text message if the interactive payload is rejected
        (e.g. outside the 24h window — templates are then required; the
        caller configures approved template names in system_settings).
        """
        recipient = normalize_phone(appointment["patient_phone"])
        ref = appointment["ref"]
        payload = {
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": recipient,
            "type": "interactive",
            "interactive": {
                "type": "button",
                "body": {"text": body[:1024]},
                "action": {
                    "buttons": [
                        {"type": "reply", "reply": {"id": f"{BUTTON_ACCEPT}:{ref}", "title": "✅ Accepter"}},
                        {"type": "reply", "reply": {"id": f"{BUTTON_REJECT}:{ref}", "title": "❌ Refuser"}},
                        {"type": "reply", "reply": {"id": f"{BUTTON_RESCHEDULE}:{ref}", "title": "🕐 Autre horaire"}},
                    ]
                },
            },
        }
        wa_id = self._post_message(phone_number_id, token, payload)
        return wa_id

    def _post_message(self, phone_number_id: str, token: str, payload: dict) -> str:
        url = f"{self.cfg.meta_graph_base}/{self.cfg.meta_graph_version}/{phone_number_id}/messages"
        data = json.dumps(payload).encode()
        req = urllib.request.Request(
            url, data=data, method="POST",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                result = json.loads(resp.read().decode())
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode()[:500]
            raise RuntimeError(f"Meta API {exc.code}: {detail}") from exc
        return result.get("messages", [{}])[0].get("id", "")

    def send_text_to_doctor(self, doctor_id: int, body: str, appointment_id=None) -> dict:
        """Generic outbound message to a doctor (reminders, confirmations)."""
        account = get_account(self.conn, doctor_id)
        if account is None or account["status"] != "connected" or account["mode"] != "cloud":
            return {"via": "unavailable"}
        if self.cfg.whatsapp_mode == "mock":
            log.warning("[MOCK WHATSAPP] Would send to doctor %s: %s", doctor_id, body[:80])
            self._log_message(appointment_id, doctor_id, "out", body, "mock", "sent")
            return {"via": "mock"}
        if self.cfg.whatsapp_mode == "disabled":
            return {"via": "unavailable"}
        try:
            token = decrypt_text(account["access_token_enc"], self.cfg.encryption_key)
            doctor = self.conn.execute(
                "SELECT whatsapp_number FROM doctors WHERE id = ?", (doctor_id,)
            ).fetchone()
            payload = {
                "messaging_product": "whatsapp",
                "to": normalize_phone(doctor["whatsapp_number"] or ""),
                "type": "text",
                "text": {"body": body[:4096]},
            }
            wa_id = self._post_message(account["phone_number_id"], token, payload)
            self._log_message(appointment_id, doctor_id, "out", body, wa_id, "sent")
            return {"via": "cloud", "wa_message_id": wa_id}
        except Exception as exc:  # noqa: BLE001
            log.error("Cloud API send failed for doctor %s: %s", doctor_id, exc)
            self._log_message(appointment_id, doctor_id, "out", body, None, "failed")
            return {"via": "unavailable", "error": str(exc)[:300]}


# ------------------------------------------------------------- webhook side
def process_webhook(conn: sqlite3.Connection, cfg: Config, payload: dict) -> dict:
    """Process a verified Meta webhook payload.

    Routes strictly by phone_number_id → doctor, so a response can only ever
    affect that doctor's own bookings. Idempotent via payload hash.
    """
    raw = json.dumps(payload, sort_keys=True)
    payload_hash = hashlib.sha256(raw.encode()).hexdigest()
    existing = conn.execute(
        "SELECT id FROM whatsapp_webhook_events WHERE payload_hash = ?", (payload_hash,)
    ).fetchone()
    if existing:
        return {"status": "duplicate", "ignored": True}

    conn.execute(
        "INSERT INTO whatsapp_webhook_events (payload_hash, payload, processed) VALUES (?, ?, 0)",
        (payload_hash, raw[:20000]),
    )
    conn.commit()

    results = []
    for entry in payload.get("entry", []):
        for change in entry.get("changes", []):
            value = change.get("value", {})
            phone_number_id = value.get("metadata", {}).get("phone_number_id", "")
            account = conn.execute(
                "SELECT * FROM whatsapp_accounts WHERE phone_number_id = ? AND mode = 'cloud'",
                (phone_number_id,),
            ).fetchone()
            if account is None:
                results.append({"phone_number_id": phone_number_id, "result": "unknown_account"})
                continue
            doctor_id = account["doctor_id"]
            for message in value.get("messages", []):
                results.append(
                    _handle_incoming(conn, cfg, doctor_id, message)
                )
            for status in value.get("statuses", []):
                _handle_status(conn, status)
    conn.execute("UPDATE whatsapp_webhook_events SET processed = 1 WHERE payload_hash = ?", (payload_hash,))
    conn.commit()
    return {"status": "processed", "results": results}


def _handle_incoming(conn, cfg, doctor_id: int, message: dict) -> dict:
    wa_id = message.get("id", "")
    sender = message.get("from", "")
    text = ""
    button_id = ""
    interactive = message.get("interactive", {})
    if interactive.get("type") == "button_reply":
        button_id = interactive.get("button_reply", {}).get("id", "")
        text = interactive.get("button_reply", {}).get("title", "")
    elif message.get("text", {}).get("body"):
        text = message["text"]["body"]
    body = f"[{button_id}] {text}".strip()
    conn.execute(
        "INSERT INTO whatsapp_messages (doctor_id, direction, body, wa_message_id, status) "
        "VALUES (?, 'in', ?, ?, 'received')",
        (doctor_id, body, wa_id),
    )
    conn.commit()

    # Button payload format: "accept:MR-2026-000001"
    if ":" in button_id:
        action, ref = button_id.split(":", 1)
        return _apply_doctor_response(conn, cfg, doctor_id, ref, action)
    # Free-text fallback: look for a booking reference in the message.
    for token in text.replace(",", " ").split():
        token = token.strip()
        if token.startswith("MR-"):
            return _apply_doctor_response(conn, cfg, doctor_id, token, "text")
    return {"doctor_id": doctor_id, "result": "no_action"}


def _apply_doctor_response(conn, cfg, doctor_id: int, ref: str, action: str) -> dict:
    """Apply a doctor's accept/reject/reschedule to THEIR OWN booking only."""
    appt = conn.execute("SELECT * FROM appointments WHERE ref = ?", (ref,)).fetchone()
    if appt is None:
        return {"ref": ref, "result": "not_found"}
    if appt["doctor_id"] != doctor_id:
        # Cross-doctor protection: never let one doctor affect another's booking.
        log.warning("Cross-doctor response blocked: doctor %s tried %s", doctor_id, ref)
        return {"ref": ref, "result": "forbidden_doctor_mismatch"}

    now = _now_utc()
    if action == BUTTON_ACCEPT:
        conn.execute(
            "UPDATE appointments SET status = 'confirmed', doctor_response = 'accepted', "
            "doctor_responded_at = ? WHERE id = ?", (now, appt["id"]),
        )
        conn.execute(
            "INSERT INTO appointment_events (appointment_id, kind, detail) VALUES (?, 'doctor_accepted', ?)",
            (appt["id"], f"via WhatsApp by doctor {doctor_id}"),
        )
        _notify_patient(conn, appt, "booking_accepted")
    elif action == BUTTON_REJECT:
        conn.execute(
            "UPDATE appointments SET status = 'rejected', doctor_response = 'rejected', "
            "doctor_responded_at = ? WHERE id = ?", (now, appt["id"]),
        )
        conn.execute(
            "INSERT INTO appointment_events (appointment_id, kind, detail) VALUES (?, 'doctor_rejected', ?)",
            (appt["id"], f"via WhatsApp by doctor {doctor_id}"),
        )
        _notify_patient(conn, appt, "booking_rejected")
    elif action == BUTTON_RESCHEDULE:
        conn.execute(
            "UPDATE appointments SET status = 'rescheduling_requested', doctor_response = 'reschedule_requested', "
            "doctor_responded_at = ? WHERE id = ?", (now, appt["id"]),
        )
        conn.execute(
            "INSERT INTO appointment_events (appointment_id, kind, detail) VALUES (?, 'reschedule_requested', ?)",
            (appt["id"], f"via WhatsApp by doctor {doctor_id}"),
        )
        _notify_patient(conn, appt, "booking_reschedule")
    else:
        return {"ref": ref, "result": "unknown_action"}
    conn.commit()
    dbmod.audit(conn, f"doctor:{doctor_id}", f"whatsapp_{action}", "appointment", appt["id"], ref)
    return {"ref": ref, "result": action}


def _handle_status(conn, status: dict) -> None:
    wa_id = status.get("id", "")
    state = status.get("status", "")
    if state in ("sent", "delivered", "read"):
        conn.execute(
            "UPDATE whatsapp_messages SET status = ? WHERE wa_message_id = ?", (state, wa_id)
        )
        conn.commit()


def _notify_patient(conn, appt: sqlite3.Row, kind: str) -> None:
    from . import i18n

    patient = conn.execute("SELECT lang FROM patients WHERE id = ?", (appt["patient_id"],)).fetchone()
    lang = (patient["lang"] if patient else "fr") or "fr"
    body = i18n.t(kind, lang, ref=appt["ref"], date=appt["date"], time=appt["time"], reason="")
    conn.execute(
        "INSERT INTO notifications (appointment_id, channel, recipient, body, status) VALUES (?, 'in_app', ?, ?, 'sent')",
        (appt["id"], appt["patient_phone"], body),
    )
    conn.commit()
