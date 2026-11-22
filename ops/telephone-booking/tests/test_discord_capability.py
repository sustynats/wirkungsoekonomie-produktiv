"""The public capability advertises only a configured OAuth channel."""
from datetime import datetime
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import create_app
from booking import UTC

class Calendar:
    enabled = True
    def busy(self, start, end):
        return []

class DiscordCapabilityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        app = create_app({'TESTING': True, 'BOOKING_ENABLED': True,
            'BOOKING_ORIGIN': 'https://wirkungsoekonomie.de',
            'BOOKING_DB': str(Path(self.tmp.name) / 'booking.sqlite3'),
            'BOOKING_SECRET': 'unit-test-key-' * 4},
            calendar=Calendar(), clock=lambda: datetime(2026, 11, 3, 9, tzinfo=UTC))
        self.client = app.test_client()

    def tearDown(self):
        self.tmp.cleanup()

    def test_only_both_oauth_values_enable_discord_without_disclosing_values(self):
        cases = [({}, ['phone']),
                 ({'DISCORD_CLIENT_ID': 'synthetic-id'}, ['phone']),
                 ({'DISCORD_CLIENT_SECRET': 'synthetic-secret'}, ['phone']),
                 ({'DISCORD_CLIENT_ID': 'synthetic-id', 'DISCORD_CLIENT_SECRET': 'synthetic-secret'}, ['phone', 'discord'])]
        for env, expected in cases:
            with self.subTest(keys=sorted(env)), patch.dict(os.environ, env, clear=True):
                response = self.client.get('/api/telephone-booking/slots', headers={'Origin':'https://wirkungsoekonomie.de'})
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json['supportedChannels'], expected)
                self.assertTrue(response.json['slots'])
                self.assertNotIn(b'synthetic-id', response.data)
                self.assertNotIn(b'synthetic-secret', response.data)

if __name__ == '__main__':
    unittest.main()
