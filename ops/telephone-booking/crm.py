"""Private conversation history. Never included in participant calendar data."""
import json
import re
import secrets
from urllib.parse import urlparse

from booking import BookingError, iso, parse, ZONE
from datetime import datetime

CONTACT_FIELDS = ('name', 'occupation', 'linkedin_url', 'email', 'phone', 'discord', 'source_note')
MEETING_FIELDS = ('subject', 'background', 'questions', 'outcome', 'notes')
STATUSES = ('planned', 'unknown', 'completed', 'cancelled', 'no_show')


def schema(db):
    db.execute('''CREATE TABLE IF NOT EXISTS crm_contacts (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, occupation TEXT NOT NULL DEFAULT '',
        linkedin_url TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '',
        phone TEXT NOT NULL DEFAULT '', discord TEXT NOT NULL DEFAULT '',
        source_note TEXT NOT NULL DEFAULT '', created TEXT NOT NULL, updated TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1)''')
    db.execute('''CREATE TABLE IF NOT EXISTS crm_identities (
        kind TEXT NOT NULL, value TEXT NOT NULL, contact_id TEXT NOT NULL,
        PRIMARY KEY(kind,value))''')
    db.execute('''CREATE TABLE IF NOT EXISTS crm_meetings (
        id TEXT PRIMARY KEY, contact_id TEXT NOT NULL, source TEXT NOT NULL,
        source_id TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL,
        channel TEXT NOT NULL, subject TEXT NOT NULL DEFAULT '',
        background TEXT NOT NULL DEFAULT '', questions TEXT NOT NULL DEFAULT '',
        outcome TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'planned',
        notes TEXT NOT NULL DEFAULT '', source_note TEXT NOT NULL DEFAULT '',
        created TEXT NOT NULL, updated TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
        UNIQUE(source,source_id))''')
    db.execute('CREATE INDEX IF NOT EXISTS crm_contact_meetings ON crm_meetings(contact_id,start)')


def text(data, key, limit=1600, required=False):
    value = data.get(key, '')
    if not isinstance(value, str) or len(value) > limit or '\x00' in value:
        raise BookingError('Bitte prüfe das Feld ' + key + '.', 400)
    value = value.strip()
    if required and not value:
        raise BookingError('Bitte fülle das Feld ' + key + ' aus.', 400)
    return value


def contact_values(data):
    values = {key: text(data, key, 1600 if key == 'source_note' else 300, key == 'name') for key in CONTACT_FIELDS}
    if values['email'] and not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', values['email']):
        raise BookingError('Bitte prüfe die E-Mail-Adresse.', 400)
    if values['linkedin_url']:
        url = urlparse(values['linkedin_url'])
        if url.scheme != 'https' or url.hostname not in ('linkedin.com', 'www.linkedin.com', 'de.linkedin.com') or not url.path.startswith('/in/') or url.username or url.password:
            raise BookingError('Bitte verwende einen LinkedIn-Profillink mit https://www.linkedin.com/in/.', 400)
    return values


def identities(data):
    # Names/phone numbers alone are not sufficient proof of identity.
    result = []
    if data.get('email') and data.get('emailVerified', True): result.append(('email', data['email'].strip().casefold()))
    if data.get('discordId'): result.append(('discord', str(data['discordId'])))
    if data.get('linkedin_url'):
        result.append(('linkedin', urlparse(data['linkedin_url']).path.rstrip('/').casefold()))
    return result


def bind(db, contact_id, values):
    for kind, value in identities(values):
        other = db.execute('SELECT contact_id FROM crm_identities WHERE kind=? AND value=?', (kind, value)).fetchone()
        if other and other[0] != contact_id:
            raise BookingError('Diese Kontaktdaten gehören bereits zu einem anderen Kontakt. Bitte ordne den Termin dem bestehenden Kontakt zu.', 409)
        db.execute('INSERT OR IGNORE INTO crm_identities VALUES (?,?,?)', (kind, value, contact_id))


