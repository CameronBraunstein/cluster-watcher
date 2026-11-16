'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { BackendClient, HEALTH_TIMEOUT_MS } = require('../client');

/** Build a small JSON response without opening a network listener. */
function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}

test('service detection uses the small identity route before cluster snapshots', async () => {
  const paths = [];
  const client = new BackendClient(() => 'http://127.0.0.1:8080/', async (url) => {
    paths.push(url.pathname);
    return jsonResponse({ schema_version: '1.0', pid: 42 });
  });

  assert.equal(HEALTH_TIMEOUT_MS, 5000);
  assert.equal(await client.isClusterWatcherService(), true);
  assert.deepEqual(await client.serviceInfo(), { schema_version: '1.0', pid: 42 });
  assert.deepEqual(paths, ['/api/v1/service', '/api/v1/service']);
});

test('a timed-out identity check does not launch expensive fallback requests', async () => {
  const paths = [];
  const client = new BackendClient(() => 'http://127.0.0.1:8080/', async (url) => {
    paths.push(url.pathname);
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  });

  await assert.rejects(client.serviceInfo(), /request timed out \(\/api\/v1\/service\)/);
  assert.deepEqual(paths, ['/api/v1/service']);
});

test('an older backend still falls back to a summary snapshot', async () => {
  const paths = [];
  const client = new BackendClient(() => 'http://127.0.0.1:8080/', async (url) => {
    paths.push(`${url.pathname}${url.search}`);
    return url.pathname === '/api/v1/service'
      ? jsonResponse({ error: 'Not found' }, 404)
      : jsonResponse({ schema_version: '1.0', clusters: [] });
  });

  assert.deepEqual(await client.serviceInfo(), {});
  assert.deepEqual(paths, ['/api/v1/service', '/api/v1/snapshot?detail=summary']);
});
