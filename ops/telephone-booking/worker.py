"""Run separately under systemd; uncertain deliveries remain on hold."""
import logging
import time
from app import create_app
from booking import now_utc, iso
from integrations import deliver_confirmation, deliver_one, deliver_verification


def run_once(store, enabled, clock=now_utc, verify=deliver_verification, notify=deliver_one, confirm=deliver_confirmation):
    # A disabled worker must not touch queued or retained personal data.
    # In particular, do not call delivery functions: they perform cleanup
    # and can claim an existing job before submitting an external message.
    if enabled is not True:
        return False
    with store.transaction() as db:
        db.execute("INSERT INTO service_meta VALUES ('worker_heartbeat',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (iso(clock()),))
    delivered = verify(store, clock())
    delivered = notify(store, clock()) or delivered
    delivered = confirm(store, clock()) or delivered
    return delivered


def main():
    app = create_app()
    store = app.extensions["booking_store"]
    # systemd EnvironmentFile is loaded at process start. Changes require
    # stopping the running worker before changing configuration and restarting.
    enabled = app.config["BOOKING_ENABLED"]
    while True:
        try:
            if not run_once(store, enabled):
                time.sleep(15)
        except Exception as error:
            logging.error("Booking worker failure: %s", type(error).__name__)
            time.sleep(30)


if __name__ == "__main__":
    main()
