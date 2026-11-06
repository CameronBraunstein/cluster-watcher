'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  StaleServiceSessionError, hasServiceSession, serviceSessionName,
  startOrRecoverServiceSession, startServiceSession,
} = require('../tmux');

test('service sessions are stable for one endpoint and distinct across ports', () => {
  const first = serviceSessionName('http://127.0.0.1:8080/');
  assert.match(first, /^cluster-watcher-[0-9a-f]{12}$/);
  assert.equal(serviceSessionName('http://127.0.0.1:8080/other-path'), first);
  assert.notEqual(serviceSessionName('http://127.0.0.1:8081/'), first);
});

test('tmux startup uses argument arrays and refuses an existing session', async () => {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (args[0] === 'has-session') throw Object.assign(new Error('missing'), { code: 1 });
  };
  const command = "'/path with spaces/cluster-watcher' 'serve' '--skip-login'";
  await startServiceSession('cluster-watcher-abc', command, run);
  assert.deepEqual(calls, [
    ['has-session', '-t', '=cluster-watcher-abc'],
    ['new-session', '-d', '-s', 'cluster-watcher-abc', '--', command],
  ]);
  await assert.rejects(
    startServiceSession('cluster-watcher-abc', command, async () => ''),
    /already exists.*tmux attach/,
  );
});

test('tmux absence has an actionable error instead of silently falling back', async () => {
  await assert.rejects(
    hasServiceSession('cluster-watcher-abc', async () => {
      throw Object.assign(new Error('spawn tmux ENOENT'), { code: 'ENOENT' });
    }),
    /Install tmux on the VS Code extension host/,
  );
});

test('stale session restart kills only the named session after approval', async () => {
  const calls = [];
  let exists = true;
  const run = async (args) => {
    calls.push(args);
    if (args[0] === 'has-session' && !exists) throw Object.assign(new Error('missing'), { code: 1 });
    if (args[0] === 'kill-session') exists = false;
    if (args[0] === 'new-session') exists = true;
  };
  const result = await startOrRecoverServiceSession(
    'cluster-watcher-abc', "'cluster-watcher' 'serve'", async () => false,
    async (error) => {
      assert.ok(error instanceof StaleServiceSessionError);
      return true;
    }, run,
  );

  assert.deepEqual(result, { outcome: 'started' });
  assert.deepEqual(calls.map((args) => args[0]), [
    'has-session', 'has-session', 'kill-session', 'has-session', 'new-session',
  ]);
  assert.deepEqual(calls[2], ['kill-session', '-t', '=cluster-watcher-abc']);
});

test('stale session is retained when restart is cancelled or service recovers', async () => {
  const calls = [];
  const run = async (args) => { calls.push(args); return ''; };

  const cancelled = await startOrRecoverServiceSession(
    'cluster-watcher-abc', 'command', async () => { throw new Error('unexpected probe'); },
    async () => false, run,
  );
  assert.equal(cancelled.outcome, 'cancelled');
  assert.equal(calls.length, 1);

  const attached = await startOrRecoverServiceSession(
    'cluster-watcher-abc', 'command', async () => true, async () => true, run,
  );
  assert.deepEqual(attached, { outcome: 'attached' });
  assert.deepEqual(calls.map((args) => args[0]), ['has-session', 'has-session']);
});
