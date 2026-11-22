"""Credential setup tests use synthetic credentials and never contact Apple/Oracle."""
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch
import xml.etree.ElementTree as ET

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import setup_icloud as setup
from integrations import ICloud

CREDENTIALS = {"username": "synthetic@example.org", "password": "aaaa-bbbb-cccc-dddd"}
CALENDAR_URL = "https://p01-caldav.icloud.com/123/calendars/synthetic/"


def multistatus(properties, href="/123/calendars/synthetic/"):
    return ET.fromstring(f'<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>{href}</d:href><d:propstat><d:prop>{properties}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>')


def calendar_properties(name="Nats", privileges="<d:write/>"):
    return f'<d:displayname>{name}</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:current-user-privilege-set><d:privilege>{privileges}</d:privilege></d:current-user-privilege-set><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>'


class ICloudSetupTests(unittest.TestCase):
    def test_credential_endpoints_are_limited_to_apple_https(self):
        for url in ("http://caldav.icloud.com/", "https://caldav.icloud.com.attacker.example/", "https://attacker.example/", "https://u:p@caldav.icloud.com/", "https://caldav.icloud.com:8443/", "https://caldav.icloud.com/?token=private", "//attacker.example/"):
            with self.subTest(url=url), self.assertRaises(setup.SetupError):
                setup.apple_url(url)
        self.assertEqual(setup.apple_url("/123/calendars/synthetic/", CALENDAR_URL), CALENDAR_URL)

    def discovery(self, calendars):
        return MagicMock(side_effect=[
            (multistatus('<d:current-user-principal><d:href>/123/principal/</d:href></d:current-user-principal>'), "https://p01-caldav.icloud.com/"),
            (multistatus('<c:calendar-home-set><d:href>/123/calendars/</d:href></c:calendar-home-set>'), "https://p01-caldav.icloud.com/123/principal/"),
            (calendars, "https://p01-caldav.icloud.com/123/calendars/"),
        ])

    def test_exact_existing_writable_nats_is_discovered(self):
        request = self.discovery(multistatus(calendar_properties()))
        self.assertEqual(setup.probe_calendar(CREDENTIALS, request), CALENDAR_URL)
        self.assertEqual(request.call_args.args[-1], "1")

    def test_missing_ambiguous_read_only_calendar_is_rejected(self):
        duplicate = multistatus(calendar_properties())
        duplicate.append(multistatus(calendar_properties()).find(setup.DAV + "response"))
        for root in (multistatus(calendar_properties("Other")), multistatus(calendar_properties(privileges="<d:read/>")), multistatus(calendar_properties(privileges="<d:write-content/>")), duplicate):
            with self.subTest(root=root), self.assertRaises(setup.SetupError):
                setup.probe_calendar(CREDENTIALS, self.discovery(root))

    def test_redirect_to_non_apple_host_never_receives_credentials(self):
        error = setup.urllib.error.HTTPError("https://caldav.icloud.com/", 302, "Redirect", {"Location": "https://attacker.example/"}, None)
        opener = MagicMock()
        opener.open.side_effect = error
        with patch.object(setup.urllib.request, "build_opener", return_value=opener), self.assertRaises(setup.SetupError):
            setup.propfind("https://caldav.icloud.com/", "<d:current-user-principal/>", CREDENTIALS)
        self.assertEqual(opener.open.call_count, 1)

    def test_failed_probe_leaves_existing_credentials_untouched(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "private.env"
            target.write_bytes(b"existing configuration")
            target.chmod(0o600)
            with self.assertRaises(setup.SetupError):
                setup.install_credentials(CREDENTIALS, target, MagicMock(side_effect=setup.SetupError("ICLOUD_AUTHENTICATION_FAILED")))
            self.assertEqual(target.read_bytes(), b"existing configuration")
            self.assertEqual(list(Path(directory).iterdir()), [target])

    def test_install_and_backup_are_private_and_roundtrip(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "private.env"
            setup.install_credentials(CREDENTIALS, target, lambda _: CALENDAR_URL)
            original = target.read_bytes()
            replacement = {**CREDENTIALS, "password": "eeee-ffff-gggg-hhhh"}
            result = setup.install_credentials(replacement, target, lambda _: CALENDAR_URL)
            backup = target.with_suffix(".env.backup")
            self.assertEqual(backup.read_bytes(), original)
            self.assertEqual(setup.read_credentials(target), replacement)
            for path in (target, backup):
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertNotIn(replacement["password"], json.dumps(result))
            self.assertFalse(result["services_restarted"])
            self.assertFalse(result["calendar_events_changed"])

    def test_symlinks_and_shared_permission_files_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            original = Path(directory) / "original"
            original.write_bytes(b"unchanged")
            original.chmod(0o644)
            link = Path(directory) / "link"
            link.symlink_to(original)
            for path in (original, link):
                with self.assertRaises(setup.SetupError):
                    setup.install_credentials(CREDENTIALS, path, lambda _: CALENDAR_URL)
            self.assertEqual(original.read_bytes(), b"unchanged")

    def test_credentials_use_stdin_and_are_not_in_ssh_arguments(self):
        with patch.object(setup.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, b'{"status":"ICLOUD_CONFIGURED"}', b"")) as run:
            setup.remote({"ssh_destination": "user@oracle.example"}, "install", CREDENTIALS)
        args, kwargs = run.call_args
        self.assertNotIn(CREDENTIALS["username"], str(args))
        self.assertNotIn(CREDENTIALS["password"], str(args))
        self.assertEqual(json.loads(kwargs["input"]), CREDENTIALS)
        self.assertNotIn("env", kwargs)

    def test_ssh_failure_does_not_echo_remote_output_or_request_secret(self):
        with patch.object(setup.subprocess, "run", return_value=subprocess.CompletedProcess([], 255, b"", b"timeout sensitive data")):
            with self.assertRaisesRegex(setup.SetupError, "^ORACLE_SETUP_FAILED$"):
                setup.remote({"ssh_destination": "user@oracle.example"}, "status")
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "config.json"
            config.write_text('{"ssh_destination":"user@oracle.example"}')
            config.chmod(0o600)
            with patch.object(sys, "argv", ["setup_icloud.py", "--config", str(config)]), patch.object(setup, "remote", side_effect=setup.SetupError("ORACLE_CONNECTION_TIMEOUT")), patch.object(setup, "prompt") as prompt:
                with self.assertRaises(setup.SetupError):
                    setup.main()
                prompt.assert_not_called()

    def test_runtime_uses_pinned_nats_and_rejects_rename(self):
        environment = {"ICLOUD_USERNAME": CREDENTIALS["username"], "ICLOUD_APP_PASSWORD": CREDENTIALS["password"], "ICLOUD_CALENDAR_URL": CALENDAR_URL}
        with patch.dict(os.environ, environment), patch("caldav.DAVClient") as client, patch("caldav.Calendar") as calendar:
            calendar.return_value.get_display_name.return_value = "Nats"
            with ICloud().calendar() as selected:
                self.assertIs(selected, calendar.return_value)
            client.return_value.__enter__.return_value.principal.assert_not_called()
            calendar.return_value.get_display_name.return_value = "Renamed"
            with self.assertRaises(RuntimeError):
                with ICloud().calendar():
                    self.fail("A different calendar must never be used")


if __name__ == "__main__":
    unittest.main()
