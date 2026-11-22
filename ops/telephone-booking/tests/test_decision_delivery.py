"""Synthetic decision-email and additive migration tests; no provider calls."""
import concurrent.futures
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import test_booking as fixture
from booking import Store
from integrations import deliver_confirmation

SMTP={'host':'smtp.example.invalid','port':587,'user':'synthetic@example.invalid','password':'synthetic','from':'wirkungscheck@wirkungsoekonomie.de'}

class DecisionDeliveryTests(unittest.TestCase):
 def setUp(self):
  self.fx=fixture.BookingTests(methodName='runTest');self.fx.setUp();self.addCleanup(self.fx.tearDown)
  self.reference,self.admin,_=self.fx.verified_phone()
 def send(self,status):
  with patch('app.smtp_config',return_value=SMTP):
   return self.fx.client.post('/api/telephone-booking/manage/request',json={'action':'send_confirmation_email','expectedStatus':status},headers=self.fx.auth(self.admin))
 def test_cancel_after_confirm_preserves_old_receipt_and_sends_only_explicit_cancel(self):
  self.assertEqual(self.fx.action(self.admin,'approve').status_code,200)
  with self.fx.store.transaction() as db:db.execute("UPDATE requests SET confirmation_sent='2026-11-03T09:01:00Z' WHERE id=?",(self.reference,))
  self.assertEqual(self.fx.action(self.admin,'cancel').json['status'],'cancelled')
  row=self.fx.row(self.reference);self.assertEqual(row['confirmation_sent'],'2026-11-03T09:01:00Z');self.assertIsNone(row['cancel_sent'])
  self.assertEqual(self.send('confirmed').status_code,409)
  self.assertIsNone(self.fx.row(self.reference)['cancel_sent'])
  preview=self.fx.client.get('/api/telephone-booking/manage/request',headers=self.fx.auth(self.admin)).json['confirmationPreview']
  self.assertEqual(preview['kind'],'cancelled');self.assertIn('absagen',preview['body'])
  self.assertEqual(self.send('cancelled').json['confirmationDelivery'],'queued')
  self.assertEqual(self.send('cancelled').json['confirmationDelivery'],'queued')
  self.assertEqual(self.fx.calendar.cancellations,1)
  sent=[];self.assertTrue(deliver_confirmation(self.fx.store,self.fx.now,sent.append));self.assertFalse(deliver_confirmation(self.fx.store,self.fx.now,sent.append))
  self.assertEqual(sent,[preview]);self.assertEqual(self.fx.calendar.cancellations,1)
  row=self.fx.row(self.reference);self.assertEqual(row['confirmation_sent'],'2026-11-03T09:01:00Z');self.assertIsNotNone(row['cancel_sent'])
 def test_decline_unknown_smtp_is_held_and_never_replayed(self):
  self.assertEqual(self.fx.action(self.admin,'decline').json['status'],'declined')
  self.assertEqual(self.send('declined').json['confirmationDelivery'],'queued')
  calls=[]
  def uncertain(notice):calls.append(notice);raise TimeoutError('synthetic')
  self.assertFalse(deliver_confirmation(self.fx.store,self.fx.now,uncertain));self.assertFalse(deliver_confirmation(self.fx.store,self.fx.now,uncertain))
  self.assertEqual(len(calls),1);self.assertEqual(self.send('declined').json['confirmationDelivery'],'unknown')
  self.assertEqual(self.fx.calendar.confirmations,0);self.assertEqual(self.fx.calendar.cancellations,0)
 def test_stale_or_missing_status_never_queues(self):
  self.assertEqual(self.fx.action(self.admin,'decline').status_code,200)
  with patch('app.smtp_config',return_value=SMTP):
   old=self.fx.client.post('/api/telephone-booking/manage/request',json={'action':'send_confirmation_email'},headers=self.fx.auth(self.admin))
   stale=self.send('confirmed')
  self.assertEqual(old.status_code,409);self.assertEqual(stale.status_code,409);self.assertIsNone(self.fx.row(self.reference)['decline_sent'])
 def test_wrong_kind_in_legacy_queue_cannot_send(self):
  self.assertEqual(self.fx.action(self.admin,'decline').status_code,200)
  with self.fx.store.transaction() as db:db.execute("UPDATE requests SET decline_sent='email_queued',verification=?,verify_at=? WHERE id=?",('{"kind":"confirmed"}', '2026-11-03T09:00:00Z',self.reference))
  sent=[];self.assertFalse(deliver_confirmation(self.fx.store,self.fx.now,sent.append));self.assertEqual(sent,[])

