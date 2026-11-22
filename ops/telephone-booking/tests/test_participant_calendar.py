"""New synthetic participant-import contracts; SMTP is always a fake."""
import ast
import copy
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, unquote, urlparse

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from icalendar import Calendar
import integrations
from booking import parse, expiry_binding, recovery_phase, iso

SMTP = {'host': 'smtp.example.invalid', 'port': 587, 'user': 'synthetic@example.invalid',
        'password': 'synthetic-test-only', 'from': 'wirkungscheck@wirkungsoekonomie.de'}
PRIVATE = ['Private Test Person', '+49 151 12345678', 'private-person@example.test', 'private.discord',
           'PRIVATE_BACKGROUND', 'PRIVATE_QUESTION', 'PRIVATE_OUTCOME', 'PRIVATE_OWNER_BEARER', '0123456789abcdef']

def row(channel='phone', reply='email', status='confirmed'):
    payload = {'name': PRIVATE[0], 'phone': PRIVATE[1], 'email': PRIVATE[2], 'discord': PRIVATE[3],
               'background': PRIVATE[4], 'questions': PRIVATE[5], 'outcome': PRIVATE[6],
               'channel': channel, 'replyVia': reply, 'start': '2027-03-30T10:00:00+02:00', 'topic': 'praxis'}
    return {'id': PRIVATE[8], 'status': status, 'payload': json.dumps(payload),
            'start': payload['start'], 'end': '2027-03-30T10:30:00+02:00', 'created': '2026-11-10T08:00:00Z',
            'notification': json.dumps({'url': 'https://private.example/manage#' + PRIVATE[7]}),
            'token_hash': PRIVATE[7], 'expires': '2026-11-13T08:00:00Z', 'calendar_state': 'synced',
            'confirmation_sent': None, 'decline_sent': None, 'cancel_sent': None,
            'notification_sent': None, 'verified': '2026-11-10T08:15:00Z', 'discord_verified': '12345' if channel == 'discord' else None}

def view(value):
    # Execute the actual pure view function without Flask/Store construction.
    tree = ast.parse((HERE.parent / 'app.py').read_text())
    function = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == 'view')
    code = compile(ast.Module(body=[copy.deepcopy(function)], type_ignores=[]), 'owner-view', 'exec')
    namespace = {'json': json, 'confirmation_notice': integrations.confirmation_notice,
                 'expiry_binding': expiry_binding, 'recovery_phase': recovery_phase, 'iso': iso,
                 'clock': lambda: parse('2026-11-10T08:30:00Z')}
    exec(code, namespace)
    return namespace['view'](value)

