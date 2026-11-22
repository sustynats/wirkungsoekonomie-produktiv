"""Synthetic Discord owner-message checks; no provider or user data."""
import io,json,os,sys,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from booking import TOPICS
from integrations import discord_notice

class OwnerNoticeTests(unittest.TestCase):
 def notice(self,name):
  return {'reference':'0123456789abcdef','url':'https://example.invalid/manage#synthetic-token',
   'payload':{'name':name,'start':'2026-11-10T09:00:00Z','channel':'phone','topic':'praxis',
    'email':'private-synthetic@example.invalid','phone':'+4915100000000','background':'private-background','questions':'private-questions','outcome':'private-outcome'}}
 def post(self,notice):
  requests=[]
  def fetch(request,timeout):requests.append(request);return io.BytesIO(b'{"id":"synthetic-channel"}')
  with patch.dict(os.environ,{'DISCORD_BOT_TOKEN':'synthetic','DISCORD_REVIEW_RECIPIENT_USER_ID':'123'},clear=True):discord_notice(notice,fetch)
  self.assertEqual(len(requests),2)
  return json.loads(requests[1].data)
 def test_name_topic_and_context_without_contact_fields_or_other_answers(self):
  body=self.post(self.notice('Maja Beispiel'));text=body['content']
  self.assertIn('Anfragende Person: `Maja Beispiel`',text)
  self.assertIn('Anlass: '+TOPICS['praxis'],text)
  self.assertIn('Anliegen (Auszug): `private-background`',text)
  self.assertIn('<https://example.invalid/manage#synthetic-token>',text)
  for private in ('private-synthetic@example.invalid','+4915100000000','private-questions','private-outcome'):self.assertNotIn(private,text)
  self.assertEqual(body['allowed_mentions'],{'parse':[]});self.assertTrue(body['enforce_nonce'])
 def test_name_cannot_break_code_span_or_insert_control_lines(self):
  body=self.post(self.notice('Maja` @everyone <@123> [Text](https://example.invalid)\n\u202e B'))
  text=body['content'];name_line=next(line for line in text.splitlines() if line.startswith('Anfragende Person: '))
  self.assertEqual(name_line.count('`'),2)
  self.assertIn("Maja' @everyone",name_line)
  self.assertNotIn('\u202e',text)
  self.assertEqual(body['allowed_mentions'],{'parse':[]})
  self.assertEqual(text.count('Anlass:'),1)
 def test_empty_after_controls_has_safe_fallback(self):
  body=self.post(self.notice('\u200b\u202e'))
  self.assertIn('Anfragende Person: `Name im Verwaltungsbereich`',body['content'])
 def test_context_is_bounded_explicitly_and_cannot_break_span(self):
  notice=self.notice('Maja Beispiel')
  notice['payload']['background']='Auszug \\`@everyone\n'+('x'*400)+'ENDMARKER'
  body=self.post(notice);text=body['content']
  line=next(line for line in text.splitlines() if line.startswith('Anliegen (Auszug): '))
  extract=line.removeprefix('Anliegen (Auszug): `').removesuffix('`')
  self.assertLessEqual(len(extract),300);self.assertTrue(extract.endswith('…'))
  self.assertNotIn('\\',extract)
  self.assertEqual(line.count('`'),2);self.assertNotIn('ENDMARKER',text)
  self.assertEqual(body['allowed_mentions'],{'parse':[]})
if __name__=='__main__':unittest.main()
