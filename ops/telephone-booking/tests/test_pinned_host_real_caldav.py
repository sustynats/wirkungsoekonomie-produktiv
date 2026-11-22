"""Real pinned caldav wheel, synthetic endpoints, never connects to a provider."""
import importlib.metadata
import os
import unittest
from urllib.parse import urlsplit
from unittest.mock import patch
import caldav
from integrations import ICloud

class PinnedHostRealCalDAV(unittest.TestCase):
 def test_pinned_apple_partition_constructs_real_calendar_for_two_hosts(self):
  self.assertEqual(importlib.metadata.version('caldav'),'3.7.0')
  for partition in ('p01','p99'):
   url=f'https://{partition}-caldav.icloud.com/123/calendars/synthetic/'
   env={'ICLOUD_USERNAME':'synthetic@example.invalid','ICLOUD_APP_PASSWORD':'synthetic','ICLOUD_CALENDAR_URL':url}
   with self.subTest(partition=partition),patch.dict(os.environ,env,clear=True),patch.object(caldav.Calendar,'get_display_name',return_value='Nats'):
    with ICloud().calendar() as selected:
     self.assertIsInstance(selected,caldav.Calendar)
     self.assertEqual(str(selected.url),url)
     self.assertEqual(urlsplit(str(selected.client.url)).hostname,partition+'-caldav.icloud.com')
 def test_generic_host_client_cannot_bind_partition_without_alias(self):
  for partition in ('p01','p99'):
   with self.subTest(partition=partition):
    with caldav.DAVClient(url='https://caldav.icloud.com/',username='synthetic',password='synthetic') as client:
     with self.assertRaises(ValueError):caldav.Calendar(client=client,url=f'https://{partition}-caldav.icloud.com/123/calendars/synthetic/')
 def test_no_pinned_url_keeps_generic_discovery(self):
  env={'ICLOUD_USERNAME':'synthetic@example.invalid','ICLOUD_APP_PASSWORD':'synthetic'}
  with patch.dict(os.environ,env,clear=True),patch('caldav.DAVClient') as cls:
   cls.return_value.__enter__.return_value.principal.return_value.calendars.return_value=[]
   with self.assertRaises(RuntimeError):
    with ICloud().calendar():pass
   self.assertEqual(cls.call_args.kwargs['url'],'https://caldav.icloud.com/')
