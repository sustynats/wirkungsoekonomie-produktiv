import tempfile
import unittest
import json
from datetime import datetime
from pathlib import Path
import uuid
from unittest.mock import patch

from app import create_app
from test_booking import FakeCalendar
from booking import UTC, slots

P = "/api/telephone-booking"
FRONT = "https://wirkungsoekonomie.de"
BACK = "https://booking.example.test"


class CrossOriginTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app({"TESTING": True, "BOOKING_ENABLED": True,
            "BOOKING_ORIGIN": BACK, "BOOKING_FRONTEND_ORIGIN": FRONT,
            "BOOKING_DB": str(Path(self.temp.name) / "db.sqlite3"),
            "BOOKING_SECRET": "synthetic-only-key-" * 3}, calendar=FakeCalendar())
        self.client = self.app.test_client()

    def tearDown(self):
        self.temp.cleanup()

    def test_only_allowed_public_preflight(self):
        headers = {"Origin": FRONT, "Access-Control-Request-Method": "POST",
                   "Access-Control-Request-Headers": "content-type"}
        r = self.client.options(P + "/requests", headers=headers)
        self.assertEqual(r.status_code, 204)
        self.assertEqual(r.headers.get("Access-Control-Allow-Origin"), FRONT)
        self.assertNotIn("Access-Control-Allow-Credentials", r.headers)
        for override in ({"Origin": "https://evil.example"},
                         {"Access-Control-Request-Method": "DELETE"},
                         {"Access-Control-Request-Headers": "authorization"}):
            denied = self.client.options(P + "/requests", headers={**headers, **override})
            self.assertEqual(denied.status_code, 403)

    def test_public_response_and_private_routes_do_not_leak_cors(self):
        r = self.client.get(P + "/slots", headers={"Origin": FRONT})
        self.assertEqual(r.headers.get("Access-Control-Allow-Origin"), FRONT)
        self.assertIn("Origin", r.headers.get("Vary", ""))
        for path in ("/manage/request", "/discord/start"):
            r = self.client.post(P + path, json={}, headers={"Origin": FRONT})
            self.assertEqual(r.status_code, 403)
            self.assertNotIn("Access-Control-Allow-Origin", r.headers)
        # The first-party phone page is intentionally CORS-enabled, but no
        # capability still means no access or verification. Other origins stay closed.
        for method in ("get", "post"):
            kwargs = {"json": {}} if method == "post" else {}
            r = getattr(self.client, method)(P + "/verify/request", headers={"Origin": FRONT}, **kwargs)
            self.assertEqual(r.status_code, 404)
            self.assertEqual(r.headers.get("Access-Control-Allow-Origin"), FRONT)
            self.assertNotIn("Access-Control-Allow-Credentials", r.headers)
            self.assertNotIn("reference", r.json)
            self.assertNotIn("start", r.json)
            denied = getattr(self.client, method)(P + "/verify/request",
                headers={"Origin": "https://evil.example"}, **kwargs)
            self.assertEqual(denied.status_code, 403)
            self.assertNotIn("Access-Control-Allow-Origin", denied.headers)
        r = self.client.get(P + "/slots", headers={"Origin": "https://evil.example"})
        self.assertNotIn("Access-Control-Allow-Origin", r.headers)

    def test_verification_page_returns_to_profile_origin(self):
        r = self.client.get(P + "/verify")
        self.assertEqual(r.status_code, 200)
        self.assertIn(('href="' + FRONT + '/w/natalie-weber/#gespraech"').encode(), r.data)
        self.assertNotIn(('href="' + BACK + '/w/natalie-weber/').encode(), r.data)

    def test_disconnected_calendar_cannot_offer_production_slots(self):
        self.app.testing = False
        with patch.dict('os.environ', {'DISCORD_BOT_TOKEN': 'synthetic',
                                      'DISCORD_REVIEW_RECIPIENT_USER_ID': 'synthetic'}), \
             patch.object(self.app.extensions['booking_store'], 'worker_ready', return_value=True):
            health = self.client.get(P + '/health')
            self.assertEqual(health.status_code, 503)
            self.assertFalse(health.json['acceptingRequests'])
            available = self.client.get(P + '/slots', headers={'Origin': FRONT})
            self.assertEqual(available.status_code, 503)
            self.assertIn('Kalenderprüfung', available.json['error'])

    def test_request_origin_is_strict_and_invalid_configuration_fails(self):
        r = self.client.post(P + "/requests", json={}, headers={"Origin": "https://evil.example"})
        self.assertEqual(r.status_code, 403)
        self.assertNotIn("Access-Control-Allow-Origin", r.headers)
        with self.assertRaises(RuntimeError):
            create_app({"TESTING": True, "BOOKING_ORIGIN": BACK,
                "BOOKING_FRONTEND_ORIGIN": "https://example.test/path",
                "BOOKING_DB": str(Path(self.temp.name) / "other.sqlite3"),
                "BOOKING_SECRET": "synthetic-only-key-" * 3})

    def test_public_submission_generates_firstparty_phone_verification_and_backend_owner_link(self):
        now = datetime(2026, 11, 3, 9, tzinfo=UTC)
        app = create_app({"TESTING": True, "BOOKING_ENABLED": True,
            "BOOKING_ORIGIN": BACK, "BOOKING_FRONTEND_ORIGIN": FRONT,
            "BOOKING_DB": str(Path(self.temp.name) / "flow.sqlite3"),
            "BOOKING_SECRET": "synthetic-only-key-" * 3}, calendar=FakeCalendar(), clock=lambda: now)
        data = {"name": "Test Person", "email": "synthetic@example.org", "channel": "phone",
                "phone": "+49 151 00000000", "discord": "", "replyVia": "email", "topic": "praxis",
                "background": "Ein synthetisches Testprojekt ohne reale Nutzerdaten.",
                "questions": "Wie würde ein gemeinsames Gespräch ablaufen?",
                "outcome": "Den nächsten Schritt gemeinsam klären.", "acknowledged": True,
                "website": "", "start": slots(now)[0]["start"], "requestId": str(uuid.uuid4())}
        client = app.test_client()
        response = client.post(P + "/requests", json=data, headers={"Origin": FRONT})
        self.assertEqual(response.status_code, 202)
        with app.extensions["booking_store"].transaction() as db:
            row = db.execute("SELECT * FROM requests WHERE id=?", (response.json["reference"],)).fetchone()
            verify = json.loads(row["verification"])["url"]
            manage = json.loads(row["notification"])["url"]
        self.assertTrue(verify.startswith(FRONT + "/w/natalie-weber/anfrage-bestaetigen/#"))
        self.assertNotIn(BACK, verify)
        self.assertNotIn("?", verify)
        self.assertTrue(manage.startswith(BACK + P + "/manage#"))
        token = verify.split("#", 1)[1]
        verified = client.post(P + "/verify/request", json={},
            headers={"Origin": FRONT, "Authorization": "Bearer " + token})
        self.assertEqual(verified.status_code, 200)
        self.assertEqual(verified.json["status"], "pending")
        self.assertEqual(verified.headers.get("Access-Control-Allow-Origin"), FRONT)
        self.assertNotIn("Access-Control-Allow-Credentials", verified.headers)
        # Existing API-origin capability reads remain usable.
        legacy = client.get(P + "/verify/request",
            headers={"Origin": BACK, "Authorization": "Bearer " + token})
        self.assertEqual(legacy.status_code, 200)
        self.assertEqual(legacy.json["status"], "pending")
        self.assertNotIn("Access-Control-Allow-Origin", legacy.headers)

if __name__ == "__main__":
    unittest.main()
