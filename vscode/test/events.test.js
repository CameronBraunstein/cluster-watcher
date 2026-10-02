'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { jobTransitions, notificationMessage, shouldNotify, statusSummary } = require('../events');
const { publishProblems } = require('../scripts/check-publish');

const job = (id, state, extra = {}) => ({ job_id: id, cluster: 'cluster_0', name: `job${id}`, state, submit_at: '2026-10-01T10:00:00Z', ...extra });

test('first refresh is a silent baseline; later finishes are reported once', () => {
  const first = jobTransitions(null, [job('1', 'RUNNING'), job('2', 'COMPLETED')]);
  assert.deepEqual(first.finished, []);

  const second = jobTransitions(first.states, [job('1', 'FAILED'), job('2', 'COMPLETED'), job('3', 'PENDING')]);
  assert.deepEqual(second.finished.map(({ job: item, group }) => [item.job_id, group]), [['1', 'FAILED']]);

  const third = jobTransitions(second.states, [job('1', 'FAILED'), job('3', 'COMPLETED')]);
  assert.deepEqual(third.finished.map(({ job: item }) => item.job_id), ['3']);
});

test('notification modes filter outcomes and skip jobs ended from the sidebar', () => {
  const completed = { job: job('1', 'COMPLETED'), group: 'COMPLETED' };
  const failed = { job: job('2', 'TIMEOUT'), group: 'FAILED' };
  const cancelled = { job: job('3', 'CANCELLED'), group: 'CANCELLED' };
  assert.equal(shouldNotify('all', completed), true);
  assert.equal(shouldNotify('failures', completed), false);
  assert.equal(shouldNotify('failures', failed), true);
  assert.equal(shouldNotify('off', failed), false);
  assert.equal(shouldNotify('unexpected', completed), true);
  assert.equal(shouldNotify('all', cancelled, new Set(['cluster_0/3'])), false);
  assert.equal(shouldNotify('all', cancelled), true);
});

test('notification text names the job, cluster, and failure state', () => {
  assert.equal(notificationMessage({ job: job('1', 'COMPLETED'), group: 'COMPLETED' }), 'Job "job1" (1) on cluster_0 completed.');
  assert.equal(
    notificationMessage({ job: job('2', 'OUT_OF_MEMORY', { exit_code: '0:125' }), group: 'FAILED' }),
    'Job "job2" (2) on cluster_0 failed (OUT_OF_MEMORY, exit 0:125).',
  );
});

test('status bar summarises running and pending jobs', () => {
  assert.equal(statusSummary([job('1', 'RUNNING'), job('2', 'PENDING'), job('3', 'PENDING'), job('4', 'COMPLETED')]).text,
    '$(server-process) 1 running · 2 pending');
  assert.equal(statusSummary([]).text, '$(server-process) no active jobs');
});

test('publishing is blocked while placeholders remain', () => {
  assert.equal(publishProblems({ publisher: 'cluster-watcher-project', repository: { url: 'https://github.com/REPLACE-ME/x' } }).length, 4);
  assert.deepEqual(publishProblems({
    publisher: 'alice', repository: { url: 'https://github.com/alice/x' },
    bugs: { url: 'https://github.com/alice/x/issues' }, homepage: 'https://github.com/alice/x',
  }), []);
});
