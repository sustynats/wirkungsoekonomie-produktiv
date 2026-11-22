"""Private, small OCI service. Never include this directory or its state in _site."""
import hashlib
from calendar import monthrange
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
from contextlib import contextmanager, closing
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

PHONE_VERIFICATION_ENTRY = "https://wirkungsoekonomie.de/w/natalie-weber/anfrage-bestaetigen/"

UTC = timezone.utc
RULES = json.loads((Path(__file__).resolve().parents[2] / "content/natalie/telephone-booking.json").read_text())
ZONE = ZoneInfo(RULES["timezone"])
TOPICS = {item["id"]: item["label"] for item in RULES["topics"]}
LINK_HOURS = 72
LEGACY_VERIFICATION_MINUTES = 30
LEGACY_PENDING_HOURS = 48
# A pending delivery may have been accepted externally. Expiration must not
# discard its remaining reconciliation evidence or make it eligible to resend.
DELIVERY_HOLD_SQL = """((verification IS NOT NULL AND verify_at IS NULL AND verify_attempts>0)
    OR (notification IS NOT NULL AND notify_at IS NULL AND notify_attempts>0)
    OR confirmation_sent='email_hold' OR decline_sent='email_hold' OR cancel_sent='email_hold')"""


class BookingError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def now_utc():
    return datetime.now(UTC)


def iso(value):
    return value.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse(value):
    if not isinstance(value, str):
        raise ValueError("Date must be text")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("Timezone required")
    return parsed.astimezone(UTC)


def booking_horizon(now):
    """Same Berlin wall time after the configured calendar months, clamped at month end."""
    local = now.astimezone(ZONE)
    year, month_index = divmod(local.year * 12 + local.month - 1 + RULES["maxMonths"], 12)
    month = month_index + 1
    return local.replace(year=year, month=month, day=min(local.day, monthrange(year, month)[1]))


def slots(now):
    local = now.astimezone(ZONE)
    earliest, latest = local + timedelta(days=RULES["minDays"]), booking_horizon(now)
    result = []
    for offset in range(RULES["minDays"], (latest.date() - local.date()).days + 1):
        date = local.date() + timedelta(days=offset)
        if date.weekday() not in RULES["weekdays"] or any(
                window["from"] <= str(date) <= window["through"] for window in RULES["blockedDateRanges"]):
            continue
        for time in RULES["times"]:
            start = datetime.fromisoformat(f"{date}T{time}").replace(tzinfo=ZONE)
            if earliest <= start <= latest:
                result.append({"date": str(date), "start": iso(start), "end": iso(start + timedelta(minutes=RULES["durationMinutes"]))})
    return result


def expiry_binding(row):
    """Return fixed deadlines only for an exact old/new persisted timestamp contract."""
    row = dict(row)
    phase = "unverified" if row.get("verified") is None else "pending"
    if row.get("status") not in (phase, "expired"):
        return None
    try:
        created = parse(row["created"])
        origin = created if phase == "unverified" else parse(row["verified"])
        if origin < created:
            return None
        legacy = origin + (timedelta(minutes=LEGACY_VERIFICATION_MINUTES) if phase == "unverified" else timedelta(hours=LEGACY_PENDING_HOURS))
        deadline = origin + timedelta(hours=LINK_HOURS)
        if row["expires"] not in (iso(legacy), iso(deadline)):
            return None
        return phase, legacy, deadline
    except (ValueError, TypeError, KeyError):
        return None


def recovery_phase(row, now):
    """Pure predicate for legacy projection/reservation; this never changes status."""
    row = dict(row)
    binding = expiry_binding(row)
    if not binding or row.get("status") != "expired" or row.get("calendar_state") != "none":
        return None
    phase, legacy, deadline = binding
    if row.get("closed") != row.get("expires") or row["expires"] != iso(legacy) or not legacy <= now < deadline:
        return None
    if any(row.get(field) in ("email_queued", "email_hold") for field in ("confirmation_sent", "decline_sent", "cancel_sent")):
        return None
    try:
        start, end = parse(row["start"]), parse(row["end"])
        local = start.astimezone(ZONE)
        if (start <= now or end - start != timedelta(minutes=RULES["durationMinutes"])
                or local.weekday() not in RULES["weekdays"] or local.strftime("%H:%M") not in RULES["times"]
                or local.second or local.microsecond
                or any(window["from"] <= str(local.date()) <= window["through"] for window in RULES["blockedDateRanges"])):
            return None
    except (ValueError, TypeError, KeyError):
        return None
    return phase


