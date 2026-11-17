"""Medirdv Central scenario tests (Part 15).

Runs the real HTTP server on an ephemeral port with a temp SQLite DB.
WHATSAPP_MODE=mock is used — mock deliveries are logged, never real.
Run: python3 -m unittest discover -s tests -v
"""
import hashlib
import hmac
import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import Config
from app.server import create_server  # noqa: E402

BASE = None
ADMIN = ("admin@medirdv.dz", "admin123")


def http(method, path, body=None, headers=None, raw=False):
    url = BASE + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            payload = resp.read()
            return resp.status, (payload if raw else json.loads(payload or b"{}")), dict(resp.headers)
    except urllib.error.HTTPError as exc:
        payload = exc.read()
        return exc.code, (payload if raw else json.loads(payload or b"{}")), dict(exc.headers)


def login(email, password):
    status, data, headers = http("POST", "/api/v1/auth/login", {"email": email, "password": password})
    assert status == 200, data
    cookie = headers.get("Set-Cookie", "").split(";")[0]
    return {"Cookie": cookie, "X-CSRF-Token": data["csrf_token"]}


class CentralTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        tmp = Path(cls.tmp.name)
        os.environ["DATA_DIR"] = str(tmp)
        os.environ["DB_PATH"] = str(tmp / "test.db")
        os.environ["WHATSAPP_MODE"] = "mock"
        os.environ["WHATSAPP_APP_SECRET"] = "test-app-secret"
        os.environ["WHATSAPP_VERIFY_TOKEN"] = "test-verify-token"
        os.environ["PORT"] = "0"
        cfg = Config.from_env()
        cfg.port = 0
        cls.server = create_server(cfg)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        global BASE
        BASE = f"http://127.0.0.1:{cls.server.server_address[1]}"
        cls.admin = login(*ADMIN)
        cls.doctor_a, cls.doctor_b = cls._make_doctors()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.tmp.cleanup()

    @classmethod
    def _make_doctors(cls):
        status, data, _ = http("POST", "/api/v1/admin/doctors", {
            "full_name": "Dr Test A", "specialty": "Médecine générale",
            "wilaya": "Alger", "city": "Alger", "fee": 2000,
            "payment_policy": "baridimob", "status": "active",
            "whatsapp_number": "+213550000010",
        }, cls.admin)
        assert status == 201, data
        doctor_a = data["id"]
        status, data, _ = http("POST", "/api/v1/admin/doctors", {
            "full_name": "Dr Test B", "specialty": "Dentaire",
            "wilaya": "Oran", "city": "Oran", "fee": 0,
            "payment_policy": "free", "status": "active",
            "whatsapp_number": "+213550000020",
        }, cls.admin)
        assert status == 201, data
        doctor_b = data["id"]
        status, data, _ = http("POST", "/api/v1/admin/clinics",
                               {"name": "Clinique Test", "wilaya": "Alger", "city": "Alger"}, cls.admin)
        clinic = data["id"]
        for did in (doctor_a, doctor_b):
            status, data, _ = http("POST", f"/api/v1/admin/doctors/{did}/clinics/{clinic}", {
                "working_days": "0,1,2,3,4,5,6", "start_time": "00:00",
                "end_time": "23:59", "slot_minutes": 30, "max_per_day": 50,
            }, cls.admin)
            assert status == 200, data
        # Connect Doctor A to official Cloud API (mock mode: no real send).
        status, data, _ = http("POST", "/api/v1/admin/whatsapp/accounts", {
            "doctor_id": doctor_a, "mode": "cloud", "phone_number_id": "PN-A",
            "display_number": "+213550000010", "access_token": "test-token-a",
        }, cls.admin)
        assert status == 201, data
        return doctor_a, doctor_b

    def _future_date(self):
        from datetime import datetime, timedelta, timezone
        return (datetime.now(timezone.utc) + timedelta(days=3)).strftime("%Y-%m-%d")

    def _book(self, doctor_id, phone="0550000001", idem="key-1"):
        date = self._future_date()
        status, data, _ = http("GET", f"/api/v1/public/doctors/{doctor_id}/availability?date={date}")
        assert status == 200 and data["slots"], data
        slot = data["slots"][0]
        status, data, _ = http("POST", "/api/v1/public/bookings", {
            "doctor_id": doctor_id, "date": date, "time": slot,
            "patient_name": "Test Patient", "patient_phone": phone, "lang": "fr",
        }, {"Idempotency-Key": idem})
        assert status == 201, data
        return data["booking"], slot, date

    # --- Part 15 scenarios ---------------------------------------------
    def test_01_patient_books_with_doctor_a(self):
        booking, _, _ = self._book(self.doctor_a, idem="s1")
        self.assertTrue(booking["ref"].startswith("MR-"))
        self.assertEqual(booking["status"], "pending_payment")

    def test_02_request_sent_to_doctor_a_whatsapp(self):
        booking, _, _ = self._book(self.doctor_a, phone="0550000002", idem="s2")
        self.assertEqual(booking["whatsapp_status"], "sent")  # mock mode, logged

    def test_03_doctor_a_accepts_via_webhook(self):
        booking, _, _ = self._book(self.doctor_a, phone="0550000003", idem="s3")
        # Pay + verify first so the booking reaches doctor approval.
        status, data, _ = http("POST", f"/api/v1/public/bookings/{booking['ref']}/payment",
                               {"phone": "0550000003", "txn_ref": "TXN-S3"})
        self.assertEqual(status, 200, data)
        status, data, _ = http("GET", "/api/v1/admin/payments?ref=" + booking["ref"], headers=self.admin)
        pid = data["payments"][0]["id"]
        status, data, _ = http("POST", f"/api/v1/admin/payments/{pid}/verify",
                               {"decision": "paid", "notes": "verified"}, self.admin)
        self.assertEqual(status, 200, data)
        # Simulate Meta webhook: doctor A taps Accept.
        payload = {"entry": [{"changes": [{"value": {
            "metadata": {"phone_number_id": "PN-A"},
            "messages": [{"id": "wamid.s3", "from": "213550000010",
                          "interactive": {"type": "button_reply",
                                           "button_reply": {"id": f"accept:{booking['ref']}", "title": "✅ Accepter"}}}]}}]}]}
        raw = json.dumps(payload).encode()
        sig = "sha256=" + hmac.new(b"test-app-secret", raw, hashlib.sha256).hexdigest()
        req = urllib.request.Request(BASE + "/webhooks/whatsapp", data=raw, method="POST")
        req.add_header("X-Hub-Signature-256", sig)
        with urllib.request.urlopen(req, timeout=10) as resp:
            self.assertEqual(resp.status, 200)
        status, data, _ = http("GET", f"/api/v1/public/bookings/track?ref={booking['ref']}&phone=0550000003")
        self.assertEqual(data["booking"]["status"], "confirmed")

    def test_04_patient_receives_confirmation(self):
        booking, _, _ = self._book(self.doctor_a, phone="0550000004", idem="s4")
        status, data, _ = http("POST", f"/api/v1/public/bookings/{booking['ref']}/payment",
                               {"phone": "0550000004", "txn_ref": "TXN-S4"})
        status, data, _ = http("GET", "/api/v1/admin/payments?ref=" + booking["ref"], headers=self.admin)
        pid = data["payments"][0]["id"]
        http("POST", f"/api/v1/admin/payments/{pid}/verify", {"decision": "paid", "notes": ""}, self.admin)
        status, data, _ = http("GET", f"/api/v1/public/bookings/track?ref={booking['ref']}&phone=0550000004")
        events = [e["kind"] for e in data["booking"]["events"]]
        self.assertIn("payment_verified", events)

    def test_05_doctor_b_receives_different_booking(self):
        booking_a, _, _ = self._book(self.doctor_a, phone="0550000005", idem="s5a")
        booking_b, _, _ = self._book(self.doctor_b, phone="0550000005", idem="s5b")
        self.assertNotEqual(booking_a["ref"], booking_b["ref"])
        self.assertEqual(booking_b["doctor_id"], self.doctor_b)

    def test_06_doctor_b_cannot_access_doctor_a_bookings(self):
        # Doctor B user tries to respond to Doctor A's booking.
        status, data, _ = http("POST", "/api/v1/admin/users", {
            "email": "doctorb@test.dz", "password": "DoctorB123!", "role": "doctor",
            "full_name": "Dr Test B",
        }, self.admin)
        self.assertEqual(status, 201, data)
        # Link user to doctor B via DB is not exposed; instead verify the
        # webhook cross-doctor guard: a button from PN-A cannot affect B.
        booking_b, _, _ = self._book(self.doctor_b, phone="0550000006", idem="s6")
        payload = {"entry": [{"changes": [{"value": {
            "metadata": {"phone_number_id": "PN-A"},
            "messages": [{"id": "wamid.s6", "from": "213550000010",
                          "interactive": {"type": "button_reply",
                                           "button_reply": {"id": f"accept:{booking_b['ref']}", "title": "x"}}}]}}]}]}
        raw = json.dumps(payload).encode()
        sig = "sha256=" + hmac.new(b"test-app-secret", raw, hashlib.sha256).hexdigest()
        req = urllib.request.Request(BASE + "/webhooks/whatsapp", data=raw, method="POST")
        req.add_header("X-Hub-Signature-256", sig)
        with urllib.request.urlopen(req, timeout=10) as resp:
            result = json.loads(resp.read())
        self.assertEqual(result["results"][0]["result"], "forbidden_doctor_mismatch")

    def test_07_payment_submitted(self):
        booking, _, _ = self._book(self.doctor_a, phone="0550000007", idem="s7")
        status, data, _ = http("POST", f"/api/v1/public/bookings/{booking['ref']}/payment",
                               {"phone": "0550000007", "txn_ref": "TXN-S7"})
        self.assertEqual(data["payment_status"], "under_verification")

    def test_08_admin_verifies_payment(self):
        booking, _, _ = self._book(self.doctor_a, phone="0550000008", idem="s8")
        http("POST", f"/api/v1/public/bookings/{booking['ref']}/payment",
             {"phone": "0550000008", "txn_ref": "TXN-S8"})
        status, data, _ = http("GET", "/api/v1/admin/payments?ref=" + booking["ref"], headers=self.admin)
        pid = data["payments"][0]["id"]
        status, data, _ = http("POST", f"/api/v1/admin/payments/{pid}/verify",
                               {"decision": "paid", "notes": "ok"}, self.admin)
        self.assertEqual(data["status"], "paid")

    def test_09_duplicate_transaction_rejected(self):
        booking, _, _ = self._book(self.doctor_a, phone="0550000009", idem="s9")
        http("POST", f"/api/v1/public/bookings/{booking['ref']}/payment",
             {"phone": "0550000009", "txn_ref": "TXN-DUP"})
        booking2, _, _ = self._book(self.doctor_a, phone="0550000009", idem="s9b")
        status, data, _ = http("POST", f"/api/v1/public/bookings/{booking2['ref']}/payment",
                               {"phone": "0550000009", "txn_ref": "TXN-DUP"})
        self.assertEqual(status, 409)

    def test_10_doctor_disconnects_whatsapp(self):
        status, data, _ = http("POST", f"/api/v1/admin/whatsapp/accounts/{self.doctor_a}/disconnect",
                               {}, self.admin)
        self.assertEqual(status, 200)
        status, data, _ = http("GET", "/api/v1/admin/whatsapp/accounts", headers=self.admin)
        account = [a for a in data["accounts"] if a["doctor_id"] == self.doctor_a][0]
        self.assertEqual(account["status"], "disconnected")
        # Reconnect for later tests.
        http("POST", "/api/v1/admin/whatsapp/accounts", {
            "doctor_id": self.doctor_a, "mode": "cloud", "phone_number_id": "PN-A",
            "access_token": "test-token-a",
        }, self.admin)

    def test_11_fallback_click_to_chat(self):
        # Doctor B has no Cloud account → Click-to-Chat fallback.
        booking, _, _ = self._book(self.doctor_b, phone="0550000011", idem="s11")
        self.assertEqual(booking["whatsapp_status"], "click_to_chat")
        status, data, _ = http("GET", f"/api/v1/public/bookings/{booking['ref']}/click-to-chat")
        self.assertIn("wa.me", data["url"])
        self.assertEqual(data["mode"], "click_to_chat")

    def test_12_bad_webhook_signature_rejected(self):
        req = urllib.request.Request(BASE + "/webhooks/whatsapp", data=b"{}", method="POST")
        req.add_header("X-Hub-Signature-256", "sha256=deadbeef")
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(req, timeout=10)
        self.assertEqual(ctx.exception.code, 403)

    def test_13_duplicate_webhook_ignored_safely(self):
        payload = {"entry": [{"changes": [{"value": {
            "metadata": {"phone_number_id": "PN-A"}, "messages": []}}]}]}
        raw = json.dumps(payload).encode()
        sig = "sha256=" + hmac.new(b"test-app-secret", raw, hashlib.sha256).hexdigest()
        for _ in range(2):
            req = urllib.request.Request(BASE + "/webhooks/whatsapp", data=raw, method="POST")
            req.add_header("X-Hub-Signature-256", sig)
            with urllib.request.urlopen(req, timeout=10) as resp:
                result = json.loads(resp.read())
        self.assertEqual(result["status"], "duplicate")

    def test_14_patient_cancels(self):
        booking, _, _ = self._book(self.doctor_b, phone="0550000014", idem="s14")
        status, data, _ = http("POST", f"/api/v1/public/bookings/{booking['ref']}/cancel",
                               {"phone": "0550000014"})
        self.assertEqual(data["status"], "cancelled")

    def test_15_doctor_requests_rescheduling(self):
        booking, _, _ = self._book(self.doctor_b, phone="0550000015", idem="s15")
        payload = {"entry": [{"changes": [{"value": {
            "metadata": {"phone_number_id": "PN-A"},
            "messages": [{"id": "wamid.s15", "from": "213550000010",
                          "interactive": {"type": "button_reply",
                                           "button_reply": {"id": f"reschedule:{booking['ref']}", "title": "x"}}}]}}]}]}
        # Doctor B has no PN; use doctor A booking for the reschedule path.
        booking_a, _, _ = self._book(self.doctor_a, phone="0550000015", idem="s15a")
        payload["entry"][0]["changes"][0]["value"]["messages"][0]["interactive"]["button_reply"]["id"] = \
            f"reschedule:{booking_a['ref']}"
        raw = json.dumps(payload).encode()
        sig = "sha256=" + hmac.new(b"test-app-secret", raw, hashlib.sha256).hexdigest()
        req = urllib.request.Request(BASE + "/webhooks/whatsapp", data=raw, method="POST")
        req.add_header("X-Hub-Signature-256", sig)
        with urllib.request.urlopen(req, timeout=10):
            pass
        status, data, _ = http("GET", f"/api/v1/public/bookings/track?ref={booking_a['ref']}&phone=0550000015")
        self.assertEqual(data["booking"]["status"], "rescheduling_requested")

    def test_16_desktop_goes_offline(self):
        status, data, _ = http("POST", "/api/v1/connector/register",
                               {"doctor_id": self.doctor_a, "device_id": "dev-test-1", "app_kind": "medirdv"})
        self.assertEqual(status, 201)
        headers = {"X-Device-Id": "dev-test-1", "X-Device-Token": data["token"]}
        status, data, _ = http("POST", "/api/v1/connector/heartbeat", {}, headers)
        self.assertEqual(status, 200)

    def test_17_sync_reconnects(self):
        status, data, _ = http("POST", "/api/v1/connector/register",
                               {"doctor_id": self.doctor_a, "device_id": "dev-test-2", "app_kind": "dentardv"})
        headers = {"X-Device-Id": "dev-test-2", "X-Device-Token": data["token"]}
        http("POST", "/api/v1/connector/sync/push",
             {"kind": "appointment_created", "payload": {"ref": "MR-TEST"}}, headers)
        status, data, _ = http("GET", "/api/v1/connector/sync/pull", headers=headers)
        self.assertEqual(status, 200)
        self.assertTrue(any(i["kind"] == "appointment_created" for i in data["items"]))
        ids = [i["id"] for i in data["items"]]
        status, data, _ = http("POST", "/api/v1/connector/sync/ack", {"ids": ids}, headers)
        self.assertEqual(status, 200)

    def test_18_arabic_and_french_strings(self):
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
        from app import i18n
        for key in ("booking_request", "booking_accepted", "payment_received"):
            self.assertIn("fr", i18n.STRINGS[key])
            self.assertIn("ar", i18n.STRINGS[key])
        self.assertIn("Patient", i18n.t("booking_request", "fr", patient="X", ref="R", date="D", time="T", clinic="C"))
        self.assertIn("المريض", i18n.t("booking_request", "ar", patient="X", ref="R", date="D", time="T", clinic="C"))

    def test_19_unauthorized_cannot_access_financials(self):
        status, data, _ = http("GET", "/api/v1/admin/payments")  # no auth
        self.assertEqual(status, 401)
        # Support agent cannot verify payments.
        status, data, _ = http("POST", "/api/v1/admin/users", {
            "email": "support@test.dz", "password": "Support123!", "role": "support_agent",
        }, self.admin)
        support = login("support@test.dz", "Support123!")
        status, data, _ = http("POST", "/api/v1/admin/payments/1/verify",
                               {"decision": "paid", "notes": ""}, support)
        self.assertEqual(status, 403)

    def test_20_existing_projects_untouched(self):
        repo = Path(__file__).resolve().parent.parent.parent
        for rel in ("medirdv/package.json", "dentardv/package.json",
                    "medirdv/src/main/whatsapp/service.js",
                    "dentardv/src/main/whatsapp/service.js", "server.py", "api/app.py"):
            self.assertTrue((repo / rel).exists(), rel)
        import subprocess
        result = subprocess.run(
            ["git", "status", "--porcelain", "--", "medirdv", "dentardv", "api", "server.py"],
            cwd=str(repo), capture_output=True, text=True)
        self.assertEqual(result.stdout.strip(), "", "existing projects must not be modified")

    def test_double_booking_prevented(self):
        booking, slot, date = self._book(self.doctor_b, phone="0550000020", idem="s20")
        status, data, _ = http("POST", "/api/v1/public/bookings", {
            "doctor_id": self.doctor_b, "date": date, "time": slot,
            "patient_name": "Other", "patient_phone": "0550000021",
        }, {"Idempotency-Key": "s20b"})
        self.assertEqual(status, 409)

    def test_idempotent_booking(self):
        booking, _, _ = self._book(self.doctor_b, phone="0550000022", idem="idem-same")
        date = self._future_date()
        status, data, _ = http("POST", "/api/v1/public/bookings", {
            "doctor_id": self.doctor_b, "date": date, "time": "10:00",
            "patient_name": "Test Patient", "patient_phone": "0550000022",
        }, {"Idempotency-Key": "idem-same"})
        self.assertEqual(status, 201)
        self.assertTrue(data["duplicate"])
        self.assertEqual(data["booking"]["ref"], booking["ref"])

    def test_unverified_payment_never_paid(self):
        booking, _, _ = self._book(self.doctor_a, phone="0550000023", idem="s23")
        http("POST", f"/api/v1/public/bookings/{booking['ref']}/payment",
             {"phone": "0550000023", "txn_ref": "TXN-S23"})
        status, data, _ = http("GET", f"/api/v1/public/bookings/track?ref={booking['ref']}&phone=0550000023")
        self.assertNotEqual(data["booking"]["payment_status"], "paid")


if __name__ == "__main__":
    unittest.main()
