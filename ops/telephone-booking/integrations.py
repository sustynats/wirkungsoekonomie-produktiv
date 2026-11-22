import html
import hmac
"""Existing Discord bot credentials; optional iCloud CalDAV account kept in OCI secrets."""
import hashlib
import json
import os
import re
import urllib.request
import urllib.parse
import smtplib
import ssl
import unicodedata
from email.message import EmailMessage
from datetime import datetime, time, timedelta
from contextlib import contextmanager
from booking import BookingError, ZONE, UTC, TOPICS, calendar_file, event_uid, iso, parse
from setup_icloud import apple_url


def discord_inline(value, limit, fallback):
    # One line inside an inline-code span: no user-supplied delimiter, control
    # or bidi character can change the message structure or activate markup.
    text = " ".join("".join(" " if c.isspace() or unicodedata.category(c).startswith("C") else "'" if c == "`" else "∖" if c == "\\" else c for c in value).split())
    if len(text) > limit:
        text = text[:limit - 1].rstrip() + "…"
    return text or fallback


def discord_notice(notice, fetch=urllib.request.urlopen):
    token = os.environ.get("DISCORD_BOT_TOKEN")
    recipient = os.environ.get("DISCORD_REVIEW_RECIPIENT_USER_ID")
    if not token or not recipient:
        raise RuntimeError("Discord configuration missing")

    def post(path, body):
        request = urllib.request.Request(f"https://discord.com/api/v10/{path}", data=json.dumps(body).encode(), headers={"Authorization": f"Bot {token}", "Content-Type": "application/json", "User-Agent": "WOeK-Telephone-Booking/1.0"})
        with fetch(request, timeout=15) as response:
            return json.load(response)

    channel = post("users/@me/channels", {"recipient_id": recipient})["id"]
    payload = notice["payload"]
    date = parse(payload["start"]).astimezone(ZONE).strftime("%d.%m.%Y, %H:%M")
    # No model call or enrichment: show only the beginning of the provided
    # context, explicitly truncated, and keep contact fields on the private page.
    name = discord_inline(payload["name"], 100, "Name im Verwaltungsbereich")
    context = discord_inline(payload["background"], 300, "Anliegen im Verwaltungsbereich")
    content = f"Neue Gesprächsanfrage · {notice['reference']}\nAnfragende Person: `{name}`\n{date} Uhr (Europe/Berlin), 30 Minuten\nWeg: {'Telefon' if payload['channel'] == 'phone' else 'Discord-Sprachanruf'}\nAnlass: {TOPICS[payload['topic']]}\nAnliegen (Auszug): `{context}`\nBitte innerhalb von 72 Stunden prüfen und persönlich zusagen oder ablehnen.\nPrivater Verwaltungslink (nicht weitergeben):\n<{notice['url']}>"
    # Stable nonce deduplicates immediate retry after an uncertain HTTP response.
    post(f"channels/{channel}/messages", {"content": content, "allowed_mentions": {"parse": []}, "nonce": str(int(notice["reference"], 16)), "enforce_nonce": True})


