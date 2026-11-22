import copy
from datetime import datetime, timedelta
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import booking
import app as app_module
from booking import BookingError, RULES, UTC, ZONE, booking_horizon, iso, parse, slots, validate

NOW = datetime(2026, 11, 10, 9, tzinfo=UTC)

def payload(start, channel="phone"):
    return {"name": "Synthetic Person", "email": "synthetic@example.invalid", "channel": channel,
        "phone": "+49 151 00000000", "discord": "synthetic.user" if channel == "discord" else "",
        "replyVia": "email", "topic": "praxis", "background": "Ein synthetisches Projekt ohne reale Personen.",
        "questions": "Eine synthetische Frage zum Test.", "outcome": "Ein synthetisches erwartetes Ergebnis.",
        "acknowledged": True, "website": "", "start": start,
        "requestId": "11111111-1111-4111-8111-111111111111"}

class FakeCalendar:
    enabled = False
    def __init__(self): self.calls = []
    def busy(self, start, end): self.calls.append((start, end)); return []

class FakeStore:
    def __init__(self, *args):
        self.creates = 0
        self.existing = {"historical": {"status": "confirmed", "start": "2026-12-16T09:00:00Z"}}
    def available(self, now, busy): return slots(now)
    def create(self, *args): self.creates += 1; raise AssertionError("Synthetic invalid input reached mutation")

class AvailabilityRulesTests(unittest.TestCase):
    def test_exact_three_calendar_month_boundary_and_beyond_old_28_days(self):
        self.assertEqual(booking_horizon(NOW), datetime(2027, 2, 10, 10, tzinfo=ZONE))
        candidates = {s["start"] for s in slots(NOW)}
        self.assertIn("2027-02-10T09:00:00Z", candidates)
        self.assertNotIn("2027-02-10T09:30:00Z", candidates)
        self.assertNotIn("2027-02-11T09:00:00Z", candidates)
        self.assertIn("2027-01-19T09:00:00Z", candidates)

    def test_month_end_clamping_and_leap_year(self):
        for year, month, day, expected in [(2026, 12, 31, (2027, 3, 31)), (2027, 1, 31, (2027, 4, 30)),
                (2026, 8, 31, (2026, 11, 30)), (2026, 11, 30, (2027, 2, 28)), (2027, 11, 30, (2028, 2, 29))]:
            with self.subTest(year=year, month=month, day=day):
                cutoff = booking_horizon(datetime(year, month, day, 11, 27, tzinfo=ZONE))
                self.assertEqual((cutoff.year, cutoff.month, cutoff.day), expected)
                self.assertEqual((cutoff.hour, cutoff.minute), (11, 27))

    def test_blackout_is_inclusive_and_does_not_hide_neighbour_dates(self):
        with patch.dict(RULES, {"weekdays": list(range(7))}):
            dates = {s["date"] for s in slots(NOW)}
            self.assertIn("2026-12-14", dates)
            self.assertNotIn("2026-12-15", dates)
            self.assertNotIn("2027-01-15", dates)
            self.assertIn("2027-01-16", dates)
            self.assertFalse(any("2026-12-15" <= d <= "2027-01-15" for d in dates))

    def test_real_schedule_preserved_around_blackout(self):
        candidates = slots(NOW)
        dates = {s["date"] for s in candidates}
        self.assertIn("2026-12-10", dates)
        self.assertIn("2027-01-19", dates)
        for slot in candidates:
            local = parse(slot["start"]).astimezone(ZONE)
            self.assertIn(local.weekday(), (1, 2, 3))
            self.assertIn(local.strftime("%H:%M"), ("10:00", "10:30", "11:00", "11:30"))
            self.assertEqual(parse(slot["end"]) - parse(slot["start"]), timedelta(minutes=30))

    def test_seven_day_minimum_remains_exact(self):
        self.assertEqual(slots(NOW)[0]["start"], "2026-11-17T09:00:00Z")
        self.assertEqual(slots(NOW + timedelta(seconds=1))[0]["start"], "2026-11-17T09:30:00Z")

    def test_berlin_day_not_utc_day_anchors_horizon(self):
        now = datetime(2026, 11, 9, 23, 30, tzinfo=UTC)
        limit = booking_horizon(now)
        self.assertEqual(limit, datetime(2027, 2, 10, 0, 30, tzinfo=ZONE))
        self.assertTrue(all(parse(s["start"]) <= limit.astimezone(UTC) for s in slots(now)))

    def test_dst_offsets_follow_berlin_calendar(self):
        spring = booking_horizon(datetime(2027, 1, 28, 10, tzinfo=ZONE))
        autumn = booking_horizon(datetime(2027, 8, 28, 10, tzinfo=ZONE))
        self.assertEqual(iso(spring), "2027-04-28T08:00:00Z")
        self.assertEqual(iso(autumn), "2027-11-28T09:00:00Z")
        candidates = slots(datetime(2027, 1, 28, 10, tzinfo=ZONE))
        self.assertIn("2027-03-25T09:00:00Z", {s["start"] for s in candidates})
        self.assertIn("2027-03-30T08:00:00Z", {s["start"] for s in candidates})

    def test_validation_rejects_blackout_and_horizon_for_both_channels(self):
        for channel in ("phone", "discord"):
            for start in ("2026-12-15T09:00:00Z", "2027-01-14T09:00:00Z", "2027-02-10T09:30:00Z", "2027-02-11T09:00:00Z"):
                with self.subTest(channel=channel, start=start), self.assertRaises(BookingError) as error:
                    validate(payload(start, channel), NOW)
                self.assertEqual(error.exception.status, 409)
            self.assertEqual(validate(payload("2027-01-19T09:00:00Z", channel), NOW)["start"], "2027-01-19T09:00:00Z")

    def make_app(self):
        calendar = FakeCalendar()
        with patch.object(app_module, "Store", FakeStore):
            application = app_module.create_app({"TESTING": True, "BOOKING_ENABLED": True,
                "BOOKING_ORIGIN": "https://wirkungsoekonomie.de", "BOOKING_DB": "/tmp/synthetic-never-created.sqlite3",
                "BOOKING_SECRET": "synthetic-only-" * 4}, calendar=calendar, clock=lambda: NOW)
        return application, calendar

    def test_api_busy_read_covers_entire_new_horizon(self):
        application, calendar = self.make_app()
        response = application.test_client().get("/api/telephone-booking/slots")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(calendar.calls, [(NOW, booking_horizon(NOW) + timedelta(days=1))])
        self.assertIn("2027-01-19T09:00:00Z", {s["start"] for s in response.json["slots"]})
        self.assertFalse(any("2026-12-15" <= s["date"] <= "2027-01-15" for s in response.json["slots"]))

    def test_forged_api_post_rejects_before_calendar_or_store_mutation(self):
        application, calendar = self.make_app()
        store = application.extensions["booking_store"]
        before = copy.deepcopy(store.existing)
        for channel in ("phone", "discord"):
            for start in ("2026-12-15T09:00:00Z", "2027-02-11T09:00:00Z"):
                response = application.test_client().post("/api/telephone-booking/requests",
                    json=payload(start, channel), headers={"Origin": "https://wirkungsoekonomie.de"})
                self.assertEqual(response.status_code, 409)
        self.assertEqual(calendar.calls, [])
        self.assertEqual(store.creates, 0)
        self.assertEqual(store.existing, before)

if __name__ == "__main__": unittest.main()
