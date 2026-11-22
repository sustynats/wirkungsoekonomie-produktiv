import concurrent.futures
from datetime import datetime, timedelta
import io
import json
import multiprocessing
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.parse import urlparse, parse_qs
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import create_app
from booking import BookingError, UTC, ZONE, RULES, calendar_file, parse, slots, validate
from integrations import deliver_one, deliver_verification, discord_notice, ICloud
from icalendar import Calendar, Event

PREFIX = "/api/telephone-booking"
ORIGIN = "https://wirkungsoekonomie.de"


class FakeCalendar:
    enabled = False
    conflicts = []
    confirmations = 0
    cancellations = 0
    fail = False

    def busy(self, start, end):
        if self.fail:
            raise RuntimeError("Synthetic outage")
        return self.conflicts

    def confirm(self, row):
        if self.fail:
            raise RuntimeError("Synthetic outage")
        if self.conflicts:
            raise BookingError("Calendar conflict", 409)
        self.confirmations += 1
        return "synced" if self.enabled else "manual"

    def cancel(self, row):
        if self.fail:
            raise RuntimeError("Synthetic outage")
        self.cancellations += 1


class BookingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.now = datetime(2026, 11, 3, 9, tzinfo=UTC)
        self.calendar = FakeCalendar()
        self.calendar.enabled = True
        self.app = create_app({"TESTING": True, "BOOKING_ENABLED": True, "BOOKING_ORIGIN": ORIGIN, "BOOKING_DB": str(Path(self.temp.name) / "booking.sqlite3"), "BOOKING_SECRET": "unit-test-key-" * 4}, calendar=self.calendar, clock=lambda: self.now, identify=lambda code, uri: {"id": "123456789012345678", "username": "actual.user"})
        self.client = self.app.test_client()
        self.store = self.app.extensions["booking_store"]
        self.headers = {"Origin": ORIGIN}

    def tearDown(self):
        self.temp.cleanup()

    def payload(self, **values):
        data = {"name": "Test Person", "email": "synthetic@example.org", "channel": "phone", "phone": "+49 151 00000000", "discord": "", "replyVia": "email", "topic": "praxis", "background": "Ein synthetisches Testprojekt ohne reale Nutzerdaten.", "questions": "Wie würde ein gemeinsames Gespräch ablaufen?", "outcome": "Den nächsten Schritt gemeinsam klären.", "acknowledged": True, "website": "", "start": slots(self.now)[0]["start"], "requestId": str(uuid.uuid4())}
        data.update(values)
        return data

    def create(self, data=None, client=None):
        response = (client or self.client).post(PREFIX + "/requests", json=data or self.payload(), headers=self.headers)
        self.assertEqual(response.status_code, 202, response.json)
        return response.json

    def row(self, reference):
        with self.store.transaction() as db:
            return dict(db.execute("SELECT * FROM requests WHERE id=?", (reference,)).fetchone())

    def auth(self, value):
        return {**self.headers, "Authorization": "Bearer " + value}

    def tokens(self, reference):
        row = self.row(reference)
        return json.loads(row["notification"])["url"].split("#")[1], json.loads(row["verification"])["url"].split("#")[1]

    def verified_phone(self):
        created = self.create()
        admin, verify = self.tokens(created["reference"])
        response = self.client.post(PREFIX + "/verify/request", json={}, headers=self.auth(verify))
        self.assertEqual(response.status_code, 200)
        return created["reference"], admin, verify

    def action(self, token, action):
        return self.client.post(PREFIX + "/manage/request", json={"action": action}, headers=self.auth(token))

    def test_time_rules_and_exact_7_day_3_month_boundaries(self):
        candidates = slots(self.now)
        self.assertEqual(candidates[0]["start"], "2026-11-10T09:00:00Z")
        self.assertEqual(candidates[-1]["start"], "2027-02-03T09:00:00Z")
        for slot in candidates:
            local = parse(slot["start"]).astimezone(ZONE)
            self.assertIn(local.weekday(), (1, 2, 3))
            self.assertIn(local.strftime("%H:%M"), RULES["times"])
            self.assertEqual(parse(slot["end"]) - parse(slot["start"]), timedelta(minutes=30))
        self.assertEqual(slots(self.now + timedelta(seconds=1))[0]["start"], "2026-11-10T09:30:00Z")

    def test_summer_winter_and_year_rollover(self):
        for now in [datetime(2026, 3, 17, 8, tzinfo=UTC), datetime(2026, 10, 13, 8, tzinfo=UTC), datetime(2026, 12, 23, 8, tzinfo=UTC)]:
            candidates = slots(now)
            self.assertTrue(candidates)
            for slot in candidates:
                self.assertIn(parse(slot["start"]).astimezone(ZONE).strftime("%H:%M"), RULES["times"])
        before = [s for s in slots(datetime(2026, 3, 17, 8, tzinfo=UTC)) if s["date"] == "2026-03-24"][0]
        after = [s for s in slots(datetime(2026, 3, 17, 8, tzinfo=UTC)) if s["date"] == "2026-03-31"][0]
        self.assertIn("T09:00", before["start"])
        self.assertIn("T08:00", after["start"])

    def test_invalid_fields_fail_server_side(self):
        cases = [{"name": ""}, {"email": "invalid"}, {"email": "x@y.z\r\nBcc: x@y.z"}, {"phone": "123"}, {"phone": "+49 abcdef"}, {"channel": "zoom"}, {"replyVia": "discord"}, {"topic": "invented"}, {"background": "short"}, {"questions": "x" * 1601}, {"acknowledged": False}, {"website": "spam"}, {"start": "2026-11-10T09:00:00"}, {"start": "2026-11-10T09:15:00Z"}, {"requestId": "bad"}, {"discord": "invalid name", "channel": "discord"}]
        for change in cases:
            with self.subTest(change=change), self.assertRaises(BookingError):
                validate(self.payload(**change), self.now)

    def test_phone_email_confirmation_then_owner_approval(self):
        created = self.create()
        self.assertIsNone(created["verificationUrl"])
        reference = created["reference"]
        admin, verify = self.tokens(reference)
        self.assertEqual(self.action(admin, "approve").status_code, 409)
        # Link previews and scanners cannot confirm via GET.
        self.assertEqual(self.client.get(PREFIX + "/verify/request", headers=self.auth(verify)).json["status"], "unverified")
        self.assertEqual(self.row(reference)["status"], "unverified")
        sent = []
        self.assertFalse(deliver_one(self.store, self.now, sent.append))
        self.assertTrue(deliver_verification(self.store, self.now, sent.append))
        self.assertEqual(sent[0]["email"], "synthetic@example.org")
        response = self.client.post(PREFIX + "/verify/request", json={}, headers=self.auth(verify))
        self.assertEqual(response.json["status"], "pending")
        self.assertTrue(deliver_one(self.store, self.now, sent.append))
        self.assertEqual(self.action(admin, "approve").json["status"], "confirmed")
        self.assertIsNone(self.row(reference)["confirmation_sent"])
        self.assertEqual(self.action(admin, "sent").status_code, 200)
        self.assertIsNotNone(self.row(reference)["confirmation_sent"])

    @patch.dict(os.environ, {"DISCORD_CLIENT_ID": "test-client"})
    def test_discord_oauth_checks_identity_cookie_state_and_explicit_confirmation(self):
        created = self.create(self.payload(channel="discord", discord="typed.user", replyVia="discord"))
        reference = created["reference"]
        admin, verify = self.tokens(reference)
        self.assertTrue(created["verificationUrl"].endswith(verify))
        self.assertEqual(self.client.post(PREFIX + "/verify/request", json={}, headers=self.auth(verify)).status_code, 403)
        start = self.client.post(PREFIX + "/discord/start", json={}, headers=self.auth(verify))
        query = parse_qs(urlparse(start.json["url"]).query)
        self.assertEqual(query["scope"], ["identify"])
        state = query["state"][0]
        callback = PREFIX + "/discord/callback?" + "code=test&state=" + state
        self.assertEqual(self.app.test_client().get(callback).status_code, 403)
        self.assertEqual(self.client.get(PREFIX + "/discord/callback?code=test&state=wrong").status_code, 403)
        self.assertEqual(self.client.get(callback).status_code, 303)
        self.assertEqual(self.client.get(callback).status_code, 403)
        row = self.row(reference)
        self.assertEqual(json.loads(row["payload"])["discord"], "actual.user")
        self.assertEqual(json.loads(row["payload"])["discordId"], "123456789012345678")
        self.assertEqual(row["status"], "unverified")
        self.assertEqual(self.client.post(PREFIX + "/verify/request", json={}, headers=self.auth(verify)).json["status"], "pending")

    def test_duplicate_request_is_idempotent_but_changed_payload_rejected(self):
        payload = self.payload()
        first = self.create(payload)
        self.assertEqual(first["reference"], self.create(payload)["reference"])
        payload["name"] = "Another Name"
        self.assertEqual(self.client.post(PREFIX + "/requests", json=payload, headers=self.headers).status_code, 409)

    def test_discord_duplicate_retains_same_verification_link(self):
        payload = self.payload(channel="discord", discord="typed.user")
        first = self.create(payload)
        self.assertEqual(first["verificationUrl"], self.create(payload)["verificationUrl"])

    def test_racing_requests_cannot_double_book(self):
        def post(number):
            with self.app.test_client() as client:
                return client.post(PREFIX + "/requests", json=self.payload(email=f"race{number}@example.org"), headers=self.headers).status_code
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            statuses = list(pool.map(post, range(4)))
        self.assertEqual(statuses.count(202), 1)
        self.assertEqual(statuses.count(409), 3)

    def test_unverified_and_pending_expire_and_release_slots(self):
        self.create()
        self.now += timedelta(hours=72, minutes=1)
        self.client.get(PREFIX + "/slots")
        with self.store.transaction() as db:
            self.assertEqual(db.execute("SELECT status FROM requests").fetchone()[0], "expired")
        reference, admin, verify = self.verified_phone()
        self.now += timedelta(hours=73)
        self.assertEqual(self.action(admin, "approve").status_code, 409)
        self.client.get(PREFIX + "/slots")
        self.assertEqual(self.row(reference)["status"], "expired")

    def test_one_active_request_per_email(self):
        self.create()
        response = self.client.post(PREFIX + "/requests", json=self.payload(start=slots(self.now)[1]["start"]), headers=self.headers)
        self.assertEqual(response.status_code, 409)

    def test_rate_limit_and_spoofed_forwarded_headers(self):
        for number, slot in enumerate(slots(self.now)[:5]):
            self.create(self.payload(email=f"rate{number}@example.org", start=slot["start"]))
        response = self.client.post(PREFIX + "/requests", json=self.payload(email="six@example.org", start=slots(self.now)[5]["start"]), headers={**self.headers, "X-Forwarded-For": "2.2.2.2", "X-Real-IP": "3.3.3.3"})
        self.assertEqual(response.status_code, 429)

    def test_origin_auth_limits_and_private_response_headers(self):
        self.assertEqual(self.client.post(PREFIX + "/requests", json=self.payload()).status_code, 403)
        self.assertEqual(self.client.post(PREFIX + "/requests", json=self.payload(), headers={"Origin": "https://attacker.invalid"}).status_code, 403)
        self.assertEqual(self.client.post(PREFIX + "/requests", json={"name": "x" * 25000}, headers=self.headers).status_code, 413)
        self.assertEqual(self.client.get(PREFIX + "/manage/request").status_code, 404)
        self.assertEqual(self.client.get(PREFIX + "/manage/request?token=not-a-token").status_code, 404)
        response = self.client.get(PREFIX + "/slots")
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertEqual(response.headers["Referrer-Policy"], "no-referrer")

    def test_public_slots_never_include_personal_information(self):
        self.create()
        response = self.client.get(PREFIX + "/slots")
        text = response.get_data(as_text=True)
        self.assertNotIn("synthetic", text)
        self.assertNotIn('"phone":', text)
        self.assertNotIn("+49 151 00000000", text)
        self.assertNotIn("token", text)
        self.assertNotIn(slots(self.now)[0]["start"], text)

    def test_approval_idempotence_decline_cancel_and_manual_message_tracking(self):
        reference, admin, verify = self.verified_phone()
        self.assertEqual(self.action(admin, "approve").status_code, 200)
        self.assertEqual(self.action(admin, "approve").status_code, 200)
        self.assertEqual(self.calendar.confirmations, 1)
        self.action(admin, "sent")
        confirmation_receipt = self.row(reference)["confirmation_sent"]
        self.assertIsNotNone(confirmation_receipt)
        cancelled = self.action(admin, "cancel")
        self.assertEqual(cancelled.json["status"], "cancelled")
        self.assertEqual(cancelled.json["confirmationDelivery"], "not_sent")
        self.assertEqual(self.row(reference)["confirmation_sent"], confirmation_receipt)
        self.assertIsNone(self.row(reference)["cancel_sent"])
        self.assertEqual(self.action(admin, "approve").status_code, 409)
        self.assertEqual(self.action(admin, "cancel").status_code, 200)

    def test_approval_requires_real_calendar_before_hold(self):
        reference, admin, _ = self.verified_phone()
        self.calendar.enabled = False
        self.assertEqual(self.action(admin, "approve").status_code, 503)
        self.assertEqual(self.row(reference)["status"], "pending")
        self.assertEqual(self.row(reference)["calendar_state"], "none")
        self.assertEqual(self.calendar.confirmations, 0)

    def test_manual_calendar_result_never_confirms_and_preserves_hold(self):
        reference, admin, _ = self.verified_phone()
        self.calendar.confirm = lambda row: "manual"
        self.assertEqual(self.action(admin, "approve").status_code, 503)
        self.assertEqual(self.row(reference)["status"], "pending")
        self.assertEqual(self.row(reference)["calendar_state"], "approve_hold")
        self.assertEqual(self.action(admin, "approve").status_code, 409)

    def test_calendar_conflict_outage_and_cancellation_failure(self):
        reference, admin, verify = self.verified_phone()
        self.calendar.conflicts = [(parse(self.row(reference)["start"]), parse(self.row(reference)["end"]))]
        self.assertEqual(self.action(admin, "approve").status_code, 409)
        self.assertEqual(self.row(reference)["status"], "pending")
        self.assertEqual(self.row(reference)["calendar_state"], "approve_hold")
        self.calendar.conflicts = []
        self.assertEqual(self.action(admin, "approve").status_code, 409)
        self.assertEqual(self.action(admin, "decline").status_code, 409)
        self.assertEqual(self.calendar.confirmations, 0)

    def test_uncertain_approval_is_durable_and_never_replayed(self):
        reference, admin, _ = self.verified_phone()
        def accepted_then_timeout(row):
            self.calendar.confirmations += 1  # synthetic provider accepted
            raise OSError("uncertain provider result")
        self.calendar.confirm = accepted_then_timeout
        self.assertEqual(self.action(admin, "approve").status_code, 503)
        self.assertEqual(self.row(reference)["calendar_state"], "approve_hold")
        self.assertEqual(self.action(admin, "approve").status_code, 409)
        self.assertEqual(self.action(admin, "decline").status_code, 409)
        self.assertEqual(self.calendar.confirmations, 1)
        self.assertFalse(deliver_one(self.store, self.now, lambda _: self.fail("must not send")))
        self.now += timedelta(days=45)
        with self.store.transaction() as db:
            self.store.cleanup(db, self.now)
        self.assertEqual(self.row(reference)["calendar_state"], "approve_hold")
        self.assertEqual(self.row(reference)["status"], "pending")
        self.assertFalse(self.store.worker_ready(self.now))

    def test_uncertain_cancellation_preserves_synced_state_and_blocks_retry(self):
        self.calendar.enabled = True
        reference, admin, _ = self.verified_phone()
        self.assertEqual(self.action(admin, "approve").status_code, 200)
        def accepted_then_timeout(row):
            self.calendar.cancellations += 1
            raise OSError("uncertain deletion result")
        self.calendar.cancel = accepted_then_timeout
        self.assertEqual(self.action(admin, "cancel").status_code, 503)
        self.assertEqual(self.row(reference)["calendar_state"], "cancel_synced_hold")
        self.assertEqual(self.row(reference)["status"], "confirmed")
        self.assertEqual(self.client.get(PREFIX + "/manage/calendar.ics", headers=self.auth(admin)).status_code, 409)
        self.assertEqual(self.action(admin, "cancel").status_code, 409)
        self.assertEqual(self.action(admin, "sent").status_code, 409)
        self.assertEqual(self.calendar.cancellations, 1)
        self.now += timedelta(days=45)
        with self.store.transaction() as db:
            self.store.cleanup(db, self.now)
        self.assertEqual(self.row(reference)["calendar_state"], "cancel_synced_hold")

    def test_concurrent_approval_performs_at_most_one_provider_call(self):
        reference, admin, _ = self.verified_phone()
        entered, finish = threading.Event(), threading.Event()
        def slow_confirm(row):
            self.calendar.confirmations += 1
            entered.set()
            if not finish.wait(5):
                raise RuntimeError("test timed out")
            return "synced"
        self.calendar.confirm = slow_confirm
        def first():
            with self.app.test_client() as client:
                return client.post(PREFIX + "/manage/request", json={"action":"approve"}, headers=self.auth(admin)).status_code
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(first)
            self.assertTrue(entered.wait(5))
            self.assertEqual(self.action(admin, "approve").status_code, 409)
            finish.set()
            self.assertEqual(pending.result(timeout=5), 200)
        self.assertEqual(self.calendar.confirmations, 1)
        self.assertEqual(self.row(reference)["status"], "confirmed")

    def test_process_exit_during_provider_call_keeps_durable_hold(self):
        reference, admin, _ = self.verified_phone()
        def process():
            def terminate_after_accept(row):
                os._exit(73)
            self.calendar.confirm = terminate_after_accept
            with self.app.test_client() as client:
                client.post(PREFIX + "/manage/request", json={"action":"approve"}, headers=self.auth(admin))
        worker = multiprocessing.get_context("fork").Process(target=process)
        worker.start()
        worker.join(10)
        self.assertFalse(worker.is_alive())
        self.assertEqual(worker.exitcode, 73)
        self.assertEqual(self.row(reference)["calendar_state"], "approve_hold")
        self.assertEqual(self.action(admin, "approve").status_code, 409)

    def test_inflight_new_request_cannot_insert_after_hold_commits(self):
        reference, admin, _ = self.verified_phone()
        entered, resume = threading.Event(), threading.Event()
        def slow_busy(start, end):
            entered.set()
            if not resume.wait(5):
                raise RuntimeError("test timed out")
            return []
        self.calendar.busy = slow_busy
        data = self.payload(email="second-synthetic@example.org", start=slots(self.now)[1]["start"])
        def new_request():
            with self.app.test_client() as client:
                return client.post(PREFIX + "/requests", json=data, headers=self.headers).status_code
        def fail_after_accept(row):
            raise OSError("synthetic provider result unknown")
        self.calendar.confirm = fail_after_accept
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(new_request)
            self.assertTrue(entered.wait(5))
            self.assertEqual(self.action(admin, "approve").status_code, 503)
            self.assertEqual(self.row(reference)["calendar_state"], "approve_hold")
            resume.set()
            self.assertEqual(pending.result(timeout=5), 503)
        with self.store.transaction() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM requests").fetchone()[0], 1)

    def test_verification_waiting_on_hold_transaction_fails_closed(self):
        reference, admin, _ = self.verified_phone()
        second = self.create(self.payload(email="second-synthetic@example.org", start=slots(self.now)[1]["start"]))
        _, verify = self.tokens(second["reference"])
        locked, release = threading.Event(), threading.Event()
        def commit_hold():
            with self.store.transaction() as db:
                db.execute("UPDATE requests SET calendar_state='approve_hold' WHERE id=?", (reference,))
                locked.set()
                if not release.wait(5):
                    raise RuntimeError("test timed out")
        def verify_other():
            with self.app.test_client() as client:
                return client.post(PREFIX + "/verify/request", json={}, headers=self.auth(verify)).status_code
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            hold = pool.submit(commit_hold)
            self.assertTrue(locked.wait(5))
            waiting = pool.submit(verify_other)
            release.set()
            hold.result(timeout=5)
            self.assertEqual(waiting.result(timeout=5), 503)
        self.assertEqual(self.row(second["reference"])["status"], "unverified")

    def test_separate_retention_job_preserves_held_row(self):
        from retention_cleanup import cleanup_existing
        reference, admin, _ = self.verified_phone()
        self.calendar.fail = True
        self.assertEqual(self.action(admin, "approve").status_code, 503)
        self.now += timedelta(days=45)
        cleanup_existing(Path(self.temp.name) / "booking.sqlite3", self.now)
        self.assertEqual(self.row(reference)["calendar_state"], "approve_hold")

    def test_new_calendar_event_explicitly_disallows_overwrite(self):
        from contextlib import nullcontext
        reference, _, _ = self.verified_phone()
        event_writes = []
        class FakeRemote:
            def add_event(self, body, **options):
                event_writes.append(options)
        provider = ICloud()
        with patch.dict(os.environ, {"BOOKING_ICLOUD_ENABLED":"1"}), \
             patch.object(provider, "calendar", return_value=nullcontext(FakeRemote())), \
             patch.object(provider, "busy", return_value=[]):
            self.assertEqual(provider.confirm(self.row(reference)), "synced")
        self.assertEqual(event_writes, [{"no_overwrite": True}])

    def test_calendar_cancel_refuses_edits_and_requires_conditional_delete(self):
        from contextlib import nullcontext
        reference, _, _ = self.verified_phone()
        row = self.row(reference)
        row["calendar_state"] = "synced"
        deletions = []
        class FakeEvent:
            def __init__(self):
                self.icalendar_instance = Calendar.from_ical(calendar_file(row))
                self.etag = '"synthetic-strong-etag"'
            def load(self):
                pass
            def delete(self, **options):
                deletions.append(options)
        event = FakeEvent()
        class FakeRemote:
            def event_by_uid(self, uid):
                return event
        provider = ICloud()
        with patch.dict(os.environ, {"BOOKING_ICLOUD_ENABLED":"1"}), \
             patch.object(provider, "calendar", return_value=nullcontext(FakeRemote())):
            provider.cancel(row)
            self.assertEqual(deletions, [{"if_match":'"synthetic-strong-etag"'}])
            deletions.clear()
            event.icalendar_instance.walk("VEVENT")[0]["SUMMARY"] = "Edited by owner"
            with self.assertRaises(BookingError):
                provider.cancel(row)
            self.assertEqual(deletions, [])
            event.icalendar_instance = Calendar.from_ical(calendar_file(row))
            for unsafe in (None, 'W/"weak"', 'invalid', '"bad\r\nheader"'):
                event.etag = unsafe
                with self.assertRaises(BookingError):
                    provider.cancel(row)
                self.assertEqual(deletions, [])

    def test_installed_caldav_delete_sends_literal_etag_as_if_match(self):
        from caldav import Event
        event = Event()
        with patch.object(event, "_delete", return_value=None) as send:
            event.delete(if_match='"synthetic-strong-etag"')
        send.assert_called_once_with({"if-match":'"synthetic-strong-etag"'})

    def test_decline_and_manual_cancellation_do_not_touch_calendar_provider(self):
        reference, admin, _ = self.verified_phone()
        self.calendar.enabled = True
        self.calendar.cancel = lambda _: self.fail("decline must not call provider")
        self.assertEqual(self.action(admin, "decline").status_code, 200)
        from contextlib import nullcontext
        provider = ICloud()
        row = self.row(reference)
        row["calendar_state"] = "manual"
        with patch.dict(os.environ, {"BOOKING_ICLOUD_ENABLED":"1"}), \
             patch.object(provider, "calendar", side_effect=AssertionError("manual event has no provider object")):
            provider.cancel(row)

    def test_ics_alarms_privacy_uid_and_injection_escaping(self):
        reference, admin, verify = self.verified_phone()
        self.assertEqual(self.client.get(PREFIX + "/manage/calendar.ics", headers=self.auth(admin)).status_code, 409)
        self.action(admin, "approve")
        response = self.client.get(PREFIX + "/manage/calendar.ics", headers=self.auth(admin))
        calendar = Calendar.from_ical(response.data)
        event = calendar.walk("VEVENT")[0]
        self.assertEqual(str(event["CLASS"]), "PRIVATE")
        self.assertEqual({alarm.decoded("TRIGGER") for alarm in event.walk("VALARM")}, {timedelta(hours=-24), timedelta(minutes=-30)})
        self.assertNotIn("ATTENDEE", event)
        row = self.row(reference)
        payload = json.loads(row["payload"])
        payload["name"] = "Untrusted\nEND:VEVENT\nBEGIN:VEVENT"
        row["payload"] = json.dumps(payload)
        self.assertEqual(len(Calendar.from_ical(calendar_file(row)).walk("VEVENT")), 1)
        self.assertEqual(calendar_file(self.row(reference)), response.data)

    def test_uncertain_notification_holds_original_without_automatic_resend(self):
        reference, admin, verify = self.verified_phone()
        def failure(value):
            raise OSError("Synthetic outage")
        self.assertFalse(deliver_one(self.store, self.now, failure))
        self.assertIsNotNone(self.row(reference)["notification"])
        self.assertIsNone(self.row(reference)["notify_at"])
        with self.store.transaction() as db:
            db.execute("INSERT INTO service_meta VALUES ('worker_heartbeat',?)", (self.now.isoformat(),))
        self.assertFalse(self.store.worker_ready(self.now))
        self.now += timedelta(minutes=3)
        sent = []
        self.assertFalse(deliver_one(self.store, self.now, sent.append))
        self.assertIsNotNone(self.row(reference)["notification"])
        self.assertEqual(sent, [])

    @patch.dict(os.environ, {"DISCORD_BOT_TOKEN": "unit-test", "DISCORD_REVIEW_RECIPIENT_USER_ID": "123456"})
    def test_discord_uses_existing_dm_process_without_mentions(self):
        created = self.create()
        notice = json.loads(self.row(created["reference"])["notification"])
        requests = []
        def fetch(request, timeout):
            requests.append(request)
            return io.BytesIO(b'{"id":"channel"}')
        discord_notice(notice, fetch)
        self.assertTrue(requests[0].full_url.endswith("users/@me/channels"))
        body = json.loads(requests[1].data)
        self.assertEqual(body["allowed_mentions"], {"parse": []})
        self.assertTrue(body["enforce_nonce"])
        self.assertNotIn("synthetic@example", body["content"])

    def test_retention_private_file_permissions_and_disabled_gate(self):
        reference, admin, verify = self.verified_phone()
        self.action(admin, "decline")
        self.now += timedelta(days=31)
        self.client.get(PREFIX + "/slots")
        self.assertEqual(self.client.get(PREFIX + "/manage/request", headers=self.auth(admin)).status_code, 404)
        self.assertEqual(Path(self.store.filename).stat().st_mode & 0o777, 0o600)
        self.app.config["BOOKING_ENABLED"] = False
        self.assertEqual(self.client.get(PREFIX + "/slots").status_code, 503)
        self.assertEqual(self.client.post(PREFIX + "/requests", json=self.payload(), headers=self.headers).status_code, 503)

    def test_caldav_all_day_transparent_cancelled_and_own_event(self):
        events = []
        for uid, transparent, cancelled in [("busy", False, False), ("transparent", True, False), ("cancelled", False, True), ("ours", False, False)]:
            cal = Calendar(); event = Event()
            event.add("uid", uid); event.add("dtstart", self.now.date()); event.add("dtend", (self.now + timedelta(days=1)).date())
            if transparent: event.add("transp", "TRANSPARENT")
            if cancelled: event.add("status", "CANCELLED")
            cal.add_component(event)
            events.append(type("Item", (), {"icalendar_instance": cal})())
        fake = type("Cal", (), {"search": lambda *args, **kwargs: events})()
        with patch.dict(os.environ, {"BOOKING_ICLOUD_ENABLED": "1"}):
            busy = ICloud().busy(self.now, self.now + timedelta(days=1), exclude_uid="ours", calendar=fake)
        self.assertEqual(len(busy), 1)
        self.assertEqual(busy[0][0].tzinfo, ZONE)

    def test_worker_health_stale_heartbeat_and_overdue_mail(self):
        self.assertFalse(self.store.worker_ready(self.now))
        with self.store.transaction() as db:
            db.execute("INSERT INTO service_meta VALUES ('worker_heartbeat',?)", (self.now.isoformat(),))
        self.assertTrue(self.store.worker_ready(self.now))
        self.assertFalse(self.store.worker_ready(self.now + timedelta(seconds=91)))
        self.create()
        self.now += timedelta(minutes=3)
        with self.store.transaction() as db:
            db.execute("UPDATE service_meta SET value=?", (self.now.isoformat(),))
        self.assertFalse(self.store.worker_ready(self.now))

    def test_uncertain_verification_holds_until_expiry_and_no_owner_dm(self):
        created = self.create()
        admin, verify = self.tokens(created["reference"])
        def failure(value):
            raise OSError("Synthetic SMTP outage")
        self.assertFalse(deliver_verification(self.store, self.now, failure))
        self.assertIsNone(self.row(created["reference"])["verify_at"])
        self.assertIsNotNone(self.row(created["reference"])["verification"])
        with self.store.transaction() as db:
            db.execute("INSERT INTO service_meta VALUES ('worker_heartbeat',?)", (self.now.isoformat(),))
        self.assertFalse(self.store.worker_ready(self.now))
        self.now += timedelta(seconds=31)
        self.assertFalse(deliver_verification(self.store, self.now, lambda value: self.fail("Uncertain mail resent")))
        self.assertFalse(deliver_one(self.store, self.now, lambda value: self.fail("Unverified request notified owner")))
        self.now += timedelta(hours=72)
        self.assertEqual(self.client.post(PREFIX + "/verify/request", json={}, headers=self.auth(verify)).status_code, 404)
        self.now += timedelta(days=1, minutes=1)
        self.client.get(PREFIX + "/slots")
        row = self.row(created["reference"])
        self.assertEqual(row["status"], "expired")
        self.assertEqual(row["verify_attempts"], 1)
        self.assertIsNotNone(row["verification"])
        self.assertIsNone(row["verify_at"])
        self.assertFalse(deliver_verification(self.store, self.now, lambda value: self.fail("Expired unknown mail resent")))

    def test_process_interruption_after_submission_never_retries_automatically(self):
        created = self.create()
        def interrupted(value):
            raise KeyboardInterrupt("synthetic stop after provider acceptance")
        with self.assertRaises(KeyboardInterrupt):
            deliver_verification(self.store, self.now, interrupted)
        self.now += timedelta(minutes=3)
        self.assertFalse(deliver_verification(self.store, self.now, lambda value: self.fail("Ambiguous mail resent")))
        self.assertIsNotNone(self.row(created["reference"])["verification"])
        self.client.post(PREFIX + "/verify/request", json={}, headers=self.auth(self.tokens(created["reference"])[1]))
        with self.assertRaises(KeyboardInterrupt):
            deliver_one(self.store, self.now, interrupted)
        self.now += timedelta(minutes=3)
        self.assertFalse(deliver_one(self.store, self.now, lambda value: self.fail("Ambiguous DM resent")))
        self.assertIsNotNone(self.row(created["reference"])["notification"])

    def test_concurrent_workers_cannot_send_same_claim_and_success_restores_readiness(self):
        created = self.create()
        verify = self.tokens(created["reference"])[1]
        with self.store.transaction() as db:
            db.execute("INSERT INTO service_meta VALUES ('worker_heartbeat',?)", (self.now.isoformat(),))
        sent = []
        def run_pair(deliver):
            started, finish = threading.Event(), threading.Event()
            def slow_sender(notice):
                sent.append(notice)
                started.set()
                self.assertTrue(finish.wait(5))
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                first = pool.submit(deliver, self.store, self.now, slow_sender)
                try:
                    self.assertTrue(started.wait(5))
                    self.assertFalse(self.store.worker_ready(self.now))
                    second = pool.submit(deliver, self.store, self.now, lambda _: self.fail("duplicate submission"))
                    self.assertFalse(second.result(timeout=5))
                finally:
                    finish.set()
                self.assertTrue(first.result(timeout=5))
            self.assertTrue(self.store.worker_ready(self.now))
        run_pair(deliver_verification)
        self.client.post(PREFIX + "/verify/request", json={}, headers=self.auth(verify))
        run_pair(deliver_one)
        self.assertEqual(len(sent), 2)


if __name__ == "__main__":
    unittest.main()
