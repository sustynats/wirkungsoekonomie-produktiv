"""Synthetic fixtures only: no live booking, provider, mail or calendar access."""
from datetime import datetime, timedelta
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import create_app
from booking import UTC, slots
from integrations import send_verification

API = "https://130.162.217.58.sslip.io"
FRONT = "https://wirkungsoekonomie.de"
PREFIX = "/api/telephone-booking"


class Calendar:
    enabled = True

    def busy(self, start, end):
        return []


class FirstpartyVerificationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.now = datetime(2026, 11, 9, 10, tzinfo=UTC)
        self.app = create_app({"TESTING": True, "BOOKING_ENABLED": True,
            "BOOKING_ORIGIN": API, "BOOKING_FRONTEND_ORIGIN": FRONT,
            "BOOKING_DB": str(Path(self.temp.name) / "synthetic.sqlite3"),
            "BOOKING_SECRET": "synthetic-fixture-only-" * 3},
            calendar=Calendar(), clock=lambda: self.now)
        self.client = self.app.test_client()
        self.store = self.app.extensions["booking_store"]

    def tearDown(self):
        self.temp.cleanup()

    def create(self, channel="phone"):
        payload = {"name": "Synthetic Person", "email": "fixture@example.org",
            "channel": channel, "phone": "+49 151 00000000" if channel == "phone" else "",
            "discord": "fixture.user" if channel == "discord" else "", "replyVia": "email",
            "topic": "praxis", "background": "Synthetischer Kontext ohne reale Person.",
            "questions": "Welche nächsten Schritte sind sinnvoll?", "outcome": "Ein gemeinsames Gespräch.",
            "acknowledged": True, "website": "", "start": slots(self.now)[0]["start"],
            "requestId": str(uuid.uuid4())}
        response = self.client.post(PREFIX + "/requests", json=payload, headers={"Origin": FRONT})
        self.assertEqual(response.status_code, 202)
        reference = response.json["reference"]
        with self.store.transaction() as db:
            row = dict(db.execute("SELECT * FROM requests WHERE id=?", (reference,)).fetchone())
        notice = json.loads(row["verification"])
        return reference, notice, notice["url"].split("#")[1], response.json

    def headers(self, token, origin=FRONT):
        return {"Origin": origin, "Authorization": "Bearer " + token}

    def row(self, reference):
        with self.store.transaction() as db:
            return dict(db.execute("SELECT * FROM requests WHERE id=?", (reference,)).fetchone())

    def test_phone_mail_contains_only_firstparty_verification_url(self):
        _, notice, token, response = self.create()
        self.assertEqual(notice["url"], FRONT + "/w/natalie-weber/anfrage-bestaetigen/#" + token)
        self.assertIsNone(response["verificationUrl"])
        sent = []

        class SMTP:
            def __init__(self, *args, **kwargs): pass
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def ehlo(self): pass
            def starttls(self, **kwargs): pass
            def login(self, *args): pass
            def send_message(self, message): sent.append(message)

        config = {"host": "synthetic.invalid", "port": 587, "user": "fixture", "password": "fixture", "from": "fixture@example.org"}
        with patch("integrations.smtp_config", return_value=config), patch("integrations.smtplib.SMTP", SMTP):
            send_verification(notice)
        self.assertEqual(len(sent), 1)
        self.assertIn(notice["url"], sent[0].get_content())
        self.assertNotIn("sslip", sent[0].as_string())

    def test_discord_link_stays_api_origin_and_frontend_cannot_use_it(self):
        reference, notice, token, response = self.create("discord")
        self.assertEqual(notice["url"], API + PREFIX + "/verify#" + token)
        self.assertEqual(response["verificationUrl"], notice["url"])
        for method in ("get", "post"):
            kwargs = {"json": {}} if method == "post" else {}
            self.assertEqual(getattr(self.client, method)(PREFIX + "/verify/request", headers=self.headers(token), **kwargs).status_code, 403)
        self.assertEqual(self.row(reference)["status"], "unverified")
        response = self.client.get(PREFIX + "/verify/request", headers=self.headers(token, API))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["channel"], "discord")
        self.assertNotIn("Access-Control-Allow-Origin", response.headers)

    def test_read_then_explicit_confirmation_preserves_two_steps(self):
        reference, _, token, _ = self.create()
        response = self.client.get(PREFIX + "/verify/request", headers=self.headers(token))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["status"], "unverified")
        self.assertIsNone(self.row(reference)["verified"])
        self.assertEqual(response.headers["Access-Control-Allow-Origin"], FRONT)
        response = self.client.post(PREFIX + "/verify/request", json={}, headers=self.headers(token))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["status"], "pending")
        self.assertIsNotNone(self.row(reference)["verified"])
        self.assertEqual(self.row(reference)["notify_attempts"], 0)

    def test_get_keeps_existing_expiry_cleanup_semantics(self):
        reference, _, token, _ = self.create()
        self.now += timedelta(hours=72, minutes=1)
        response = self.client.get(PREFIX + "/verify/request", headers=self.headers(token))
        self.assertEqual(response.status_code, 404)
        self.assertEqual(self.row(reference)["status"], "expired")
        self.assertIsNone(self.row(reference)["verified"])

    def test_preflight_exact_origin_method_headers_no_credentials(self):
        base = {"Origin": FRONT, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "Authorization, Content-Type"}
        for method in ("GET", "POST"):
            response = self.client.options(PREFIX + "/verify/request", headers={**base, "Access-Control-Request-Method": method})
            self.assertEqual(response.status_code, 204)
            self.assertEqual(response.headers["Access-Control-Allow-Origin"], FRONT)
            self.assertEqual(response.headers["Access-Control-Allow-Headers"], "Authorization, Content-Type")
            self.assertEqual(response.headers["Access-Control-Allow-Methods"], "GET, POST")
            self.assertNotIn("Access-Control-Allow-Credentials", response.headers)
            self.assertIn("Origin", response.headers["Vary"])
        for change in ({"Origin": FRONT + ".attacker.invalid"}, {"Origin": "null"},
                       {"Access-Control-Request-Method": "DELETE"},
                       {"Access-Control-Request-Headers": "Authorization, Cookie"}):
            self.assertEqual(self.client.options(PREFIX + "/verify/request", headers={**base, **change}).status_code, 403)

    def test_no_cross_origin_management_or_discord_expansion(self):
        for route in ("/manage/request", "/discord/start"):
            response = self.client.post(PREFIX + route, json={}, headers={"Origin": FRONT})
            self.assertEqual(response.status_code, 403)
            self.assertNotIn("Access-Control-Allow-Origin", response.headers)
            response = self.client.options(PREFIX + route, headers={"Origin": FRONT, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "Authorization"})
            self.assertNotIn("Access-Control-Allow-Origin", response.headers)

    def test_foreign_read_post_and_non_json_cannot_confirm(self):
        reference, _, token, _ = self.create()
        for method in ("get", "post"):
            kwargs = {"json": {}} if method == "post" else {}
            response = getattr(self.client, method)(PREFIX + "/verify/request", headers=self.headers(token, "https://foreign.invalid"), **kwargs)
            self.assertEqual(response.status_code, 403)
            self.assertNotIn("Access-Control-Allow-Origin", response.headers)
        response = self.client.post(PREFIX + "/verify/request", data="{}", headers=self.headers(token))
        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.row(reference)["status"], "unverified")


if __name__ == "__main__":
    unittest.main(verbosity=2)