def validate(data, now):
    if not isinstance(data, dict):
        raise BookingError("Bitte prüfe deine Angaben.")
    if data.get("website"):
        raise BookingError("Die Anfrage konnte nicht angenommen werden.")
    if data.get("acknowledged") is not True:
        raise BookingError("Bitte bestätige die Hinweise zur Terminanfrage.")
    result = {}
    limits = {"name": (2, 100), "email": (3, 254), **{q["id"]: (q["minLength"], q["maxLength"]) for q in RULES["questions"]}}
    for key, (minimum, maximum) in limits.items():
        value = data.get(key)
        if not isinstance(value, str) or not minimum <= len(value.strip()) <= maximum or re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", value):
            raise BookingError("Bitte fülle alle Pflichtfelder vollständig aus und beachte die maximale Textlänge.")
        result[key] = value.strip()
    if re.search(r"[\r\n]", result["name"]) or not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", result["email"]):
        raise BookingError("Bitte prüfe Name und E-Mail-Adresse.")
    result["email"] = result["email"].lower()
    if not isinstance(data.get("topic"), str) or data["topic"] not in TOPICS or data.get("channel") not in ("phone", "discord"):
        raise BookingError("Bitte wähle Anlass und Gesprächsweg.")
    result.update(topic=data["topic"], channel=data["channel"], phone="", discord="")
    if result["channel"] == "phone":
        phone = data.get("phone", "")
        if not isinstance(phone, str) or len(phone) > 40 or not re.fullmatch(r"\+[1-9][0-9 ()/.-]{6,38}", phone.strip()) or not 7 <= len(re.sub(r"\D", "", phone)) <= 15:
            raise BookingError("Bitte gib eine gültige Telefonnummer mit Ländervorwahl an (zum Beispiel +49 …).")
        result["phone"] = phone.strip()
    else:
        handle = data.get("discord", "")
        if not isinstance(handle, str):
            raise BookingError("Bitte gib deinen Discord-Benutzernamen an.")
        handle = handle.strip().removeprefix("@")
        if not re.fullmatch(r"[a-z0-9_.]{2,32}", handle) or ".." in handle:
            raise BookingError("Bitte gib deinen Discord-Benutzernamen an, nicht den Anzeigenamen.")
        result["discord"] = handle
    if data.get("replyVia") not in ("email", "discord") or (data["replyVia"] == "discord" and not result["discord"]):
        raise BookingError("Für eine Bestätigung per Discord wird dein Discord-Benutzername benötigt.")
    result["replyVia"] = data["replyVia"]
    if not isinstance(data.get("requestId"), str) or not re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", data["requestId"]):
        raise BookingError("Bitte lade die Seite neu und versuche es erneut.")
    result["requestId"] = data["requestId"]
    try:
        start = iso(parse(data.get("start")))
    except (ValueError, TypeError):
        raise BookingError("Bitte wähle einen gültigen Termin.") from None
    selected = next((slot for slot in slots(now) if slot["start"] == start), None)
    if not selected:
        raise BookingError("Dieser Termin liegt nicht mehr im Anfragezeitraum. Bitte wähle neu.", 409)
    result.update(start=selected["start"], end=selected["end"])
    return result