class ICloud:
    @property
    def enabled(self):
        return os.environ.get("BOOKING_ICLOUD_ENABLED") == "1"

    @contextmanager
    def calendar(self):
        import caldav
        username = os.environ.get("ICLOUD_USERNAME")
        password = os.environ.get("ICLOUD_APP_PASSWORD")
        if not username or not password:
            raise RuntimeError("iCloud configuration missing")
        pinned_url = os.environ.get("ICLOUD_CALENDAR_URL")
        if pinned_url:
            pinned_url = apple_url(pinned_url)
        with caldav.DAVClient(url=pinned_url or "https://caldav.icloud.com/", username=username, password=password, timeout=15) as client:
            if pinned_url:
                selected = caldav.Calendar(client=client, url=pinned_url)
                calendars = [selected] if selected.get_display_name() == "Nats" else []
            else:
                calendars = [calendar for calendar in client.principal().calendars() if calendar.name == "Nats"]
            if len(calendars) != 1:
                raise RuntimeError("Exactly one existing Nats calendar is required")
            yield calendars[0]

    def busy(self, start, end, exclude_uid=None, calendar=None):
        if not self.enabled:
            return []
        if calendar is None:
            with self.calendar() as selected:
                return self.busy(start, end, exclude_uid, selected)
        periods = []
        for item in calendar.search(start=start, end=end, event=True, expand=True):
            for event in item.icalendar_instance.walk("VEVENT"):
                if str(event.get("UID", "")) == exclude_uid or str(event.get("STATUS", "")) == "CANCELLED" or str(event.get("TRANSP", "")) == "TRANSPARENT":
                    continue
                beginning = event.decoded("DTSTART")
                finish = event.decoded("DTEND", None)
                if finish is None:
                    finish = beginning + event.decoded("DURATION", timedelta(days=1) if not isinstance(beginning, datetime) else timedelta(0))
                if not isinstance(beginning, datetime):
                    beginning = datetime.combine(beginning, time(), ZONE)
                if not isinstance(finish, datetime):
                    finish = datetime.combine(finish, time(), ZONE)
                periods.append((beginning.replace(tzinfo=ZONE) if beginning.tzinfo is None else beginning, finish.replace(tzinfo=ZONE) if finish.tzinfo is None else finish))
        return periods

    def confirm(self, row):
        if not self.enabled:
            return "manual"
        with self.calendar() as calendar:
            start, end = parse(row["start"]), parse(row["end"])
            busy = self.busy(start, end, event_uid(row), calendar)
            if any(start < stop and end > beginning for beginning, stop in busy):
                raise BookingError("Im Kalender Nats liegt inzwischen ein anderer Termin. Die Kalenderaktion muss persönlich geprüft werden.", 409)
            # Never overwrite a pre-existing event. The persistent hold in the
            # caller prevents blind retries after an uncertain provider result.
            calendar.add_event(calendar_file(row).decode(), no_overwrite=True)
        return "synced"

    def cancel(self, row):
        if row["calendar_state"] in ("none", "manual"):
            return
        if not self.enabled:
            if row["calendar_state"] == "synced":
                raise BookingError("iCloud ist derzeit nicht verbunden. Bitte erst den Kalenderanschluss wiederherstellen.", 503)
            return
        from icalendar import Calendar
        with self.calendar() as calendar:
            remote = calendar.event_by_uid(event_uid(row))
            # Load the current version and its ETag. If the entry contains
            # any provider or owner edits, stop rather than delete them.
            remote.load()
            actual_events = remote.icalendar_instance.walk("VEVENT")
            expected_events = Calendar.from_ical(calendar_file(row)).walk("VEVENT")
            if (len(actual_events) != 1 or len(expected_events) != 1 or
                    actual_events[0].to_ical() != expected_events[0].to_ical()):
                raise BookingError("Der Kalendereintrag wurde verändert und muss persönlich geprüft werden.", 409)
            # Pin a literal strong ETag, not if_match=True: caldav 3.7 may
            # otherwise fall back to a Schedule-Tag for a weak/missing ETag.
            etag = remote.etag
            if not isinstance(etag, str) or len(etag) > 1024 or not re.fullmatch(r'"[\x21\x23-\x7e\x80-\xff]*"', etag):
                raise BookingError("Die Kalenderfassung lässt sich nicht sicher prüfen.", 409)
            # A missing event, absent tag or changed version requires review;
            # an uncertain negative lookup is not proof of completed deletion.
            remote.delete(if_match=etag)


