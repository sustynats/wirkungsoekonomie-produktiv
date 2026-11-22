"""Synthetic tests for closing new bookings without stranding existing ones."""
import json
import os
import unittest
from datetime import timedelta
from unittest.mock import Mock, patch
from urllib.parse import parse_qs, urlparse

import test_booking as fixtures

PREFIX = fixtures.PREFIX


class DisabledContractTests(unittest.TestCase):
    setUp = fixtures.BookingTests.setUp
    tearDown = fixtures.BookingTests.tearDown
    payload = fixtures.BookingTests.payload
    create = fixtures.BookingTests.create
    row = fixtures.BookingTests.row
    auth = fixtures.BookingTests.auth
    tokens = fixtures.BookingTests.tokens
    verified_phone = fixtures.BookingTests.verified_phone
    action = fixtures.BookingTests.action

    @patch.dict(os.environ, {"DISCORD_CLIENT_ID": "synthetic-client"})
    def test_late_oauth_callback_does_not_consume_state_when_closed(self):
        identify = Mock(return_value={"id": "123456789012345678", "username": "actual.user"})
        self.app = fixtures.create_app(dict(self.app.config), calendar=self.calendar, clock=lambda: self.now, identify=identify)
        self.client = self.app.test_client()
        self.store = self.app.extensions["booking_store"]
        created = self.create(self.payload(channel="discord", discord="typed.user", replyVia="discord"))
        ref = created["reference"]
        _, verify = self.tokens(ref)
        response = self.client.post(PREFIX + "/discord/start", json={}, headers=self.auth(verify))
        self.assertEqual(response.status_code, 200)
        state = parse_qs(urlparse(response.json["url"]).query)["state"][0]
        before = self.row(ref)
        self.app.config["BOOKING_ENABLED"] = False
        with patch("app.hmac.compare_digest", wraps=__import__("hmac").compare_digest) as compare:
            result = self.client.get(PREFIX + "/discord/callback?code=synthetic&state=" + state)
        self.assertEqual(result.status_code, 503)
        self.assertEqual(compare.call_count, 0)
        identify.assert_not_called()
        self.assertEqual(self.row(ref), before)
        self.app.config["BOOKING_ENABLED"] = True
        result = self.client.get(PREFIX + "/discord/callback?code=synthetic&state=" + state)
        self.assertEqual(result.status_code, 303)
        identify.assert_called_once()
        self.assertEqual(json.loads(self.row(ref)["payload"])["discord"], "actual.user")

    def test_closed_refuses_new_approval_without_calendar_side_effects(self):
        ref, admin, _ = self.verified_phone()
        before = self.row(ref)
        self.app.config["BOOKING_ENABLED"] = False
        self.assertEqual(self.action(admin, "approve").status_code, 503)
        self.assertEqual(self.calendar.confirmations, 0)
        self.assertEqual(self.row(ref), before)
        self.assertEqual(self.client.get(PREFIX + "/manage/request", headers=self.auth(admin)).status_code, 200)
        self.app.config["BOOKING_ENABLED"] = True
        self.assertEqual(self.action(admin, "approve").status_code, 200)

    def test_closed_preserves_explicit_owner_decline_and_read_access(self):
        ref, admin, verify = self.verified_phone()
        self.app.config["BOOKING_ENABLED"] = False
        self.assertEqual(self.client.get(PREFIX + "/verify/request", headers=self.auth(verify)).status_code, 200)
        self.assertEqual(self.action(admin, "decline").status_code, 200)
        self.assertEqual(self.row(ref)["status"], "declined")
        self.assertEqual(self.calendar.confirmations, 0)

    def test_closed_preserves_owner_cancellation_of_existing_commitment(self):
        ref, admin, _ = self.verified_phone()
        self.assertEqual(self.action(admin, "approve").status_code, 200)
        self.app.config["BOOKING_ENABLED"] = False
        self.assertEqual(self.action(admin, "cancel").status_code, 200)
        self.assertEqual(self.row(ref)["status"], "cancelled")
        self.assertEqual(self.calendar.cancellations, 1)

    def test_closed_does_not_hide_calendar_cancellation_failure(self):
        ref, admin, _ = self.verified_phone()
        self.assertEqual(self.action(admin, "approve").status_code, 200)
        self.app.config["BOOKING_ENABLED"] = False
        self.calendar.fail = True
        self.assertEqual(self.action(admin, "cancel").status_code, 503)
        self.assertEqual(self.row(ref)["status"], "confirmed")

    def test_existing_retention_cleanup_remains_accessible_while_closed(self):
        ref, admin, _ = self.verified_phone()
        self.assertEqual(self.action(admin, "decline").status_code, 200)
        self.app.config["BOOKING_ENABLED"] = False
        self.now += timedelta(days=31)
        self.assertEqual(self.client.get(PREFIX + "/manage/request", headers=self.auth(admin)).status_code, 404)
        with self.store.transaction() as db:
            count = db.execute("SELECT COUNT(*) FROM requests WHERE id=?", (ref,)).fetchone()[0]
        self.assertEqual(count, 0)

    def test_expired_tokens_do_not_roll_back_cleanup_on_all_private_gets(self):
        for path, token_index in (("/verify/request", 1), ("/manage/request", 0), ("/manage/calendar.ics", 0)):
            with self.subTest(path=path):
                self.app.config["BOOKING_ENABLED"] = True
                ref, admin, verify = self.verified_phone()
                self.assertEqual(self.action(admin, "decline").status_code, 200)
                self.app.config["BOOKING_ENABLED"] = False
                self.now += timedelta(days=31)
                self.assertEqual(self.client.get(PREFIX + path, headers=self.auth((admin, verify)[token_index])).status_code, 404)
                with self.store.transaction() as db:
                    count = db.execute("SELECT COUNT(*) FROM requests WHERE id=?", (ref,)).fetchone()[0]
                self.assertEqual(count, 0)

    def test_closed_owner_can_mark_existing_confirmation_as_sent(self):
        ref, admin, _ = self.verified_phone()
        self.assertEqual(self.action(admin, "approve").status_code, 200)
        self.app.config["BOOKING_ENABLED"] = False
        self.assertEqual(self.action(admin, "sent").status_code, 200)
        self.assertIsNotNone(self.row(ref)["confirmation_sent"])

    def test_closed_rejects_new_requests_and_verifications(self):
        created = self.create()
        _, verify = self.tokens(created["reference"])
        self.app.config["BOOKING_ENABLED"] = False
        self.assertEqual(self.client.post(PREFIX + "/requests", json=self.payload(), headers=self.headers).status_code, 503)
        self.assertEqual(self.client.post(PREFIX + "/verify/request", json={}, headers=self.auth(verify)).status_code, 503)
        self.assertEqual(self.client.post(PREFIX + "/discord/start", json={}, headers=self.auth(verify)).status_code, 503)


if __name__ == "__main__":
    unittest.main()
