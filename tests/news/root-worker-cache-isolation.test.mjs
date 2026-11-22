import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('root worker activation removes only its own obsolete app shell caches', async () => {
  const handlers = new Map();
  const deleted = [];
  let keys = [];
  const context = vm.createContext({
    self: {
      addEventListener: (name, handler) => handlers.set(name, handler),
      clients: { claim() {} },
    },
    caches: {
      keys: async () => [...keys],
      delete: async name => {
        deleted.push(name);
        keys = keys.filter(key => key !== name);
        return true;
      },
    },
  });
  vm.runInContext(fs.readFileSync(new URL('../../sw.js', import.meta.url), 'utf8'), context);
  const currentShell = vm.runInContext('CACHE_NAME', context);
  const notificationState = vm.runInContext('NEWS_STATE_CACHE', context);
  const retained = [
    currentShell,
    notificationState,
    'woek-wirkungsticker-shell-20260920-gepackte-daten',
    'woek-wirkungsticker-notification-state-v1',
    'woek-news-shell-legacy-reader',
    'independent-app-offline-data',
  ];
  keys = [...retained, 'woek-app-shell-obsolete'];
  let activation;
  handlers.get('activate')({ waitUntil: promise => { activation = promise; } });
  await activation;
  assert.deepEqual(deleted, ['woek-app-shell-obsolete']);
  assert.deepEqual(keys, retained);
});
