'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { RefreshCoordinator } = require('../refresh');

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

  await state.coordinator.refreshJobs();
  await state.coordinator.refreshJobs();

  assert.deepEqual(calls, [
    { path: '/api/v1/jobs', etag: undefined },
    { path: '/api/v1/jobs', etag: 'jobs-1' },
  ]);
  assert.equal(state.jobsProvider.updates.length, 2);
  assert.equal(state.statusProvider.updates.length, 0);
  assert.equal(state.monitor.updates.length, 2);
});

test('Cluster Status refresh polls and updates only the snapshot endpoint', async () => {
  const calls = [];
  const state = harness(async (path, etag) => {
    calls.push({ path, etag });
    return { payload: { clusters: ['alpha'] }, etag: 'status-1' };
  });

  await state.coordinator.refreshStatus();
  await state.coordinator.refreshStatus();

  assert.deepEqual(calls, [
    { path: '/api/v1/snapshot', etag: undefined },
    { path: '/api/v1/snapshot', etag: 'status-1' },
  ]);
  assert.equal(state.statusProvider.updates.length, 2);
  assert.equal(state.jobsProvider.updates.length, 0);
  assert.equal(state.monitor.updates.length, 0);
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

  await state.coordinator.refreshJobs();

  assert.equal(state.monitor.checks.length, 1);
  assert.equal(state.jobsProvider.checks.length, 1);
  assert.equal(state.monitor.updates.length, 0);
});
