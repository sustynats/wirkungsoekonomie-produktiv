import unittest
import os
from types import SimpleNamespace
from unittest.mock import Mock, patch

import test_booking as fixture
import worker


class WorkerDisabledTests(unittest.TestCase):
    def setUp(self):
        self.fx = fixture.BookingTests(methodName='runTest')
        self.fx.setUp()
        self.addCleanup(self.fx.tearDown)
        self.created = self.fx.create()
        with self.fx.store.transaction() as db:
            db.execute("INSERT INTO service_meta VALUES ('sentinel','unchanged')")

    def snapshot(self):
        with self.fx.store.transaction() as db:
            rows = [tuple(row) for row in db.execute('SELECT * FROM requests ORDER BY id')]
            meta = [tuple(row) for row in db.execute('SELECT * FROM service_meta ORDER BY key')]
        return rows, meta

    def test_disabled_preserves_existing_queue_and_has_no_side_effects(self):
        before = self.snapshot()
        clock = Mock(side_effect=AssertionError('clock called'))
        verify = Mock(side_effect=AssertionError('email path called'))
        notify = Mock(side_effect=AssertionError('discord path called'))
        for value in (False, None, '0', 0):
            self.assertFalse(worker.run_once(self.fx.store, value, clock, verify, notify))
        self.assertEqual(self.snapshot(), before)
        clock.assert_not_called(); verify.assert_not_called(); notify.assert_not_called()

    def test_enabled_runs_heartbeat_and_both_synthetic_callbacks_once(self):
        clock = Mock(return_value=self.fx.now)
        calls = []
        def verify(store, now): calls.append(('verify', store, now)); return False
        def notify(store, now): calls.append(('notify', store, now)); return True
        self.assertTrue(worker.run_once(self.fx.store, True, clock, verify, notify))
        self.assertEqual([x[0] for x in calls], ['verify', 'notify'])
        with self.fx.store.transaction() as db:
            heartbeat = db.execute("SELECT value FROM service_meta WHERE key='worker_heartbeat'").fetchone()
        self.assertIsNotNone(heartbeat)

    def test_disabled_main_loop_never_accesses_queue(self):
        store = Mock()
        app = SimpleNamespace(config={'BOOKING_ENABLED': False}, extensions={'booking_store': store})
        with patch.object(worker, 'create_app', return_value=app), patch.object(worker.time, 'sleep', side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                worker.main()
        store.transaction.assert_not_called()

    def test_disabled_main_with_real_store_preserves_retained_requests(self):
        before = self.snapshot()
        env = {'BOOKING_ENABLED': '0', 'BOOKING_ORIGIN': 'https://api.example.test',
               'BOOKING_FRONTEND_ORIGIN': 'https://website.example.test',
               'BOOKING_DB': self.fx.store.filename, 'BOOKING_SECRET': 'synthetic-key-' * 4}
        with patch.dict(os.environ, env, clear=True), \
             patch.object(worker.time, 'sleep', side_effect=KeyboardInterrupt), \
             patch('socket.socket', side_effect=AssertionError('network prohibited')):
            with self.assertRaises(KeyboardInterrupt):
                worker.main()
        self.assertEqual(self.snapshot(), before)

if __name__ == '__main__':
    unittest.main()