class SchemaUpgradeTests(unittest.TestCase):
 def test_atomic_idempotent_concurrent_upgrade_preserves_old_receipts(self):
  with tempfile.TemporaryDirectory() as td:
   dbpath=str(Path(td)/'booking.sqlite3');db=sqlite3.connect(dbpath,isolation_level=None)
   db.execute("""CREATE TABLE requests (id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, fingerprint TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, payload TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL, created TEXT NOT NULL, expires TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'unverified', closed TEXT, verify_hash TEXT UNIQUE NOT NULL, verification TEXT, verify_at TEXT, verify_attempts INTEGER NOT NULL DEFAULT 0, verified TEXT, discord_verified TEXT, oauth_state_hash TEXT, calendar_state TEXT NOT NULL DEFAULT 'none', notification TEXT, notify_at TEXT, notify_attempts INTEGER NOT NULL DEFAULT 0, notification_sent TEXT, confirmation_sent TEXT)""")
   for i,status in enumerate(('confirmed','declined','cancelled')):
    db.execute('INSERT INTO requests(id,request_key,fingerprint,token_hash,payload,start,end,created,expires,status,verify_hash,confirmation_sent) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',(str(i),'r'+str(i),'f','t'+str(i),'{}','2026-12-01','2026-12-02','2026-11-01','2026-11-02',status,'v'+str(i),'2026-11-01T00:00:00Z'))
   db.execute('INSERT INTO requests(id,request_key,fingerprint,token_hash,payload,start,end,created,expires,status,verify_hash,confirmation_sent) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',('3','r3','f','t3','{}','2026-12-01','2026-12-02','2026-11-01','2026-11-02','cancelled','v3','email_hold'))
   db.execute('BEGIN IMMEDIATE');db.execute('ALTER TABLE requests ADD COLUMN temporary_upgrade TEXT');db.execute("UPDATE requests SET temporary_upgrade='synthetic'");db.rollback()
   self.assertNotIn('temporary_upgrade',{r[1] for r in db.execute('PRAGMA table_info(requests)')});db.close()
   with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:list(pool.map(lambda _:Store(dbpath,'synthetic-key'),range(4)))
   with sqlite3.connect(dbpath) as db:
    columns={r[1] for r in db.execute('PRAGMA table_info(requests)')};self.assertTrue({'decline_sent','cancel_sent'}<=columns)
    rows=db.execute('SELECT status,confirmation_sent,decline_sent,cancel_sent FROM requests ORDER BY id').fetchall()
    t='2026-11-01T00:00:00Z';self.assertEqual(rows,[('confirmed',t,None,None),('declined',t,t,None),('cancelled',t,None,t),('cancelled','email_hold',None,'email_hold')])
    db.execute("UPDATE requests SET decline_sent='email_hold' WHERE status='declined'")
   Store(dbpath,'synthetic-key')
   with sqlite3.connect(dbpath) as db:
    self.assertEqual(db.execute("SELECT confirmation_sent,decline_sent FROM requests WHERE status='declined'").fetchone(),(t,'email_hold'))
    self.assertEqual(db.execute("SELECT COUNT(*) FROM requests WHERE confirmation_sent=?",(t,)).fetchone()[0],3)
if __name__=='__main__':unittest.main()