class Store:
    def __init__(self, filename, secret):
        self.filename, self.secret = str(filename), secret.encode()
        parent = Path(filename).resolve().parent
        parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with closing(sqlite3.connect(self.filename, timeout=30, isolation_level=None)) as db:
            # WAL mode on SQLite versions without the upstream WAL-reset fix
            # can corrupt a database under concurrent writes/checkpoints.
            # SQLite performs the WAL-to-rollback transition itself; if any
            # other connection prevents the transition, fail rather than
            # continuing in an unsafe journal mode.
            mode = db.execute("PRAGMA journal_mode=DELETE").fetchone()[0]
            if mode.lower() != "delete":
                raise RuntimeError("Booking database requires DELETE journal mode")
            db.execute("PRAGMA synchronous=FULL")
            db.execute("PRAGMA secure_delete=ON")
            db.execute("BEGIN IMMEDIATE")
            try:
                # The file mode can have changed since the initial pragma.
                # Recheck under the write reservation before schema writes.
                if db.execute("PRAGMA journal_mode").fetchone()[0].lower() != "delete":
                    raise RuntimeError("Booking database changed to an unsafe journal mode")
                db.execute("""CREATE TABLE IF NOT EXISTS requests (
                    id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL,
                    fingerprint TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL,
                    payload TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL,
                    created TEXT NOT NULL, expires TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'unverified', closed TEXT,
                    verify_hash TEXT UNIQUE NOT NULL, verification TEXT,
                    verify_at TEXT, verify_attempts INTEGER NOT NULL DEFAULT 0,
                    verified TEXT, discord_verified TEXT, oauth_state_hash TEXT,
                    calendar_state TEXT NOT NULL DEFAULT 'none',
                    notification TEXT, notify_at TEXT, notify_attempts INTEGER NOT NULL DEFAULT 0,
                    notification_sent TEXT, confirmation_sent TEXT
                )""")
                # Preserve all existing delivery state while giving each
                # later personal decision its own durable delivery status.
                columns = {row[1] for row in db.execute("PRAGMA table_info(requests)")}
                for column, status in (("decline_sent", "declined"), ("cancel_sent", "cancelled")):
                    if column not in columns:
                        db.execute(f"ALTER TABLE requests ADD COLUMN {column} TEXT")
                        # Older releases reused confirmation_sent for an owner
                        # acknowledgement after decline/cancel. Preserve that
                        # receipt once, without clearing or re-sending it.
                        db.execute(f"UPDATE requests SET {column}=confirmation_sent WHERE status=? AND confirmation_sent IS NOT NULL", (status,))
                db.execute("""CREATE UNIQUE INDEX IF NOT EXISTS active_slot ON requests(start)
                  WHERE status IN ('unverified', 'pending', 'confirmed')""")
                db.execute("CREATE TABLE IF NOT EXISTS rate_limits (key TEXT NOT NULL, created TEXT NOT NULL)")
                db.execute("CREATE INDEX IF NOT EXISTS rate_key ON rate_limits(key, created)")
                db.execute("CREATE TABLE IF NOT EXISTS service_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
                from crm import schema
                schema(db)
                db.commit()
            except BaseException:
                db.rollback()
                raise
        os.chmod(filename, 0o600)

    def connect(self):
        db = sqlite3.connect(self.filename, timeout=30, isolation_level=None)
        try:
            if db.execute("PRAGMA journal_mode").fetchone()[0].lower() != "delete":
                raise RuntimeError("Booking database is not in DELETE journal mode")
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA synchronous=FULL")
            db.execute("PRAGMA secure_delete=ON")
        except BaseException:
            db.close()
            raise
        return db

    @contextmanager
    def transaction(self):
        db = self.connect()
        try:
            db.execute("BEGIN IMMEDIATE")
            # A separate connection can switch the file to WAL after
            # connect() checked it.  BEGIN refreshes SQLite's view and takes
            # the write reservation; verify under that lock before any write.
            if db.execute("PRAGMA journal_mode").fetchone()[0].lower() != "delete":
                raise RuntimeError("Booking database changed to an unsafe journal mode")
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def digest(self, value):
        return hmac.new(self.secret, value.encode(), hashlib.sha256).hexdigest()

    def require_no_calendar_hold(self, db):
        # Caller must already own the BEGIN IMMEDIATE transaction. This check
        # and the protected mutation then serialize with creation of a hold.
        if db.execute("SELECT 1 FROM requests WHERE calendar_state GLOB '*_hold' LIMIT 1").fetchone():
            raise BookingError("Der Termindienst ist vorübergehend nicht verfügbar. Bitte versuche es später erneut.", 503)

    def cleanup(self, db, now):
        from crm import sync_bookings
        sync_bookings(db, now)
        stamp = iso(now)
        # Extend active legacy deadlines from their original event time, never
        # from migration/access time. Closed rows are not reactivated here.
        for row in db.execute("SELECT id,status,created,verified,expires,closed,calendar_state FROM requests WHERE status IN ('unverified','pending') AND closed IS NULL AND calendar_state NOT GLOB '*_hold'").fetchall():
            binding = expiry_binding(row)
            if binding and row["expires"] == iso(binding[1]):
                db.execute("UPDATE requests SET expires=? WHERE id=?", (iso(binding[2]), row["id"]))
        db.execute("UPDATE requests SET status='expired', closed=expires, notification=CASE WHEN notification IS NOT NULL AND notify_at IS NULL AND notify_attempts>0 THEN notification ELSE NULL END, verification=CASE WHEN verification IS NOT NULL AND verify_at IS NULL AND verify_attempts>0 THEN verification ELSE NULL END, oauth_state_hash=NULL WHERE status IN ('unverified','pending') AND calendar_state NOT GLOB '*_hold' AND expires<=?", (stamp,))
        # Keep exact legacy visitor rows through their fixed 72-hour window
        # plus the existing one-day deletion reserve. Never reconstruct rows.
        for row in db.execute("SELECT id,status,created,verified,expires,closed,calendar_state FROM requests WHERE status='expired' AND calendar_state NOT GLOB '*_hold' AND verified IS NULL AND NOT COALESCE(" + DELIVERY_HOLD_SQL + ",0) AND closed<?", (iso(now - timedelta(days=1)),)).fetchall():
            binding = expiry_binding(row)
            if binding and row["closed"] == row["expires"] and now <= binding[2] + timedelta(days=1):
                continue
            db.execute("DELETE FROM requests WHERE id=?", (row["id"],))
        cutoff = iso(now - timedelta(days=RULES["retentionDays"]))
        db.execute("DELETE FROM requests WHERE calendar_state NOT GLOB '*_hold' AND ((status='confirmed' AND end<?) OR (closed IS NOT NULL AND closed<?))", (cutoff, cutoff))
        db.execute("DELETE FROM rate_limits WHERE created<?", (iso(now - timedelta(days=1)),))

    def worker_ready(self, now):
        with self.transaction() as db:
            heartbeat = db.execute("SELECT value FROM service_meta WHERE key='worker_heartbeat'").fetchone()
            overdue = db.execute("SELECT COUNT(*) FROM requests WHERE (status='pending' AND notification IS NOT NULL AND (notify_at IS NULL OR verified<?)) OR (status='unverified' AND json_extract(payload, '$.channel')='phone' AND verification IS NOT NULL AND (verify_at IS NULL OR created<?))", (iso(now - timedelta(minutes=5)), iso(now - timedelta(minutes=2)))).fetchone()[0]
            holds = db.execute("SELECT COUNT(*) FROM requests WHERE calendar_state GLOB '*_hold'").fetchone()[0]
        return bool(heartbeat and parse(heartbeat[0]) >= now - timedelta(seconds=90) and not overdue and not holds)

    def available(self, now, busy=()):
        with self.transaction() as db:
            self.require_no_calendar_hold(db)
            self.cleanup(db, now)
            occupied = {row[0] for row in db.execute("SELECT start FROM requests WHERE status IN ('unverified','pending','confirmed')")}
            legacy = [(parse(row["start"]), parse(row["end"])) for row in self.legacy_reservations(db, now)]
        return [slot for slot in slots(now) if slot["start"] not in occupied and not any(parse(slot["start"]) < end and parse(slot["end"]) > start for start, end in (*busy, *legacy))]

    def legacy_reservations(self, db, now):
        rows = db.execute("SELECT id,status,created,verified,expires,closed,start,end,calendar_state,confirmation_sent,decline_sent,cancel_sent FROM requests WHERE status='expired'").fetchall()
        return [dict(row) for row in rows if recovery_phase(row, now) is not None]

    def create(self, payload, ip, now, admin_url):
        fingerprint = self.digest(json.dumps(payload, sort_keys=True))
        with self.transaction() as db:
            self.require_no_calendar_hold(db)
            self.cleanup(db, now)
            old = db.execute("SELECT id, fingerprint, verification, status FROM requests WHERE request_key=?", (payload["requestId"],)).fetchone()
            if old:
                if not hmac.compare_digest(old["fingerprint"], fingerprint):
                    raise BookingError("Diese Anfrage wurde bereits übermittelt. Bitte lade die Seite neu.", 409)
                if old["status"] in ("expired", "declined", "cancelled"):
                    raise BookingError("Diese Anfrage ist bereits abgeschlossen. Bitte wähle einen neuen Termin.", 409)
                verification = json.loads(old["verification"]) if old["verification"] else {}
                return old["id"], verification.get("url") if payload["channel"] == "discord" else None, old["status"]
            if any(parse(payload["start"]) < parse(row["end"]) and parse(payload["end"]) > parse(row["start"]) for row in self.legacy_reservations(db, now)):
                raise BookingError("Dieser Termin ist bereits vorgemerkt. Bitte wähle einen anderen Termin.", 409)
            for kind, value, limit, hours in [("ip", ip, 5, 1), ("email", payload["email"], 3, 24)]:
                key = self.digest(f"{kind}:{value}")
                count = db.execute("SELECT COUNT(*) FROM rate_limits WHERE key=? AND created>?", (key, iso(now - timedelta(hours=hours)))).fetchone()[0]
                if count >= limit:
                    raise BookingError("Es wurden bereits mehrere Anfragen übermittelt. Bitte versuche es später erneut.", 429)
                db.execute("INSERT INTO rate_limits VALUES (?,?)", (key, iso(now)))
            active = db.execute("SELECT payload FROM requests WHERE status IN ('unverified','pending','confirmed') AND end>?", (iso(now),)).fetchall()
            if any(json.loads(row[0])["email"] == payload["email"] for row in active):
                raise BookingError("Unter dieser E-Mail-Adresse besteht bereits eine offene oder bestätigte Anfrage.", 409)
            reference, token, verify_token = secrets.token_hex(8), secrets.token_urlsafe(32), secrets.token_urlsafe(32)
            notice = json.dumps({"url": f"{admin_url}/manage#{token}", "payload": payload, "reference": reference}, ensure_ascii=False)
            verify_entry = PHONE_VERIFICATION_ENTRY if payload["channel"] == "phone" else f"{admin_url}/verify"
            verify_url = f"{verify_entry}#{verify_token}"
            verification = json.dumps({"url": verify_url, "email": payload["email"], "reference": reference, "start": payload["start"]})
            try:
                db.execute("""INSERT INTO requests (id, request_key, fingerprint, token_hash, payload, start, end, created, expires, notification, notify_at, verify_hash, verification, verify_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", (reference, payload["requestId"], fingerprint, self.digest(token), json.dumps(payload, ensure_ascii=False), payload["start"], payload["end"], iso(now), iso(now + timedelta(minutes=RULES["verificationMinutes"])), notice, iso(now), self.digest(verify_token), verification, iso(now)))
            except sqlite3.IntegrityError:
                raise BookingError("Dieser Termin wurde inzwischen angefragt. Bitte wähle einen anderen Termin.", 409) from None
        return reference, verify_url if payload["channel"] == "discord" else None, "unverified"

    def authorized(self, db, token):
        if not isinstance(token, str) or not 40 <= len(token) <= 80:
            raise BookingError("Dieser Verwaltungslink ist ungültig oder abgelaufen.", 404)
        row = db.execute("SELECT * FROM requests WHERE token_hash=?", (self.digest(token),)).fetchone()
        if row is None:
            raise BookingError("Dieser Verwaltungslink ist ungültig oder abgelaufen.", 404)
        return dict(row)

    def verification_request(self, db, token, now=None):
        if not isinstance(token, str) or not 40 <= len(token) <= 80:
            raise BookingError("Dieser Bestätigungslink ist ungültig oder abgelaufen.", 404)
        row = db.execute("SELECT * FROM requests WHERE verify_hash=?", (self.digest(token),)).fetchone()
        if row is None or (row["status"] == "expired" and (now is None or recovery_phase(row, now) is None)):
            raise BookingError("Dieser Bestätigungslink ist ungültig oder abgelaufen. Bitte frage einen neuen Termin an.", 404)
        return dict(row)

    def reactivate(self, db, row, now, phase):
        """Only an explicit authenticated POST may call this inside its write transaction."""
        self.require_no_calendar_hold(db)
        if recovery_phase(row, now) != phase:
            raise BookingError("Diese Anfrage kann nicht mehr bestätigt werden. Bitte frage einen neuen Termin an.", 409)
        try:
            email = json.loads(row["payload"])["email"].casefold()
        except (ValueError, TypeError, KeyError, AttributeError):
            raise BookingError("Diese Anfrage muss persönlich geprüft werden.", 409) from None
        others = db.execute("SELECT start,end,payload FROM requests WHERE id<>? AND status IN ('unverified','pending','confirmed') AND end>?", (row["id"], iso(now))).fetchall()
        for other in others:
            try:
                conflict = (parse(other["start"]) < parse(row["end"]) and parse(other["end"]) > parse(row["start"])) or json.loads(other["payload"])["email"].casefold() == email
            except (ValueError, TypeError, KeyError, AttributeError):
                raise BookingError("Diese Anfrage muss persönlich geprüft werden.", 409) from None
            if conflict:
                raise BookingError("Inzwischen besteht eine andere Anfrage oder Reservierung. Bitte frage einen neuen Termin an.", 409)
        if phase == "unverified" and (row["notify_attempts"] != 0 or row["notification_sent"] is not None):
            raise BookingError("Eine frühere Zustellung muss zuerst persönlich geprüft werden.", 409)
        deadline = expiry_binding(row)[2]
        # Preserve delivery attempts/receipts. No notice is restored or sent.
        db.execute("UPDATE requests SET status=?, expires=?, closed=NULL, oauth_state_hash=NULL WHERE id=?", (phase, iso(deadline), row["id"]))
        return dict(db.execute("SELECT * FROM requests WHERE id=?", (row["id"],)).fetchone())

    def verify(self, db, row, now, admin_url=None):
        self.require_no_calendar_hold(db)
        if row["status"] != "unverified":
            return
        if parse(row["expires"]) <= now:
            raise BookingError("Die Bestätigungsfrist ist abgelaufen. Bitte frage einen neuen Termin an.", 409)
        payload = json.loads(row["payload"])
        if payload["channel"] == "discord" and not row["discord_verified"]:
            raise BookingError("Bitte melde dich zuerst bei Discord an.", 403)
        if row["notification"] is None:
            if row["notify_attempts"] != 0 or row["notification_sent"] is not None or not isinstance(admin_url, str):
                raise BookingError("Eine frühere Zustellung muss zuerst persönlich geprüft werden.", 409)
            # The legacy expiry removed the never-delivered owner notice. A
            # deliberate visitor confirmation can create its first notice;
            # the visitor bearer and all prior delivery receipts stay intact.
            owner_token = secrets.token_urlsafe(32)
            notice = json.dumps({"url": f"{admin_url}/manage#{owner_token}", "payload": payload, "reference": row["id"]}, ensure_ascii=False)
            db.execute("UPDATE requests SET token_hash=?, notification=? WHERE id=?", (self.digest(owner_token), notice, row["id"]))
        db.execute("UPDATE requests SET status='pending', verified=?, expires=?, verification=NULL, notify_at=? WHERE id=?", (iso(now), iso(now + timedelta(hours=RULES["pendingHours"])), iso(now), row["id"]))


def event_uid(row):
    return f"woek-call-{row['id']}@wirkungsoekonomie.de"


def calendar_file(row):
    # icalendar handles CRLF/escaping/folding of untrusted user text correctly.
    from icalendar import Calendar, Event, Alarm
    payload = json.loads(row["payload"])
    calendar = Calendar()
    calendar.add("prodid", "-//Wirkungsoekonomie//Gespraechsanfrage//DE")
    calendar.add("version", "2.0")
    event = Event()
    event.add("uid", event_uid(row))
    event.add("dtstamp", parse(row["created"]))
    event.add("dtstart", parse(row["start"]))
    event.add("dtend", parse(row["end"]))
    event.add("summary", f"Gespräch: {payload['name']}")
    contact = payload["phone"] or f"Discord: {payload['discord']}"
    event.add("location", "Telefon" if payload["channel"] == "phone" else "Discord-Sprachanruf (nur Audio)")
    event.add("description", f"{contact}\n{payload['email']}\nAnlass: {TOPICS[payload['topic']]}\nAnfrage: {row['id']}")
    event.add("class", "PRIVATE")
    event.add("status", "CONFIRMED")
    for minutes in (1440, 30):
        alarm = Alarm()
        alarm.add("action", "DISPLAY")
        alarm.add("description", "Gespräch mit Natalie Weber")
        alarm.add("trigger", timedelta(minutes=-minutes))
        event.add_component(alarm)
    calendar.add_component(event)
    return calendar.to_ical()
