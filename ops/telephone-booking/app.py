import json
import os
import secrets
import hmac
from datetime import timedelta
from pathlib import Path
from urllib.parse import urlparse, urlencode
from flask import Flask, Response, jsonify, render_template, request, redirect
from werkzeug.exceptions import HTTPException
from booking import BookingError, Store, RULES, booking_horizon, calendar_file, iso, now_utc, parse, validate, expiry_binding, recovery_phase
from integrations import ICloud, confirmation_notice, discord_identity, smtp_config, participant_calendar, participant_calendar_key


def create_app(config=None, calendar=None, clock=now_utc, identify=discord_identity):
    app = Flask(__name__)
    app.config.update(
        MAX_CONTENT_LENGTH=24_000,
        BOOKING_CRM_TOKEN=os.environ.get("BOOKING_CRM_TOKEN", ""),
        BOOKING_ENABLED=os.environ.get("BOOKING_ENABLED") == "1",
        BOOKING_ORIGIN=os.environ.get("BOOKING_ORIGIN", "https://wirkungsoekonomie.de"),
        BOOKING_FRONTEND_ORIGIN=os.environ.get("BOOKING_FRONTEND_ORIGIN", ""),
        BOOKING_DB=os.environ.get("BOOKING_DB", "/var/lib/woek-telephone-booking/booking.sqlite3"),
        BOOKING_SECRET=os.environ.get("BOOKING_SECRET", ""),
        TRUST_PROXY=os.environ.get("BOOKING_TRUST_PROXY") == "1",
    )
    if config:
        app.config.update(config)
    if len(app.config["BOOKING_SECRET"]) < 32:
        raise RuntimeError("BOOKING_SECRET must contain at least 32 random characters")
    origin = app.config["BOOKING_ORIGIN"].rstrip("/")
    parsed = urlparse(origin)
    if parsed.scheme != "https" and not app.testing:
        raise RuntimeError("A production HTTPS origin is required")
    if parsed.path or parsed.query or parsed.fragment or parsed.username or not parsed.netloc:
        raise RuntimeError("BOOKING_ORIGIN must be an origin without path or credentials")
    app.config["BOOKING_ORIGIN"] = origin
    frontend_origin = (app.config["BOOKING_FRONTEND_ORIGIN"] or origin).rstrip("/")
    frontend = urlparse(frontend_origin)
    if ((frontend.scheme != "https" and not app.testing) or frontend.path or
            frontend.query or frontend.fragment or frontend.username or not frontend.netloc):
        raise RuntimeError("BOOKING_FRONTEND_ORIGIN must be an HTTPS origin without path or credentials")
    # Never let the database be placed in a public repository/artifact directory.
    if Path(app.config["BOOKING_DB"]).resolve().is_relative_to(Path(__file__).resolve().parents[2]):
        raise RuntimeError("BOOKING_DB must be outside the repository")
    store = Store(app.config["BOOKING_DB"], app.config["BOOKING_SECRET"])
    calendar = calendar or ICloud()
    app.extensions["booking_store"] = store
    prefix = "/api/telephone-booking"
    cookie_prefix = "woek" if app.testing else "__Secure-woek"

    @app.before_request
    def protect():
        if request.path.startswith("/internal/crm"):
            request.max_content_length = 32_000
            return None
        # The first-party phone page can only read/confirm a verification token.
        # Owner management and Discord OAuth keep their existing API-origin gate.
        verification_path = request.path == prefix + "/verify/request"
        if request.method == "OPTIONS" and request.path in (prefix + "/requests", prefix + "/verify/request"):
            methods = {"GET", "POST"} if verification_path else {"POST"}
            allowed_headers = {"authorization", "content-type"} if verification_path else {"content-type"}
            if (request.headers.get("Origin") != frontend_origin or
                    request.headers.get("Access-Control-Request-Method") not in methods or
                    set(h.strip().lower() for h in request.headers.get("Access-Control-Request-Headers", "").split(",") if h.strip()) - allowed_headers):
                raise BookingError("Nicht erlaubte Anfrage.", 403)
            response = Response(status=204)
            response.headers["Access-Control-Allow-Methods"] = "GET, POST" if verification_path else "POST"
            response.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type" if verification_path else "Content-Type"
            return response
        if verification_path and request.method == "GET" and request.headers.get("Origin") not in (None, origin, frontend_origin):
            raise BookingError("Nicht erlaubte Anfrage.", 403)
        if request.method == "POST":
            allowed_origins = {frontend_origin} if request.path == prefix + "/requests" else {origin}
            if verification_path:
                allowed_origins.add(frontend_origin)
            if request.headers.get("Origin") not in allowed_origins or not request.is_json:
                raise BookingError("Die Anfrage stammt nicht von der Buchungsseite. Bitte lade sie neu.", 403)

    @app.after_request
    def headers(response):
        if request.path in (prefix + "/slots", prefix + "/requests", prefix + "/verify/request"):
            response.headers.add("Vary", "Origin")
            if request.headers.get("Origin") == frontend_origin:
                response.headers["Access-Control-Allow-Origin"] = frontend_origin
        response.headers["Cache-Control"] = "no-store"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-Robots-Tag"] = "noindex, nofollow, noarchive"
        response.headers["Content-Security-Policy"] = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
        return response

    @app.errorhandler(BookingError)
    def booking_error(error):
        return jsonify(error=str(error)), error.status

    @app.errorhandler(HTTPException)
    def http_error(error):
        return jsonify(error="Die Anfrage konnte nicht verarbeitet werden. Bitte prüfe deine Angaben."), error.code

    @app.errorhandler(Exception)
    def server_error(error):
        # No exception body, request body, contacts, credentials or calendar data in logs.
        app.logger.error("Booking operation failed: %s", type(error).__name__)
        return jsonify(error="Der Termindienst ist vorübergehend nicht verfügbar. Bitte versuche es später erneut."), 503

    def require_booking_enabled():
        if not app.config["BOOKING_ENABLED"]:
            raise BookingError("Die Terminanfrage ist noch nicht freigeschaltet.", 503)

    def require_enabled():
        require_booking_enabled()
        if not app.testing and not calendar.enabled:
            raise BookingError("Die Kalenderprüfung ist vorübergehend nicht verfügbar. Bitte versuche es später erneut.", 503)
        if not app.testing and not (os.environ.get("DISCORD_BOT_TOKEN") and os.environ.get("DISCORD_REVIEW_RECIPIENT_USER_ID")):
            raise BookingError("Die Terminanfrage ist vorübergehend nicht verfügbar.", 503)
        if not app.testing and not store.worker_ready(clock()):
            raise BookingError("Die Zustellung von Terminanfragen ist vorübergehend nicht verfügbar. Bitte versuche es später erneut.", 503)

    def token():
        authorization = request.headers.get("Authorization", "")
        return authorization[7:] if authorization.startswith("Bearer ") else ""

    def cleanup_before_private_read():
        # Keep expiry and retention cleanup committed even when a subsequent
        # lookup rejects an expired or invalid token and returns 404.
        with store.transaction() as db:
            store.cleanup(db, clock())

    def view(row):
        recovery = recovery_phase(row, clock())
        payload = json.loads(row["payload"])
        field = {"confirmed": "confirmation_sent", "declined": "decline_sent", "cancelled": "cancel_sent"}.get(row["status"])
        sent = row[field] if field else None
        delivery = ("queued" if sent == "email_queued" else
                    "unknown" if sent == "email_hold" else
                    "sent" if sent else "not_sent")
        preview = confirmation_notice(row) if field else None
        return {"reference": row["id"], "payload": payload, "status": recovery or row["status"], "expires": iso(expiry_binding(row)[2]) if recovery else row["expires"], "recoveryRequired": bool(recovery), "calendarState": row["calendar_state"], "confirmationSent": sent if delivery == "sent" else None, "confirmationDelivery": delivery, "confirmationPreview": preview, "notificationSent": row["notification_sent"], "verified": row["verified"], "discordVerified": row["discord_verified"]}

    @app.get(prefix + "/health")
    def health():
        with store.transaction() as db:
            db.execute("SELECT 1")
        ready = app.testing or (calendar.enabled and store.worker_ready(clock()))
        return jsonify(status="ok" if ready else "degraded", acceptingRequests=app.config["BOOKING_ENABLED"] and ready), 200 if ready else 503

    @app.get(prefix + "/slots")
    def available():
        require_enabled()
        now = clock()
        busy = calendar.busy(now, booking_horizon(now) + timedelta(days=1))
        channels = ["phone"]
        if os.environ.get("DISCORD_CLIENT_ID") and os.environ.get("DISCORD_CLIENT_SECRET"):
            channels.append("discord")
        return jsonify(timezone=RULES["timezone"], durationMinutes=RULES["durationMinutes"], slots=store.available(now, busy), supportedChannels=channels)

    @app.post(prefix + "/requests")
    def create():
        require_enabled()
        now = clock()
        payload = validate(request.get_json(), now)
        if not app.testing:
            if payload["channel"] == "phone" and not all(smtp_config().values()):
                raise BookingError("Die E-Mail-Bestätigung ist derzeit nicht verfügbar. Bitte versuche es später erneut.", 503)
            if payload["channel"] == "discord" and not (os.environ.get("DISCORD_CLIENT_ID") and os.environ.get("DISCORD_CLIENT_SECRET")):
                raise BookingError("Die Discord-Anmeldung ist derzeit nicht verfügbar. Bitte versuche es später erneut.", 503)
        busy = calendar.busy(parse(payload["start"]), parse(payload["end"]))
        if any(parse(payload["start"]) < end and parse(payload["end"]) > start for start, end in busy):
            raise BookingError("Dieser Termin ist inzwischen belegt. Bitte wähle einen anderen Termin.", 409)
        # Reverse proxy must overwrite X-Real-IP; never trust arbitrary X-Forwarded-For.
        ip = request.headers.get("X-Real-IP", request.remote_addr) if app.config["TRUST_PROXY"] else request.remote_addr
        reference, verify_url, state = store.create(payload, ip or "unknown", now, origin + prefix)
        return jsonify(reference=reference, status=state, verification="discord" if payload["channel"] == "discord" else "email", verificationUrl=verify_url), 202

    @app.get(prefix + "/verify")
    def verify_page():
        return render_template("verify.html", profile_url=frontend_origin + "/w/natalie-weber/#gespraech")

    @app.get(prefix + "/verify.js")
    def verify_script():
        return Response((Path(__file__).parent / "static/verify.js").read_text(), mimetype="application/javascript")

    def verification_view(row):
        recovery = recovery_phase(row, clock())
        payload = json.loads(row["payload"])
        return {"reference": row["id"], "start": row["start"], "channel": payload["channel"], "status": recovery or row["status"], "recoveryRequired": bool(recovery), "discord": payload["discord"] if row["discord_verified"] else None, "discordVerified": bool(row["discord_verified"])}

    def require_verification_channel(row):
        if (frontend_origin != origin and request.headers.get("Origin") == frontend_origin and
                json.loads(row["payload"])["channel"] != "phone"):
            raise BookingError("Bitte öffne für diese Anfrage den ursprünglichen Bestätigungslink.", 403)

    @app.get(prefix + "/verify/request")
    def verify_detail():
        cleanup_before_private_read()
        with store.transaction() as db:
            row = store.verification_request(db, token(), clock())
            require_verification_channel(row)
            return jsonify(verification_view(row))

    @app.post(prefix + "/verify/request")
    def verify_request():
        require_enabled()
        now = clock()
        with store.transaction() as db:
            store.verification_request(db, token(), now)
            store.require_no_calendar_hold(db)
            store.cleanup(db, now)
            row = store.verification_request(db, token(), now)
            require_verification_channel(row)
            if row["status"] == "expired" and recovery_phase(row, now) == "unverified":
                row = store.reactivate(db, row, now, "unverified")
            if row["status"] == "unverified":
                busy = calendar.busy(parse(row["start"]), parse(row["end"]))
                if any(parse(row["start"]) < end and parse(row["end"]) > start for start, end in busy):
                    raise BookingError("Dieser Termin ist inzwischen belegt. Bitte frage einen neuen Termin an.", 409)
            store.verify(db, row, now, origin + prefix)
            return jsonify(verification_view(store.verification_request(db, token(), now)))

    @app.post(prefix + "/discord/start")
    def oauth_start():
        require_enabled()
        now = clock()
        with store.transaction() as db:
            store.verification_request(db, token(), now)
            store.require_no_calendar_hold(db)
            store.cleanup(db, now)
            row = store.verification_request(db, token(), now)
            if row["status"] == "expired" and recovery_phase(row, now) == "unverified":
                row = store.reactivate(db, row, now, "unverified")
            if row["status"] != "unverified" or json.loads(row["payload"])["channel"] != "discord":
                raise BookingError("Für diese Anfrage ist keine Discord-Anmeldung erforderlich.", 409)
            client_id = os.environ.get("DISCORD_CLIENT_ID")
            if not client_id:
                raise BookingError("Die Discord-Anmeldung ist derzeit nicht verfügbar.", 503)
            state = secrets.token_urlsafe(32)
            db.execute("UPDATE requests SET oauth_state_hash=? WHERE id=?", (store.digest(state), row["id"]))
        url = "https://discord.com/oauth2/authorize?" + urlencode({"client_id": client_id, "response_type": "code", "scope": "identify", "redirect_uri": origin + prefix + "/discord/callback", "state": state, "prompt": "consent"})
        response = jsonify(url=url)
        for name, value in (("state", state), ("verify", token())):
            response.set_cookie(f"{cookie_prefix}-{name}", value, max_age=1800, secure=not app.testing, httponly=True, samesite="Lax", path=prefix)
        return response

    @app.get(prefix + "/discord/callback")
    def oauth_callback():
        # An OAuth redirect may return after the service has been disabled.
        # Do not consume its state or contact Discord while booking is closed.
        require_booking_enabled()
        state = request.args.get("state", "")
        cookie_state = request.cookies.get(f"{cookie_prefix}-state", "")
        verify_token = request.cookies.get(f"{cookie_prefix}-verify", "")
        if not state or not cookie_state or not hmac.compare_digest(state, cookie_state):
            raise BookingError("Discord-Anmeldung konnte nicht zugeordnet werden. Bitte öffne deinen Bestätigungslink erneut.", 403)
        with store.transaction() as db:
            store.require_no_calendar_hold(db)
            store.cleanup(db, clock())
            row = store.verification_request(db, verify_token)
            if row["status"] != "unverified" or not row["oauth_state_hash"] or not hmac.compare_digest(row["oauth_state_hash"], store.digest(state)):
                raise BookingError("Diese Discord-Anmeldung ist ungültig oder bereits abgeschlossen.", 403)
            db.execute("UPDATE requests SET oauth_state_hash=NULL WHERE id=?", (row["id"],))
        if request.args.get("code") and not request.args.get("error"):
            profile = identify(request.args["code"], origin + prefix + "/discord/callback")
            with store.transaction() as db:
                store.require_no_calendar_hold(db)
                row = store.verification_request(db, verify_token)
                if row["status"] != "unverified" or parse(row["expires"]) <= clock():
                    raise BookingError("Die Bestätigungsfrist ist abgelaufen. Bitte frage einen neuen Termin an.", 409)
                payload = json.loads(row["payload"])
                payload.update(discord=profile["username"], discordId=profile["id"])
                db.execute("UPDATE requests SET payload=?, discord_verified=? WHERE id=?", (json.dumps(payload, ensure_ascii=False), iso(clock()), row["id"]))
        response = redirect(prefix + "/verify#" + verify_token, code=303)
        for name in ("state", "verify"):
            response.delete_cookie(f"{cookie_prefix}-{name}", path=prefix, secure=not app.testing, httponly=True, samesite="Lax")
        return response

    @app.get(prefix + "/manage")
    def manage():
        return render_template("manage.html")

    @app.get(prefix + "/manage.js")
    def manage_script():
        return Response((Path(__file__).parent / "static/manage.js").read_text(), mimetype="application/javascript")

    @app.get(prefix + "/manage.css")
    def manage_style():
        return Response((Path(__file__).parent / "static/manage.css").read_text(), mimetype="text/css")

    @app.get(prefix + "/manage/request")
    def detail():
        cleanup_before_private_read()
        with store.transaction() as db:
            return jsonify(view(store.authorized(db, token())))

    @app.post(prefix + "/manage/request")
    def decision():
        data = request.get_json()
        if not isinstance(data, dict) or data.get("action") not in ("approve", "decline", "cancel", "sent", "send_confirmation_email"):
            raise BookingError("Bitte wähle eine gültige Aktion.")
        now, action = clock(), data["action"]
        # Disabling booking stops new commitments. Owner-initiated decline,
        # cancellation, and acknowledgements remain available, so existing
        # users are not stranded and synced calendars can be reconciled.
        if action in ("approve", "send_confirmation_email"):
            require_booking_enabled()
        # Reserve the operation durably *before* any calendar write. A crash,
        # timeout, provider error or local commit failure leaves a hold rather
        # than automatically issuing another PUT or DELETE.
        with store.transaction() as db:
            store.authorized(db, token())
            store.cleanup(db, now)
            row = store.authorized(db, token())
            if action == "approve" and row["status"] == "expired":
                row = store.reactivate(db, row, now, "pending")
            if row["calendar_state"].endswith("_hold"):
                raise BookingError("Die letzte Kalenderaktion muss zuerst persönlich geprüft werden. Bitte nicht erneut auslösen.", 409)
            if action in ("cancel", "sent") and row["confirmation_sent"] in ("email_queued", "email_hold"):
                raise BookingError("Der E-Mail-Versand muss zuerst abgeschlossen oder persönlich geklärt werden.", 409)
            if action == "send_confirmation_email":
                if data.get("expectedStatus") != row["status"]:
                    raise BookingError("Der Status hat sich geändert. Bitte lade die Anfrage und die Antwortvorschau neu.", 409)
                field = {"confirmed": "confirmation_sent", "declined": "decline_sent", "cancelled": "cancel_sent"}.get(row["status"])
                allowed_calendar = (row["status"] == "confirmed" and row["calendar_state"] == "synced") or (row["status"] in ("declined", "cancelled") and row["calendar_state"] == "none")
                if not field or not allowed_calendar or json.loads(row["payload"])["replyVia"] != "email":
                    raise BookingError("Eine E-Mail-Bestätigung ist für diese Anfrage nicht verfügbar.", 409)
                if row[field]:
                    return jsonify(view(row))
                config = smtp_config()
                if not all(config.values()) or config["port"] != 587 or config["from"].strip().casefold() != "wirkungscheck@wirkungsoekonomie.de":
                    raise BookingError("Der Versand über das bestätigte Postfach ist derzeit nicht verfügbar.", 503)
                if row["verification"] is not None:
                    raise BookingError("Eine vorherige Zustellung muss zuerst persönlich geprüft werden.", 409)
                db.execute(f"UPDATE requests SET {field}='email_queued', verification=?, verify_at=? WHERE id=?", (json.dumps(confirmation_notice(row), ensure_ascii=False), iso(now), row["id"]))
                return jsonify(view(store.authorized(db, token())))
            if action == "approve":
                if row["status"] == "confirmed":
                    return jsonify(view(row))
                if row["status"] != "pending" or parse(row["start"]) <= now:
                    raise BookingError("Diese Anfrage ist nicht mehr offen. Bitte einen neuen Termin vereinbaren.", 409)
                if row["calendar_state"] != "none":
                    raise RuntimeError("Unexpected calendar state")
                # The public flow promises a real calendar reservation. Do not
                # create a new commitment in the legacy manual-only mode.
                if not calendar.enabled:
                    raise BookingError("Der Kalender ist derzeit nicht verbunden. Bitte versuche es später erneut.", 503)
                expected_hold = "approve_hold"
                db.execute("UPDATE requests SET calendar_state='approve_hold' WHERE id=?", (row["id"],))
            elif action in ("decline", "cancel"):
                target = "declined" if action == "decline" else "cancelled"
                if row["status"] == target:
                    return jsonify(view(row))
                expected = "pending" if action == "decline" else "confirmed"
                if row["status"] != expected:
                    raise BookingError("Der Status der Anfrage hat sich geändert. Bitte lade sie neu.", 409)
                if action == "decline":
                    if row["calendar_state"] != "none":
                        raise RuntimeError("Unexpected calendar state")
                    # A pending, never-synced request has no calendar event to
                    # delete. Decline it atomically without a provider call.
                    db.execute("UPDATE requests SET status='declined', closed=?, notification=NULL, calendar_state='none' WHERE id=?", (iso(now), row["id"]))
                    return jsonify(view(store.authorized(db, token())))
                else:
                    if row["calendar_state"] not in ("manual", "synced"):
                        raise RuntimeError("Unexpected calendar state")
                    expected_hold = "cancel_" + row["calendar_state"] + "_hold"
                db.execute("UPDATE requests SET calendar_state=? WHERE id=?", (expected_hold, row["id"]))
            else:
                if row["status"] not in ("confirmed", "declined", "cancelled"):
                    raise BookingError("Bitte entscheide zuerst über die Anfrage.", 409)
                field = {"confirmed": "confirmation_sent", "declined": "decline_sent", "cancelled": "cancel_sent"}[row["status"]]
                if row[field] in ("email_queued", "email_hold"):
                    raise BookingError("Der E-Mail-Versand muss zuerst abgeschlossen oder persönlich geklärt werden.", 409)
                db.execute(f"UPDATE requests SET {field}=? WHERE id=?", (iso(now), row["id"]))
                return jsonify(view(store.authorized(db, token())))

        if action == "approve":
            calendar_state = calendar.confirm(row)
            if calendar_state != "synced":
                # A provider/configuration change between the preflight and
                # confirmation must not turn a calendar request into a manual
                # confirmation. Keep the durable hold for reconciliation.
                raise RuntimeError("Calendar confirmation not synchronized")
        else:
            calendar.cancel(row)

        with store.transaction() as db:
            current = store.authorized(db, token())
            if current["id"] != row["id"] or current["status"] != row["status"] or current["calendar_state"] != expected_hold:
                raise RuntimeError("Calendar operation requires reconciliation")
            if action == "approve":
                db.execute("UPDATE requests SET status='confirmed', calendar_state=?, notification=NULL WHERE id=?", (calendar_state, row["id"]))
            else:
                db.execute("UPDATE requests SET status=?, closed=?, notification=NULL, calendar_state='none' WHERE id=?", (target, iso(now), row["id"]))
            return jsonify(view(store.authorized(db, token())))

    @app.get(prefix + "/manage/calendar.ics")
    def ics():
        cleanup_before_private_read()
        with store.transaction() as db:
            row = store.authorized(db, token())
            if row["status"] != "confirmed" or row["calendar_state"].endswith("_hold"):
                raise BookingError("Kalendereinträge stehen erst nach deiner Zusage bereit.", 409)
        return Response(calendar_file(row), mimetype="text/calendar", headers={"Content-Disposition": 'attachment; filename="gespraech-nats.ics"'})

    @app.get(prefix + "/calendar/<key>.ics")
    def participant_calendar_download(key):
        import re
        if not re.fullmatch(r"[a-f0-9]{64}", key):
            raise BookingError("Kalenderdatei nicht verfügbar.", 404)
        with store.transaction() as db:
            rows = db.execute("SELECT * FROM requests WHERE status='confirmed' AND calendar_state='synced'").fetchall()
            row = next((r for r in rows if hmac.compare_digest(key, participant_calendar_key(r["id"], app.config["BOOKING_SECRET"]))), None)
        if row is None:
            raise BookingError("Dieser Termin ist nicht mehr für den Kalenderimport verfügbar.", 404)
        return Response(participant_calendar(row)["ics"], mimetype="text/calendar", headers={"Content-Disposition": 'attachment; filename="gespraech-natalie-weber.ics"'})

    from crm import register
    register(app, store, clock)
    return app
