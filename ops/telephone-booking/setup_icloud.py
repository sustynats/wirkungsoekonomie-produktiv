#!/usr/bin/env python3
"""Configure the private Oracle iCloud credential file without exposing secrets.

Local: python3 setup_icloud.py [--check]
Remote helper runs via SSH stdin, requires root, and uses only the standard library.
"""
import argparse
import base64
import getpass
import json
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

CONFIG = Path.home() / ".config/woek-reference/config.json"
REMOTE_FILE = Path("/etc/woek-telephone-booking-icloud.env")
DAV = "{DAV:}"
CAL = "{urn:ietf:params:xml:ns:caldav}"


class SetupError(Exception):
    pass


def apple_url(value, base="https://caldav.icloud.com/"):
    url = urllib.parse.urljoin(base, value)
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or not re.fullmatch(r"(?:p\d+-)?caldav\.icloud\.com", parsed.hostname or "") or parsed.port not in (None, 443) or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise SetupError("ICLOUD_ENDPOINT_REJECTED")
    return url


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def propfind(url, properties, credentials, depth="0"):
    body = ('<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop>' + properties + '</d:prop></d:propfind>').encode()
    authorization = "Basic " + base64.b64encode(f"{credentials['username']}:{credentials['password']}".encode()).decode()
    opener = urllib.request.build_opener(NoRedirect())
    url = apple_url(url)
    for _ in range(5):
        request = urllib.request.Request(url, data=body, method="PROPFIND", headers={"Authorization": authorization, "Depth": depth, "Content-Type": "application/xml; charset=utf-8", "User-Agent": "WOeK-Calendar-Setup/1.0"})
        try:
            with opener.open(request, timeout=20) as response:
                if response.status != 207:
                    raise SetupError("ICLOUD_UNEXPECTED_RESPONSE")
                data = response.read(2_000_001)
                if len(data) > 2_000_000:
                    raise SetupError("ICLOUD_RESPONSE_TOO_LARGE")
                return ET.fromstring(data), url
        except urllib.error.HTTPError as error:
            if error.code in (301, 302, 307, 308) and error.headers.get("Location"):
                url = apple_url(error.headers["Location"], url)
                continue
            raise SetupError("ICLOUD_AUTHENTICATION_FAILED" if error.code in (401, 403) else "ICLOUD_REQUEST_FAILED") from None
    raise SetupError("ICLOUD_REDIRECT_LIMIT")


def successful_properties(response):
    return [item.find(DAV + "prop") for item in response.findall(DAV + "propstat") if " 200 " in (item.findtext(DAV + "status") or "") and item.find(DAV + "prop") is not None]


def find_property(root, name):
    for response in root.findall(DAV + "response"):
        for properties in successful_properties(response):
            result = properties.find(name)
            if result is not None:
                return result
    raise SetupError("ICLOUD_DISCOVERY_FAILED")


