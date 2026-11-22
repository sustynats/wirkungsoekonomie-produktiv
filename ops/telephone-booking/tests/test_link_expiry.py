"""72-hour and legacy-reservation behavior; synthetic temporary SQLite only."""
import concurrent.futures
from datetime import datetime, timedelta
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import urlparse, parse_qs
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import create_app
from booking import BookingError, UTC, iso, parse, slots
from integrations import deliver_one, deliver_verification
from retention_cleanup import cleanup_existing

PREFIX = "/api/telephone-booking"
ORIGIN = "https://wirkungsoekonomie.de"


class Calendar:
    enabled = True
    def __init__(self):
        self.conflicts = []
        self.confirmations = 0
    def busy(self, start, end):
        return self.conflicts
    def confirm(self, row):
        if self.conflicts:
            raise BookingError("Synthetic conflict", 409)
        self.confirmations += 1
        return "synced"
    def cancel(self, row):
        raise AssertionError("No cancellation expected")


class LinkExpiryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.created = self.now = datetime(2026, 11, 3, 9, tzinfo=UTC)
        self.calendar = Calendar()
        self.app = create_app({"TESTING": True, "BOOKING_ENABLED": True,
            "BOOKING_ORIGIN": ORIGIN,
            "BOOKING_DB": str(Path(self.temp.name) / "synthetic.sqlite3"),
            "BOOKING_SECRET": "synthetic-key-only-" * 3},
            calendar=self.calendar, clock=lambda: self.now,
            identify=lambda code, uri: {"id": "123456789012345678", "username": "fixture.user"})
        self.client = self.app.test_client()
        self.store = self.app.extensions["booking_store"]
    def tearDown(self):
        self.temp.cleanup()
    def payload(self, **updates):
        data = {"name": "Synthetic Person", "email": "fixture@example.org", "channel": "phone",
            "phone": "+49 151 00000000", "discord": "", "replyVia": "email", "topic": "praxis",
            "background": "Synthetischer Kontext ohne reale Person.", "questions": "Welche nächsten Schritte sind sinnvoll?",
            "outcome": "Ein gemeinsames Gespräch.", "acknowledged": True, "website": "",
            "start": slots(self.created)[4]["start"], "requestId": str(uuid.uuid4())}
        data.update(updates)
        return data
    def create(self, **updates):
        response = self.client.post(PREFIX + "/requests", json=self.payload(**updates), headers={"Origin": ORIGIN})
        self.assertEqual(response.status_code, 202, response.json)
        ref = response.json["reference"]
        row = self.row(ref)
        return ref, json.loads(row["notification"])["url"].split("#")[1], json.loads(row["verification"])["url"].split("#")[1]
    def row(self, ref):
        with self.store.transaction() as db:
            row = db.execute("SELECT * FROM requests WHERE id=?", (ref,)).fetchone()
            return dict(row) if row else None
    def update(self, ref, **values):
        with self.store.transaction() as db:
            db.execute("UPDATE requests SET " + ",".join(key + "=?" for key in values) + " WHERE id=?", (*values.values(), ref))
    def auth(self, token):
        return {"Origin": ORIGIN, "Authorization": "Bearer " + token}
    def verify(self, token, client=None):
        return (client or self.client).post(PREFIX + "/verify/request", json={}, headers=self.auth(token))
    def action(self, token, action="approve"):
        return self.client.post(PREFIX + "/manage/request", json={"action": action}, headers=self.auth(token))
    def legacy(self, pending=False, **updates):
        ref, owner, visitor = self.create(**updates)
        if pending:
            self.assertEqual(self.verify(visitor).status_code, 200)
        old = self.created + (timedelta(hours=48) if pending else timedelta(minutes=30))
        self.update(ref, status="expired", expires=iso(old), closed=iso(old), verification=None,
                    notification=None, oauth_state_hash=None)
        self.now = self.created + (timedelta(hours=49) if pending else timedelta(hours=1))
        return ref, owner, visitor
    def cleanup(self):
        with self.store.transaction() as db:
            self.store.cleanup(db, self.now)

    def test_new_visitor_and_owner_deadlines_are_fixed_72_hours(self):
        ref, _, visitor = self.create()
        self.assertEqual(self.row(ref)["expires"], iso(self.created + timedelta(hours=72)))
        self.now += timedelta(hours=2)
        self.assertEqual(self.verify(visitor).status_code, 200)
        after = self.row(ref)
        self.assertEqual(after["expires"], iso(self.now + timedelta(hours=72)))
        self.now += timedelta(hours=1)
        self.assertEqual(self.verify(visitor).status_code, 200)
        self.assertEqual(self.row(ref), after)

    def test_active_legacy_deadlines_extend_once_from_original_times(self):
        ref, _, visitor = self.create()
        self.update(ref, expires=iso(self.created + timedelta(minutes=30)))
        self.now += timedelta(hours=1)
        self.cleanup()
        self.assertEqual(self.row(ref)["expires"], iso(self.created + timedelta(hours=72)))
        self.assertEqual(self.verify(visitor).status_code, 200)
        verified = self.now
        self.update(ref, expires=iso(verified + timedelta(hours=48)))
        self.now += timedelta(hours=49)
        self.cleanup()
        self.assertEqual(self.row(ref)["status"], "pending")
        self.assertEqual(self.row(ref)["expires"], iso(verified + timedelta(hours=72)))
        self.now += timedelta(hours=1)
        self.cleanup()
        self.assertEqual(self.row(ref)["expires"], iso(verified + timedelta(hours=72)))

    def test_get_projects_legacy_without_reactivation_or_owner_notice(self):
        ref, owner, visitor = self.legacy()
        before = self.row(ref)
        for route, token in (("verify", visitor), ("manage", owner)):
            response = self.client.get(PREFIX + "/" + route + "/request", headers=self.auth(token))
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json["status"], "unverified")
            self.assertTrue(response.json["recoveryRequired"])
        self.assertEqual(self.row(ref), before)
        self.assertEqual(self.calendar.confirmations, 0)

    def test_visitor_post_restores_one_first_owner_notice_without_resending_mail(self):
        ref, old_owner, visitor = self.legacy()
        self.assertEqual(self.verify(visitor).status_code, 200)
        row = self.row(ref)
        self.assertEqual(row["status"], "pending")
        self.assertEqual(row["expires"], iso(self.now + timedelta(hours=72)))
        self.assertIsNone(row["verification"])
        self.assertEqual(row["notify_attempts"], 0)
        self.assertIsNotNone(row["notification"])
        self.assertIsNone(row["notification_sent"])
        self.assertEqual(self.client.get(PREFIX + "/manage/request", headers=self.auth(old_owner)).status_code, 404)
        self.assertFalse(deliver_verification(self.store, self.now, lambda notice: self.fail("No visitor resend")))
        self.assertEqual(self.verify(visitor).status_code, 200)
        self.assertEqual(self.row(ref), row)
        notices = []
        self.assertTrue(deliver_one(self.store, self.now, notices.append))
        self.assertEqual(len(notices), 1)
        self.assertFalse(deliver_one(self.store, self.now, lambda notice: self.fail("No duplicate DM")))

    @patch.dict(os.environ, {"DISCORD_CLIENT_ID": "synthetic-client"})
    def test_legacy_discord_start_never_auto_confirms_or_queues_owner(self):
        ref, _, visitor = self.legacy(channel="discord", discord="fixture.user", phone="")
        response = self.client.post(PREFIX + "/discord/start", json={}, headers=self.auth(visitor))
        self.assertEqual(response.status_code, 200)
        self.assertIn("Max-Age=1800", response.headers.get("Set-Cookie"))
        row = self.row(ref)
        self.assertEqual(row["status"], "unverified")
        self.assertIsNone(row["notification"])
        self.assertIsNone(row["verification"])
        self.assertIsNone(row["verified"])
        state = parse_qs(urlparse(response.json["url"]).query)["state"][0]
        self.assertEqual(self.client.get(PREFIX + "/discord/callback?code=synthetic&state=" + state).status_code, 303)
        self.assertEqual(self.verify(visitor).status_code, 200)
        self.assertIsNotNone(self.row(ref)["notification"])

    def test_pending_recovery_requires_owner_approve_preserves_unknown_notice_receipt(self):
        ref, owner, visitor = self.legacy(pending=True)
        self.update(ref, notify_attempts=1, notify_at=None, notification_sent=None)
        before = self.row(ref)
        self.assertEqual(self.verify(visitor).status_code, 200)
        self.assertEqual(self.row(ref), before)
        self.assertEqual(self.action(owner, "decline").status_code, 409)
        self.assertEqual(self.row(ref), before)
        self.assertEqual(self.action(owner).status_code, 200)
        row = self.row(ref)
        self.assertEqual(row["status"], "confirmed")
        self.assertEqual(row["verified"], before["verified"])
        self.assertEqual(row["expires"], iso(self.created + timedelta(hours=72)))
        self.assertEqual(row["notify_attempts"], 1)
        self.assertIsNone(row["notification_sent"])
        self.assertIsNone(row["notification"])
        self.assertEqual(self.calendar.confirmations, 1)

    def test_visitor_recovery_rejects_unknown_prior_owner_attempt(self):
        ref, _, visitor = self.legacy()
        self.update(ref, notify_attempts=1)
        before = self.row(ref)
        self.assertEqual(self.verify(visitor).status_code, 409)
        self.assertEqual(self.row(ref), before)

    def test_legacy_retention_uses_new_deadline_plus_one_day_without_reactivation(self):
        ref, _, _ = self.legacy()
        self.now = self.created + timedelta(hours=73)
        cleanup_existing(self.store.filename, self.now)
        self.assertEqual(self.row(ref)["status"], "expired")
        self.now = self.created + timedelta(hours=96, seconds=1)
        cleanup_existing(self.store.filename, self.now)
        self.assertIsNone(self.row(ref))

    def test_unknown_mail_expires_and_releases_slot_but_preserves_claim(self):
        ref, _, _ = self.create()
        self.update(ref, verify_attempts=1, verify_at=None)
        original = self.row(ref)["verification"]
        self.now += timedelta(hours=72)
        self.cleanup()
        row = self.row(ref)
        self.assertEqual(row["status"], "expired")
        self.assertEqual(row["verification"], original)
        self.assertEqual(row["verify_attempts"], 1)
        with self.store.transaction() as db:
            self.assertEqual(self.store.legacy_reservations(db, self.now), [])
        self.now += timedelta(days=31)
        self.cleanup()
        self.assertIsNone(self.row(ref))
        self.assertFalse(deliver_verification(self.store, self.now, lambda notice: self.fail("No retry")))

    def test_unknown_notify_expires_without_requeue_or_slot_extension(self):
        ref, _, visitor = self.create()
        self.assertEqual(self.verify(visitor).status_code, 200)
        self.update(ref, notify_attempts=1, notify_at=None)
        original = self.row(ref)["notification"]
        self.now += timedelta(hours=72)
        self.cleanup()
        self.assertEqual(self.row(ref)["status"], "expired")
        self.assertEqual(self.row(ref)["notification"], original)
        self.assertFalse(deliver_one(self.store, self.now, lambda notice: self.fail("No retry")))

    def test_legacy_reservation_blocks_overlap_before_rate_limit_insert_and_frees_at_deadline(self):
        # Later original slot stays inside today's seven-day listing boundary.
        start = slots(self.created)[20]["start"]
        ref, _, _ = self.legacy(start=start)
        self.assertNotIn(start, {slot["start"] for slot in self.store.available(self.now)})
        with self.store.transaction() as db:
            rate_count = db.execute("SELECT COUNT(*) FROM rate_limits").fetchone()[0]
        payload = self.payload(start=iso(parse(start) + timedelta(minutes=15)), email="new@example.org")
        payload["end"] = iso(parse(payload["start"]) + timedelta(minutes=30))
        with self.assertRaises(BookingError) as caught:
            self.store.create(payload, "synthetic-ip", self.now, ORIGIN + PREFIX)
        self.assertEqual(caught.exception.status, 409)
        with self.store.transaction() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM rate_limits").fetchone()[0], rate_count)
        self.now = self.created + timedelta(hours=72)
        self.assertIn(start, {slot["start"] for slot in self.store.available(self.now)})
        self.assertEqual(self.row(ref)["status"], "expired")

    def test_two_concurrent_new_requests_have_one_winner(self):
        def post(number):
            with self.app.test_client() as client:
                return client.post(PREFIX + "/requests", json=self.payload(email=f"race{number}@example.org"), headers={"Origin": ORIGIN}).status_code
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(post, range(2)))
        self.assertEqual(sorted(results), [202, 409])

    def test_first_explicit_post_wins_between_two_legacy_reservations(self):
        ref, _, visitor = self.legacy()
        self.now = self.created
        # Fixture second historical reservation is inserted while first is
        # outside its old expiry; no production reactivation/creation occurs.
        self.update(ref, expires=iso(self.created - timedelta(minutes=30)), closed=iso(self.created - timedelta(minutes=30)))
        other, _, second = self.create(email="other@example.org")
        old = iso(self.created + timedelta(minutes=30))
        self.update(ref, expires=old, closed=old)
        self.update(other, status="expired", expires=old, closed=old, verification=None, notification=None)
        self.now = self.created + timedelta(hours=1)
        def post(token):
            with self.app.test_client() as client:
                return self.verify(token, client).status_code
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(post, (visitor, second)))
        self.assertEqual(sorted(results), [200, 409])
        self.assertEqual(sorted((self.row(ref)["status"], self.row(other)["status"])), ["expired", "pending"])

    def test_existing_active_overlap_wins_and_cannot_be_displaced(self):
        ref, _, visitor = self.legacy()
        original = self.row(ref)
        self.update(ref, expires=iso(self.created - timedelta(minutes=30)), closed=iso(self.created - timedelta(minutes=30)))
        self.now = self.created
        other, _, _ = self.create(email="other@example.org")
        self.update(ref, expires=original["expires"], closed=original["closed"])
        self.now += timedelta(hours=1)
        self.assertEqual(self.verify(visitor).status_code, 409)
        self.assertEqual(self.row(ref)["status"], "expired")
        self.assertEqual(self.row(other)["status"], "unverified")

    def test_casefold_email_conflict_blocks_recovery(self):
        ref, _, visitor = self.legacy()
        self.now = self.created
        other, _, _ = self.create(email="FIXTURE@example.org", start=slots(self.created)[10]["start"])
        self.now += timedelta(hours=1)
        self.assertEqual(self.verify(visitor).status_code, 409)
        self.assertEqual(self.row(ref)["status"], "expired")
        self.assertEqual(self.row(other)["status"], "unverified")

    def test_future_legacy_slot_inside_new_seven_day_minimum_can_confirm(self):
        ref, _, visitor = self.legacy(start=slots(self.created)[0]["start"])
        self.now = self.created + timedelta(hours=2)
        self.assertLess(parse(self.row(ref)["start"]) - self.now, timedelta(days=7))
        self.assertEqual(self.verify(visitor).status_code, 200)

    def test_blackout_past_and_ambiguous_timestamps_never_reactivate(self):
        ref, _, visitor = self.legacy()
        original = self.row(ref)
        cases = [dict(closed=iso(parse(original["closed"]) + timedelta(seconds=1))),
                 dict(expires=iso(parse(original["expires"]) + timedelta(seconds=1))),
                 dict(start="2026-12-15T09:00:00Z", end="2026-12-15T09:30:00Z"),
                 dict(start="2026-11-03T09:00:00Z", end="2026-11-03T09:30:00Z")]
        for values in cases:
            with self.subTest(values=values):
                self.update(ref, **{key: original[key] for key in ("closed", "expires", "start", "end")})
                self.update(ref, **values)
                self.assertEqual(self.verify(visitor).status_code, 404)
                self.assertEqual(self.row(ref)["status"], "expired")

    def test_calendar_and_email_holds_block_recovery(self):
        ref, owner, visitor = self.legacy(pending=True)
        self.update(ref, confirmation_sent="email_hold")
        self.assertEqual(self.action(owner).status_code, 409)
        self.update(ref, confirmation_sent=None, calendar_state="approve_hold")
        self.assertEqual(self.action(owner).status_code, 503)
        self.assertEqual(self.row(ref)["status"], "expired")
        self.assertEqual(self.calendar.confirmations, 0)

    def test_external_calendar_conflict_rolls_back_visitor_reactivation(self):
        ref, _, visitor = self.legacy()
        self.calendar.conflicts = [(parse(self.row(ref)["start"]), parse(self.row(ref)["end"]))]
        before = self.row(ref)
        self.assertEqual(self.verify(visitor).status_code, 409)
        self.assertEqual(self.row(ref), before)

    def test_confirmed_and_closed_states_are_not_reactivated_or_shortened(self):
        ref, owner, visitor = self.create()
        self.assertEqual(self.verify(visitor).status_code, 200)
        self.assertEqual(self.action(owner).status_code, 200)
        self.now += timedelta(hours=80)
        self.assertEqual(self.client.get(PREFIX + "/manage/request", headers=self.auth(owner)).json["status"], "confirmed")
        for status in ("declined", "cancelled"):
            self.update(ref, status=status, closed=iso(self.now), calendar_state="none")
            before = self.row(ref)
            self.assertEqual(self.action(owner).status_code, 409)
            self.assertEqual(self.row(ref), before)

    def test_deleted_or_invalid_bearers_do_not_reconstruct_rows(self):
        ref, _, visitor = self.legacy()
        with self.store.transaction() as db:
            db.execute("DELETE FROM requests WHERE id=?", (ref,))
        self.assertEqual(self.verify(visitor).status_code, 404)
        self.assertEqual(self.verify("x" * 43).status_code, 404)
        self.assertIsNone(self.row(ref))

    def test_frontend_and_mail_texts_use_72_hours_keep_30_minute_duration(self):
        site = Path(__file__).resolve().parents[3]
        paths = ["components/natalie/telephone-booking.mjs", "assets/js/telephone-booking.js",
                 "assets/js/telephone-booking-verify.js", "ops/telephone-booking/static/phone-verify.js",
                 "ops/telephone-booking/static/verify.js", "ops/telephone-booking/integrations.py"]
        for rel in paths:
            text = (site / rel).read_text()
            self.assertIn("72 Stunden", text, rel)
            self.assertNotIn("innerhalb von 30 Minuten", text, rel)
            self.assertNotIn("48 Stunden", text, rel)
        self.assertEqual((site / paths[2]).read_bytes(), (site / paths[3]).read_bytes())
        self.assertIn("30 Minuten · Telefon", (site / paths[2]).read_text())


if __name__ == "__main__":
    unittest.main()
