'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const {
  BackgroundCliProcess, CREDENTIAL_PROMPT_PREFIX, LineDecoder, appendRecentLine, parseCredentialPrompt,
} = require('../background');

test('credential protocol recognizes only valid prefixed requests', () => {
  assert.equal(parseCredentialPrompt('ordinary diagnostic'), undefined);
  assert.deepEqual(parseCredentialPrompt(`${CREDENTIAL_PROMPT_PREFIX}{"version":1,"request_id":3,"kind":"otp","prompt":"Code"}`), {
    version: 1, request_id: 3, kind: 'otp', prompt: 'Code',
  });
  assert.throws(() => parseCredentialPrompt(`${CREDENTIAL_PROMPT_PREFIX}{bad`), /malformed/);
  assert.throws(() => parseCredentialPrompt(`${CREDENTIAL_PROMPT_PREFIX}{"version":2}`), /unsupported/);
});

test('line decoder preserves split chunks and flushes the final line', () => {
  const lines = [];
  const decoder = new LineDecoder((line) => lines.push(line));
  decoder.push('one\ntw');
  decoder.push('o\r\nthree');
  decoder.flush();
  assert.deepEqual(lines, ['one', 'two', 'three']);
});

test('recent diagnostics are bounded and never retain protocol records', () => {
  const lines = [];
  appendRecentLine(lines, 'stderr', `${CREDENTIAL_PROMPT_PREFIX}{"value":"secret"}`, 2);
  appendRecentLine(lines, 'stdout', 'one', 2);
  appendRecentLine(lines, 'stderr', 'two', 2);
  appendRecentLine(lines, 'stdout', 'three', 2);
  assert.deepEqual(lines, [
    { stream: 'stderr', text: 'two' }, { stream: 'stdout', text: 'three' },
  ]);
});

test('background process sends a UI secret only through child stdin', async () => {
  const child = new EventEmitter();
  child.pid = 42;
  child.exitCode = null;
  child.killed = false;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const writes = [];
  child.stdin = { writable: true, write: (value) => writes.push(value) };
  child.kill = () => { child.killed = true; };
  let spawnCall;
  const process = new BackgroundCliProcess('cluster-watcher', ['serve'], {
    onCredential: async () => 'top-secret',
  }, (executable, args, options) => {
    spawnCall = { executable, args, options };
    return child;
  }).start();

  child.stderr.write(`${CREDENTIAL_PROMPT_PREFIX}{"version":1,"request_id":9,"kind":"password","prompt":"Password"}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(spawnCall, {
    executable: 'cluster-watcher', args: ['serve'],
    options: { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false },
  });
  assert.deepEqual(writes, ['{"request_id":9,"value":"top-secret"}\n']);
  assert.equal(JSON.stringify(process.recentLines).includes('top-secret'), false);
  child.emit('close', 0, null);
  assert.equal((await process.completion).code, 0);
});