def contact(db, data, now, strict_identity=True):
    values = contact_values(data)
    matches = {r[0] for kind, value in identities(data) for r in db.execute('SELECT contact_id FROM crm_identities WHERE kind=? AND value=?', (kind, value))}
    conflict = len(matches) > 1
    if conflict and strict_identity:
        raise BookingError('Die Kontaktdaten sind mehreren Kontakten zugeordnet. Bitte prüfe die Zuordnung.', 409)
    if conflict:
        matches.clear()
        values['source_note'] = 'Zuordnung prüfen: E-Mail und Discord verweisen auf verschiedene Kontakte. ' + values['source_note']
    if matches:
        identifier = matches.pop()
        # A new request must never overwrite manually maintained profile data.
        existing = db.execute('SELECT * FROM crm_contacts WHERE id=?', (identifier,)).fetchone()
        for key in CONTACT_FIELDS:
            if not existing[key] and values[key]:
                db.execute(f'UPDATE crm_contacts SET {key}=?, updated=?, version=version+1 WHERE id=?', (values[key], iso(now), identifier))
    else:
        identifier = secrets.token_hex(16)
        db.execute('INSERT INTO crm_contacts (id,' + ','.join(CONTACT_FIELDS) + ',created,updated) VALUES (' + ','.join('?' for _ in range(10)) + ')',
                   (identifier, *(values[k] for k in CONTACT_FIELDS), iso(now), iso(now)))
    if not conflict:
        bind(db, identifier, data)
    return identifier


