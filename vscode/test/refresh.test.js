'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { RefreshCoordinator, RefreshFeedback, refreshResultMessage } = require('../refresh');

/** Build a coordinator whose collaborators record every observable update. */
function harness(poll) {
  const jobsProvider = {
    cancelling: new Set(),
    updates: [],
    checks: [],
    errors: [],
    update(payload, checkedAt) { this.updates.push({ payload, checkedAt }); },
    checked(checkedAt) { this.checks.push(checkedAt); },
    error(error) { this.errors.push(error); },
    jobsApiDisabled() {},
  };
  const statusProvider = {
    updates: [],
    checks: [],
    errors: [],
    update(payload, checkedAt) { this.updates.push({ payload, checkedAt }); },
    checked(checkedAt) { this.checks.push(checkedAt); },
    error(error) { this.errors.push(error); },
  };
  const monitor = {
    updates: [],
    checks: [],
    update(payload, cancelling, checkedAt) { this.updates.push({ payload, cancelling, checkedAt }); },
    checked(checkedAt) { this.checks.push(checkedAt); },
    jobsApiDisabled() {},
    offline() {},
  };
  const coordinator = new RefreshCoordinator(
    { poll }, jobsProvider, statusProvider, monitor,
    { jobsApiDisabled: () => false, refreshSeconds: () => 15 },
  );
  return { coordinator, jobsProvider, statusProvider, monitor };
}

test('My Jobs refresh polls and updates only the jobs endpoint', async () => {
  const calls = [];
  const state = harness(async (path, etag) => {
    calls.push({ path, etag });
    return { payload: { jobs: ['job-1'] }, etag: 'jobs-1' };
  });

  const first = await state.coordinator.refreshJobs();
  const second = await state.coordinator.refreshJobs();

  assert.deepEqual(calls, [
    { path: '/api/v1/jobs', etag: undefined },
    { path: '/api/v1/jobs', etag: 'jobs-1' },
  ]);
  assert.equal(state.jobsProvider.updates.length, 2);
  assert.equal(state.statusProvider.updates.length, 0);
  assert.equal(state.monitor.updates.length, 2);
  assert.equal(first.outcome, 'updated');
  assert.equal(second.outcome, 'updated');
});

test('Cluster Status refresh polls and updates only the snapshot endpoint', async () => {
  const calls = [];
  const state = harness(async (path, etag) => {
    calls.push({ path, etag });
    return { payload: { clusters: ['alpha'] }, etag: 'status-1' };
  });

  const first = await state.coordinator.refreshStatus();
  const second = await state.coordinator.refreshStatus();

  assert.deepEqual(calls, [
    { path: '/api/v1/snapshot', etag: undefined },
    { path: '/api/v1/snapshot', etag: 'status-1' },
  ]);
  assert.equal(state.statusProvider.updates.length, 2);
  assert.equal(state.jobsProvider.updates.length, 0);
  assert.equal(state.monitor.updates.length, 0);
  assert.equal(first.outcome, 'updated');
  assert.equal(second.outcome, 'updated');
});

test('combined refresh continues to poll both endpoints', async () => {
  const calls = [];
  const state = harness(async (path) => {
    calls.push(path);
    return { payload: { source: path }, etag: path };
  });

  await state.coordinator.refresh();

  assert.deepEqual(calls.sort(), ['/api/v1/jobs', '/api/v1/snapshot']);
  assert.equal(state.jobsProvider.updates.length, 1);
  assert.equal(state.statusProvider.updates.length, 1);
});

test('overlapping refreshes share the request for each endpoint', async () => {
  const resolvers = new Map();
  const calls = [];
  const state = harness((path) => {
    calls.push(path);
    return new Promise((resolve) => resolvers.set(path, resolve));
  });

  const jobsOnly = state.coordinator.refreshJobs();
  const combined = state.coordinator.refresh();
  assert.deepEqual(calls.sort(), ['/api/v1/jobs', '/api/v1/snapshot']);

  resolvers.get('/api/v1/jobs')({ payload: { jobs: [] }, etag: 'jobs' });
  resolvers.get('/api/v1/snapshot')({ payload: { clusters: [] }, etag: 'status' });
  await Promise.all([jobsOnly, combined]);

  assert.equal(calls.filter((path) => path === '/api/v1/jobs').length, 1);
  assert.equal(calls.filter((path) => path === '/api/v1/snapshot').length, 1);
});

test('an unchanged jobs check updates the status-bar refresh time', async () => {
  const state = harness(async () => ({ notModified: true }));

  const result = await state.coordinator.refreshJobs();

  assert.equal(state.monitor.checks.length, 1);
  assert.equal(state.jobsProvider.checks.length, 1);
  assert.equal(state.monitor.updates.length, 0);
  assert.equal(result.outcome, 'unchanged');
});

test('manual refresh feedback spins for a perceptible minimum duration', async () => {
  let now = 1000;
  const contexts = [];
  const delays = [];
  const feedback = new RefreshFeedback(
    async (key, value) => contexts.push([key, value]),
    {
      minimumMilliseconds: 550,
      now: () => now,
      delay: async (milliseconds) => { delays.push(milliseconds); now += milliseconds; },
    },
  );

  await feedback.run('clusterWatcher.refreshingJobs', async () => { now += 75; });

  assert.deepEqual(contexts, [
    ['clusterWatcher.refreshingJobs', true],
    ['clusterWatcher.refreshingJobs', false],
  ]);
  assert.deepEqual(delays, [475]);
});

test('manual refresh messages distinguish changed and unchanged responses', () => {
  const timestamp = '08.10.2026 15:42:17';
  assert.equal(
    refreshResultMessage({ outcome: 'updated' }, timestamp),
    `Refreshed at: ${timestamp}`,
  );
  assert.equal(
    refreshResultMessage({ outcome: 'unchanged' }, timestamp),
    `Checked, but no updates at: ${timestamp}`,
  );
  assert.equal(refreshResultMessage({ outcome: 'error' }, timestamp), undefined);
});