class ParticipantCalendarTests(unittest.TestCase):
    def assert_private_absent(self, text):
        for private in PRIVATE:
            self.assertNotIn(private, unquote(text))
        self.assertNotIn('/manage', unquote(text))

    def fake_send(self, notice):
        with patch.object(integrations, 'smtp_config', return_value=SMTP), \
             patch.object(integrations.ssl, 'create_default_context', return_value=object()), \
             patch.object(integrations.smtplib, 'SMTP') as smtp:
            integrations.send_confirmation(notice)
        smtp.assert_called_once_with(SMTP['host'], 587, timeout=15)
        session = smtp.return_value.__enter__.return_value
        session.send_message.assert_called_once()
        self.assertEqual(session.ehlo.call_count, 2)
        session.starttls.assert_called_once(); session.login.assert_called_once()
        return session.send_message.call_args.args[0]

    def test_ics_has_only_neutral_utc_fields_and_no_private_or_owner_data(self):
        for channel, location in [('phone', 'Telefon'), ('discord', 'Discord-Sprachanruf')]:
            with self.subTest(channel=channel):
                source = row(channel=channel)
                item = integrations.participant_calendar(source)
                self.assert_private_absent(item['ics'])
                calendar = Calendar.from_ical(item['ics'])
                self.assertEqual(str(calendar['METHOD']), 'PUBLISH')
                events = calendar.walk('VEVENT'); self.assertEqual(len(events), 1)
                event = events[0]
                self.assertEqual(set(event.keys()), {'UID','DTSTAMP','DTSTART','DTEND','SUMMARY','LOCATION','URL','CLASS','STATUS'})
                self.assertEqual(event['DTSTART'].dt, parse('2027-03-30T08:00:00Z'))
                self.assertEqual(event['DTEND'].dt, parse('2027-03-30T08:30:00Z'))
                self.assertIn('DTSTART:20270330T080000Z', item['ics'])
                self.assertEqual(str(event['SUMMARY']), 'Gespräch mit Natalie Weber')
                self.assertEqual(str(event['LOCATION']), location)
                self.assertEqual(str(event['URL']), 'https://wirkungsoekonomie.de/w/natalie-weber/')
                self.assertEqual(calendar.walk('VALARM'), [])

    def test_uid_and_notice_are_stable_across_repeated_preview_and_private_changes(self):
        first = row(); second = copy.deepcopy(first)
        payload = json.loads(second['payload']); payload.update(name='Changed Name', email='other@example.test', phone='+499999')
        second['payload'] = json.dumps(payload)
        def uid(value): return str(Calendar.from_ical(integrations.participant_calendar(value)['ics']).walk('VEVENT')[0]['UID'])
        self.assertEqual(uid(first), uid(second))
        self.assertNotEqual(uid(first), uid({**first, 'id': 'fedcba9876543210'}))
        self.assertEqual(integrations.confirmation_notice(first), integrations.confirmation_notice(first))

    def test_compose_links_use_fixed_providers_utc_and_only_neutral_fields(self):
        links = integrations.participant_calendar(row())['links']
        self.assertEqual([urlparse(x['url']).hostname for x in links], ['calendar.google.com','outlook.office.com','outlook.live.com'])
        for index, link in enumerate(links):
            self.assert_private_absent(link['url'])
            url = urlparse(link['url']); self.assertEqual(url.scheme, 'https'); self.assertEqual(url.fragment, '')
            query = parse_qs(url.query)
            if index == 0:
                self.assertEqual(query['dates'], ['20270330T080000Z/20270330T083000Z'])
                self.assertEqual(query['action'], ['TEMPLATE'])
                self.assertEqual(set(query), {'action','text','dates','details','location','ctz'})
            else:
                self.assertEqual(url.path, '/calendar/deeplink/compose')
                self.assertEqual(query['startdt'], ['2027-03-30T08:00:00Z'])
                self.assertEqual(query['enddt'], ['2027-03-30T08:30:00Z'])
                self.assertEqual(set(query), {'allday','body','enddt','path','rru','startdt','subject','location'})

    def test_only_confirmed_notices_offer_import_and_discord_does_not_promise_attachment(self):
        for status in ['declined', 'cancelled']:
            notice = integrations.confirmation_notice(row(status=status))
            self.assertNotIn('calendar', notice)
            self.assertNotIn('In deinen Kalender', notice['body'])
            self.assertNotIn('calendar.google.com', notice['body'])
        email = integrations.confirmation_notice(row())
        discord = integrations.confirmation_notice(row(channel='discord', reply='discord'))
        self.assertIn('angehängte Datei', email['body'])
        self.assertNotIn('angehängte Datei', discord['body'])
        self.assertIn('nicht automatisch aktualisiert', email['body'])
        for notice in [email, discord]:
            for item in notice['calendar']['links']: self.assertIn(item['url'], notice['body'])

    def test_new_confirmation_has_one_calendar_attachment_and_exact_plain_body(self):
        notice = integrations.confirmation_notice(row()); message = self.fake_send(notice)
        self.assertEqual(message.get_body(preferencelist=('plain',)).get_content().rstrip('\n'), notice['body'])
        attachments = list(message.iter_attachments()); self.assertEqual(len(attachments), 1)
        attachment = attachments[0]
        self.assertEqual(attachment.get_content_type(), 'text/calendar')
        self.assertEqual(attachment.get_param('method'), 'PUBLISH')
        self.assertEqual(attachment.get_filename(), 'gespraech-natalie-weber.ics')
        raw = attachment.get_payload(decode=True).decode(attachment.get_content_charset())
        self.assert_private_absent(raw)
        self.assertEqual(str(Calendar.from_ical(raw).walk('VEVENT')[0]['SUMMARY']), 'Gespräch mit Natalie Weber')

    def test_legacy_queued_confirmation_without_calendar_or_kind_still_sends_once(self):
        notice = {'email':'synthetic@example.test','reference':'aabbccddeeff0011','subject':'Legacy queued','body':'Preserved old body'}
        message = self.fake_send(notice)
        self.assertFalse(message.is_multipart())
        self.assertEqual(message.get_content().rstrip('\n'), notice['body'])
        self.assertEqual(list(message.iter_attachments()), [])

    def test_bad_attachment_stops_before_smtp_and_cancel_does_not_attach(self):
        notice = integrations.confirmation_notice(row()); notice['calendar']['ics'] = 'x' * 16385
        with patch.object(integrations, 'smtp_config', return_value=SMTP), patch.object(integrations.smtplib, 'SMTP') as smtp:
            with self.assertRaisesRegex(ValueError, 'Invalid participant calendar'):
                integrations.send_confirmation(notice)
            smtp.assert_not_called()
        cancel = integrations.confirmation_notice(row(status='cancelled'))
        cancel['calendar'] = {'ics':'should not attach'}
        self.assertEqual(list(self.fake_send(cancel).iter_attachments()), [])

    def test_owner_discord_preview_contains_same_copyable_notice_and_safe_calendar(self):
        value = row(channel='discord', reply='discord'); response = view(value)
        self.assertEqual(response['confirmationPreview'], integrations.confirmation_notice(value))
        self.assertEqual(response, json.loads((HERE / 'participant-calendar-preview.fixture.json').read_text()))
        self.assertEqual(response['payload']['replyVia'], 'discord')
        self.assert_private_absent(response['confirmationPreview']['calendar']['ics'])

if __name__ == '__main__':
    unittest.main(verbosity=2)
