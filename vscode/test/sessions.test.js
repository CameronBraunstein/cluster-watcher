'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { sessionDialogText } = require('../sessions');

test('session dialog text lists copyable full SSH accounts and hours/minutes remaining', () => {
  assert.equal(sessionDialogText({ machines: [
    { name: 'zeta', username: 'bob', host: 'login-2', session_open: true, control_persist_seconds: null },
    { name: 'alpha', username: 'alice', host: 'login-1', session_open: true, control_persist_seconds: 3600, estimated_remaining_seconds: 3661 },
    { name: 'beta', username: 'carol', host: 'login-3', session_open: false },
    { name: 'gamma', username: 'dana', host: 'login-4', session_open: true, control_persist_seconds: 3600, estimated_remaining_seconds: null },
  ] }), [
    'zeta: bob@login-2\nno idle limit',
    'alpha: alice@login-1\n🕒 01:01 left',
    'beta: carol@login-3\nclosed',
    'gamma: dana@login-4\nremaining time unknown',
  ].join('\n\n'));
  assert.equal(sessionDialogText(), 'No SSH sessions are available.');
});

test('session time handles short, expired, multi-day, and invalid estimates', () => {
  for (const [seconds, expected] of [
    [59, '🕒 00:00 left'],
    [-60, '🕒 00:00 left'],
    [7260, '🕒 02:01 left'],
    [90000, '🕒 25:00 left'],
    ['invalid', 'remaining time unknown'],
    [Infinity, 'remaining time unknown'],
  ]) {
    assert.equal(sessionDialogText({ machines: [{
      name: 'alpha', username: 'alice', host: 'login.example',
      session_open: true, control_persist_seconds: 100000,
      estimated_remaining_seconds: seconds,
    }] }), `alpha: alice@login.example\n${expected}`);
  }
});

test('session dialog uses the compact cluster and account heading', () => {
  assert.equal(sessionDialogText({ machines: [{
    name: 'cluster_a', username: 'alice', host: 'login11.example.org',
    session_open: true, control_persist_seconds: 7200, estimated_remaining_seconds: 7140,
  }] }), 'cluster_a: alice@login11.example.org\n🕒 01:59 left');
});

test('session headings have no extra indentation and clock minutes use a colon', () => {
  const text = sessionDialogText({ machines: [{
    name: 'cluster_a', username: 'alice', host: 'login.example.org',
    session_open: true, control_persist_seconds: 7200, estimated_remaining_seconds: 3900,
  }] });
  assert.equal(text, 'cluster_a: alice@login.example.org\n🕒 01:05 left');
});

test('session entries preserve configured machine order without changing the inventory', () => {
  const { sessionDialogEntries } = require('../sessions');
  const machines = Object.freeze([
    Object.freeze({ name: 'cluster_c', username: 'alice', host: 'login3.example.org' }),
    Object.freeze({ name: 'cluster_a', username: 'alice', host: 'login1.example.org' }),
    Object.freeze({ name: 'cluster_b', username: 'alice', host: 'login2.example.org' }),
  ]);
  assert.deepEqual(sessionDialogEntries({ machines }).map((entry) => entry.split(':')[0]),
    ['cluster_c', 'cluster_a', 'cluster_b']);
});
