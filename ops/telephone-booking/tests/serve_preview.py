"""Loopback-only synthetic browser fixture. Never run this in production."""
from datetime import datetime
import json
import os
from pathlib import Path
import sys
import tempfile
from flask import jsonify, send_from_directory, abort

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import create_app
from booking import UTC
from test_booking import FakeCalendar

root = Path(__file__).resolve().parents[3]
state = tempfile.TemporaryDirectory(prefix="woek-booking-browser-")
os.environ["DISCORD_CLIENT_ID"] = "synthetic-client"
app = create_app({"TESTING": True, "BOOKING_ENABLED": True, "BOOKING_ORIGIN": "http://127.0.0.1:8766", "BOOKING_DB": str(Path(state.name) / "test.sqlite3"), "BOOKING_SECRET": "synthetic-preview-" * 3}, calendar=FakeCalendar(), clock=lambda: datetime(2026, 11, 3, 9, tzinfo=UTC), identify=lambda code, uri: {"id": "123456789012345678", "username": "verified.synthetic"})


@app.get("/w/natalie-weber/<path:filename>")
@app.get("/w/natalie-weber/", defaults={"filename": "index.html"})
def profile(filename):
    if filename.endswith("/"):
        filename += "index.html"
    return send_from_directory(root / "w/natalie-weber", filename)


@app.get("/assets/<path:filename>")
def asset(filename):
    if not filename.startswith(("css/", "js/telephone-booking", "fonts/", "img/people/", "img/brand/")):
        abort(404)
    return send_from_directory(root / "assets", filename)


@app.get("/__test__/links/<reference>")
def fixture_links(reference):
    with app.extensions["booking_store"].transaction() as db:
        row = db.execute("SELECT notification, verification FROM requests WHERE id=?", (reference,)).fetchone()
        if not row:
            abort(404)
        return jsonify(admin=json.loads(row[0])["url"], verify=json.loads(row[1])["url"])


@app.post("/__test__/reset")
def reset_fixture():
    with app.extensions["booking_store"].transaction() as db:
        db.execute("DELETE FROM requests")
        db.execute("DELETE FROM rate_limits")
    return jsonify(ok=True)


@app.after_request
def preview_headers(response):
    # Profile uses its existing inline CSS; private API retains production CSP.
    from flask import request
    # This loopback-only fake supports both channels; production must advertise
    # Discord only after its own OAuth configuration is available.
    if request.path == "/api/telephone-booking/slots" and response.status_code == 200:
        payload = response.get_json()
        payload["supportedChannels"] = ["phone", "discord"]
        response.set_data(json.dumps(payload))
    if request.path.startswith(("/w/", "/assets/")):
        response.headers.pop("Content-Security-Policy", None)
    return response


if __name__ == "__main__":
    # Flask runs after_request handlers in reverse registration order.
    app.after_request_funcs[None].insert(0, app.after_request_funcs[None].pop())
    app.run(host="127.0.0.1", port=8766, debug=False)
