'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { RefreshCoordinator, RefreshFeedback, initialCollectionPending, refreshResultMessage } = require('../refresh');

/** Build a coordinator whose collaborators record every observable update. */
function harness(poll, refreshServer, options = {}) {
  const jobsProvider = {
    cancelling: new Set(),
    updates: [],
    checks: [],
    errors: [],
    loadings: 0,
    loading() { this.loadings += 1; },
    update(payload, checkedAt) { this.updates.push({ payload, checkedAt }); },
    checked(checkedAt) { this.checks.push(checkedAt); },
    error(error) { this.errors.push(error); },
    jobsApiDisabled() {},
  };
  const statusProvider = {
    updates: [],
    checks: [],
    errors: [],
    loadings: 0,
    loading() { this.loadings += 1; },
    update(payload, checkedAt) { this.updates.push({ payload, checkedAt }); },
    checked(checkedAt) { this.checks.push(checkedAt); },
    error(error) { this.errors.push(error); },
  };
  const monitor = {
    updates: [],
    checks: [],
    loadings: 0,
    loading() { this.loadings += 1; },
    update(payload, cancelling, checkedAt) { this.updates.push({ payload, cancelling, checkedAt }); },
    checked(checkedAt) { this.checks.push(checkedAt); },
    jobsApiDisabled() {},
    offline() {},
  };
  const coordinator = new RefreshCoordinator(
    { poll }, jobsProvider, statusProvider, monitor,
    { jobsApiDisabled: () => false, refreshSeconds: () => 15, refreshServer, ...options },
  );
  return { coordinator, jobsProvider, statusProvider, monitor };
}

test('a reachable service immediately replaces stale offline indicators with loading', () => {
  const state = harness(async () => ({ payload: {}, etag: 'ready' }));

  state.coordinator.serviceReachable();

  assert.equal(state.jobsProvider.loadings, 1);
  assert.equal(state.statusProvider.loadings, 1);
  assert.equal(state.monitor.loadings, 1);
});

test('the initial-collection 503 is loading and retries promptly without an offline state', async () => {
  const retryCallbacks = [];
  const delays = [];
  const requests = [];
  const pending = Object.assign(new Error('The first cluster status collection has not completed'), { status: 503 });
  const state = harness(async (path) => {
    requests.push(path);
    if (requests.length <= 2) throw pending;
    return { payload: { source: path }, etag: path };
  }, undefined, {
    setTimeout: (callback, delay) => { retryCallbacks.push(callback); delays.push(delay); return retryCallbacks.length; },
    clearTimeout: () => {},
  });

  const first = await state.coordinator.refresh();
  assert.deepEqual(first.map((result) => result.outcome), ['loading', 'loading']);
  assert.deepEqual(delays, [1000, 1000]);
  assert.equal(state.monitor.loadings, 1);
  assert.equal(state.jobsProvider.loadings, 1);
  assert.equal(state.statusProvider.loadings, 1);
  assert.equal(state.monitor.updates.length, 0);
  assert.equal(state.jobsProvider.errors.length, 0);
  assert.equal(state.statusProvider.errors.length, 0);

  retryCallbacks.forEach((callback) => callback());
  await state.coordinator.refresh();
  assert.equal(state.jobsProvider.updates.length, 1);
  assert.equal(state.statusProvider.updates.length, 1);
});

test('a pre-start request failure cannot restore offline after the service becomes reachable', async () => {
  let rejectJobs;
  let rejectStatus;
  const callbacks = [];
  const state = harness((path) => new Promise((_resolve, reject) => {
    if (path === '/api/v1/jobs') rejectJobs = reject;
    else rejectStatus = reject;
  }), undefined, {
    setTimeout: (callback) => { callbacks.push(callback); return callbacks.length; },
    clearTimeout: () => {},
  });

  const first = state.coordinator.refresh();
  state.coordinator.serviceReachable();
  rejectJobs(new Error('Connection refused before startup'));
  rejectStatus(new Error('Connection refused before startup'));
  assert.deepEqual((await first).map((result) => result.outcome), ['loading', 'loading']);
  assert.equal(callbacks.length, 2);
  assert.equal(state.jobsProvider.errors.length, 0);
  assert.equal(state.statusProvider.errors.length, 0);
});

test('unrelated server errors do not enter first-load retry', async () => {
  const unexpected = Object.assign(new Error('Database unavailable'), { status: 503 });
  assert.equal(initialCollectionPending(unexpected), false);
  const state = harness(async () => { throw unexpected; }, undefined, {
    setTimeout: () => { throw new Error('should not retry'); },
  });

  const result = await state.coordinator.refreshJobs();
  assert.equal(result.outcome, 'error');
  assert.equal(state.monitor.loadings, 0);
  assert.equal(state.jobsProvider.errors.length, 1);
});

test('disposing the coordinator cancels a scheduled first-load retry', async () => {
  const cleared = [];
  const pending = Object.assign(new Error('The first cluster status collection has not completed'), { status: 503 });
  const state = harness(async () => { throw pending; }, undefined, {
    setTimeout: () => 7,
    clearTimeout: (handle) => cleared.push(handle),
  });

  await state.coordinator.refreshJobs();
  state.coordinator.dispose();

  assert.deepEqual(cleared, [7]);
});

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

test('combined and server-only refreshes include the local service inventory', async () => {
  const serverCalls = [];
  const state = harness(
    async (path) => ({ payload: { source: path }, etag: path }),
    async () => { serverCalls.push('server'); return { outcome: 'updated', checkedAt: 1 }; },
  );

  await state.coordinator.refresh();
  await state.coordinator.refreshServer();

  assert.deepEqual(serverCalls, ['server', 'server']);
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