def deliver_one(store, now, sender=discord_notice):
    with store.transaction() as db:
        store.cleanup(db, now)
        row = db.execute("SELECT * FROM requests WHERE status='pending' AND calendar_state NOT GLOB '*_hold' AND notification IS NOT NULL AND notify_at<=? ORDER BY created LIMIT 1", (iso(now),)).fetchone()
        if row is None:
            return False
        # The provider may accept a request just before the worker crashes or
        # the connection fails. Persist a hold BEFORE sending: no automatic
        # retry can safely distinguish that situation from an unsent message.
        db.execute("UPDATE requests SET notify_at=NULL, notify_attempts=notify_attempts+1 WHERE id=?", (row["id"],))
    try:
        sender(json.loads(row["notification"]))
    except Exception:
        # Preserve the existing notification for explicit reconciliation.
        return False
    with store.transaction() as db:
        db.execute("UPDATE requests SET notification=NULL, notification_sent=? WHERE id=?", (iso(now), row["id"]))
    return True


def smtp_config():
    def value(key, default=None):
        return next((os.environ[f"{prefix}_SMTP_{key}"] for prefix in ("BOOKING", "REVIEW_NOTIFICATION", "WIRKUNGSRADAR", "WOEK_NEWSLETTER") if os.environ.get(f"{prefix}_SMTP_{key}")), default)
    return {"host": value("HOST"), "port": int(value("PORT", "587")), "user": value("USER"), "password": value("PASSWORD"), "from": value("FROM")}


def participant_calendar_key(reference, secret):
    return hmac.new(secret.encode(), ("participant-calendar-v1:" + reference).encode(), hashlib.sha256).hexdigest()


def participant_calendar(row):
    """Public-safe event data only; no owner links, contact fields or request ID."""
    from icalendar import Calendar, Event
    if row["status"] != "confirmed" or not re.fullmatch(r"[a-f0-9]{16}", row["id"]):
        raise ValueError("Participant calendar requires a confirmed request")
    payload = json.loads(row["payload"])
    if payload["channel"] not in ("phone", "discord"):
        raise ValueError("Unknown conversation channel")
    start, end = parse(row["start"]), parse(row["end"])
    if end <= start:
        raise ValueError("Invalid conversation interval")
    title = "Gespräch mit Natalie Weber"
    location = "Telefon" if payload["channel"] == "phone" else "Discord-Sprachanruf"
    profile = "https://wirkungsoekonomie.de/w/natalie-weber/"
    # Domain-separated opaque identifier: stable for this request, never its raw ID.
    uid = hashlib.sha256(("woek-participant-calendar-v1:" + row["id"]).encode("ascii")).hexdigest()
    calendar = Calendar()
    calendar.add("prodid", "-//Wirkungsoekonomie//Teilnehmertermin//DE")
    calendar.add("version", "2.0")
    calendar.add("method", "PUBLISH")
    event = Event()
    event.add("uid", uid + "@wirkungsoekonomie.de")
    event.add("dtstamp", parse(row["created"]))
    event.add("dtstart", start)
    event.add("dtend", end)
    event.add("summary", title)
    event.add("location", location)
    event.add("url", profile)
    event.add("class", "PRIVATE")
    event.add("status", "CONFIRMED")
    calendar.add_component(event)
    google = "https://calendar.google.com/calendar/render?" + urllib.parse.urlencode({
        "action": "TEMPLATE", "text": title, "dates": start.strftime("%Y%m%dT%H%M%SZ") + "/" + end.strftime("%Y%m%dT%H%M%SZ"),
        "details": profile, "location": location, "ctz": "UTC"})
    outlook = urllib.parse.urlencode({"allday": "false", "body": profile,
        "enddt": iso(end), "path": "/calendar/action/compose", "rru": "addevent",
        "startdt": iso(start), "subject": title, "location": location})
    links = [{"label": "Google Kalender", "url": google},
             {"label": "Outlook / Microsoft 365", "url": "https://outlook.office.com/calendar/deeplink/compose?" + outlook},
             {"label": "Outlook.com", "url": "https://outlook.live.com/calendar/deeplink/compose?" + outlook}]
    result = {"ics": calendar.to_ical().decode("utf-8"), "links": links}
    secret = os.environ.get("BOOKING_SECRET", "")
    if len(secret) >= 32:
        result["download"] = "https://institut.wirkungsoekonomie.de/kalender/" + participant_calendar_key(row["id"], secret)
    return result