def sync_bookings(db, now):
    # Only accepted conversations; no unverified visitors or spam. A cancelled
    # booking is retained only if it already has an accepted conversation record.
    for row in db.execute("SELECT * FROM requests WHERE status IN ('confirmed','cancelled')").fetchall():
        existing = db.execute("SELECT * FROM crm_meetings WHERE source='booking' AND source_id=?", (row['id'],)).fetchone()
        if row['status'] == 'cancelled':
            if existing and existing['status'] not in ('completed', 'no_show', 'cancelled'):
                db.execute("UPDATE crm_meetings SET status='cancelled',updated=?,version=version+1 WHERE id=?", (iso(now), existing['id']))
            continue
        if existing:
            continue
        payload = json.loads(row['payload'])
        identifier = contact(db, {**payload, 'emailVerified': payload['channel'] == 'phone', 'source_note': 'Bestätigte Terminanfrage'}, now, strict_identity=False)
        db.execute('''INSERT INTO crm_meetings
            (id,contact_id,source,source_id,start,end,channel,subject,background,questions,outcome,status,source_note,created,updated)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
            (secrets.token_hex(16), identifier, 'booking', row['id'], row['start'], row['end'], payload['channel'],
             payload.get('topic', ''), payload.get('background', ''), payload.get('questions', ''), payload.get('outcome', ''),
             'unknown' if parse(row['end']) < now else 'planned', 'Bestätigte Terminanfrage; Durchführung nicht automatisch bestätigt.', iso(now), iso(now)))


def snapshot(db, now):
    sync_bookings(db, now)
    contacts = [dict(r) for r in db.execute('SELECT * FROM crm_contacts ORDER BY name COLLATE NOCASE')]
    meetings = [dict(r) for r in db.execute('SELECT * FROM crm_meetings ORDER BY start DESC')]
    for meeting in meetings:
        if meeting['status'] == 'planned' and parse(meeting['end']) < now:
            meeting['status'] = 'unknown'
    return {'contacts': contacts, 'meetings': meetings}


def save_contact(db, data, now):
    values = contact_values(data)
    identifier = data.get('id')
    if not identifier:
        return contact(db, values, now)
    bind(db, identifier, values)
    result = db.execute('UPDATE crm_contacts SET ' + ','.join(k + '=?' for k in CONTACT_FIELDS) + ', updated=?,version=version+1 WHERE id=? AND version=?',
                        (*(values[k] for k in CONTACT_FIELDS), iso(now), identifier, data.get('version')))
    if result.rowcount != 1:
        raise BookingError('Der Kontakt wurde inzwischen geändert. Bitte lade ihn neu, bevor du speicherst.', 409)
    return identifier


def meeting_time(value):
    if isinstance(value, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}", value):
        local = datetime.fromisoformat(value).replace(tzinfo=ZONE)
        result = parse(iso(local))
        if result.astimezone(ZONE).replace(tzinfo=None) != datetime.fromisoformat(value):
            raise ValueError("Nonexistent local time")
        return result
    return parse(value)


def save_meeting(db, data, now):
    identifier = data.get('id')
    status = data.get('status')
    if status not in STATUSES:
        raise BookingError('Bitte wähle einen gültigen Gesprächsstatus.', 400)
    values = {key: text(data, key, 20000 if key == 'notes' else 2000) for key in MEETING_FIELDS}
    if identifier:
        current = db.execute('SELECT * FROM crm_meetings WHERE id=?', (identifier,)).fetchone()
        if not current: raise BookingError('Gespräch nicht gefunden.', 404)
        if status == 'completed' and parse(current['start']) > now:
            raise BookingError('Ein zukünftiges Gespräch kann noch nicht stattgefunden haben.', 400)
        contact_id = data.get('contact_id', current['contact_id'])
        if not db.execute('SELECT 1 FROM crm_contacts WHERE id=?', (contact_id,)).fetchone():
            raise BookingError('Kontakt nicht gefunden.', 404)
        result = db.execute('UPDATE crm_meetings SET ' + ','.join(k + '=?' for k in MEETING_FIELDS) + ',status=?,contact_id=?,updated=?,version=version+1 WHERE id=? AND version=?',
                            (*(values[k] for k in MEETING_FIELDS), status, contact_id, iso(now), identifier, data.get('version')))
        if result.rowcount != 1:
            raise BookingError('Die Notiz oder der Termin wurde inzwischen geändert. Dein Text wurde nicht überschrieben. Bitte lade den aktuellen Stand neu.', 409)
        return identifier
    contact_id = data.get('contact_id')
    if not db.execute('SELECT 1 FROM crm_contacts WHERE id=?', (contact_id,)).fetchone():
        raise BookingError('Bitte wähle einen vorhandenen Kontakt.', 400)
    try:
        start, end = meeting_time(data['start']), meeting_time(data['end'])
        if end <= start or (end - start).total_seconds() > 86400: raise ValueError()
    except (KeyError, TypeError, ValueError):
        raise BookingError('Bitte prüfe Anfang und Ende des Gesprächs.', 400)
    if status == 'completed' and start > now:
        raise BookingError('Ein zukünftiges Gespräch kann noch nicht stattgefunden haben.', 400)
    channel = data.get('channel', 'phone')
    if channel not in ('phone', 'discord'): raise BookingError('Bitte wähle Telefon oder Discord.', 400)
    identifier = secrets.token_hex(16)
    # Caller supplies a stable import key only for an explicit private backfill.
    source = 'manual'
    source_id = text(data, 'import_key', 400) or identifier
    existing = db.execute('SELECT id FROM crm_meetings WHERE source=? AND source_id=?', (source, source_id)).fetchone()
    if existing: return existing['id']
    db.execute('INSERT INTO crm_meetings (id,contact_id,source,source_id,start,end,channel,status,' + ','.join(MEETING_FIELDS) + ',source_note,created,updated) VALUES (' + ','.join('?' for _ in range(16)) + ')',
               (identifier, contact_id, source, source_id, iso(start), iso(end), channel, status, *(values[k] for k in MEETING_FIELDS), text(data, 'source_note'), iso(now), iso(now)))
    return identifier


def register(app, store, clock):
    from flask import jsonify, request
    import hmac

    @app.before_request
    def private_access():
        if request.path.startswith('/internal/crm'):
            secret = app.config.get('BOOKING_CRM_TOKEN', '')
            actual = request.headers.get('Authorization', '').removeprefix('Bearer ')
            if (len(secret) < 32 or request.remote_addr not in ('127.0.0.1', '::1') or
                    request.headers.get('Origin') or request.headers.get('X-Real-IP') or
                    request.headers.get('X-Forwarded-For') or not hmac.compare_digest(secret.encode(), actual.encode())):
                raise BookingError('Kein Zugriff.', 403)

    @app.get('/internal/crm')
    def crm_read():
        with store.transaction() as db:
            return jsonify(snapshot(db, clock()))

    @app.post('/internal/crm/<kind>')
    def crm_write(kind):
        data = request.get_json(silent=True)
        if not isinstance(data, dict): raise BookingError('Ungültige Anfrage.', 400)
        with store.transaction() as db:
            if kind == 'contacts': identifier = save_contact(db, data, clock())
            elif kind == 'meetings': identifier = save_meeting(db, data, clock())
            else: raise BookingError('Nicht gefunden.', 404)
        return jsonify(id=identifier)
