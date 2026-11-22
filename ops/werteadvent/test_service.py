import datetime,importlib.util,tempfile,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('s',Path(__file__).with_name('service.py'));s=importlib.util.module_from_spec(spec);spec.loader.exec_module(s)
class CampaignTests(unittest.TestCase):
 def setUp(self):self.tmp=tempfile.TemporaryDirectory();self.db=Path(self.tmp.name)/'db';s.initialize(self.db)
 def tearDown(self):self.tmp.cleanup()
 def test_consent_and_minimization(self):
  for p in [{'event':'visit'},{'event':'visit','consent':True,'ip':'1.2.3.4'},{'event':'download','day':25,'resource':'icon-labelled','consent':True}]:
   with self.assertRaises(s.Invalid):s.event(p,self.db)
 def test_count_and_berlin_midnight(self):
  at=datetime.datetime(2026,11,30,23,30,tzinfo=datetime.timezone.utc)
  for _ in range(2):s.event({'event':'value_open','day':1,'consent':True},self.db,at)
  self.assertEqual(s.export(self.db)['counters'],[{'date':'2026-12-01','day':1,'event':'value_open','resource':'','count':2}])
 def test_report_deduplication_and_deletion(self):
  p={'day':2,'url':'https://www.tiktok.com/@example/video/1234567890123456789?tracking=remove#foo','consent':True,'consent_version':s.CONSENT}
  r=s.report(p,self.db);self.assertTrue(s.report(p,self.db)['duplicate']);e=s.export(self.db,True);self.assertEqual(e['reports'][0]['url'],'https://www.tiktok.com/@example/video/1234567890123456789');self.assertNotIn('deletion_hash',str(e));self.assertEqual(e['reports_by_day'][0]['submitted_links'],1);s.delete({'deletion_code':r['deletion_code']},self.db);self.assertEqual(s.export(self.db)['reports_by_day'],[])
 def test_external_short_profile_links_rejected(self):
  for link in ['https://tiktok.com.evil.invalid/@a/video/1234567','https://www.tiktok.com@evil.invalid/@a/video/1234567','https://www.tiktok.com/@a','https://vm.tiktok.com/x','http://www.tiktok.com/@a/video/1234567','https://www.tiktok.com:443/@a/video/1234567']:
   with self.assertRaises(s.Invalid):s.url(link)
 def test_report_requires_explicit_consent(self):
  for consent in [False,'true',None]:
   with self.assertRaises(s.Invalid):s.report({'day':1,'url':'https://www.tiktok.com/@a/video/123456789','consent':consent,'consent_version':s.CONSENT},self.db)
 def test_retention(self):
  p={'day':1,'url':'https://www.tiktok.com/@a/video/123456789','consent':True,'consent_version':s.CONSENT};s.report(p,self.db);s.prune(self.db,s.ERASE_ON);self.assertEqual(s.export(self.db)['reports_by_day'],[])
  with self.assertRaises(s.Invalid):s.report(p,self.db,s.ERASE_ON)
 def test_no_visitor_columns(self):
  with s.connect(self.db) as c:self.assertEqual([r['name'] for r in c.execute('PRAGMA table_info(counters)')],['date','day','event','resource','count'])
if __name__=='__main__':unittest.main()