def confirmation_notice(row):
    payload = json.loads(row["payload"])
    date = parse(row["start"]).astimezone(ZONE).strftime("%d.%m.%Y um %H:%M")
    status = row["status"]
    if status == "confirmed":
        subject = "Bestätigung deines Gesprächstermins mit Natalie Weber"
        contact = (f"Ich rufe dich unter {payload['phone']} an." if payload["channel"] == "phone"
                   else f"Wir sprechen per Discord-Sprachanruf (nur Audio). Dein Benutzername: {payload['discord']}.")
        text = (f"hiermit bestätige ich unser Gespräch am {date} Uhr (Europe/Berlin) für 30 Minuten.\n"
                f"{contact}\nFalls du verhindert bist, gib mir bitte Bescheid.")
    elif status == "cancelled":
        subject = "Absage deines Gesprächstermins mit Natalie Weber"
        text = f"leider muss ich unseren Gesprächstermin am {date} Uhr (Europe/Berlin) absagen."
    elif status == "declined":
        subject = "Antwort auf deine Gesprächsanfrage an Natalie Weber"
        text = f"vielen Dank für deine Anfrage. Den gewünschten Gesprächstermin am {date} Uhr (Europe/Berlin) kann ich leider nicht zusagen."
    else:
        raise ValueError("Reply requires a decided request")
    calendar = participant_calendar(row) if status == "confirmed" else None
    intro = text
    if calendar:
        text += "\n\nIn deinen Kalender übernehmen:\n" + "\n".join(item["label"] + ": " + item["url"] for item in calendar["links"])
        if calendar.get("download"):
            text += "\nApple Kalender / Kalenderdatei: " + calendar["download"]
        if payload["replyVia"] == "email":
            text += "\nFür Apple Kalender/iCloud, Exchange oder andere Kalender öffne die angehängte Datei gespraech-natalie-weber.ics."
        text += "\nPrüfe den Termin und speichere ihn in deinem Kalender. Ein importierter Eintrag wird bei Änderungen oder einer Absage nicht automatisch aktualisiert."
    result = {"email": payload["email"], "reference": row["id"],
              "kind": status, "subject": subject,
              "body": f"Hallo {payload['name']},\n\n{text}\n\nViele Grüße\nNatalie Weber"}
    if calendar:
        result["calendar"] = calendar
        buttons = []
        for item in calendar["links"][:2]:
            label = "Outlook / Teams" if "outlook.office.com" in item["url"] else "Google Kalender"
            buttons.append((label, item["url"]))
        if calendar.get("download"):
            buttons.append(("Apple Kalender", calendar["download"]))
        links_html = " ".join('<a style="display:inline-block;margin:0 8px 10px 0;padding:12px 18px;background:#175541;color:#ffffff;border-radius:6px;text-decoration:none;font-weight:bold" href="' + html.escape(url, quote=True) + '">' + label + '</a>' for label, url in buttons)
        result["html"] = ('<!doctype html><html lang="de"><body style="font-family:Arial,sans-serif;font-size:16px;line-height:1.6;color:#20362d;background:#ffffff">'
            '<div style="max-width:620px;margin:24px auto;padding:24px">'
            '<p>Hallo ' + html.escape(payload['name']) + ',</p><p>' + html.escape(intro).replace('\n', '<br>') + '</p>'
            '<h2 style="font-size:20px">In deinen Kalender übernehmen</h2><p>' + links_html + '</p>'
            '<p>Kalender auswählen, Termin prüfen und speichern.</p>'
            '<p style="font-size:14px">Privates Microsoft-Konto? <a href="' + html.escape(calendar['links'][2]['url'], quote=True) + '">Outlook.com öffnen</a>. '
            'Alternativ die angehängte Datei gespraech-natalie-weber.ics öffnen.</p>'
            '<p style="font-size:14px">Wir sprechen per Telefon oder Discord-Audio. Ein importierter Eintrag wird bei Änderungen oder einer Absage nicht automatisch aktualisiert.</p>'
            '<p>Viele Grüße<br>Natalie Weber</p></div></body></html>')
    return result


