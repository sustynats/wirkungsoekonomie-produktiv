"""New integration seams only: availability + 72-hour decisions + participant import."""
import json
from datetime import timedelta
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from icalendar import Calendar
import app as booking_app
import integrations
from booking import RULES, iso
import test_link_expiry as ttl_fixture
import test_participant_calendar as participant_fixture


class CombinedPolicyTests(unittest.TestCase):
    def setUp(self):
        self.flow = ttl_fixture.LinkExpiryTests()
        self.flow.setUp()
        self.addCleanup(self.flow.tearDown)

    def test_late_visitor_and_owner_confirmation_keep_blackout_and_attach_calendar_once(self):
        flow = self.flow
        blocked = flow.client.post(ttl_fixture.PREFIX + "/requests",
            json=flow.payload(start="2026-12-15T09:00:00Z"), headers={"Origin": ttl_fixture.ORIGIN})
        self.assertEqual(blocked.status_code, 409)
        self.assertEqual(RULES["maxMonths"], 3)
        ref, owner, visitor = flow.create()
        flow.now = flow.created + timedelta(hours=71)
        self.assertEqual(flow.verify(visitor).status_code, 200)
        self.assertEqual(flow.row(ref)["expires"], iso(flow.now + timedelta(hours=72)))
        flow.now += timedelta(hours=71)
        response = flow.action(owner)
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json["recoveryRequired"])
        notice = response.json["confirmationPreview"]
        self.assertEqual(notice["kind"], "confirmed")
        self.assertEqual(len(notice["calendar"]["links"]), 3)
        with patch.object(booking_app, "smtp_config", return_value=participant_fixture.SMTP):
            queued = flow.client.post(ttl_fixture.PREFIX + "/manage/request",
                json={"action": "send_confirmation_email", "expectedStatus": "confirmed"},
                headers=flow.auth(owner))
        self.assertEqual(queued.status_code, 200)
        self.assertEqual(json.loads(flow.row(ref)["verification"]), notice)
        with patch.object(integrations, "smtp_config", return_value=participant_fixture.SMTP), \
             patch.object(integrations.ssl, "create_default_context", return_value=object()), \
             patch.object(integrations.smtplib, "SMTP") as smtp:
            self.assertTrue(integrations.deliver_confirmation(flow.store, flow.now))
            self.assertFalse(integrations.deliver_confirmation(flow.store, flow.now))
        session = smtp.return_value.__enter__.return_value
        session.send_message.assert_called_once()
        message = session.send_message.call_args.args[0]
        attachment, = message.iter_attachments()
        self.assertEqual(attachment.get_content_type(), "text/calendar")
        event, = Calendar.from_ical(attachment.get_payload(decode=True)).walk("VEVENT")
        self.assertEqual(str(event["SUMMARY"]), "Gespräch mit Natalie Weber")
        self.assertNotIn(ref, notice["calendar"]["ics"])
        self.assertNotIn("fixture@example.org", notice["calendar"]["ics"])
        self.assertEqual(flow.row(ref)["status"], "confirmed")
        self.assertEqual(flow.calendar.confirmations, 1)

    def test_expired_legacy_owner_projection_becomes_confirmed_calendar_without_notice_retry(self):
        flow = self.flow
        ref, owner, _ = flow.legacy(pending=True)
        flow.update(ref, notify_attempts=1, notify_at=None)
        before = flow.row(ref)
        projected = flow.client.get(ttl_fixture.PREFIX + "/manage/request", headers=flow.auth(owner))
        self.assertEqual(projected.status_code, 200)
        self.assertTrue(projected.json["recoveryRequired"])
        self.assertEqual(projected.json["status"], "pending")
        self.assertIsNone(projected.json["confirmationPreview"])
        self.assertEqual(flow.row(ref), before)
        confirmed = flow.action(owner)
        self.assertEqual(confirmed.status_code, 200)
        self.assertEqual(confirmed.json["status"], "confirmed")
        self.assertFalse(confirmed.json["recoveryRequired"])
        self.assertIn("calendar", confirmed.json["confirmationPreview"])
        self.assertEqual(flow.row(ref)["expires"], iso(flow.created + timedelta(hours=72)))
        self.assertEqual(flow.row(ref)["notify_attempts"], 1)
        self.assertIsNone(flow.row(ref)["notification"])
        self.assertFalse(integrations.deliver_one(flow.store, flow.now,
            lambda notice: self.fail("No repeated owner notification")))
        self.assertEqual(flow.calendar.confirmations, 1)


if __name__ == "__main__":
    unittest.main()
