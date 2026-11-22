"""Delete expired booking data without loading provider credentials or sending.

This process is independent from the delivery worker and can run while new
booking requests are disabled. It never creates a missing database.
"""
import os
from pathlib import Path
import sqlite3
import stat
import sys
from urllib.parse import quote

from booking import Store, now_utc


def cleanup_existing(database, now):
    path = Path(database)
    if not path.is_absolute() or path.is_symlink():
        raise ValueError("A private absolute database path is required")
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_mode & 0o077 or before.st_uid != os.geteuid():
        raise ValueError("A private owner-controlled database is required")
    uri = "file:" + quote(str(path), safe="/") + "?mode=rw"
    db = sqlite3.connect(uri, uri=True, isolation_level=None, timeout=3)
    try:
        db.row_factory = sqlite3.Row
        after = path.lstat()
        if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino) or path.is_symlink():
            raise ValueError("The database changed during opening")
        if db.execute("PRAGMA journal_mode").fetchone()[0].lower() != "delete":
            raise ValueError("Unsafe database journal mode")
        db.execute("PRAGMA synchronous=FULL")
        db.execute("PRAGMA secure_delete=ON")
        db.execute("BEGIN IMMEDIATE")
        try:
            if db.execute("PRAGMA journal_mode").fetchone()[0].lower() != "delete":
                raise ValueError("Database journal mode changed")
            names = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
            if names not in ({"requests", "rate_limits", "service_meta"},
                             {"requests", "rate_limits", "service_meta", "crm_contacts", "crm_identities", "crm_meetings"}):
                raise ValueError("Unexpected database schema")
            if db.execute("SELECT count(*) FROM sqlite_master WHERE type='trigger'").fetchone()[0]:
                raise ValueError("Unexpected database triggers")
            for table, required in {
                "requests": {"id", "created", "status", "closed", "expires", "notification", "notify_at", "notify_attempts", "verification", "verify_at", "verify_attempts", "oauth_state_hash", "verified", "end", "calendar_state", "confirmation_sent", "decline_sent", "cancel_sent"},
                "rate_limits": {"created"},
            }.items():
                columns = {row[1] for row in db.execute("PRAGMA table_info(" + table + ")")}
                if not required <= columns:
                    raise ValueError("Unexpected database columns")
            from crm import schema
            schema(db)
            # Store.cleanup uses no instance fields; no secret is necessary.
            Store.cleanup(None, db, now)
            db.commit()
        except BaseException:
            db.rollback()
            raise
    finally:
        db.close()


def main():
    # Fixed path: accepting a caller-supplied database could delete other data.
    try:
        cleanup_existing("/var/lib/woek-telephone-booking/booking.sqlite3", now_utc())
    except Exception as exc:
        # Do not log paths, values, SQL, contacts, calendar data or credentials.
        print("Booking retention failed: " + type(exc).__name__, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
