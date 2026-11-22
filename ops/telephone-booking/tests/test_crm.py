import json
from datetime import timedelta
from unittest.mock import patch
import unittest
import test_booking as fixtures
import crm
from integrations import confirmation_notice, participant_calendar_key

class CrmTests(unittest.TestCase):
    setUp = fixtures.BookingTests.setUp
    tearDown = fixtures.BookingTests.tearDown
    payload = fixtures.BookingTests.payload
    create = fixtures.BookingTests.create
    row = fixtures.BookingTests.row
    auth = fixtures.BookingTests.auth
    tokens = fixtures.BookingTests.tokens
    verified_phone = fixtures.BookingTests.verified_phone
    action = fixtures.BookingTests.action

    def read(self):
        with self.store.transaction() as db: return crm.snapshot(db, self.now)

    def test_private_api_requires_separate_token_and_loopback_without_proxy(self):
        self.app.config['BOOKING_CRM_TOKEN']='crm-only-token-'*4
        headers={'Authorization':'Bearer '+self.app.config['BOOKING_CRM_TOKEN']}
        self.assertEqual(self.client.get('/internal/crm').status_code,403)
        self.assertEqual(self.client.get('/internal/crm',headers=headers).status_code,200)
        for extra in [{'Origin':fixtures.ORIGIN},{'X-Real-IP':'127.0.0.1'},{'X-Forwarded-For':'127.0.0.1'}]:
            self.assertEqual(self.client.get('/internal/crm',headers={**headers,**extra}).status_code,403)
        self.assertEqual(self.client.get('/internal/crm',headers=headers,environ_base={'REMOTE_ADDR':'198.51.100.1'}).status_code,403)
        r=self.client.post('/internal/crm/contacts',json={'name':'Synthetic Person'},headers=headers)
        self.assertEqual(r.status_code,200)
        self.assertEqual(self.client.get('/internal/crm',headers=headers).headers['Cache-Control'],'no-store')

    def test_only_approved_requests_import_once_and_followups_match_email(self):
        ref, admin, _ = self.verified_phone()
        self.assertEqual(len(self.read()['contacts']),0)
        self.action(admin,'approve')
        first=self.read();self.assertEqual(len(first['contacts']),1)
        self.assertEqual(len(self.read()['meetings']),1)
        with self.store.transaction() as db:
            original=db.execute('SELECT * FROM requests WHERE id=?',(ref,)).fetchone()
            columns=list(original.keys());values=dict(original)
            values.update(id='ffffffffffffffff',request_key='next-request',token_hash='next-token',verify_hash='next-verify',start='2026-11-17T10:00:00Z',end='2026-11-17T10:30:00Z')
            payload=json.loads(values['payload']);payload['email']=payload['email'].upper();values['payload']=json.dumps(payload)
            db.execute('INSERT INTO requests ('+','.join(columns)+') VALUES ('+','.join('?' for _ in columns)+')',[values[k] for k in columns])
        after=self.read();self.assertEqual(len(after['contacts']),1);self.assertEqual(len(after['meetings']),2)

    def test_notes_survive_retention_and_conflicting_save_is_rejected(self):
        ref, admin, _=self.verified_phone();self.action(admin,'approve')
        self.now+=timedelta(days=15)
        meeting=self.read()['meetings'][0];self.assertEqual(meeting['status'],'unknown')
        with self.store.transaction() as db:
            crm.save_meeting(db,{**meeting,'status':'completed','notes':'Agreed next steps\nSecond line'},self.now)
        with self.assertRaisesRegex(Exception,'inzwischen geändert'):
            with self.store.transaction() as db:crm.save_meeting(db,{**meeting,'notes':'stale overwrite'},self.now)
        self.now+=timedelta(days=60)
        import retention_cleanup
        retention_cleanup.cleanup_existing(self.store.filename,self.now)
        result=self.read()['meetings'][0]
        self.assertEqual(result['notes'],'Agreed next steps\nSecond line');self.assertEqual(result['status'],'completed')
        with self.store.transaction() as db:self.assertIsNone(db.execute('SELECT id FROM requests WHERE id=?',(ref,)).fetchone())

    def test_different_people_with_same_name_or_phone_are_not_merged(self):
        with self.store.transaction() as db:
            a=crm.contact(db,{'name':'Same Name','phone':'+4915100000000','email':'one@example.test'},self.now)
            b=crm.contact(db,{'name':'Same Name','phone':'+4915100000000','email':'two@example.test'},self.now)
            self.assertNotEqual(a,b)

    def test_manual_backfill_idempotent_berlin_time_and_link_validation(self):
        with self.store.transaction() as db:
            c=crm.contact(db,{'name':'Synthetic Historical Person'},self.now)
            data={'contact_id':c,'start':'2026-10-01T10:00','end':'2026-10-01T10:30','status':'completed','import_key':'calendar:synthetic','notes':'Original note'}
            a=crm.save_meeting(db,data,self.now);b=crm.save_meeting(db,{**data,'notes':'must not overwrite'},self.now)
            self.assertEqual(a,b)
            row=db.execute('SELECT * FROM crm_meetings WHERE id=?',(a,)).fetchone()
            self.assertEqual(row['start'],'2026-10-01T08:00:00Z');self.assertEqual(row['notes'],'Original note')
            with self.assertRaises(Exception):crm.contact_values({'name':'test','linkedin_url':'https://evil.example/in/fake'})
        with self.assertRaises(ValueError):crm.meeting_time('2027-03-28T02:30')

    def test_calendar_link_is_private_safe_and_revoked_on_cancel(self):
        ref, admin, _=self.verified_phone();self.action(admin,'approve')
        secret=self.app.config['BOOKING_SECRET'];key=participant_calendar_key(ref,secret)
        with patch.dict('os.environ',{'BOOKING_SECRET':secret}):
            notice=confirmation_notice(self.row(ref))
        self.assertIn('Outlook / Teams',notice['html']);self.assertIn('Apple Kalender',notice['html'])
        self.assertIn('/kalender/'+key,notice['html']);self.assertNotIn(ref,notice['calendar']['download'])
        r=self.client.get('/api/telephone-booking/calendar/'+key+'.ics')
        self.assertEqual(r.status_code,200)
        self.assertNotIn('synthetic@example.org',r.text);self.assertNotIn('Test Person',r.text)
        self.assertEqual(self.client.get('/api/telephone-booking/calendar/'+'a'*64+'.ics').status_code,404)
        self.action(admin,'cancel')
        self.assertEqual(self.client.get('/api/telephone-booking/calendar/'+key+'.ics').status_code,404)

if __name__=='__main__':unittest.main()