def probe_calendar(credentials, request_properties=propfind):
    root, location = request_properties("https://caldav.icloud.com/", "<d:current-user-principal/>", credentials)
    principal = find_property(root, DAV + "current-user-principal").findtext(DAV + "href")
    if not principal:
        raise SetupError("ICLOUD_PRINCIPAL_MISSING")
    root, location = request_properties(apple_url(principal, location), "<c:calendar-home-set/>", credentials)
    home = find_property(root, CAL + "calendar-home-set").findtext(DAV + "href")
    if not home:
        raise SetupError("ICLOUD_HOME_MISSING")
    root, location = request_properties(apple_url(home, location), "<d:displayname/><d:resourcetype/><d:current-user-privilege-set/><c:supported-calendar-component-set/>", credentials, "1")
    candidates = []
    for response in root.findall(DAV + "response"):
        properties = successful_properties(response)
        if not any(prop.findtext(DAV + "displayname") == "Nats" for prop in properties):
            continue
        if not any(prop.find(f"{DAV}resourcetype/{CAL}calendar") is not None for prop in properties):
            continue
        privileges = {item.tag for prop in properties for privilege in prop.findall(f"{DAV}current-user-privilege-set/{DAV}privilege") for item in privilege}
        writable = bool({DAV + "write", DAV + "all"} & privileges) or {DAV + "write-content", DAV + "bind", DAV + "unbind"} <= privileges
        event_support = any(item.get("name") == "VEVENT" for prop in properties for item in prop.findall(f"{CAL}supported-calendar-component-set/{CAL}comp"))
        href = response.findtext(DAV + "href")
        candidates.append({"url": apple_url(href, location) if href else None, "writable": writable, "events": event_support})
    if len(candidates) != 1 or not candidates[0]["url"]:
        raise SetupError("EXACTLY_ONE_NATS_CALENDAR_REQUIRED")
    if not candidates[0]["writable"] or not candidates[0]["events"]:
        raise SetupError("NATS_WRITE_PRIVILEGE_NOT_ESTABLISHED")
    return candidates[0]["url"]


def credentials_valid(credentials):
    username, password = credentials.get("username"), credentials.get("password")
    if not isinstance(username, str) or not username.strip() or len(username) > 254 or re.search(r"[\x00-\x20\x7f:]", username):
        raise SetupError("APPLE_ACCOUNT_INVALID")
    if not isinstance(password, str) or not re.fullmatch(r"[a-zA-Z]{4}(?:-[a-zA-Z]{4}){3}", password):
        raise SetupError("USE_AN_APP_SPECIFIC_PASSWORD")


def regular_private_file(path):
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid() or metadata.st_mode & 0o077:
        raise SetupError("UNSAFE_PRIVATE_FILE")


