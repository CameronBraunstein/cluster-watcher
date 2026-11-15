'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

/** Load the browser's refresh helper from its embedded source. */
function browserJobRefresh() {
  const root = path.resolve(__dirname, '../..');
  const script = fs.readFileSync(path.join(root, 'clusterwatcher/dashboard.py'), 'utf8');
  const start = script.indexOf('const jobSuccessAt = new Map();');
  const end = script.indexOf('// Conditional GET:', start);
  assert.ok(start >= 0 && end > start, 'browser refresh helper is present');
  const context = { currentJobs: [] };
  vm.runInNewContext(`${script.slice(start, end)}\nglobalThis.mergeJobRefresh = mergeJobRefresh;`, context);
  return context;
}

test('browser freezes stale running and pending progress bars', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../clusterwatcher/dashboard.py'), 'utf8');
  const running = source.slice(source.indexOf('function runningJobProgress('),
    source.indexOf('/** Parse dependency clauses', source.indexOf('function runningJobProgress(')));
  const pending = source.slice(source.indexOf('function pendingJobProgress('),
    source.indexOf('function pendingJobStatus(', source.indexOf('function pendingJobProgress(')));
  const context = { formatSeconds: (seconds) => `${Math.floor(seconds)}s`,
    allottedRuntime: () => '1h allotted', escapeHtml: String,
    waitsForDependency: () => false, pendingDependency: () => '' };
  vm.runInNewContext(`${running}\n${pending}\nglobalThis.running = runningJobProgress; globalThis.pending = pendingJobProgress;`, context);

  const staleRunning = context.running({ elapsed_seconds: 60, time_limit_seconds: 3600,
    refresh_error: 'SSH timed out' });
  assert.match(staleRunning, /job-progress-fill" style="width:/);
  assert.doesNotMatch(staleRunning, /data-running-progress/);
  const freshRunning = context.running({ elapsed_seconds: 60, time_limit_seconds: 3600 });
  assert.match(freshRunning, /data-running-progress/);

  const stalePending = context.pending({ submit_time: '2026-11-13T10:00:00Z',
    start_time: '2026-11-13T11:00:00Z', last_success_at: '2026-11-13T10:05:00Z',
    refresh_error: 'SSH timed out' });
  assert.match(stalePending, /job-progress-fill" style="width:/);
  assert.doesNotMatch(stalePending, /data-pending-progress/);
});

test('browser keeps only disconnected cluster cards and clears warnings on recovery', () => {
  const browser = browserJobRefresh();
  browser.currentJobs = [
    { cluster: 'down', job_id: '1', state: 'RUNNING' },
    { cluster: 'up', job_id: '2', state: 'RUNNING' },
  ];
  const partial = browser.mergeJobRefresh(
    [{ cluster: 'up', job_id: '3', state: 'RUNNING' }],
    [{ name: 'down', error: 'SSH timed out', last_success_at: '2026-11-13T10:00:00Z' },
      { name: 'up' }], '', '2026-11-13T10:01:00Z',
  );
  assert.deepEqual(Array.from(partial, (job) => job.job_id).sort(), ['1', '3']);
  assert.equal(partial.find((job) => job.job_id === '1').refresh_error, 'SSH timed out');
  assert.equal(partial.find((job) => job.job_id === '3').refresh_error, undefined);

  browser.currentJobs = partial;
  const offline = browser.mergeJobRefresh([], [{ name: 'down' }, { name: 'up' }], 'API unavailable');
  assert.equal(offline.length, 2);
  assert.ok(offline.every((job) => job.refresh_error === 'API unavailable'));

  browser.currentJobs = offline;
  const recovered = browser.mergeJobRefresh([{ cluster: 'down', job_id: '4' }],
    [{ name: 'down' }, { name: 'up' }]);
  assert.deepEqual(Array.from(recovered, (job) => job.job_id), ['4']);
  assert.equal(recovered[0].refresh_error, undefined);
});

test('browser drops a failed jobs ETag so recovery fetches fresh cards', async () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../clusterwatcher/dashboard.py'), 'utf8');
  const start = source.indexOf('async function refreshJobs(');
  const end = source.indexOf('const partitionDisclosure', start);
  const cache = new Map([['/api/v1/jobs', { etag: 'old' }]]);
  const calls = [];
  const context = { responseCache: cache,
    fetchUnlessUnchanged: async () => { throw new Error('connection refused'); },
    jobsView: (_clusters, error) => calls.push(error), recentJobsView: () => {} };
  vm.runInNewContext(`${source.slice(start, end)}\nglobalThis.refreshJobs = refreshJobs;`, context);

  await context.refreshJobs({ jobs_api_enabled: true, clusters: [{ name: 'alpha' }] }, true);

  assert.equal(cache.has('/api/v1/jobs'), false);
  assert.match(calls[0], /connection refused/);
});