def send_confirmation(notice):
    config = smtp_config()
    if not all(config.values()) or config["port"] != 587 or config["from"].strip().casefold() != "wirkungscheck@wirkungsoekonomie.de":
        raise RuntimeError("Booking confirmation sender is not configured")
    message = EmailMessage()
    message["Subject"] = notice["subject"]
    message["From"], message["To"] = config["from"], notice["email"]
    kind = notice.get("kind", "confirmed")
    if kind not in ("confirmed", "declined", "cancelled"):
        raise RuntimeError("Unknown booking message kind")
    tag = {"confirmed": "confirm", "declined": "decline", "cancelled": "cancel"}[kind]
    message["Message-ID"] = f"<booking-{tag}-{notice['reference']}@wirkungsoekonomie.de>"
    message["Auto-Submitted"] = "auto-generated"
    message["X-Auto-Response-Suppress"] = "All"
    message.set_content(notice["body"])
    if kind == "confirmed" and isinstance(notice.get("html"), str):
        message.add_alternative(notice["html"], subtype="html")
    # Legacy queued notices have no calendar member and remain sendable unchanged.
    if kind == "confirmed" and notice.get("calendar") is not None:
        calendar = notice["calendar"]
        if not isinstance(calendar, dict) or not isinstance(calendar.get("ics"), str) or not 0 < len(calendar["ics"]) <= 16384:
            raise ValueError("Invalid participant calendar attachment")
        message.add_attachment(calendar["ics"], subtype="calendar", params={"method": "PUBLISH"},
                               filename="gespraech-natalie-weber.ics")
    with smtplib.SMTP(config["host"], config["port"], timeout=15) as smtp:
        smtp.ehlo()
        smtp.starttls(context=ssl.create_default_context())
        smtp.ehlo()
        smtp.login(config["user"], config["password"])
        smtp.send_message(message)


def deliver_confirmation(store, now, sender=send_confirmation):
    with store.transaction() as db:
        store.cleanup(db, now)
        row = db.execute("""SELECT * FROM requests WHERE verification IS NOT NULL AND verify_at<=? AND
            ((status='confirmed' AND calendar_state='synced' AND confirmation_sent='email_queued' AND
              (json_extract(verification, '$.kind') IS NULL OR json_extract(verification, '$.kind')='confirmed')) OR
             (status='declined' AND calendar_state='none' AND decline_sent='email_queued' AND json_extract(verification, '$.kind')='declined') OR
             (status='cancelled' AND calendar_state='none' AND cancel_sent='email_queued' AND json_extract(verification, '$.kind')='cancelled'))
            ORDER BY created LIMIT 1""", (iso(now),)).fetchone()
        if row is None:
            return False
        field = {"confirmed": "confirmation_sent", "declined": "decline_sent", "cancelled": "cancel_sent"}[row["status"]]
        # Claim before SMTP; a crash or uncertain acceptance is never retried.
        db.execute(f"UPDATE requests SET {field}='email_hold', verify_at=NULL WHERE id=?", (row["id"],))
    try:
        sender(json.loads(row["verification"]))
    except Exception:
        return False
    with store.transaction() as db:
        current = db.execute(f"SELECT status, {field} FROM requests WHERE id=?", (row["id"],)).fetchone()
        if current is None or current["status"] != row["status"] or current[field] != "email_hold":
            raise RuntimeError("Confirmation delivery requires reconciliation")
        db.execute(f"UPDATE requests SET {field}=?, verification=NULL WHERE id=?", (iso(now), row["id"]))
    return True


