import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function worker() {
  const handlers = new Map();
  const cached = [];
  const offline = new Response('Public offline shell');
  const context = {
    URL,
    Response,
    self: {
      location: { origin: 'https://church.test' },
      addEventListener: (name, handler) => handlers.set(name, handler),
      skipWaiting: async () => {},
      clients: { claim: async () => {} },
    },
    caches: {
      open: async () => ({ addAll: async (urls) => cached.push(...urls) }),
      keys: async () => [],
      delete: async () => true,
      match: async (url) => (url === '/portal-offline.html' ? offline : undefined),
    },
    fetch: async () => {
      throw new TypeError('Offline');
    },
  };
  vm.runInNewContext(await readFile(new URL('../../public/portal-sw.js', import.meta.url), 'utf8'), context);
  return { handlers, cached, offline };
}

test('portal service worker installs only the public offline shell and icon', async () => {
  const { handlers, cached } = await worker();
  let installed;
  handlers.get('install')({
    waitUntil: (promise) => {
      installed = promise;
    },
  });
  await installed;
  assert.deepEqual(cached, ['/portal-offline.html', '/portal-icon.svg']);
});

test('portal service worker never intercepts or caches member APIs and media', async () => {
  const { handlers } = await worker();
  for (const path of [
    '/api/member/v1/me',
    '/api/member/v1/directory',
    '/api/member/v1/sermons',
    '/api/content/files/download/private',
    '/api/membership/users/login',
    'https://media.example.test/audio.mp3',
  ]) {
    let intercepted = false;
    handlers.get('fetch')({
      request: {
        method: 'GET',
        url: new URL(path, 'https://church.test').href,
        mode: 'cors',
      },
      respondWith: () => {
        intercepted = true;
      },
    });
    assert.equal(intercepted, false, path);
  }
});

test('offline portal navigation returns only the static offline notice', async () => {
  const { handlers, offline } = await worker();
  let result;
  handlers.get('fetch')({
    request: {
      method: 'GET',
      url: 'https://church.test/portal',
      mode: 'navigate',
    },
    respondWith: (promise) => {
      result = promise;
    },
  });
  assert.equal(await result, offline);
  let intercepted = false;
  handlers.get('fetch')({
    request: {
      method: 'GET',
      url: 'https://church.test/people',
      mode: 'navigate',
    },
    respondWith: () => {
      intercepted = true;
    },
  });
  assert.equal(intercepted, false, 'admin routes are outside portal navigation handling');
});
