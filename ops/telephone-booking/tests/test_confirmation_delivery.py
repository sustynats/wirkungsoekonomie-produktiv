"""Synthetic confirmation outbox behavior; no mail, calendar, or network providers."""
import concurrent.futures
import json
import unittest
from unittest.mock import patch
import test_booking as fixture
from integrations import deliver_confirmation, send_confirmation

SMTP = {'host':'smtp.example.invalid','port':587,'user':'synthetic@example.invalid','password':'synthetic','from':'wirkungscheck@wirkungsoekonomie.de'}

class ConfirmationDeliveryTests(unittest.TestCase):
    def setUp(self):
        self.fx = fixture.BookingTests(methodName='runTest')
        self.fx.setUp()
        self.addCleanup(self.fx.tearDown)
        self.reference, self.admin, _ = self.fx.verified_phone()
        self.assertEqual(self.fx.action(self.admin, 'approve').status_code, 200)
        self.assertEqual(self.fx.calendar.confirmations, 1)

    def send(self, token=None):
        with patch('app.smtp_config', return_value=SMTP):
            return self.fx.client.post('/api/telephone-booking/manage/request',
                json={'action':'send_confirmation_email','expectedStatus':'confirmed'}, headers=self.fx.auth(token or self.admin))

    def test_personal_click_queues_once_and_sends_exact_preview_once(self):
        before = self.fx.client.get('/api/telephone-booking/manage/request', headers=self.fx.auth(self.admin)).json
        preview = before['confirmationPreview']
        self.assertEqual(preview['email'], 'synthetic@example.org')
        self.assertIn('30 Minuten', preview['body'])
        first = self.send(); second = self.send()
        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.json['confirmationDelivery'], 'queued')
        self.assertEqual(second.json['confirmationDelivery'], 'queued')
        sent = []
        self.assertTrue(deliver_confirmation(self.fx.store, self.fx.now, sent.append))
        self.assertEqual(sent, [preview])
        self.assertFalse(deliver_confirmation(self.fx.store, self.fx.now, sent.append))
        self.assertEqual(len(sent), 1)
        again = self.send()
        self.assertEqual(again.json['confirmationDelivery'], 'sent')
        self.assertEqual(self.fx.calendar.confirmations, 1)

    def test_uncertain_smtp_outcome_is_held_and_never_retried(self):
        self.assertEqual(self.send().json['confirmationDelivery'], 'queued')
        calls = []
        def uncertain(notice):
            calls.append(notice)
            raise TimeoutError('synthetic uncertain result')
        self.assertFalse(deliver_confirmation(self.fx.store, self.fx.now, uncertain))
        row = self.fx.row(self.reference)
        self.assertEqual(row['confirmation_sent'], 'email_hold')
        self.assertFalse(deliver_confirmation(self.fx.store, self.fx.now, uncertain))
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.send().json['confirmationDelivery'], 'unknown')
        self.assertEqual(self.fx.action(self.admin, 'cancel').status_code, 409)
        self.assertEqual(self.fx.action(self.admin, 'sent').status_code, 409)
        self.assertEqual(self.fx.calendar.cancellations, 0)

    def test_bearer_and_sender_configuration_are_required(self):
        self.assertEqual(self.send('not-a-valid-private-token').status_code, 404)
        with patch('app.smtp_config', return_value={**SMTP, 'from':'other@example.invalid'}):
            self.assertEqual(self.fx.client.post('/api/telephone-booking/manage/request',
                json={'action':'send_confirmation_email','expectedStatus':'confirmed'}, headers=self.fx.auth(self.admin)).status_code, 503)
        self.assertIsNone(self.fx.row(self.reference)['confirmation_sent'])
        self.assertEqual(self.fx.calendar.confirmations, 1)

    def test_unapproved_or_non_email_reply_never_queues(self):
        with self.fx.store.transaction() as db:
            db.execute("UPDATE requests SET status='pending' WHERE id=?", (self.reference,))
        self.assertEqual(self.send().status_code, 409)
        with self.fx.store.transaction() as db:
            row = db.execute('SELECT payload FROM requests WHERE id=?', (self.reference,)).fetchone()
            payload = json.loads(row['payload']); payload['replyVia'] = 'discord'
            db.execute("UPDATE requests SET status='confirmed', payload=? WHERE id=?", (json.dumps(payload), self.reference))
        self.assertEqual(self.send().status_code, 409)
        self.assertIsNone(self.fx.row(self.reference)['confirmation_sent'])

    def test_smtp_message_uses_requested_sender_and_exact_preview(self):
        preview = self.fx.client.get('/api/telephone-booking/manage/request', headers=self.fx.auth(self.admin)).json['confirmationPreview']
        with patch('integrations.smtp_config', return_value=SMTP), patch('integrations.smtplib.SMTP') as smtp:
            send_confirmation(preview)
        session = smtp.return_value.__enter__.return_value
        session.send_message.assert_called_once()
        message = session.send_message.call_args.args[0]
        self.assertEqual(message['From'], 'wirkungscheck@wirkungsoekonomie.de')
        self.assertEqual(message['To'], preview['email'])
        self.assertEqual(message['Subject'], preview['subject'])
        self.assertEqual(message.get_body(preferencelist=('plain',)).get_content().rstrip('\n'), preview['body'])

    def test_parallel_button_clicks_reserve_one_message(self):
        def click(_):
            with self.fx.app.test_client() as client:
                return client.post('/api/telephone-booking/manage/request',
                    json={'action':'send_confirmation_email','expectedStatus':'confirmed'}, headers=self.fx.auth(self.admin))
        with patch('app.smtp_config', return_value=SMTP), concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(click, range(4)))
        self.assertTrue(all(response.status_code == 200 for response in results))
        self.assertTrue(all(response.json['confirmationDelivery'] == 'queued' for response in results))
        sent = []
        self.assertTrue(deliver_confirmation(self.fx.store, self.fx.now, sent.append))
        self.assertFalse(deliver_confirmation(self.fx.store, self.fx.now, sent.append))
        self.assertEqual(len(sent), 1)

if __name__ == '__main__':
    unittest.main()