def send_verification(notice):
    config = smtp_config()
    if not all(config.values()) or config["port"] != 587:
        raise RuntimeError("SMTP configuration with STARTTLS on port 587 required")
    message = EmailMessage()
    message["Subject"] = "Bitte bestätige deine Gesprächsanfrage an Natalie Weber"
    message["From"], message["To"] = config["from"], notice["email"]
    message["Message-ID"] = f"<booking-verify-{notice['reference']}@wirkungsoekonomie.de>"
    message["Auto-Submitted"] = "auto-generated"
    message["X-Auto-Response-Suppress"] = "All"
    date = parse(notice["start"]).astimezone(ZONE).strftime("%d.%m.%Y um %H:%M")
    message.set_content(f"Bitte bestätige deine Anfrage für ein 30-minütiges Gespräch am {date} Uhr (Europe/Berlin):\n\n{notice['url']}\n\nÖffne den Link und klicke dort auf „Anfrage bestätigen“. Der Link gilt 72 Stunden ab deiner Anfrage.\n\nErst danach erhält Natalie deine Anfrage zur persönlichen Prüfung. Dies ist noch keine Terminzusage.\n\nFalls du diese Anfrage nicht gestellt hast, ignoriere diese Nachricht.\n")
    with smtplib.SMTP(config["host"], config["port"], timeout=15) as smtp:
        smtp.ehlo()
        smtp.starttls(context=ssl.create_default_context())
        smtp.ehlo()
        smtp.login(config["user"], config["password"])
        smtp.send_message(message)


def deliver_verification(store, now, sender=send_verification):
    with store.transaction() as db:
        store.cleanup(db, now)
        row = db.execute("SELECT * FROM requests WHERE status='unverified' AND json_extract(payload, '$.channel')='phone' AND verification IS NOT NULL AND verify_at<=? ORDER BY created LIMIT 1", (iso(now),)).fetchone()
        if row is None:
            return False
        # SMTP does not guarantee deduplication on Message-ID. Persist a hold
        # before submission to survive a crash after provider acceptance.
        db.execute("UPDATE requests SET verify_at=NULL, verify_attempts=verify_attempts+1 WHERE id=?", (row["id"],))
    try:
        sender(json.loads(row["verification"]))
    except Exception:
        # Preserve the verification and do not resend an uncertain result.
        return False
    with store.transaction() as db:
        db.execute("UPDATE requests SET verification=NULL WHERE id=?", (row["id"],))
    return True


def discord_identity(code, redirect_uri, fetch=urllib.request.urlopen):
    client_id, client_secret = os.environ.get("DISCORD_CLIENT_ID"), os.environ.get("DISCORD_CLIENT_SECRET")
    if not client_id or not client_secret:
        raise RuntimeError("Discord OAuth configuration missing")
    body = urllib.parse.urlencode({"client_id": client_id, "client_secret": client_secret, "grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri}).encode()
    request = urllib.request.Request("https://discord.com/api/oauth2/token", data=body, headers={"Content-Type": "application/x-www-form-urlencoded"})
    with fetch(request, timeout=15) as response:
        tokens = json.load(response)
    access_token = tokens["access_token"]
    try:
        request = urllib.request.Request("https://discord.com/api/v10/users/@me", headers={"Authorization": f"Bearer {access_token}"})
        with fetch(request, timeout=15) as response:
            profile = json.load(response)
        if profile.get("bot") or not str(profile.get("id", "")).isdigit() or not isinstance(profile.get("username"), str):
            raise RuntimeError("Discord did not return a human user")
        return {"id": str(profile["id"]), "username": profile["username"]}
    finally:
        # Only identity is retained. No refresh/access tokens, DMs, contacts or guild lists.
        revoke = urllib.parse.urlencode({"client_id": client_id, "client_secret": client_secret, "token": access_token, "token_type_hint": "access_token"}).encode()
        try:
            with fetch(urllib.request.Request("https://discord.com/api/oauth2/token/revoke", data=revoke, headers={"Content-Type": "application/x-www-form-urlencoded"}), timeout=15):
                pass
        except Exception:
            pass
