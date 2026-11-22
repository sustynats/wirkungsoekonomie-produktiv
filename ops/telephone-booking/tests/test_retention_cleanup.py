"""Retention timer uses only synthetic local SQLite data and no services."""
import os
from pathlib import Path
import sqlite3
from datetime import timedelta
import unittest
from unittest.mock import patch

import test_booking as fixtures
import retention_cleanup


class RetentionCleanupTests(unittest.TestCase):
    setUp = fixtures.BookingTests.setUp
    tearDown = fixtures.BookingTests.tearDown
    payload = fixtures.BookingTests.payload
    create = fixtures.BookingTests.create
    row = fixtures.BookingTests.row
    auth = fixtures.BookingTests.auth
    tokens = fixtures.BookingTests.tokens
    verified_phone = fixtures.BookingTests.verified_phone
    action = fixtures.BookingTests.action

    def test_disabled_delivery_still_expires_and_deletes_after_30_days(self):
        ref, admin, _ = self.verified_phone()
        self.assertEqual(self.action(admin, "decline").status_code, 200)
        self.app.config["BOOKING_ENABLED"] = False
        self.now += timedelta(days=30, seconds=1)
        with patch("socket.socket", side_effect=AssertionError("network forbidden")):
            retention_cleanup.cleanup_existing(self.store.filename, self.now)
        with self.store.transaction() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM requests WHERE id=?", (ref,)).fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT count(*) FROM rate_limits").fetchone()[0], 0)
        self.assertEqual(self.calendar.confirmations, 0)

    def test_preserves_completed_record_before_30_days(self):
        ref, admin, _ = self.verified_phone()
        self.assertEqual(self.action(admin, "decline").status_code, 200)
        self.now += timedelta(days=30, seconds=-1)
        retention_cleanup.cleanup_existing(self.store.filename, self.now)
        self.assertEqual(self.row(ref)["status"], "declined")

    def test_preserves_unexpired_pending_request(self):
        ref, _, _ = self.verified_phone()
        before = self.row(ref)
        retention_cleanup.cleanup_existing(self.store.filename, self.now + timedelta(minutes=1))
        self.assertEqual(self.row(ref), before)

    def test_refuses_missing_symlink_and_insecure_mode(self):
        db = Path(self.store.filename)
        missing = db.parent / "missing.sqlite3"
        with self.assertRaises(FileNotFoundError):
            retention_cleanup.cleanup_existing(missing, self.now)
        self.assertFalse(missing.exists())
        symlink = db.parent / "other.sqlite3"
        symlink.symlink_to(db)
        with self.assertRaises(ValueError):
            retention_cleanup.cleanup_existing(symlink, self.now)
        db.chmod(0o644)
        with self.assertRaises(ValueError):
            retention_cleanup.cleanup_existing(db, self.now)

    def test_refuses_wal_and_trigger_without_modifying_records(self):
        ref, admin, _ = self.verified_phone()
        self.assertEqual(self.action(admin, "decline").status_code, 200)
        db = sqlite3.connect(self.store.filename)
        db.execute("CREATE TRIGGER unexpected AFTER DELETE ON requests BEGIN SELECT 1; END")
        db.commit()
        db.close()
        with self.assertRaises(ValueError):
            retention_cleanup.cleanup_existing(self.store.filename, self.now + timedelta(days=31))
        self.assertEqual(self.row(ref)["status"], "declined")
        db = sqlite3.connect(self.store.filename)
        db.execute("DROP TRIGGER unexpected")
        db.execute("PRAGMA journal_mode=WAL")
        db.close()
        with self.assertRaises(ValueError):
            retention_cleanup.cleanup_existing(self.store.filename, self.now + timedelta(days=31))
        db = sqlite3.connect(self.store.filename)
        self.assertEqual(db.execute("SELECT count(*) FROM requests WHERE id=?", (ref,)).fetchone()[0], 1)
        db.close()

    def test_lock_contention_fails_without_deleting(self):
        ref, admin, _ = self.verified_phone()
        self.assertEqual(self.action(admin, "decline").status_code, 200)
        db = sqlite3.connect(self.store.filename, isolation_level=None)
        db.execute("BEGIN IMMEDIATE")
        try:
            with self.assertRaises(sqlite3.OperationalError):
                retention_cleanup.cleanup_existing(self.store.filename, self.now + timedelta(days=31))
        finally:
            db.rollback()
            db.close()
        self.assertEqual(self.row(ref)["status"], "declined")

    def test_main_uses_fixed_path_and_reports_no_details(self):
        with patch.object(retention_cleanup, "cleanup_existing", side_effect=ValueError("secret")) as cleanup:
            with patch("sys.stderr") as stderr:
                self.assertEqual(retention_cleanup.main(), 1)
        self.assertEqual(cleanup.call_args.args[0], "/var/lib/woek-telephone-booking/booking.sqlite3")
        self.assertNotIn("secret", str(stderr.write.call_args_list))


if __name__ == "__main__":
    unittest.main()