def atomic_private_write(path, data):
    if path.exists() or path.is_symlink():
        regular_private_file(path)
    fd, temporary = tempfile.mkstemp(prefix=".woek-icloud-", dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def read_credentials(path):
    regular_private_file(path)
    values = {}
    for line in path.read_text().splitlines():
        if line.startswith(("ICLOUD_USERNAME=", "ICLOUD_APP_PASSWORD=")):
            key, value = line.split("=", 1)
            values[key] = json.loads(value)
    credentials = {"username": values.get("ICLOUD_USERNAME"), "password": values.get("ICLOUD_APP_PASSWORD")}
    credentials_valid(credentials)
    return credentials


def install_credentials(credentials, target=REMOTE_FILE, probe=probe_calendar):
    credentials_valid(credentials)
    calendar_url = probe(credentials)  # No filesystem mutation before successful validation.
    values = {"BOOKING_ICLOUD_ENABLED": "1", "ICLOUD_USERNAME": credentials["username"], "ICLOUD_APP_PASSWORD": credentials["password"], "ICLOUD_CALENDAR_URL": calendar_url}
    content = "# Private Oracle iCloud connection; managed by setup_icloud.py\n" + "\n".join(f"{key}={json.dumps(value, ensure_ascii=False)}" for key, value in values.items()) + "\n"
    if target.exists() or target.is_symlink():
        regular_private_file(target)
        atomic_private_write(target.with_suffix(target.suffix + ".backup"), target.read_bytes())
    atomic_private_write(target, content.encode())
    return {"status": "ICLOUD_CONFIGURED", "calendar": "Nats", "writable": True, "credentials_stored": True, "services_restarted": False, "calendar_events_changed": False}


def remote_main(action):
    if os.getuid() != 0:
        raise SetupError("ROOT_REQUIRED")
    if action == "status":
        if REMOTE_FILE.exists() or REMOTE_FILE.is_symlink():
            regular_private_file(REMOTE_FILE)
        return {"status": "ORACLE_READY", "configured": REMOTE_FILE.exists()}
    if action == "verify":
        probe_calendar(read_credentials(REMOTE_FILE))
        return {"status": "ICLOUD_VERIFIED", "calendar": "Nats", "writable": True, "calendar_events_changed": False}
    if action == "install":
        payload = sys.stdin.buffer.read(8193)
        if len(payload) > 8192:
            raise SetupError("INPUT_TOO_LARGE")
        return install_credentials(json.loads(payload))
    raise SetupError("UNKNOWN_ACTION")


def ssh_args(config):
    destination = config.get("ssh_destination", "")
    if not re.fullmatch(r"[a-zA-Z0-9_.@-]+", destination) or destination.startswith("-"):
        raise SetupError("SSH_DESTINATION_INVALID")
    args = ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2"]
    if config.get("identity_file"):
        args += ["-i", str(Path(config["identity_file"]).expanduser()), "-o", "IdentitiesOnly=yes"]
    return args + [destination]


def remote(config, action, credentials=None):
    source = Path(__file__).read_text()
    command = "sudo -n python3 -c " + shlex.quote(source) + " --remote " + shlex.quote(action)
    try:
        result = subprocess.run(ssh_args(config) + [command], input=json.dumps(credentials or {}).encode(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180 if action != "status" else 25)
    except subprocess.TimeoutExpired:
        raise SetupError("ORACLE_CONNECTION_TIMEOUT") from None
    if result.returncode:
        error = result.stderr.decode(errors="replace").lower()
        if "timed out" in error or "no route to host" in error:
            raise SetupError("ORACLE_CONNECTION_TIMEOUT")
        if "password is required" in error:
            raise SetupError("ORACLE_SUDO_REQUIRED")
        if "permission denied" in error:
            raise SetupError("ORACLE_SSH_AUTHENTICATION_FAILED")
        try:
            safe_error = json.loads(result.stdout).get("error", "ORACLE_SETUP_FAILED")
            if re.fullmatch(r"[A-Z_]+", safe_error):
                raise SetupError(safe_error)
        except (ValueError, TypeError):
            pass
        raise SetupError("ORACLE_SETUP_FAILED")
    return json.loads(result.stdout)


def prompt(label, hidden):
    if not sys.stdin.isatty():
        raise SetupError("INTERACTIVE_TERMINAL_REQUIRED")
    return (getpass.getpass(label + ": ") if hidden else input(label + ": ")).strip()


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=CONFIG)
    parser.add_argument("--check", action="store_true", help="Read-only connectivity / existing credential check, no prompt")
    parser.add_argument("--replace", action="store_true", help="Replace an existing dedicated iCloud configuration, retaining a private backup")
    parser.add_argument("--remote", choices=("status", "verify", "install"), help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.remote:
        print(json.dumps(remote_main(args.remote)))
        return
    regular_private_file(args.config)
    config = json.loads(args.config.read_text())
    status = remote(config, "status")
    if status["configured"] and not args.replace:
        print(json.dumps(remote(config, "verify")))
        return
    if args.check:
        print(json.dumps(status))
        return
    print("Oracle ist erreichbar. Eingaben gehen verschlüsselt über SSH direkt an den Server.", flush=True)
    username = prompt("Apple-Account für den Kalender Nats", False)
    password = prompt("App-spezifisches Apple-Passwort für WOeK Oracle Termine (nicht dein normales Apple-Passwort)", True)
    credentials = {"username": username, "password": password}
    credentials_valid(credentials)
    print(json.dumps(remote(config, "install", credentials)))
    print("Kalenderzugang geprüft und privat auf Oracle hinterlegt. Es wurden keine Termine verändert und keine Dienste gestartet.")


if __name__ == "__main__":
    try:
        main()
    except SetupError as error:
        print(json.dumps({"status": "BLOCKED", "error": str(error)}))
        sys.exit(1)
    except Exception:
        # Deliberately do not print exceptions, URLs, account names, payloads or tracebacks.
        print('{"status":"BLOCKED","error":"SETUP_FAILED"}')
        sys.exit(1)
